import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { IntentApprovals } from "./intentApprovals";

for (const requestId of [500, "question-request", "canceled-request", "async-message", "intent-request", "intent-steer-rejected"]) test(`question ${requestId} drains notifications and handles its result`, { timeout: 20000 }, async () => {
  const intent = String(requestId).startsWith("intent-");
  const rejectSteer = requestId === "intent-steer-rejected";
  const asyncMessage = requestId === "async-message";
  const cancel = requestId === "canceled-request";
  const root = mkdtempSync(resolve(tmpdir(), "threadex-input-runner-"));
  const project = resolve(import.meta.dirname, "../..");
  const script = resolve(root, "fake-codex.mjs");
  const controlPath = resolve(root, "controls.ndjson"), controlResultDir = resolve(root, "control-results");
  const answer = { answers: { [asyncMessage ? "0" : "scope"]: { answers: [asyncMessage ? "private-token" : "Both"] } } };
  let questionRequests = 0;
  let wait: ServerResponse | undefined;
  let progressed = false;
  let receivedNativeAnswer = false;
  let canceled = false;
  let steerAcknowledged = false;
  const service = new IntentApprovals({
    active: async () => true, pending: () => undefined, publish: async () => undefined,
    deliver: async (approval, message) => {
      assert.equal(receivedNativeAnswer, false, "tool must remain pending during steer delivery");
      const commandId = `intent-${approval.approvalId}`;
      appendFileSync(controlPath, JSON.stringify({ id: commandId, source: "intent-approval", message }) + "\n");
      const resultPath = resolve(controlResultDir, `${commandId}.json`);
      const deadline = Date.now() + 8000;
      while (!existsSync(resultPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(existsSync(resultPath), "real promptRunner must write the acknowledgement");
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      if (!result.ok) throw new Error(result.error);
      steerAcknowledged = true;
    }
  });
  const release = () => { if (wait && (cancel ? canceled : progressed)) { wait.end(JSON.stringify({ decision: canceled ? "cancel" : answer })); wait = undefined; } };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : {};
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/intent-approvals") {
      assert.equal(data.sessionId, "session-1"); assert.equal(data.turnId, "turn-1");
      assert.deepEqual(data.intent.actions, ["Deploy staging"]);
      questionRequests++;
      const created = await service.request(data.sessionId, data.turnId, data.intent);
      res.end(JSON.stringify(created));
      setTimeout(() => { void service.decide(created.approvalId, { outcome: "approved", actions: data.intent.actions, constraints: "Only staging" }).catch(() => undefined); }, 20);
      return;
    }
    if (req.url?.startsWith("/api/intent-approvals/") && req.url.endsWith("/result")) {
      res.end(JSON.stringify(await service.result(req.url.split("/")[3]))); return;
    }
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
let intentToolPending = false, intentSteerAcknowledged = false;
createInterface({ input: process.stdin }).on("line", (line) => {
  const r = JSON.parse(line);
  if (r.method === "initialize" || r.method === "thread/goal/clear") send({ id: r.id, result: {} });
  if (r.method === "thread/start") {
    if (${intent} && !r.params.dynamicTools?.some(t => t.name === "request_intent_approval" && t.type === "function")) process.exit(4);
    send({ id: r.id, result: { thread: { id: "thread-1" } } });
  }
  if (r.method === "turn/start") {
    send({ id: r.id, result: { turn: { id: "turn-1" } } });
    if (${intent}) {
      intentToolPending = true;
      send({ id: ${JSON.stringify(requestId)}, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", callId: "intent-call", tool: "request_intent_approval", arguments: { title: "Deploy?", scope: "Project A staging", actions: ["Deploy staging"], exclusions: "Production", consequences: "Staging downtime" } } });
    } else if (${asyncMessage}) {
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
  if (${intent} && r.method === "turn/steer") {
    if (!intentToolPending || r.params.expectedTurnId !== "turn-1" || !r.params.input[0].text.includes("Threadex user intent decision")) process.exit(5);
    send({ method: "item/agentMessage/delta", params: { itemId: "during-steer", delta: "Reader still draining" } });
    setTimeout(() => {
      intentSteerAcknowledged = true;
      send(${rejectSteer} ? { id: r.id, error: { code: -32000, message: "steer rejected" } } : { id: r.id, result: { turnId: "turn-1" } });
    }, 75);
  }
  if (${asyncMessage} ? r.method === "turn/steer" : r.id === ${JSON.stringify(requestId)}) {
    if (${cancel}) process.exit(3);
    if (${asyncMessage}) {
      if (r.params.expectedTurnId !== "turn-1" || r.params.input[0].text !== "Which?\\nAnswer: private-token") process.exit(2);
      send({ id: r.id, result: { turnId: "turn-1" } });
    } else if (${intent}) {
      const decision = JSON.parse(r.result.contentItems[0].text);
      if (!intentToolPending || !intentSteerAcknowledged || !r.result.success) process.exit(2);
      if (${rejectSteer} ? decision.decision !== "cancel" || decision.grantId : !decision.grantId || decision.decision.outcome !== "approved") process.exit(6);
      intentToolPending = false;
    } else if (JSON.stringify(r.result) !== ${JSON.stringify(JSON.stringify(answer))}) process.exit(2);
    send({ method: "item/completed", params: { item: { id: "answer", type: "agentMessage", text: "native answer received" } } });
    send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
  }
});
`);
  chmodSync(script, 0o755);
  const job = resolve(root, "job.json");
  writeFileSync(job, JSON.stringify({ sessionId: "session-1", turnId: "turn-1", message: "Ask", cwd: project, controlPath, controlResultDir, codexHome: resolve(root, "home"), logPath: resolve(root, "log.ndjson"), serverUrl: `http://127.0.0.1:${address.port}` }));
  const child = spawn(process.execPath, ["--import", "tsx", resolve(project, "src/server/promptRunner.ts"), job], { cwd: project, env: { ...process.env, CODEX_PATH: script, THREADEX_INHIBIT_SLEEP: "0" }, stdio: ["ignore", "ignore", "pipe"] });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const code = await new Promise((done) => child.once("exit", done));
    assert.equal(code, 0, stderr + readFileSync(resolve(root, "log.ndjson"), "utf8"));
    assert.equal(progressed, true);
    assert.equal(receivedNativeAnswer, !cancel);
    if (!asyncMessage) assert.equal(canceled, cancel);
    assert.equal(questionRequests, 1);
    if (intent) assert.equal(steerAcknowledged, !rejectSteer);
    if (asyncMessage) {
      const log = readFileSync(resolve(root, "log.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const item = log.find((e) => e.event === "item" && e.data.id === "call_question").data;
      assert.equal(item.delivery, "async");
      assert.deepEqual(item.questions, [{ title: "Which?", options: ["Both"] }]);
      assert.ok(log.some((e) => e.event === "steer.accepted" && e.data.commandId === "async:thread-1:call_question" && e.data.message === "Which?\nAnswer: private-token"));
      assert.ok(log.some((e) => e.event === "approval.resolved" && JSON.stringify(e.data.decision) === JSON.stringify(answer)));
    }
  } finally {
    clearTimeout(timeout); child.kill(); server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  }
});
