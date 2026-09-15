import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { buildIsolatedLunaAppServerArgs, IsolatedLunaRunner } from "./isolatedLunaRunner.js";

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

test("omitting timeoutMs does not schedule a runner cancellation timer", async () => {
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
  const runner = fixture.runner({ name: "no-timeout-test", baseInstructions: "Return done.", timeoutMs: undefined });
  const originalSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((handler: (...args: any[]) => void, timeout?: number, ...args: any[]) => {
    delays.push(Number(timeout));
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof setTimeout;
  try {
    assert.equal((await runner.run("test")).responseText, "done");
    assert.deepEqual(delays, []);
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
    runner: (options: Pick<ConstructorParameters<typeof IsolatedLunaRunner>[0], "name" | "baseInstructions" | "freshThreadPerRun" | "maxRunsPerProcess" | "workspaceCwd" | "allowWorkspaceRead" | "timeoutMs">) => new IsolatedLunaRunner({
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
