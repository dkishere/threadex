import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

for (const requestId of [500, "question-request", "canceled-request", "async-message"]) test(`question ${requestId} drains notifications and handles its result`, { timeout: 20000 }, async () => {
  const asyncMessage = requestId === "async-message";
  const cancel = requestId === "canceled-request";
  const root = mkdtempSync(resolve(tmpdir(), "threadex-input-runner-"));
  const project = resolve(import.meta.dirname, "../..");
  const script = resolve(root, "fake-codex.mjs");
  const answer = { answers: { [asyncMessage ? "0" : "scope"]: { answers: ["Both"] } } };
  let questionRequests = 0;
  let wait: ServerResponse | undefined;
  let progressed = false;
  let receivedNativeAnswer = false;
  let canceled = false;
  const release = () => { if (wait && (cancel ? canceled : progressed)) { wait.end(JSON.stringify({ decision: canceled ? "cancel" : answer })); wait = undefined; } };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : {};
    res.setHeader("Content-Type", "application/json");
    if (req.url?.endsWith("/api/approvals/request")) questionRequests++;
    if (req.url?.endsWith("/wait")) { wait = res; release(); return; }
    if (req.url?.endsWith("/decision")) { canceled = data.decision === "cancel"; release(); }
    if (data.event === "codex" && data.data?.method === "item/agentMessage/delta") { progressed = true; release(); }
    if (data.event === "codex" && data.data?.params?.item?.text === "native answer received") receivedNativeAnswer = true;
    res.end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  writeFileSync(script, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const send = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const r = JSON.parse(line);
  if (r.method === "initialize" || r.method === "thread/goal/clear") send({ id: r.id, result: {} });
  if (r.method === "thread/start") send({ id: r.id, result: { thread: { id: "thread-1" } } });
  if (r.method === "turn/start") {
    send({ id: r.id, result: { turn: { id: "turn-1" } } });
    if (${asyncMessage}) {
      const params = { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "call_question", text: "Which?", phase: "final_answer", delivery: "async", questions: [{ title: "Which?", options: ["Both"] }] } };
      send({ method: "item/started", params });
      send({ method: "item/completed", params });
    } else send({ id: ${JSON.stringify(requestId)}, method: "item/tool/requestUserInput", params: { isBlocking: false, threadId: "thread-1", turnId: "turn-1", itemId: "question-1", questions: [{ id: "scope", header: "Scope", question: "Which?", options: [{ label: "Both", description: "Both parts" }] }] } });
    send({ method: "item/agentMessage/delta", params: { itemId: "progress", delta: "Still working" } });
    if (${cancel}) setTimeout(() => {
      send({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: ${JSON.stringify(requestId)} } });
      setTimeout(() => send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } }), 100);
    }, 50);
  }
  if (${asyncMessage} ? r.method === "turn/steer" : r.id === ${JSON.stringify(requestId)}) {
    if (${cancel}) process.exit(3);
    if (${asyncMessage}) {
      if (r.params.expectedTurnId !== "turn-1" || r.params.input[0].text !== "Which?\\nAnswer: Both") process.exit(2);
      send({ id: r.id, result: { turnId: "turn-1" } });
    } else if (JSON.stringify(r.result) !== ${JSON.stringify(JSON.stringify(answer))}) process.exit(2);
    send({ method: "item/completed", params: { item: { id: "answer", type: "agentMessage", text: "native answer received" } } });
    send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
  }
});
`);
  chmodSync(script, 0o755);
  const job = resolve(root, "job.json");
  writeFileSync(job, JSON.stringify({ sessionId: "session-1", turnId: "turn-1", message: "Ask", cwd: project, codexHome: resolve(root, "home"), logPath: resolve(root, "log.ndjson"), serverUrl: `http://127.0.0.1:${address.port}` }));
  const child = spawn(process.execPath, ["--import", "tsx", resolve(project, "src/server/promptRunner.ts"), job], { cwd: project, env: { ...process.env, CODEX_PATH: script, THREADEX_INHIBIT_SLEEP: "0" }, stdio: ["ignore", "ignore", "pipe"] });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const code = await new Promise((done) => child.once("exit", done));
    assert.equal(code, 0, stderr + readFileSync(resolve(root, "log.ndjson"), "utf8"));
    assert.equal(progressed, true);
    assert.equal(receivedNativeAnswer, !cancel);
    assert.equal(canceled, cancel);
    assert.equal(questionRequests, 1);
    if (asyncMessage) {
      const log = readFileSync(resolve(root, "log.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const item = log.find((e) => e.event === "item" && e.data.id === "call_question").data;
      assert.equal(item.delivery, "async");
      assert.deepEqual(item.questions, [{ title: "Which?", options: ["Both"] }]);
      assert.ok(log.some((e) => e.event === "steer.accepted"));
    }
  } finally {
    clearTimeout(timeout); child.kill(); server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  }
});
