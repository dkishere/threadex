import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SessionSummarizer } from "./sessionSummarizer";
import type { SessionStore } from "./sessionStore";

const config = { model: "gpt-6-luna", idleMs: 60_000, sweepMs: 60_000, pendingRetryMs: 60_000,
  maxInputChars: 5_000, timeoutMs: 5_000, runnerMaxRuns: 10, runnerMaxAgeMs: 60_000,
  reasoningEffort: "low" as const, provider: "luna-runner" as const, mockResponse: null, promptDumpDir: null };

test("Decision Codex helpers keep workspace auth, schema and isolation; parallel calls clean up independently", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "decision-codex-"));
  const executable = resolve(root, "codex.mjs");
  const requests = resolve(root, "requests.jsonl");
  const oldPath = process.env.CODEX_PATH;
  writeFileSync(resolve(root, "auth.json"), JSON.stringify({ tokens: { account_id: "workspace-account" } }));
  writeFileSync(executable, `#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {appendFileSync,readFileSync} from 'node:fs';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line);
  if(r.method==='initialize')send({id:r.id,result:{}});
  if(r.method==='thread/start')send({id:r.id,result:{thread:{id:'thread'}}});
  if(r.method==='turn/start'){
    appendFileSync(${JSON.stringify(requests)},JSON.stringify({pid:process.pid,params:r.params,auth:JSON.parse(readFileSync(process.env.CODEX_HOME+'/auth.json','utf8'))})+'\\n');
    if(r.params.input[0].text==='stall-before-ack')return;
    send({id:r.id,result:{turn:{id:'turn'}}});
    if(r.params.input[0].text==='stall')return;
    send({method:'thread/tokenUsage/updated',params:{threadId:'thread',tokenUsage:{last:{inputTokens:12,outputTokens:3,totalTokens:15}}}});
    send({method:'item/completed',params:{threadId:'thread',item:{id:'answer',type:'agentMessage',text:'{"ok":true}'}}});
    send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
  }
});
`);
  chmodSync(executable, 0o755);
  process.env.CODEX_PATH = executable;
  let backgroundCharges = 0;
  const store = { getWorkspace: async () => ({ codexHome: root }), listAccounts: async () => [],
    recordTokenUsage: async () => { backgroundCharges++; } } as unknown as SessionStore;
  const summarizer = new SessionSummarizer(store, config);
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
  const stalled = new AbortController();
  try {
    const pending = summarizer.runDecisionJsonTask({ workspaceId: "ws", prompt: "stall", outputSchema: schema, signal: stalled.signal });
    await waitFor(() => { try { return readFileSync(requests, "utf8").includes('"stall"'); } catch { return false; } });
    const result = await summarizer.runDecisionJsonTask({ workspaceId: "ws", prompt: "answer", outputSchema: schema });
    assert.equal(result.responseText, '{"ok":true}');
    assert.equal(result.model, "gpt-6-luna");
    assert.equal(result.usage?.inputTokens, 12);
    stalled.abort();
    await assert.rejects(pending, /stopped/);
    const captures = readFileSync(requests, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(captures.length, 2);
    assert.notEqual(captures[0].pid, captures[1].pid);
    for (const capture of captures) {
      assert.equal(capture.auth.tokens.account_id, "workspace-account");
      assert.deepEqual(capture.params.outputSchema, schema);
      assert.equal(capture.params.approvalPolicy, "never");
      assert.deepEqual(capture.params.environments, []);
      assert.deepEqual(capture.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
    }
    assert.equal(backgroundCharges, 0);
    const internals = summarizer as unknown as { lunaRunners: Map<string, unknown> };
    assert.equal(internals.lunaRunners.size, 0);
    const startup = new AbortController();
    const starting = summarizer.runDecisionJsonTask({ workspaceId: "ws", prompt: "stall-before-ack", outputSchema: schema, signal: startup.signal });
    await waitFor(() => readFileSync(requests, "utf8").includes('"stall-before-ack"'));
    startup.abort();
    await assert.rejects(starting, /stopped/);
    // Node's test runner also fails this test on any unhandledRejection from
    // the completion promise while the turn/start RPC was pending.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(internals.lunaRunners.size, 0);
    const aborted = AbortSignal.abort();
    await assert.rejects(summarizer.runDecisionJsonTask({ workspaceId: "ws", prompt: "never start", signal: aborted }), /abort/i);
    assert.equal(readFileSync(requests, "utf8").trim().split("\n").length, 3);
  } finally {
    summarizer.close();
    if (oldPath === undefined) delete process.env.CODEX_PATH; else process.env.CODEX_PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Decision helper model settings choose Claude for long input and preserve cancellation scope", async () => {
  const store = { getWorkspace: async () => ({ codexHome: "workspace-home" }) } as unknown as SessionStore;
  const summarizer = new SessionSummarizer(store, config, undefined, undefined,
    () => ({ summarizerModel: "gpt-6-luna", summarizerLongModel: "claude-haiku-5-5" }));
  const controller = new AbortController();
  const internals = summarizer as unknown as { runSummarizerClaude: (...args: unknown[]) => Promise<unknown> };
  let calls = 0;
  internals.runSummarizerClaude = async (_prompt, model, scope, control) => {
    calls++;
    assert.equal(model, "claude-haiku-5-5");
    assert.deepEqual(scope, { workspaceId: "ws" });
    assert.equal((control as { signal: AbortSignal }).signal, controller.signal);
    return { responseText: "{}", usage: null };
  };
  try {
    const result = await summarizer.runDecisionJsonTask({ workspaceId: "ws", prompt: "x".repeat(100_000), signal: controller.signal });
    assert.equal(result.model, "claude-haiku-5-5");
    assert.equal(calls, 1);
  } finally { summarizer.close(); }
});

async function waitFor(check: () => boolean) {
  const end = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Fake Codex did not start");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
