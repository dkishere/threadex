import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

for (const missing of [false, true]) test(`Codex provider resume ${missing ? "recovers a missing thread with full history" : "keeps the original thread and appends the other agent's turns"}`, { timeout: 30_000 }, async () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-provider-resume-"));
  const fake = resolve(root, "fake-codex.mjs");
  const capture = resolve(root, "rpc.ndjson");
  const logPath = resolve(root, "runner.ndjson");
  const jobPath = resolve(root, "job.json");
  const providerThread = { provider: "codex", nativeHome: root, cwd: process.cwd(), accountId: "account" };
  writeFileSync(fake, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  appendFileSync(process.env.CAPTURE_PATH, JSON.stringify(request) + "\\n");
  if (request.method === "thread/resume") {
    send(${missing} ? { id: request.id, error: { message: "No rollout found for thread id codex-original" } }
      : { id: request.id, result: { thread: { id: request.params.threadId } } });
  } else if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "codex-replacement" } } });
  else if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "native-turn" } } });
    send({ method: "item/completed", params: { item: { id: "answer", type: "agentMessage", text: "done" } } });
    send({ method: "turn/completed", params: { turn: { id: "native-turn", status: "completed" } } });
  } else if (request.id) send({ id: request.id, result: {} });
});
`);
  chmodSync(fake, 0o755);
  writeFileSync(jobPath, JSON.stringify({ sessionId: "session", turnId: "current", threadId: "codex-original",
    message: "continue", model: "gpt-6-sol", providerThread,
    providerHandoff: "[Threadex agent handoff]\nTurn 2 [turnId=cc-turn; agent=Claude Code]:\nFixed the bug.",
    recoveryContext: { reason: "thread_unavailable", sourceThreadId: "claude:b", handoff: "FULL SAVED HISTORY" },
    logPath, codexHome: root, cwd: process.cwd() }));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/promptRunner.ts", jobPath], {
    cwd: process.cwd(), env: { ...process.env, CODEX_PATH: fake, CAPTURE_PATH: capture, SESSION_INSPECTOR_MCP_MODE: "off" },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    assert.equal(await new Promise(resolveExit => child.once("exit", resolveExit)), 0, stderr);
    const requests = readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(requests.find(item => item.method === "thread/resume").params.threadId, "codex-original");
    assert.equal(requests.filter(item => item.method === "thread/start").length, missing ? 1 : 0);
    const turn = requests.find(item => item.method === "turn/start").params;
    assert.equal(turn.threadId, missing ? "codex-replacement" : "codex-original");
    const prompt = turn.input.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
    assert.match(prompt, missing ? /FULL SAVED HISTORY/ : /turnId=cc-turn; agent=Claude Code/);
    assert.doesNotMatch(prompt, missing ? /Fixed the bug/ : /FULL SAVED HISTORY/);
    const events = readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(events.find(event => event.event === "result").data.providerThread, providerThread);
  } finally { child.kill(); rmSync(root, { recursive: true, force: true }); }
});
