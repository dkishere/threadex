import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resolveSubagentPromptTarget, subagentPromptRecord } from "./subagentPromptRecord";
import { normalizeSubagentTranscript } from "./subagentTranscript";
import { compactTimelineEntries } from "../client/sessionHelpers01";

test("V2 task-name spawn -> runner reminder -> CLI record -> reloaded child card", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "subagent-prompt-flow-"));
  const repo = resolve(import.meta.dirname, "../..");
  const prompt = "檢查 src/main.ts\n保留 `pwd` 原文，唔好修改。";
  const nativeItem = { id: "spawn-call", itemType: "subagent", tool: "activity", status: "started",
    label: "/root/check", receiverThreadIds: ["child-thread"], agents: [], originThreadId: "root-thread" };
  const stored: any[] = [nativeItem];
  let received: any;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/subagent-prompts") {
      received = JSON.parse(body);
      const threadId = resolveSubagentPromptTarget(received, stored);
      stored.push(subagentPromptRecord({ ...received, threadId }));
      res.end(JSON.stringify({ ok: true, threadId }));
    } else res.end(JSON.stringify({ ok: true, challenges: [] }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const fakePath = resolve(dir, "fake-codex.mjs");
  const logPath = resolve(dir, "runner.ndjson");
  const reminderPath = resolve(dir, "reminder.json");
  writeFileSync(fakePath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const send = x => process.stdout.write(JSON.stringify(x) + "\\n");
createInterface({input:process.stdin}).on("line", line => {
  const r = JSON.parse(line);
  if (r.method === "initialize" || r.method === "thread/goal/clear") send({id:r.id,result:{}});
  if (r.method === "thread/start") send({id:r.id,result:{thread:{id:"root-thread"}}});
  if (r.method === "turn/start") {
    send({id:r.id,result:{turn:{id:"native-turn"}}});
    send({method:"turn/started",params:{threadId:"root-thread",turn:{id:"native-turn",status:"inProgress",items:[]}}});
    // V2 exposes the UUID only in this event, not in spawn's task_name result.
    for (const method of ["item/started", "item/completed"]) send({method,params:{threadId:"root-thread",turnId:"native-turn",
      item:{id:"spawn-call",type:"subAgentActivity",kind:"started",agentThreadId:"child-thread",agentPath:"/root/check"}}});
  }
  if (r.method === "thread/inject_items") {
    writeFileSync(${JSON.stringify(reminderPath)},JSON.stringify(r.params));
    send({id:r.id,result:{}});
    execFileSync(process.execPath,[${JSON.stringify(resolve(repo, "scripts/session-inspector.mjs"))},"record_subagent_prompt",JSON.stringify({taskName:"/root/check",kind:"spawn",prompt:${JSON.stringify(prompt)}})],{env:process.env});
    send({method:"item/completed",params:{threadId:"root-thread",turnId:"native-turn",item:{id:"answer",type:"agentMessage",text:"Recorded"}}});
    send({method:"turn/completed",params:{threadId:"root-thread",turn:{id:"native-turn",status:"completed",items:[]}}});
  }
});
`);
  chmodSync(fakePath, 0o755);
  const jobPath = resolve(dir, "job.json");
  writeFileSync(jobPath, JSON.stringify({ sessionId: "session", turnId: "host-turn", message: "Check task",
    model: "gpt-6.1-sol", logPath, cwd: repo, serverUrl: `http://127.0.0.1:${address.port}`,
    codexHome: resolve(dir, "codex-home") }));
  const child = spawn(process.execPath, ["--import", "tsx", resolve(repo, "src/server/promptRunner.ts"), jobPath], {
    cwd: repo, env: { ...process.env, CODEX_PATH: fakePath, AGENT_CLI_PATH: fakePath,
      RUNNER_SERVER_URL: `http://127.0.0.1:${address.port}`, THREADEX_SESSION_ID: "session", THREADEX_TURN_ID: "host-turn" },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 12000);
  try {
    const code = await new Promise<number | null>((done, reject) => { child.once("exit", done); child.once("error", reject); });
    assert.equal(code, 0, stderr);
    assert.equal(received.sessionId, "session");
    assert.equal(received.turnId, "host-turn");
    assert.equal(received.prompt, prompt);
    assert.equal(stored.length, 2, "duplicate start/completed notifications only trigger one record");
    const reminder = JSON.parse(readFileSync(reminderPath, "utf8"));
    assert.equal(reminder.threadId, "root-thread");
    assert.match(reminder.items[0].content[0].text, /child-thread/);
    const transcript = normalizeSubagentTranscript({ sessionId: "session", threadId: "child-thread",
      threadReadResult: { thread: { id: "child-thread", turns: [] } }, liveItemsByTurn: { "host-turn": stored } });
    assert.equal(transcript.delegatedPrompt, prompt);
    const cards = compactTimelineEntries({ compactLiveItemGroup: () => null }, stored.map(item => ({ type: "live", id: item.id, item })));
    assert.equal(cards.length, 1);
    assert.ok(cards[0].item.activityUpdates.some((item: any) => item.prompt === prompt));
  } finally {
    clearTimeout(timer); child.kill(); server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  }
});
