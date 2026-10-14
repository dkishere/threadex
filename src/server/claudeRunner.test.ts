import assert from "node:assert/strict";
import test from "node:test";
import { USER_INPUT_METHOD } from "../userInputRequest";
import { inspectorCommand } from "./sessionInspectorCommand";
import { withProviderHandoff } from "./sessionProviderThreads";
import {
  buildClaudeUserMessage,
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
  assert.deepEqual(seen.options?.systemPrompt, { type: "preset", preset: "claude_code", append: "Threadex rules" });
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
