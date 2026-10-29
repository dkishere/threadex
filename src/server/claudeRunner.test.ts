import assert from "node:assert/strict";
import test from "node:test";
import { USER_INPUT_METHOD } from "../userInputRequest";
import { managedModeTurnInstructions } from "../managedMode";
import { inspectorCommand } from "./sessionInspectorCommand";
import { withProviderHandoff } from "./sessionProviderThreads";
import { REPLY_LANGUAGE_INSTRUCTIONS } from "./replyLanguage";
import {
  buildClaudeUserMessage,
  claudeSystemPromptAppend,
  claudeEffort,
  claudeEnvironment,
  claudePermissionFallback,
  claudePermissions,
  runClaudeTurn,
  type ClaudeRunnerContext,
  type ClaudeSteerCommand,
  type SdkModule
} from "./claudeRunner";

type Emitted = { event: string; data: any };
type CanUseTool = (name: string, input: Record<string, unknown>, options: Record<string, unknown>) => Promise<any>;
type Script = (user: any, turn: number, canUseTool: CanUseTool) => AsyncGenerator<unknown>;

function fakeSdk(script: Script, seen: { options?: Record<string, unknown>; prompts: any[] }): SdkModule {
  return {
    query: ({ prompt, options }) => {
      seen.options = options;
      const canUseTool = options.canUseTool as CanUseTool;
      async function* run() {
        let turn = 0;
        for await (const user of prompt) {
          seen.prompts.push(user);
          yield* script(user, turn++, canUseTool);
        }
      }
      return Object.assign(run(), { close() {} });
    }
  };
}

function context(overrides: Partial<ClaudeRunnerContext> = {}) {
  const emitted: Emitted[] = [];
  const approvals: any[] = [];
  const steerResults: any[] = [];
  const ctx: ClaudeRunnerContext = {
    sessionId: "thx-session",
    turnId: "turn-1",
    threadId: null,
    model: "claude-opus-5-5",
    reasoningEffort: "high",
    cwd: "/repo",
    input: [{ type: "text", text: "Fix the bug" }],
    appendSystemPrompt: "Threadex rules",
    permissionMode: "default",
    autoApproveAll: false,
    readOnly: false,
    mcpServers: {},
    allowedTools: [],
    extraEnv: {},
    emitEvent: async (event, data) => { emitted.push({ event, data }); return undefined; },
    appendInternalLog: () => undefined,
    requestApproval: async (input) => { approvals.push(input); return "accept"; },
    pendingSteerCommands: () => [],
    writeSteerResult: (result) => { steerResults.push(result); },
    ...overrides
  };
  return { ctx, emitted, approvals, steerResults };
}

const init = { type: "system", subtype: "init", session_id: "claude-123", model: "claude-opus-5-5" };
const success = (text: string) => ({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 20 } });

test("Fable 5.1 reaches the Claude SDK unchanged for new and resumed turns", async () => {
  for (const threadId of [null, "claude:claude-123"]) {
    const seen: { options?: Record<string, unknown>; prompts: any[] } = { prompts: [] };
    const { ctx, emitted } = context({ model: "claude-fable-5-1", reasoningEffort: "max", threadId });
    await runClaudeTurn(ctx, fakeSdk(async function* () {
      yield { ...init, model: "claude-fable-5-1" };
      yield success("Done");
    }, seen));
    assert.equal(seen.options?.model, "claude-fable-5-1");
    assert.equal(seen.options?.effort, "max");
    assert.equal(seen.options?.resume, threadId ? "claude-123" : undefined);
    assert.equal(emitted.find(entry => entry.event === "result")?.data.reply, "Done");
    assert.equal(emitted.at(-1)?.event, "done");
  }
});

test("Claude resume receives current Managed state after an enabled turn", async () => {
  for (const enabled of [true, false]) {
    const seen: { options?: any; prompts: any[] } = { prompts: [] };
    const { ctx } = context({
      threadId: enabled ? null : "claude:claude-123",
      appendSystemPrompt: managedModeTurnInstructions(enabled, enabled ? "on" : "off") ?? "base prompt"
    });
    await runClaudeTurn(ctx, fakeSdk(async function* () {
      yield init;
      yield success("Done");
    }, seen));
    if (enabled) assert.match(seen.options.systemPrompt.append, /Managed mode: ON/);
    else {
      assert.equal(seen.options.resume, "claude-123");
      assert.doesNotMatch(seen.options.systemPrompt.append, /Managed mode/);
    }
  }
});

test("Claude native child startup gets a snapshot even without Managed mode", async () => {
  const seen: { options?: any; prompts: any[] } = { prompts: [] };
  const { ctx } = context();
  await runClaudeTurn(ctx, fakeSdk(async function* () {
    yield init;
    const hook = seen.options.hooks.SubagentStart[0].hooks[0];
    const result = await hook({ cwd: process.cwd() });
    assert.equal(result.hookSpecificOutput.hookEventName, "SubagentStart");
    assert.ok(result.hookSpecificOutput.additionalContext.includes(`pwd: ${process.cwd()}`));
    assert.match(result.hookSpecificOutput.additionalContext, /Do not repeat/);
    assert.ok(seen.options.hooks.PreToolUse, "existing approval hook is preserved");
    yield success("Done");
  }, seen));
});

test("Claude runner publishes native Agent and Task cards with delegated prompts and requested models", async () => {
  const { ctx, emitted } = context();
  await runClaudeTurn(ctx, fakeSdk(async function* () {
    yield init;
    for (const name of ["Agent", "Task"]) {
      const id = `delegate-${name}`;
      yield { type: "assistant", message: { id: `message-${name}`, content: [{
        type: "tool_use", id, name,
        input: { description: "Inspect the implementation", prompt: `Full ${name} brief\nKeep the second line.`, model: "sonnet", subagent_type: "general-purpose" }
      }] } };
      yield { type: "assistant", parent_tool_use_id: id, message: { id: `child-${name}`, content: [{ type: "text", text: "Internal child progress" }] } };
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "Review completed" }] } };
    }
    yield success("Done");
  }, { prompts: [] }));
  for (const name of ["Agent", "Task"]) {
    const cards = emitted.filter(entry => entry.event === "item" && entry.data.itemType === "subagent" && entry.data.id === `delegate-${name}`);
    assert.ok(cards.some(entry => entry.data.eventType === "item.started"));
    const completed = cards.find(entry => entry.data.eventType === "item.completed");
    assert.ok(completed);
    assert.equal(completed.data.prompt, `Full ${name} brief\nKeep the second line.`);
    assert.equal(completed.data.model, "sonnet");
    assert.equal(completed.data.agents[0].message, "Review completed");
  }
  assert.ok(!emitted.some(entry => entry.event === "item" && entry.data.text === "Internal child progress"));
});

test("read-only Claude planners can invoke their CLI command but cannot escalate other shell work", async () => {
  const { ctx, approvals } = context({ readOnly: true, permissionMode: "plan", approvedInspectorCommands: ["todo_set_plan"] });
  const seen: { options?: Record<string, unknown>; prompts: any[] } = { prompts: [] };
  const decisions: string[] = [];
  await runClaudeTurn(ctx, fakeSdk(async function* (_user, _turn, canUseTool) {
    yield init;
    for (const command of [`${inspectorCommand} todo_set_plan '{}'`, `${inspectorCommand} prompt_session '{}'`, `${inspectorCommand} todo_set_plan '{}'; touch /repo/change`, "touch /repo/change"]) {
      decisions.push((await canUseTool("Bash", { command, dangerouslyDisableSandbox: true }, {})).behavior);
    }
    yield success("Planned");
  }, seen));
  assert.deepEqual(decisions, ["allow", "deny", "deny", "deny"]);
  assert.equal(approvals.length, 0);
  assert.equal(seen.options!.mcpServers, undefined);
});

test("effort and environment mapping", () => {
  assert.equal(claudeEffort("ultra", "claude-opus-5-5"), "max");
  assert.equal(claudeEffort("minimal", "claude-sonnet-5-5"), "low");
  assert.equal(claudeEffort("high", "claude-haiku-5-5"), "high");
  const accountEnv = claudeEnvironment({ CLAUDE_CODE_OAUTH_TOKEN: "global", THREADEX_CLAUDE_CONFIG_DIR: "/cfg" }, { CLAUDE_CONFIG_DIR: "/acct" });
  assert.equal(accountEnv.CLAUDE_CONFIG_DIR, "/acct");
  assert.equal(accountEnv.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  const env = claudeEnvironment({ ANTHROPIC_API_KEY: "sk", CLAUDECODE: "1", PATH: "/bin", THREADEX_CLAUDE_CONFIG_DIR: "/cfg" }, { THREADEX_TURN_ID: "t" });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, "/cfg");
  assert.equal(env.THREADEX_TURN_ID, "t");
  assert.equal(claudeEnvironment({ ANTHROPIC_API_KEY: "sk", THREADEX_CLAUDE_USE_API_KEY: "1" }, {}).ANTHROPIC_API_KEY, "sk");
});

test("approval policies map onto Claude permission modes", () => {
  for (const policy of ["granular", "never", "on-request", "untrusted", undefined]) {
    assert.deepEqual(claudePermissions({ policy, readOnly: true }), { permissionMode: "plan", autoApproveAll: false });
  }
  assert.deepEqual(claudePermissions({ policy: "granular", readOnly: false }), { permissionMode: "auto", autoApproveAll: false });
  assert.deepEqual(claudePermissions({ policy: "never", readOnly: false }), { permissionMode: "acceptEdits", autoApproveAll: true });
  assert.deepEqual(claudePermissions({ policy: "on-request", readOnly: false }), { permissionMode: "default", autoApproveAll: false });
  assert.deepEqual(claudePermissions({ policy: "untrusted", readOnly: false }), { permissionMode: "default", autoApproveAll: false });

  // Unavailable auto mode starts as "default"; any other reported mode is a settings choice to keep.
  assert.equal(claudePermissionFallback("auto", "default"), "acceptEdits");
  assert.equal(claudePermissionFallback("auto", "auto"), null);
  assert.equal(claudePermissionFallback("auto", "dontAsk"), null);
  assert.equal(claudePermissionFallback("auto", null), null);
  assert.equal(claudePermissionFallback("default", "default"), null);
});

test("default authentication retains the workspace home and explicit accounts discard global tokens", () => {
  const base = { THREADEX_CLAUDE_CONFIG_DIR: "/global", CLAUDE_CODE_OAUTH_TOKEN: "fixture", ANTHROPIC_AUTH_TOKEN: "fixture" };
  const defaults = claudeEnvironment(base, { CLAUDE_CONFIG_DIR: "/workspace", THREADEX_CLAUDE_DEFAULT_AUTH: "1" });
  assert.equal(defaults.CLAUDE_CONFIG_DIR, "/workspace");
  assert.equal(defaults.CLAUDE_CODE_OAUTH_TOKEN, "fixture");
  assert.equal(claudeEnvironment(base, { CLAUDE_CONFIG_DIR: "/workspace" }).ANTHROPIC_AUTH_TOKEN, undefined);
});

test("auto approvals cannot bypass the workspace through file tools or unsandboxed Bash", async () => {
  const seen: { options?: Record<string, any>; prompts: any[] } = { prompts: [] };
  await runClaudeTurn(context({ autoApproveAll: true, permissionMode: "acceptEdits" }).ctx,
    fakeSdk(async function* (_user, _turn, canUseTool) {
      yield init;
      assert.equal((await canUseTool("Write", { file_path: "/etc/forbidden", content: "" }, {})).behavior, "deny");
      assert.equal((await canUseTool("Bash", { command: "touch /etc/forbidden", dangerouslyDisableSandbox: true }, {})).behavior, "deny");
      assert.equal((await canUseTool("Write", { file_path: "/repo/ok", content: "" }, {})).behavior, "allow");
      // PreToolUse runs even when the SDK skips canUseTool for accepted edits.
      const hook = seen.options!.hooks.PreToolUse[0].hooks[0];
      assert.equal((await hook({ tool_name: "Write", tool_input: { file_path: "/etc/forbidden" } })).hookSpecificOutput.permissionDecision, "deny");
      yield success("ok");
    }, seen));
  assert.equal(seen.options!.sandbox.failIfUnavailable, true);
});

test("native split children run as fixed actor agents and every actor call carries its caller's own credential", async () => {
  const seen: { options?: Record<string, any>; prompts: any[] } = { prompts: [] };
  const credentials = { main: "a".repeat(64), toolNames: ["actor_read_memory"], children: { actor_ui_123456: { workItemId: "ui-work", capability: "b".repeat(64) } } };
  const agents = { actor_ui_123456: { description: "Domain actor UI", prompt: "You are domain actor UI", model: "claude-sonnet-5-5", effort: "high" } };
  const call = (input: object) => `${inspectorCommand} actor_read_memory '${JSON.stringify(input)}'`;
  const injected = (output: any) => JSON.parse(output.hookSpecificOutput.updatedInput.command.match(/actor_read_memory' '(.*)'$/)[1]);
  await runClaudeTurn(context({ actorCredentials: credentials, agents, approvedInspectorCommands: ["actor_read_memory"] }).ctx,
    fakeSdk(async function* () {
      yield init;
      const hook = seen.options!.hooks.PreToolUse[0].hooks[0];
      const main = await hook({ tool_name: "Bash", tool_input: { command: call({ field: "rolePrompt", _actorCredential: "forged" }) } });
      assert.equal(main.hookSpecificOutput.permissionDecision, "allow");
      assert.deepEqual(injected(main), { field: "rolePrompt", _actorCredential: "a".repeat(64) }, "a forged credential is replaced");
      const child = await hook({ tool_name: "Bash", agent_id: "agent-1", agent_type: "actor_ui_123456", tool_input: { command: call({ field: "rolePrompt" }) } });
      assert.deepEqual(injected(child), { field: "rolePrompt", _actorCredential: "b".repeat(64), _actorWorkItem: "ui-work" });
      const helper = await hook({ tool_name: "Bash", agent_id: "agent-2", agent_type: "general-purpose", tool_input: { command: call({ field: "rolePrompt" }) } });
      assert.deepEqual(injected(helper), { field: "rolePrompt", _actorCredential: "a".repeat(64) }, "non-actor helpers keep the session actor");
      const spawn = await hook({ tool_name: "Agent", tool_input: { subagent_type: "actor_ui_123456", prompt: "Build the form", description: "UI", model: "opus", effort: "max", isolation: "worktree", run_in_background: true, name: "ui" } });
      assert.deepEqual(spawn.hookSpecificOutput.updatedInput, { subagent_type: "actor_ui_123456", prompt: "Build the form", description: "UI", run_in_background: false });
      const rework = await hook({ tool_name: "SendMessage", tool_input: { to: "actor_ui_123456", message: "Fix the label" } });
      assert.equal(rework.hookSpecificOutput.permissionDecision, "deny");
      assert.match(rework.hookSpecificOutput.permissionDecisionReason, /start the same subagent_type again/);
      assert.deepEqual(await hook({ tool_name: "SendMessage", tool_input: { to: "helper", message: "hi" } }), {}, "messages to non-actor helpers are untouched");
      const nested = await hook({ tool_name: "Agent", agent_id: "agent-1", agent_type: "actor_ui_123456", tool_input: { subagent_type: "actor_ui_123456", prompt: "again" } });
      assert.equal(nested.hookSpecificOutput.permissionDecision, "deny");
      assert.deepEqual(await hook({ tool_name: "Bash", tool_input: { command: "ls" } }), {}, "ordinary tools are untouched");
      yield success("ok");
    }, seen));
  assert.deepEqual(seen.options!.agents, { actor_ui_123456: { description: "Domain actor UI", prompt: "You are domain actor UI", model: "claude-sonnet-5-5", effort: "high" } });
});

test("boundary escalation asks once for the exact action and respects a denial", async () => {
  const seen: { options?: Record<string, any>; prompts: any[] } = { prompts: [] };
  const calls: any[] = [];
  await runClaudeTurn(context({ requestApproval: async input => { calls.push(input); return calls.length === 1 ? "accept" : "decline"; } }).ctx,
    fakeSdk(async function* (_user, _turn, canUseTool) {
      yield init;
      const hook = seen.options!.hooks.PreToolUse[0].hooks[0];
      const args = { file_path: "/etc/approved-for-test", content: "fixture" };
      assert.equal((await hook({ tool_name: "Write", tool_input: args }, "one")).hookSpecificOutput.permissionDecision, "allow");
      assert.equal((await canUseTool("Write", args, { toolUseID: "one" })).behavior, "allow");
      assert.equal(calls.length, 1);
      assert.equal((await canUseTool("Write", { ...args, content: "different" }, { toolUseID: "one" })).behavior, "deny");
      assert.match(calls[0].params.reason, /outside the sandbox boundary/);
      yield success("ok");
    }, seen));
});

test("one session approval covers every later sandbox escape", async () => {
  const run = async (overrides: Partial<ClaudeRunnerContext>, decision: string) => {
    const calls: any[] = [];
    const decisions: string[] = [];
    await runClaudeTurn(context({ ...overrides, requestApproval: async input => { calls.push(input); return decision; } }).ctx,
      fakeSdk(async function* (_user, _turn, canUseTool) {
        yield init;
        for (const command of ["git init", "cat > /etc/x <<'EOF'\nx\nEOF", "node e2e.mjs"]) {
          decisions.push((await canUseTool("Bash", { command, dangerouslyDisableSandbox: true }, { toolUseID: command })).behavior);
        }
        yield success("ok");
      }, { prompts: [] }));
    return { decisions, asked: calls.map(call => call.params.command), flagged: calls.every(call => call.params.sandboxEscape === true) };
  };
  assert.deepEqual(await run({}, "acceptForSession"), { decisions: ["allow", "allow", "allow"], asked: ["git init"], flagged: true });
  // A grant from an earlier turn needs no card; a one-off approval keeps asking.
  assert.deepEqual(await run({ sandboxEscapesApproved: true }, "decline"), { decisions: ["allow", "allow", "allow"], asked: [], flagged: true });
  assert.deepEqual((await run({}, "accept")).asked.length, 3);
});

test("a downgraded auto mode switches to acceptEdits and logs the mismatch", async () => {
  async function run(reported: string, withSetter = true) {
    const modes: string[] = [];
    const logs: Array<{ event: string; data: any }> = [];
    const sdk: SdkModule = {
      query: () => Object.assign((async function* () {
        yield { ...init, permissionMode: reported };
        yield success("ok");
      })(), {
        close() {},
        ...(withSetter ? { setPermissionMode: async (mode: string) => { modes.push(mode); } } : {})
      })
    };
    const { ctx } = context({ permissionMode: "auto", appendInternalLog: (event, data) => { logs.push({ event, data }); } });
    await runClaudeTurn(ctx, sdk);
    return { modes, mismatch: logs.find((entry) => entry.event === "claude.permission_mode_mismatch")?.data };
  }

  const downgraded = await run("default");
  assert.deepEqual(downgraded.modes, ["acceptEdits"]);
  assert.deepEqual(downgraded.mismatch, { requested: "auto", reported: "default", fallback: "acceptEdits", applied: true });

  const honoured = await run("auto");
  assert.deepEqual(honoured.modes, []);
  assert.equal(honoured.mismatch, undefined);

  const restricted = await run("dontAsk");
  assert.deepEqual(restricted.modes, []);
  assert.deepEqual(restricted.mismatch, { requested: "auto", reported: "dontAsk", fallback: null, applied: false });

  const oldSdk = await run("default", false);
  assert.deepEqual(oldSdk.mismatch, { requested: "auto", reported: "default", fallback: "acceptEdits", applied: false });
});

test("user message carries text and skips empty parts", () => {
  const message = buildClaudeUserMessage([{ type: "text", text: "hi" }, { type: "text", text: "" }], "s");
  assert.deepEqual(message.message.content, [{ type: "text", text: "hi" }]);
  assert.equal(message.parent_tool_use_id, null);
});

test("a turn streams items, routes Bash approval and publishes the result", async () => {
  const seen = { prompts: [] as any[] } as { options?: Record<string, unknown>; prompts: any[] };
  const sdk = fakeSdk(async function* (_user, _turn, canUseTool) {
    yield init;
    yield { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "npm test" } }] } };
    const permission = await canUseTool("Bash", { command: "npm test" }, { toolUseID: "tu_1", suggestions: [] });
    assert.equal(permission.behavior, "allow");
    yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] } };
    yield { type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Fixed." }] } };
    yield success("Fixed.");
  }, seen);
  const { ctx, emitted, approvals } = context();
  await runClaudeTurn(ctx, sdk);

  assert.equal(seen.options?.model, "claude-opus-5-5");
  assert.equal(seen.options?.effort, "high");
  assert.equal(seen.options?.resume, undefined);
  assert.deepEqual(seen.options?.systemPrompt, { type: "preset", preset: "claude_code", append: `Threadex rules\n\n${REPLY_LANGUAGE_INSTRUCTIONS}` });
  assert.equal(approvals[0].method, "item/commandExecution/requestApproval");
  assert.equal(approvals[0].params.command, "npm test");
  assert.equal(approvals[0].params.cwd, "/repo");

  const session = emitted.find((entry) => entry.event === "session");
  assert.equal(session?.data.threadId, "claude:claude-123");
  assert.ok(emitted.some((entry) => entry.event === "item" && entry.data.itemType === "command_execution" && entry.data.status === "completed"));
  const result = emitted.find((entry) => entry.event === "result");
  assert.equal(result?.data.reply, "Fixed.");
  assert.equal(result?.data.threadId, "claude:claude-123");
  assert.equal(result?.data.tokenIn, 100);
  assert.equal(result?.data.tokenOut, 20);
  assert.equal(emitted.at(-1)?.event, "done");
});

test("the native prompt suggestion after the final result is published with it", async () => {
  const seen = { prompts: [] as any[] } as { options?: Record<string, unknown>; prompts: any[] };
  const sdk = fakeSdk(async function* () {
    yield init;
    yield success("Done.");
    yield { type: "prompt_suggestion", suggestion: "  Now add tests  ", uuid: "u1", session_id: "claude-123" };
  }, seen);
  const { ctx, emitted } = context({ threadId: "claude:claude-123" });
  await runClaudeTurn(ctx, sdk);
  assert.equal(seen.options?.promptSuggestions, true);
  assert.equal(emitted.find((entry) => entry.event === "result")?.data.promptSuggestion, "Now add tests");

  const stale = fakeSdk(async function* () {
    yield init;
    yield { type: "prompt_suggestion", suggestion: "Stale", uuid: "u2", session_id: "claude-123" };
    yield success("Done.");
  }, { prompts: [] });
  const second = context({ threadId: "claude:claude-123" });
  await runClaudeTurn(second.ctx, stale);
  assert.equal("promptSuggestion" in (second.emitted.find((entry) => entry.event === "result")?.data ?? {}), false);
});

test("resume uses the stored Claude session and a Codex thread gets a handoff note", async () => {
  const seen = { prompts: [] as any[] } as { options?: Record<string, unknown>; prompts: any[] };
  const sdk = fakeSdk(async function* () { yield init; yield success("ok"); }, seen);
  await runClaudeTurn(context({ threadId: "claude:abc" }).ctx, sdk);
  assert.equal(seen.options?.resume, "abc");

  const seenCodex = { prompts: [] as any[] } as { options?: Record<string, unknown>; prompts: any[] };
  await runClaudeTurn(context({ threadId: "019f-codex" }).ctx, fakeSdk(async function* () { yield init; yield success("ok"); }, seenCodex));
  assert.equal(seenCodex.options?.resume, undefined);
  assert.match(seenCodex.prompts[0].message.content[0].text, /previously ran on Codex/);
});

test("returning to Claude resumes its original session with the intervening Codex turns", async () => {
  const seen = { prompts: [] as any[] } as { options?: Record<string, unknown>; prompts: any[] };
  await runClaudeTurn(context({ threadId: "claude:original", input: [{ type: "text",
    text: withProviderHandoff("continue", "Turn 3 [turnId=codex-turn; agent=Codex]:\nTests now pass.") }] }).ctx,
  fakeSdk(async function* () { yield init; yield success("ok"); }, seen));
  assert.equal(seen.options?.resume, "original");
  assert.match(seen.prompts[0].message.content[0].text, /turnId=codex-turn; agent=Codex/);
  assert.match(seen.prompts[0].message.content[0].text, /Current user request:\ncontinue$/);
  assert.doesNotMatch(seen.prompts[0].message.content[0].text, /native context is not available/);
});

test("missing Claude native session falls back once with full saved history; auth errors do not", async () => {
  for (const missing of [true, false]) {
    const seen: Array<{ options: Record<string, unknown>; input: any }> = [];
    const sdk: SdkModule = { query: ({ prompt, options }) => (async function* () {
      for await (const input of prompt) {
        seen.push({ options, input });
        if (options.resume) throw new Error(missing ? "No conversation found with session ID: original" : "Authentication failed");
        yield init;
        yield success("recovered");
      }
    })() };
    const { ctx, emitted } = context({ threadId: "claude:original", input: [{ type: "text", text: "delta" }],
      recoveryInput: [{ type: "text", text: "full saved history and current request" }] });
    const previousExitCode = process.exitCode;
    try {
      await runClaudeTurn(ctx, sdk);
      assert.equal(seen.length, missing ? 2 : 1);
      if (missing) {
        assert.equal(seen[1].options.resume, undefined);
        assert.equal(seen[1].input.message.content[0].text, "full saved history and current request");
        assert.equal(emitted.filter(event => event.event === "context_recovery").length, 1);
        assert.equal(emitted.some(event => event.event === "error"), false);
      } else assert.equal(emitted.some(event => event.event === "error"), true);
    } finally { process.exitCode = previousExitCode; }
  }
});

test("every Claude query carries the reply-language rule exactly once", async () => {
  const count = (append: unknown) => String(append).split(REPLY_LANGUAGE_INSTRUCTIONS).length - 1;
  // New and resumed turns.
  for (const threadId of [null, "claude:claude-123"]) {
    const seen: { options?: any; prompts: any[] } = { prompts: [] };
    const { ctx } = context({ threadId, input: [{ type: "text", text: "幫我修呢個 bug" }] });
    await runClaudeTurn(ctx, fakeSdk(async function* () { yield init; yield success("搞掂"); }, seen));
    assert.equal(seen.options.resume, threadId ? "claude-123" : undefined);
    assert.equal(seen.options.systemPrompt.preset, "claude_code");
    assert.equal(count(seen.options.systemPrompt.append), 1, `threadId=${threadId}`);
    assert.match(seen.options.systemPrompt.append, /^Threadex rules/);
  }
  // A missing native session retries without resume; the rule is not stacked.
  const queries: any[] = [];
  const sdk: SdkModule = { query: ({ prompt, options }) => (async function* () {
    for await (const _input of prompt) {
      queries.push(options);
      if (options.resume) throw new Error("No conversation found with session ID: original");
      yield init;
      yield success("recovered");
    }
  })() };
  const { ctx } = context({ threadId: "claude:original", recoveryInput: [{ type: "text", text: "history" }] });
  await runClaudeTurn(ctx, sdk);
  assert.equal(queries.length, 2);
  for (const options of queries) assert.equal(count((options.systemPrompt as any).append), 1);
  // Caller-supplied copies and empty prompts stay single.
  assert.equal(claudeSystemPromptAppend(`base\n\n${REPLY_LANGUAGE_INSTRUCTIONS}`), `base\n\n${REPLY_LANGUAGE_INSTRUCTIONS}`);
  assert.equal(claudeSystemPromptAppend(""), REPLY_LANGUAGE_INSTRUCTIONS);
});

test("declined edits deny the tool and plan-mode turns refuse mutation", async () => {
  const outcomes: any[] = [];
  const sdk = fakeSdk(async function* (_user, _turn, canUseTool) {
    yield init;
    outcomes.push(await canUseTool("Edit", { file_path: "/repo/a.ts", old_string: "a", new_string: "b" }, { toolUseID: "tu_e" }));
    yield success("done");
  }, { prompts: [] });
  const declined = context({ requestApproval: async (input) => { assert.equal(input.method, "item/fileChange/requestApproval"); return "decline"; } });
  await runClaudeTurn(declined.ctx, sdk);
  assert.equal(outcomes[0].behavior, "deny");

  const readOnly = context({ readOnly: true, permissionMode: "plan" });
  await runClaudeTurn(readOnly.ctx, sdk);
  assert.equal(outcomes[1].behavior, "deny");
  assert.equal(readOnly.approvals.length, 0);
});

test("AskUserQuestion goes through the Threadex user-input card", async () => {
  let permission: any;
  const sdk = fakeSdk(async function* (_user, _turn, canUseTool) {
    yield init;
    permission = await canUseTool("AskUserQuestion", { questions: [
      { question: "Which DB?", header: "DB", multiSelect: false, options: [{ label: "Postgres", description: "SQL" }, { label: "DuckDB", description: "Embedded" }] }
    ] }, { toolUseID: "tu_q" });
    yield success("ok");
  }, { prompts: [] });
  const { ctx, approvals } = context({
    requestApproval: async (input) => {
      approvals.push(input);
      return { answers: { "0": { answers: ["DuckDB"] } } };
    }
  });
  const approvalsRef = approvals;
  await runClaudeTurn(ctx, sdk);
  assert.equal(approvalsRef[0].method, USER_INPUT_METHOD);
  assert.deepEqual(approvalsRef[0].params.questions[0].options, [{ label: "Postgres", description: "SQL" }, { label: "DuckDB", description: "Embedded" }]);
  assert.equal(permission.behavior, "allow");
  assert.deepEqual(permission.updatedInput.answers, { "Which DB?": "DuckDB" });
});

test("ExitPlanMode publishes the plan and stops", async () => {
  let permission: any;
  const sdk = fakeSdk(async function* (_user, _turn, canUseTool) {
    yield init;
    permission = await canUseTool("ExitPlanMode", { plan: "1. Do X\n2. Do Y" }, { toolUseID: "tu_p" });
    yield { type: "result", subtype: "success", is_error: false, result: "" };
  }, { prompts: [] });
  const { ctx, emitted } = context({ readOnly: true, permissionMode: "plan" });
  await runClaudeTurn(ctx, sdk);
  assert.equal(permission.behavior, "deny");
  assert.ok(emitted.some((entry) => entry.event === "item" && entry.data.text === "1. Do X\n2. Do Y"));
  assert.equal(emitted.find((entry) => entry.event === "result")?.data.reply, "1. Do X\n2. Do Y");
});

test("steer commands join the running Claude session", async () => {
  let pending: ClaudeSteerCommand[] = [];
  const sdk = fakeSdk(async function* (_user, turn) {
    if (turn === 0) {
      yield init;
      pending = [{ id: "steer-1", message: "Also update docs", buildInput: () => [{ type: "text", text: "Also update docs" }] }];
      await new Promise((resolve) => setTimeout(resolve, 450));
      yield success("first");
    } else {
      yield { type: "assistant", message: { id: "m-steer", content: [{ type: "text", text: "Docs updated." }] } };
      yield success("Docs updated.");
    }
  }, { prompts: [] });
  const { ctx, emitted, steerResults } = context({ pendingSteerCommands: () => pending });
  await runClaudeTurn(ctx, sdk);
  assert.deepEqual(steerResults.map((result) => result.ok), [true]);
  assert.ok(emitted.some((entry) => entry.event === "steer.accepted"));
  assert.equal(emitted.find((entry) => entry.event === "result")?.data.reply, "Docs updated.");
});

test("a steer folded into the running turn ends the turn at its single result", async () => {
  let pending: ClaudeSteerCommand[] = [];
  const prompts: any[] = [];
  const sdk: SdkModule = {
    query: ({ prompt }) => Object.assign((async function* () {
      const inbox = prompt[Symbol.asyncIterator]();
      prompts.push((await inbox.next()).value);
      yield init;
      pending = [{ id: "steer-1", message: "cc only", buildInput: () => [{ type: "text", text: "cc only" }] }];
      // The CLI takes the queued steer between tool rounds; no second result follows.
      prompts.push((await inbox.next()).value);
      yield { type: "assistant", message: { id: "m-final", content: [{ type: "text", text: "Claude Code only." }] } };
      yield { ...success("Claude Code only."), user_message_uuids: prompts.map((user) => user.uuid), queued_turn_count: 0 };
      yield { type: "prompt_suggestion", suggestion: "Run the tests", uuid: "s1", session_id: "claude-123" };
      // Like the CLI, keep waiting for input until the runner closes the inbox.
      if (!(await inbox.next()).done) throw new Error("unexpected extra prompt");
    })(), { close() {} })
  };
  const { ctx, emitted, steerResults } = context({ pendingSteerCommands: () => pending });
  await runClaudeTurn(ctx, sdk);
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((user) => typeof user.uuid === "string"));
  assert.deepEqual(steerResults.map((result) => result.ok), [true]);
  const result = emitted.find((entry) => entry.event === "result");
  assert.equal(result?.data.reply, "Claude Code only.");
  assert.equal(result?.data.promptSuggestion, "Run the tests");
  assert.equal(emitted.at(-1)?.event, "done");
});

test("an empty CLI queue ends the turn when the result echoes no uuids", async () => {
  let pending: ClaudeSteerCommand[] = [];
  let prompts = 0;
  const logs: Array<{ event: string; data: any }> = [];
  const sdk: SdkModule = {
    query: ({ prompt }) => Object.assign((async function* () {
      const inbox = prompt[Symbol.asyncIterator]();
      await inbox.next();
      prompts += 1;
      yield init;
      pending = [{ id: "steer-1", message: "cc only", buildInput: () => [{ type: "text", text: "cc only" }] }];
      await inbox.next();
      prompts += 1;
      yield { ...success("Folded."), queued_turn_count: 0 };
      if (!(await inbox.next()).done) throw new Error("unexpected extra prompt");
    })(), { close() {} })
  };
  const { ctx, emitted } = context({ pendingSteerCommands: () => pending,
    appendInternalLog: (event, data) => { logs.push({ event, data }); } });
  await runClaudeTurn(ctx, sdk);
  assert.equal(prompts, 2);
  assert.equal(emitted.find((entry) => entry.event === "result")?.data.reply, "Folded.");
  assert.equal(emitted.at(-1)?.event, "done");
  assert.equal(logs.find((entry) => entry.event === "claude.result")?.data.clearedByEmptyQueue, 1);
  assert.equal(logs.some((entry) => entry.event === "claude.closed_after_result"), false);
});

test("a stream left open after the final result is closed after the grace period", async () => {
  let closed = false;
  const logs: string[] = [];
  const sdk: SdkModule = {
    query: ({ prompt }) => Object.assign((async function* () {
      const user: any = (await prompt[Symbol.asyncIterator]().next()).value;
      yield init;
      yield { ...success("Done."), user_message_uuids: [user.uuid] };
      yield { type: "prompt_suggestion", suggestion: "Next", uuid: "s1", session_id: "claude-123" };
      // Background work holding the CLI open; close() never settles this read.
      await new Promise(() => undefined);
    })(), { close() { closed = true; } })
  };
  const { ctx, emitted } = context({ resultGraceMs: 20, appendInternalLog: (event) => { logs.push(event); } });
  await runClaudeTurn(ctx, sdk);
  assert.equal(closed, true);
  assert.ok(logs.includes("claude.closed_after_result"));
  assert.equal(emitted.some((entry) => entry.event === "error"), false);
  assert.equal(emitted.find((entry) => entry.event === "result")?.data.promptSuggestion, "Next");
  assert.equal(emitted.at(-1)?.event, "done");
});

const backgroundTasks = (...ids: string[]) => ({ type: "system", subtype: "background_tasks_changed",
  tasks: ids.map((task_id) => ({ task_id, task_type: "local_agent", description: task_id })), uuid: "b", session_id: "claude-123" });

test("live background tasks keep the CLI open until their completion is answered", async () => {
  let closed = false;
  let inboxOpenAtCompletion = false;
  let inboxDone = false;
  const logs: string[] = [];
  const sdk: SdkModule = {
    query: ({ prompt }) => Object.assign((async function* () {
      const inbox = prompt[Symbol.asyncIterator]();
      const user: any = (await inbox.next()).value;
      void inbox.next().then((next) => { inboxDone = Boolean(next.done); });
      yield init;
      yield backgroundTasks("worker-1", "worker-2");
      yield { ...success("Workers are running in the background."), user_message_uuids: [user.uuid] };
      // Longer than the result grace: the old runner closed the CLI here and killed the workers.
      await new Promise((resolve) => setTimeout(resolve, 80));
      inboxOpenAtCompletion = !inboxDone;
      yield { ...backgroundTasks("worker-1", "worker-2"), tasks: [{ task_id: "watch", task_type: "monitor", description: "w", ambient: true }] };
      yield success("Both workers finished.");
    })(), { close() { closed = true; } })
  };
  const { ctx, emitted } = context({ resultGraceMs: 20, backgroundHeartbeatMs: 10, appendInternalLog: (event) => { logs.push(event); } });
  await runClaudeTurn(ctx, sdk);
  assert.equal(inboxOpenAtCompletion, true);
  assert.equal(closed, false);
  assert.ok(logs.includes("claude.awaiting_background_tasks"));
  assert.ok(logs.includes("claude.background_tasks_heartbeat"));
  assert.equal(logs.includes("claude.closed_after_result"), false);
  assert.match(emitted.find((entry) => entry.event === "result")?.data.reply ?? "", /Both workers finished/);
  assert.equal(emitted.at(-1)?.event, "done");
});

test("the turn finishes after the grace period when emptied background tasks get no reply", async () => {
  const logs: string[] = [];
  const sdk: SdkModule = {
    query: ({ prompt }) => Object.assign((async function* () {
      const user: any = (await prompt[Symbol.asyncIterator]().next()).value;
      yield init;
      yield backgroundTasks("shell-1");
      yield { ...success("Started."), user_message_uuids: [user.uuid] };
      yield backgroundTasks();
      await new Promise(() => undefined);
    })(), { close() {} })
  };
  const { ctx, emitted } = context({ resultGraceMs: 20, appendInternalLog: (event) => { logs.push(event); } });
  await runClaudeTurn(ctx, sdk);
  assert.ok(logs.includes("claude.closed_after_result"));
  assert.equal(emitted.at(-1)?.event, "done");
});

test("background tasks that outlive the wait cap are closed with the CLI", async () => {
  let closed = false;
  const logs: string[] = [];
  const sdk: SdkModule = {
    query: ({ prompt }) => Object.assign((async function* () {
      const user: any = (await prompt[Symbol.asyncIterator]().next()).value;
      yield init;
      yield backgroundTasks("dev-server");
      yield { ...success("Server started."), user_message_uuids: [user.uuid] };
      await new Promise(() => undefined);
    })(), { close() { closed = true; } })
  };
  const { ctx, emitted } = context({ resultGraceMs: 20, backgroundWaitMaxMs: 40, appendInternalLog: (event) => { logs.push(event); } });
  await runClaudeTurn(ctx, sdk);
  assert.equal(closed, true);
  assert.ok(logs.indexOf("claude.background_wait_expired") < logs.indexOf("claude.closed_after_result"));
  assert.equal(emitted.at(-1)?.event, "done");
});

for (const limitMessage of [
  { type: "rate_limit_event", rate_limit_info: { status: "rejected" } },
  { type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "Limit reached" }] } }
]) {
  test(`quota rejection releases the runner without a result (${limitMessage.type})`, async () => {
    let readAfterRejection = false;
    let closed = false;
    const sdk: SdkModule = {
      query: () => Object.assign((async function* () {
        yield init;
        yield limitMessage;
        readAfterRejection = true;
        throw new Error("SDK would wait indefinitely for more input here");
      })(), { close() { closed = true; } })
    };
    const { ctx, emitted } = context();
    await runClaudeTurn(ctx, sdk);
    assert.equal(readAfterRejection, false);
    assert.equal(closed, true);
    assert.equal(emitted.filter((entry) => entry.event === "pending").length, 1);
    assert.equal(emitted.find((entry) => entry.event === "pending")?.data.reason, "rate_limit");
    assert.equal(emitted.some((entry) => ["result", "error"].includes(entry.event)), false);
    assert.equal(emitted.at(-1)?.event, "done");
  });
}

test("quota warnings allow the turn to complete", async () => {
  const sdk = fakeSdk(async function* () {
    yield init;
    yield { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } };
    yield success("Finished");
  }, { prompts: [] });
  const { ctx, emitted } = context();
  await runClaudeTurn(ctx, sdk);
  assert.ok(emitted.some((entry) => entry.event === "result"));
  assert.equal(emitted.some((entry) => entry.event === "pending"), false);
});

test("plan limits become a pending turn and update the Claude account", async () => {
  const sdk = fakeSdk(async function* () {
    yield init;
    yield { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: "2026-10-13T15:00:00Z" } };
    yield { type: "assistant", error: "rate_limit", message: { id: "m", content: [{ type: "text", text: "Limit reached" }] } };
    yield { type: "result", subtype: "error_during_execution", is_error: true };
  }, { prompts: [] });
  const reports: any[] = [];
  const { ctx, emitted } = context({ accountLabel: "Work", reportAccountEvent: async (kind, info) => { reports.push({ kind, info }); } });
  const previousExitCode = process.exitCode;
  await runClaudeTurn(ctx, sdk);
  process.exitCode = previousExitCode;
  const pending = emitted.find((entry) => entry.event === "pending");
  assert.equal(pending?.data.reason, "rate_limit");
  assert.equal(pending?.data.accountId, null);
  assert.match(pending?.data.message, /Claude plan limit reached for Work; it resets at 2026-10-13T15:00:00Z/);
  assert.equal(emitted.some((entry) => entry.event === "error"), false);
  assert.deepEqual(reports.map((report) => [report.kind, report.info.status]), [["rate_limit", "rejected"]]);
  assert.equal(emitted.at(-1)?.event, "done");
});

test("a quiet running subagent emits heartbeats while the turn waits, then stops once it stalls", async () => {
  const sdk: SdkModule = {
    query: ({ prompt }) => Object.assign((async function* () {
      const user: any = (await prompt[Symbol.asyncIterator]().next()).value;
      yield init;
      yield { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { description: "d", subagent_type: "general-purpose", prompt: "p" } }] } };
      yield { type: "assistant", parent_tool_use_id: "toolu_agent", message: { id: "c1", content: [{ type: "text", text: "working" }] } };
      yield { type: "system", subtype: "task_progress", task_id: "a1", tool_use_id: "toolu_agent", description: "d", usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } };
      yield backgroundTasks("a1");
      yield { ...success("Started."), user_message_uuids: [user.uuid] };
      await new Promise((resolve) => setTimeout(resolve, 400));
      yield { type: "system", subtype: "task_notification", task_id: "a1", tool_use_id: "toolu_agent", status: "completed", summary: "done" };
      yield backgroundTasks();
      yield success("Finished.");
    })(), { close() {} })
  };
  const { ctx, emitted } = context({ resultGraceMs: 20, subagentHeartbeatMs: 20, subagentStallMs: 150 });
  await runClaudeTurn(ctx, sdk);
  const activity = emitted.filter((entry) => entry.event === "subagent_activity").map((entry) => entry.data as any);
  const kinds = activity.map((entry) => entry.kind);
  assert.ok(kinds.includes("message"));
  assert.ok(kinds.includes("progress"));
  const beats = activity.filter((entry) => entry.kind === "heartbeat");
  assert.ok(beats.length >= 2, `expected heartbeats, got ${kinds.join()}`);
  assert.ok(beats.length < 12, "heartbeats must stop after the stall window");
  assert.equal(beats.every((entry) => entry.agentId === "toolu_agent" && entry.processAlive === true), true);
  assert.equal(kinds.at(-1), "finished");
  const seqs = activity.map((entry) => entry.seq);
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs.slice().sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
  assert.equal(emitted.at(-1)?.event, "done");
});
