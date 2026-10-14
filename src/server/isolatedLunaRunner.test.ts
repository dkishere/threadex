import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { buildIsolatedLunaAppServerArgs, IsolatedLunaRunner } from "./isolatedLunaRunner.js";
import { inspectorCommand } from "./sessionInspectorCommand";

test("isolated Luna runner starts a read-only app-server with no approval path", () => {
  assert.deepEqual(buildIsolatedLunaAppServerArgs(), [
    "app-server",
    "-c", 'approval_policy="never"',
    "-c", 'sandbox_mode="read-only"',
    "-c", "features.memories=false",
    "-c", "features.shell_tool=false",
    "-c", "features.unified_exec=false",
    "-c", "features.apps=false",
    "-c", "features.multi_agent=false",
    "-c", "tools.web_search=false",
    "-c", "tools.view_image=false"
  ]);
});

test("scratch-write jobs may run shell commands in a writable sandbox", () => {
  const args = buildIsolatedLunaAppServerArgs([], false, true);
  assert.ok(args.includes('sandbox_mode="workspace-write"'));
  assert.ok(!args.includes("features.shell_tool=false"));
  assert.ok(args.includes("tools.web_search=false"), "web search stays off unless the caller enables it");
  assert.ok(!args.includes("sandbox_workspace_write.network_access=true"), "network stays off unless the caller enables it");
  assert.ok(buildIsolatedLunaAppServerArgs([], false, true, true).includes("sandbox_workspace_write.network_access=true"));
});

test("scratch jobs expose a shell but grant writes only to their private directory", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "isolated-luna-scratch-test-"));
  const capturePath = resolve(root, "requests.json");
  const fixture = createFakeCodexFixture("isolated-luna-scratch-fixture-", `
const requests = [];
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") {
    requests.push(request);
    send({ id: request.id, result: { thread: { id: "thread-1" } } });
  }
  if (request.method === "turn/start") {
    requests.push(request);
    writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(requests));
    send({ id: request.id, result: { turn: { id: "turn-1" } } });
    send({ method: "item/completed", params: { threadId: "thread-1", item: { id: "answer", type: "agentMessage", text: "verified" } } });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  }
});`);
  const runner = fixture.runner({ name: "scratch-test", baseInstructions: "Verify in scratch.", scratchWrite: true });
  let scratch: string | undefined;
  try {
    assert.equal((await runner.run("verify")).responseText, "verified");
    const [thread, turn] = JSON.parse(readFileSync(capturePath, "utf8"));
    scratch = thread.params.cwd;
    assert.ok(scratch && existsSync(scratch));
    assert.equal(thread.params.environments, undefined, "an empty environment list removes shell access");
    assert.equal(turn.params.environments, undefined);
    assert.deepEqual(thread.params.runtimeWorkspaceRoots, [scratch]);
    assert.deepEqual(turn.params.sandboxPolicy, {
      type: "workspaceWrite", writableRoots: [scratch], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true
    });
  } finally {
    runner.stop();
    fixture.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(existsSync(scratch!), false, "verification files are removed with the runner");
});

test("isolated Codex CLI approvals keep network closed and enforce the cross-process read budget", async () => {
  const fixture = createFakeCodexFixture("isolated-cli-approval-", `
const decisions = [];
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread-1" } } });
  if (request.method === "turn/start") {
    if (request.params.sandboxPolicy.networkAccess !== false) throw new Error("Network policy was widened");
    if (request.params.approvalPolicy !== "on-request") throw new Error("CLI approvals unavailable");
    send({ id: request.id, result: { turn: { id: "turn-1" } } });
    for (let id = 90; id < 94; id++) send({ id, method: "item/commandExecution/requestApproval", params: {
      command: id === 93 ? "touch /tmp/unwanted" : ${JSON.stringify(`${inspectorCommand} get_session '{}'`)}
    } });
  }
  if (request.id >= 90 && request.id < 94 && request.result) {
    decisions.push(request.result.decision);
    if (decisions.length === 4) {
      send({ method: "item/completed", params: { threadId: "thread-1", item: { id: "answer", type: "agentMessage", text: JSON.stringify(decisions) } } });
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    }
  }
});`);
  const runner = fixture.runner({ name: "cli-approval", baseInstructions: "Read saved history",
    inspectorCli: { env: { THREADEX_TODO_AGENT_ROLE: "turn_grill" }, approvedCommands: ["get_session"], maxCalls: 2 } });
  try {
    assert.deepEqual(JSON.parse((await runner.run("inspect")).responseText), ["accept", "accept", "decline", "decline"]);
  } finally { runner.stop(); fixture.cleanup(); }
});

test("isolated runner appends only explicitly supplied app-server config", () => {
  assert.deepEqual(buildIsolatedLunaAppServerArgs(["-c", "mcp_servers.session_inspector.command=\"node\""]).slice(-2), [
    "-c",
    "mcp_servers.session_inspector.command=\"node\""
  ]);
});

test("isolated runner exposes project files only for an explicit read-only workspace job", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "isolated-luna-workspace-read-test-"));
  const project = resolve(root, "project");
  const capturePath = resolve(root, "thread-start.json");
  const fixture = createFakeCodexFixture("isolated-luna-workspace-read-fixture-", `
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") {
    writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ params: request.params, argv: process.argv }));
    send({ id: request.id, result: { thread: { id: "thread-1" } } });
  }
  if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "turn-1" } } });
    send({ method: "item/completed", params: { threadId: "thread-1", item: { id: "answer", type: "agentMessage", text: "done" } } });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  }
});`);
  mkdirSync(project, { recursive: true });
  writeFileSync(resolve(project, ".keep"), "", { encoding: "utf8", flag: "w" });
  const runner = fixture.runner({
    name: "workspace-read-test",
    baseInstructions: "Read source only.",
    workspaceCwd: project,
    allowWorkspaceRead: true
  });
  try {
    assert.equal((await runner.run("review")).responseText, "done");
    const captured = JSON.parse(readFileSync(capturePath, "utf8"));
    assert.equal(captured.params.cwd, project);
    assert.deepEqual(captured.params.runtimeWorkspaceRoots, [project]);
    assert.equal(captured.argv.includes("features.shell_tool=false"), false);
    assert.equal(captured.argv.includes("features.unified_exec=false"), false);
  } finally {
    runner.stop();
    fixture.cleanup();
    assert.equal(existsSync(project), true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("omitting timeoutMs records inbound activity without scheduling a runner cancellation timer", async () => {
  const fixture = createFakeCodexFixture("isolated-luna-no-timeout-test-", `
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread-1" } } });
  if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "turn-1" } } });
    send({ method: "item/completed", params: { threadId: "thread-1", item: { id: "answer", type: "agentMessage", text: "done" } } });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  }
});`);
  const events: any[] = [];
  const runner = fixture.runner({ name: "no-timeout-test", baseInstructions: "Return done.", timeoutMs: undefined, onEvent: event => events.push(event) });
  const originalSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((handler: (...args: any[]) => void, timeout?: number, ...args: any[]) => {
    delays.push(Number(timeout));
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof setTimeout;
  try {
    assert.equal((await runner.run("test")).responseText, "done");
    assert.deepEqual(delays, []);
    assert.ok(events.some(event => event.method === "process.started" && typeof event.pid === "number"));
    assert.ok(events.some(event => event.method === "item/completed" && event.params.item.text === "done"));
    assert.ok(events.some(event => event.method === "turn/completed"));
    assert.ok(events.every(event => event.method !== "initialize" && event.method !== "thread/start"), "outbound config is not logged");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    runner.stop();
    fixture.cleanup();
  }
});

test("isolated Luna runner retains thread token usage for the completed turn", async () => {
  const fixture = createFakeCodexFixture("isolated-luna-usage-test-", `
let threadNumber = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") {
    threadNumber += 1;
    send({ id: request.id, result: { thread: { id: "thread-" + threadNumber } } });
  }
  if (request.method === "turn/start") {
    const threadId = request.params.threadId;
    send({ id: request.id, result: { turn: { id: "turn-1" } } });
    send({ method: "thread/tokenUsage/updated", params: {
      threadId,
      tokenUsage: {
        last: { inputTokens: 12, cachedInputTokens: 2, outputTokens: 3, totalTokens: 15 },
        total: { inputTokens: 42, cachedInputTokens: 7, outputTokens: 8, totalTokens: 50 }
      }
    } });
    send({ method: "item/completed", params: {
      threadId,
      item: { id: "answer-1", type: "agentMessage", text: "{\\"ok\\":true}" }
    } });
    send({ method: "turn/completed", params: {
      threadId,
      turn: { id: "turn-1", status: "completed" }
    } });
  }
});`);
  const runner = fixture.runner({ name: "usage-test", baseInstructions: "Return JSON." });
  try {
    const result = await runner.run("test");
    assert.equal(result.responseText, '{"ok":true}');
    assert.deepEqual(result.usage, {
      last: { inputTokens: 12, cachedInputTokens: 2, outputTokens: 3, totalTokens: 15 },
      total: { inputTokens: 42, cachedInputTokens: 7, outputTokens: 8, totalTokens: 50 }
    });
  } finally {
    runner.stop();
    fixture.cleanup();
  }
});

test("isolated Luna runner creates a fresh thread for every stateless run", async () => {
  const fixture = createFakeCodexFixture("isolated-luna-fresh-thread-test-", `
let threadNumber = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") {
    threadNumber += 1;
    send({ id: request.id, result: { thread: { id: "thread-" + threadNumber } } });
  }
  if (request.method === "turn/start") {
    const threadId = request.params.threadId;
    send({ id: request.id, result: { turn: { id: "turn-" + threadNumber } } });
    send({ method: "item/completed", params: {
      threadId,
      item: { id: "answer-" + threadNumber, type: "agentMessage", text: threadId }
    } });
    send({ method: "turn/completed", params: {
      threadId,
      turn: { id: "turn-" + threadNumber, status: "completed" }
    } });
  }
});`);
  const runner = fixture.runner({
    name: "fresh-thread-test",
    baseInstructions: "Return the thread id.",
    freshThreadPerRun: true
  });
  try {
    assert.equal((await runner.run("first")).responseText, "thread-1");
    assert.equal((await runner.run("second")).responseText, "thread-2");
  } finally {
    runner.stop();
    fixture.cleanup();
  }
});

test("isolated Luna runner periodically removes its temporary Codex home", async () => {
  const fixture = createFakeCodexFixture("isolated-luna-recycle-test-", `
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread-1" } } });
  if (request.method === "turn/start") {
    const threadId = request.params.threadId;
    send({ id: request.id, result: { turn: { id: "turn-1" } } });
    send({ method: "item/completed", params: {
      threadId,
      item: { id: "answer-1", type: "agentMessage", text: "done" }
    } });
    send({ method: "turn/completed", params: {
      threadId,
      turn: { id: "turn-1", status: "completed" }
    } });
  }
});`);
  const runnerName = `recycle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tempPrefix = `session-${runnerName}-`;
  const runner = fixture.runner({
    name: runnerName,
    baseInstructions: "Return done.",
    freshThreadPerRun: true,
    maxRunsPerProcess: 1
  });
  try {
    assert.equal((await runner.run("test")).responseText, "done");
    assert.deepEqual(readdirSync(tmpdir()).filter((name) => name.startsWith(tempPrefix)), []);
  } finally {
    runner.stop();
    fixture.cleanup();
  }
});

for (const scenario of ["recover", "persistent", "other"] as const) {
  test(`isolated runner discovery auth recovery: ${scenario}`, async () => {
    const fixture = createFakeCodexFixture("isolated-auth-recovery-", `
import { existsSync, readFileSync } from "node:fs";
const marker = new URL("./attempts.json", import.meta.url);
const attempts = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : [];
attempts.push(process.env.CODEX_HOME);
writeFileSync(marker, JSON.stringify(attempts));
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") {
    if (${JSON.stringify(scenario)} !== "recover" || attempts.length === 1) {
      writeFileSync(new URL("./auth.json", import.meta.url), JSON.stringify({ tokens: { account_id: "refreshed-account" } }));
      send({ id: request.id, error: { message: ${JSON.stringify(scenario === "other" ? "unrelated failure" : "workspace routing discovery unauthorized (401)")} } });
    } else send({ id: request.id, result: { thread: { id: "recovered" } } });
  }
  if (request.method === "turn/start") {
    send({ id: request.id, result: {} });
    send({ method: "item/completed", params: { threadId: "recovered", item: { type: "agentMessage", text: "recovered" } } });
    send({ method: "turn/completed", params: { threadId: "recovered", turn: { status: "completed" } } });
  }
});`);
    const runner = fixture.runner({ name: "auth-recovery", baseInstructions: "Reply briefly." });
    try {
      if (scenario === "recover") {
        const result = await runner.run("test");
        assert.equal(result.responseText, "recovered");
        assert.equal(result.authIdentity.externalAccountId, "refreshed-account");
      }
      else await assert.rejects(runner.run("test"), scenario === "other" ? /unrelated failure/ : /unauthorized \(401\)/);
      const attempts: string[] = JSON.parse(readFileSync(resolve(fixture.root, "attempts.json"), "utf8"));
      assert.equal(attempts.length, scenario === "other" ? 1 : 2);
      assert.equal(new Set(attempts).size, attempts.length);
      if (scenario !== "other") assert.equal(existsSync(attempts[0]), false);
      if (scenario === "persistent") assert.equal(existsSync(attempts[1]), false);
    } finally {
      runner.stop();
      fixture.cleanup();
    }
  });
}

function createFakeCodexFixture(prefix: string, body: string) {
  const root = mkdtempSync(resolve(tmpdir(), prefix));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const previousCodexPath = process.env.CODEX_PATH;
  writeFileSync(resolve(root, "auth.json"), "{}", "utf8");
  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
${body}
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);
  process.env.CODEX_PATH = fakeCodexPath;
  return {
    root,
    runner: (options: Pick<ConstructorParameters<typeof IsolatedLunaRunner>[0], "name" | "baseInstructions" | "freshThreadPerRun" | "maxRunsPerProcess" | "workspaceCwd" | "allowWorkspaceRead" | "scratchWrite" | "timeoutMs" | "onEvent" | "inspectorCli">) => new IsolatedLunaRunner({
      model: "gpt-5.6-luna",
      reasoningEffort: "none",
      timeoutMs: 2_000,
      sourceHomeCandidates: [root],
      ...options
    }),
    cleanup: () => {
      if (previousCodexPath === undefined) delete process.env.CODEX_PATH;
      else process.env.CODEX_PATH = previousCodexPath;
      rmSync(root, { recursive: true, force: true });
    }
  };
}
