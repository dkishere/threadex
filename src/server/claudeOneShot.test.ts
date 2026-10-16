import assert from "node:assert/strict";
import test from "node:test";
import { runClaudeOneShot as runQuery, type ClaudeOneShotOptions } from "./claudeOneShot";
import { existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { inspectorCommand } from "./sessionInspectorCommand";
import { githubReadArgv } from "./githubReadCommand";
import type { SdkModule } from "./claudeRunner";

type CanUseTool = (name: string, input: Record<string, unknown>) => Promise<any>;

for (const stalls of [false, true]) {
  test(`idle timeout ${stalls ? "aborts after output stops" : "allows output beyond the total timeout"}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const sdk: SdkModule = { query: ({ options }) => {
      assert.equal(options.includePartialMessages, true);
      const controller = options.abortController as AbortController;
      async function* messages() {
        for (let i = 0; i < 4; i++) {
          t.mock.timers.tick(60);
          assert.equal(controller.signal.aborted, false);
          yield { type: "stream_event", event: { type: "content_block_delta", index: 0,
            delta: { type: "text_delta", text: "working" } } };
        }
        if (stalls) {
          t.mock.timers.tick(101);
          assert.equal(controller.signal.aborted, true);
          throw new Error("SDK aborted");
        }
        yield { type: "result", subtype: "success", is_error: false, result: "Done" };
      }
      return Object.assign(messages(), { close() {} });
    } };
    const result = runClaudeOneShot({ model: "claude-sonnet-5-5", prompt: "Discuss", systemPrompt: "Discuss",
      timeoutMs: 100, idleTimeout: true }, sdk);
    if (stalls) await assert.rejects(result, /100ms without output/);
    else assert.equal((await result).responseText, "Done");
  });
}

function runClaudeOneShot(options: ClaudeOneShotOptions, sdk: SdkModule) {
  return runQuery({ ...options, ...(options.persistSession ? { sessionScope: options.sessionScope ?? "test-workspace:test-session" } : {}) }, sdk,
    { read: () => null, write: () => {} });
}

test("an external abort cancels an isolated Claude request", async () => {
  const controller = new AbortController();
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const sdk: SdkModule = { query: ({ options }) => {
    const cancellation = options.abortController as AbortController;
    async function* messages() {
      began();
      await new Promise((_resolve, reject) => cancellation.signal.addEventListener("abort", () => reject(new Error("SDK aborted")), { once: true }));
    }
    return Object.assign(messages(), { close() {} });
  } };
  const result = runClaudeOneShot({ model: "claude-sonnet-5-5", prompt: "Discuss", systemPrompt: "Discussion only", signal: controller.signal }, sdk);
  await started; controller.abort();
  await assert.rejects(result, /cancelled/);
});

function fakeSdk(script: (canUseTool: CanUseTool) => AsyncGenerator<unknown>, seen: { options?: Record<string, unknown>; prompts: any[] }): SdkModule {
  return {
    query: ({ prompt, options }) => {
      seen.options = options;
      async function* run() {
        for await (const user of prompt) {
          seen.prompts.push(user);
          yield* script(options.canUseTool as CanUseTool);
        }
      }
      return Object.assign(run(), { close() {} });
    }
  };
}

test("runs an isolated Claude request and maps usage like Codex usage", async () => {
  const seen: { options?: Record<string, unknown>; prompts: any[] } = { prompts: [] };
  const events: any[] = [];
  const result = await runClaudeOneShot({
    model: "claude-haiku-5-5",
    prompt: "Summarize this",
    systemPrompt: "You are a summarizer.",
    reasoningEffort: "high",
    onEvent: event => events.push(event),
    configDir: "/accounts/claude-a"
  }, fakeSdk(async function* () {
    yield { type: "system", subtype: "init", session_id: "s1", model: "claude-haiku-5-5" };
    yield { type: "tool_progress", tool_name: "Read", elapsed_time_seconds: 1 };
    yield { type: "result", subtype: "success", is_error: false, result: "{\"title\":\"Fix login\"}",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 } };
  }, seen));

  assert.equal(result.responseText, "{\"title\":\"Fix login\"}");
  assert.deepEqual(result.usage, { inputTokens: 150, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 0, totalTokens: 170 });
  assert.equal(seen.prompts[0].message.content[0].text, "Summarize this");
  const options = seen.options!;
  assert.equal(options.model, "claude-haiku-5-5");
  assert.equal(options.systemPrompt, "You are a summarizer.");
  assert.equal(options.effort, "high", "Haiku 5.5 receives the selected effort");
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.persistSession, false);
  assert.equal(options.mcpServers, undefined);
  const executionHome = (options.env as Record<string, string>).CLAUDE_CONFIG_DIR;
  assert.notEqual(executionHome, "/accounts/claude-a");
  assert.equal(existsSync(executionHome), false, "ephemeral helper state is removed");
  assert.deepEqual(events.map(event => event.type), ["system", "tool_progress", "result"]);
  assert.equal(options.includePartialMessages, true, "capture activity during long streamed responses");
});

test("a scratch directory sandboxes Bash and confines file writes", async () => {
  const seen: { options?: Record<string, unknown>; prompts: any[] } = { prompts: [] };
  const decisions: any[] = [];
  await runClaudeOneShot({
    model: "claude-sonnet-5-5", prompt: "Verify", systemPrompt: "Actor", scratchDir: "/private/tmp/scratch",
    builtinTools: ["Bash", "Write"], allowedTools: ["Bash", "Write"]
  }, fakeSdk(async function* (canUseTool) {
    decisions.push(await canUseTool("Write", { file_path: "check.py", content: "" }));
    decisions.push(await canUseTool("Write", { file_path: "/private/tmp/scratch/../repo/app.ts", content: "" }));
    decisions.push(await canUseTool("Bash", { command: "python3 check.py" }));
    yield { type: "result", subtype: "success", is_error: false, result: "Verified", usage: { input_tokens: 1, output_tokens: 1 } };
  }, seen));
  assert.equal(seen.options!.cwd, "/private/tmp/scratch");
  assert.deepEqual(seen.options!.sandbox, { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true });
  assert.deepEqual(decisions.map(decision => decision.behavior), ["allow", "deny", "allow"]);
  assert.equal(seen.options!.allowedTools, undefined, "bare allow rules would bypass the path check");
});

test("CLI-only helpers permit bounded history reads and deny arbitrary shell or mutations", async () => {
  const seen: { options?: Record<string, unknown>; prompts: any[] } = { prompts: [] };
  const decisions: string[] = [];
  await runClaudeOneShot({ model: "claude-sonnet-5-5", prompt: "Inspect", systemPrompt: "Read only",
    inspectorCli: { env: { RUNNER_SERVER_URL: "http://127.0.0.1:8787", THREADEX_TODO_AGENT_ROLE: "turn_grill" }, approvedCommands: ["get_session"], maxCalls: 2 }
  }, fakeSdk(async function* (canUseTool) {
    for (const command of [
      `${inspectorCommand} help get_session`,
      `${inspectorCommand} get_session '{}'`,
      `${inspectorCommand} get_session '{}'`,
      `${inspectorCommand} get_session '{}'`,
      `${inspectorCommand} prompt_session '{}'`,
      `${inspectorCommand} get_session '{}'; touch /tmp/unwanted`,
      "touch /tmp/unwanted"
    ]) decisions.push((await canUseTool("Bash", { command, dangerouslyDisableSandbox: true })).behavior);
    yield { type: "result", subtype: "success", is_error: false, result: "Read", usage: {} };
  }, seen));
  assert.deepEqual(decisions, ["allow", "allow", "allow", "deny", "deny", "deny", "deny"]);
  assert.deepEqual(seen.options!.tools, ["Bash"]);
  assert.equal(seen.options!.mcpServers, undefined);
  assert.equal((seen.options!.env as Record<string, string>).THREADEX_TODO_AGENT_ROLE, "turn_grill");
});

test("only allowed tools may run", async () => {
  const seen: { options?: Record<string, unknown>; prompts: any[] } = { prompts: [] };
  const decisions: any[] = [];
  await runClaudeOneShot({
    model: "claude-sonnet-5-5",
    prompt: "Grill",
    systemPrompt: "Griller",
    builtinTools: ["Read"],
    allowedTools: ["Read", "mcp__session_inspector__get_session"],
    mcpServers: { session_inspector: { type: "stdio", command: "node", args: ["mcp.js"], env: {} } }
  }, fakeSdk(async function* (canUseTool) {
    decisions.push(await canUseTool("mcp__session_inspector__get_session", { turnId: "t1" }));
    decisions.push(await canUseTool("Bash", { command: "rm -rf /" }));
    yield { type: "result", subtype: "success", is_error: false, result: "[]" };
  }, seen));

  assert.deepEqual(decisions.map((decision) => decision.behavior), ["allow", "deny"]);
  assert.deepEqual(decisions[0].updatedInput, { turnId: "t1" });
  assert.deepEqual(seen.options!.tools, ["Read"]);
  assert.equal(seen.options!.strictMcpConfig, true);
});

test("Claude actors receive host CLI configs and approve standalone browser and GitHub reads", async () => {
  const seen: { options?: Record<string, unknown>; prompts: any[] } = { prompts: [] };
  const decisions: string[] = [];
  const bridge = { executable: "/trusted/bin/browser-bridge", dataDir: "/host/browser-config" };
  const github = { executable: "/trusted/bin/gh", configDir: "/host/gh-config", hostHome: "/host" };
  await runClaudeOneShot({ model: "claude-sonnet-5-5", prompt: "Read the PR comments", systemPrompt: "Discussion only",
    scratchDir: "/private/tmp/scratch", builtinTools: ["Bash", "Write"], allowedTools: ["Bash", "Write"], browserBridgeCli: bridge, githubReadCli: github
  }, fakeSdk(async function* (canUseTool) {
    for (const command of [
      `${bridge.executable} tabs`, `${bridge.executable} evaluate 42 'document.body.innerText'`,
      `${bridge.executable} tabs; curl https://example.com`, "curl https://example.com", "gh pr view 14",
      `${bridge.executable} screenshot 42 /host/project/overwrite.png`,
      [...githubReadArgv(github), "pr", "view", "14", "--repo", "owner/repo", "--comments"].map(value => `'${value}'`).join(" "),
      `${github.executable} api repos/owner/repo/pulls/14/comments --paginate`,
      `${github.executable} api repos/owner/repo/pulls/14/comments -X POST`
    ]) decisions.push((await canUseTool("Bash", { command, dangerouslyDisableSandbox: true })).behavior);
    decisions.push((await canUseTool("Write", { file_path: "/host/project/app.ts", content: "" })).behavior);
    yield { type: "result", subtype: "success", is_error: false, result: "Read", usage: {} };
  }, seen));
  assert.deepEqual(decisions, ["allow", "allow", "deny", "deny", "deny", "deny", "allow", "allow", "deny", "deny"]);
  assert.equal((seen.options!.env as Record<string, string>).LOCAL_BROWSER_BRIDGE_DATA_DIR, bridge.dataDir);
  assert.equal((seen.options!.env as Record<string, string>).GH_CONFIG_DIR, github.configDir);
  assert.match(String(seen.options!.systemPrompt), /Browser Bridge CLI/);
  assert.deepEqual(seen.options!.sandbox, { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: true, autoAllowBashIfSandboxed: false });
  assert.equal(seen.options!.allowedTools, undefined);
});

test("a persisted request reports its Claude session and can be resumed", async () => {
  const seen: { options?: Record<string, unknown>; prompts: any[] } = { prompts: [] };
  const result = await runClaudeOneShot({ model: "claude-haiku-5-5", prompt: "Follow up", systemPrompt: "Side chat",
    persistSession: true, resume: "claude-earlier" }, fakeSdk(async function* () {
    yield { type: "system", subtype: "init", session_id: "claude-earlier", model: "claude-haiku-5-5" };
    yield { type: "result", subtype: "success", is_error: false, result: "Answer", session_id: "claude-earlier" };
  }, seen));
  assert.equal(result.sessionId, "claude-earlier");
  assert.equal(seen.options!.persistSession, true);
  assert.equal(seen.options!.resume, "claude-earlier");
});

test("a rejected rate limit fails with a usage-limit message", async () => {
  await assert.rejects(runClaudeOneShot({ model: "claude-haiku-5-5", prompt: "x", systemPrompt: "y" }, fakeSdk(async function* () {
    yield { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: "2026-10-13T15:00:00Z" } };
    yield { type: "assistant", error: "rate_limit", message: { id: "m", content: [{ type: "text", text: "Limit reached" }] } };
    yield { type: "result", subtype: "error_during_execution", is_error: true };
  }, { prompts: [] })), /Claude plan limit reached/);
});

test("persisted helpers cannot share native state across workspace scopes", async () => {
  const homes: string[] = [];
  const scope = randomUUID();
  try {
    for (const workspace of ["a", "b", "a"]) {
      const seen: { options?: Record<string, any>; prompts: any[] } = { prompts: [] };
      await runClaudeOneShot({ model: "claude-haiku-5-5", prompt: "local fixture", systemPrompt: "helper",
        configDir: "/fixture-account", persistSession: true, sessionScope: `${workspace}:${scope}` },
      fakeSdk(async function* () { yield { type: "result", subtype: "success", result: "ok" }; }, seen));
      homes.push(seen.options!.env.CLAUDE_CONFIG_DIR);
    }
    assert.notEqual(homes[0], homes[1]);
    assert.equal(homes[0], homes[2]);
  } finally { for (const home of new Set(homes)) rmSync(home, { recursive: true, force: true }); }
});
