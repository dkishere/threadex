import { randomUUID } from "node:crypto";
import { buildSubagentStartupSnapshot } from "./subagentStartup";
import { approvedInspectorCommand } from "./sessionInspectorCommand";
import { normalizeModelEffort } from "../modelCatalog";
import { readFileSync, statSync } from "node:fs";
import { USER_INPUT_METHOD } from "../userInputRequest";
import { claudeSandboxOptions, claudeToolBoundary, type ClaudeSandboxMode } from "./claudeSandbox";
import {
  ClaudeStreamMapper,
  fromClaudeThreadId,
  isClaudeEditTool,
  summarizeClaudeToolForApproval,
  toClaudeThreadId,
  type ClaudeUsage
} from "./claudeEvents";
import type { StreamItem } from "./codexEvents";

/**
 * Runs one Threadex turn on Claude through the Claude Agent SDK.
 *
 * promptRunner.ts owns job parsing, instructions, approvals and the runner log;
 * this module only drives the SDK and reports through the injected context, so
 * it emits the same runner events as the Codex app-server path.
 */

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type ClaudeInputPart =
  | { type: "text"; text: string }
  | { type: "image"; path: string; mimeType: string };

export type ClaudePermissionMode = "default" | "acceptEdits" | "plan" | "auto";

/** Maps a Threadex (Codex) approval policy onto Claude permission settings. */
export function claudePermissions(input: { policy: string | undefined; readOnly: boolean }): { permissionMode: ClaudePermissionMode; autoApproveAll: boolean } {
  if (input.readOnly) return { permissionMode: "plan", autoApproveAll: false };
  // "Approve for me" mirrors Codex auto_review: Claude's classifier decides, asking through canUseTool when unsure.
  if (input.policy === "granular") return { permissionMode: "auto", autoApproveAll: false };
  if (input.policy === "never") return { permissionMode: "acceptEdits", autoApproveAll: true };
  return { permissionMode: "default", autoApproveAll: false };
}

/**
 * Claude starts in "default" without an error when auto mode is unavailable (model, account
 * or a disableAutoMode setting). Fall back to auto-accepting edits, the pre-auto mapping.
 * Other reported modes come from settings and are left alone so Threadex never loosens them.
 */
export function claudePermissionFallback(requested: ClaudePermissionMode, reported: string | null): ClaudePermissionMode | null {
  return requested === "auto" && reported === "default" ? "acceptEdits" : null;
}

export type ClaudeSteerCommand = {
  id: string;
  message: string;
  /** Built only when the command is sent (attachments are read lazily). */
  buildInput: () => ClaudeInputPart[];
};

export type ClaudeSteerResult = {
  ok: boolean;
  notSent?: boolean;
  commandId: string;
  turnId: string;
  appTurnId?: string | null;
  error?: string;
};

export type ClaudeRunnerContext = {
  sessionId: string;
  turnId: string;
  threadId: string | null;
  model: string;
  reasoningEffort?: string;
  cwd: string;
  input: ClaudeInputPart[];
  /** Full persisted history, used only if the saved native session is missing. */
  recoveryInput?: ClaudeInputPart[];
  appendSystemPrompt: string;
  permissionMode: ClaudePermissionMode;
  /** Codex approval_policy=never: run tools without asking. */
  autoApproveAll: boolean;
  /** Plan turns and read-only sandboxes: refuse mutating tools. */
  readOnly: boolean;
  sandboxMode?: ClaudeSandboxMode;
  protectedPaths?: string[];
  mcpServers: Record<string, { type: "stdio"; command: string; args: string[]; env: Record<string, string> }>;
  allowedTools: string[];
  approvedInspectorCommands?: string[];
  /** The user approved sandbox escapes for this session in an earlier turn. */
  sandboxEscapesApproved?: boolean;
  extraEnv: Record<string, string>;
  emitEvent: (event: string, data: unknown, options?: { waitForCallback?: boolean }) => Promise<unknown>;
  appendInternalLog: (event: string, data: unknown) => void;
  requestApproval: (input: {
    approvalId: string;
    requestId: string;
    method: string;
    params: unknown;
    isCanceled?: () => boolean;
  }) => Promise<unknown>;
  pendingSteerCommands: () => ClaudeSteerCommand[];
  writeSteerResult: (result: ClaudeSteerResult) => void;
  /** Threadex Claude account used for this turn, if any (for limit and login reporting). */
  accountLabel?: string | null;
  reportAccountEvent?: (kind: "rate_limit" | "auth_failed", info: Record<string, unknown>) => Promise<void>;
};

export type SdkModule = {
  query: (input: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => AsyncIterable<unknown> & {
    interrupt?: () => Promise<unknown>;
    setPermissionMode?: (mode: ClaudePermissionMode) => Promise<unknown>;
    close?: () => void;
  };
};

type PermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };

type CanUseToolOptions = {
  signal?: AbortSignal;
  suggestions?: unknown[];
  decisionReason?: string;
  blockedPath?: string;
  toolUseID?: string;
};

export function claudeEffort(value: string | undefined, model: string): string | undefined {
  return value ? normalizeModelEffort(model, value) : undefined;
}

export function claudeEnvironment(base: NodeJS.ProcessEnv, extra: Record<string, string>) {
  const env: Record<string, string | undefined> = { ...base, ...extra, CLAUDE_AGENT_SDK_CLIENT_APP: "threadex/0.1.0" };
  // Use the local Claude login (subscription) unless an API key is explicitly wanted.
  if (base.THREADEX_CLAUDE_USE_API_KEY !== "1") delete env.ANTHROPIC_API_KEY;
  if (extra.CLAUDE_CONFIG_DIR) {
    if (extra.THREADEX_CLAUDE_DEFAULT_AUTH !== "1") {
      // A Threadex Claude account: its own login must win over any global token.
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }
  } else if (base.THREADEX_CLAUDE_CONFIG_DIR) {
    env.CLAUDE_CONFIG_DIR = base.THREADEX_CLAUDE_CONFIG_DIR;
  }
  // A Threadex server started from inside Claude Code must not look like a nested session.
  delete env.CLAUDECODE;
  return env;
}

export function buildClaudeUserMessage(parts: ClaudeInputPart[], sessionId: string) {
  const content: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text) content.push({ type: "text", text: part.text });
      continue;
    }
    const image = readImage(part);
    if (image) content.push(image);
  }
  if (content.length === 0) content.push({ type: "text", text: "(empty message)" });
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: sessionId };
}

export function providerSwitchNote(previousProvider: string) {
  return `[Threadex note: this session previously ran on ${previousProvider}. That agent's native context is not available in this turn. If the request depends on earlier turns, run session-inspector recover_current_session first and treat recovered turns as historical records.]`;
}

export async function runClaudeTurn(ctx: ClaudeRunnerContext, sdkOverride?: SdkModule): Promise<void> {
  const startedAt = Date.now();
  const sdk = sdkOverride ?? await loadSdk();
  const sandboxMode = ctx.readOnly ? "read-only" : ctx.sandboxMode ?? "workspace-write";
  const isInspector = (tool: string, args: Record<string, unknown>) => tool === "Bash" &&
    approvedInspectorCommand(args.command, ctx.approvedInspectorCommands ?? []);
  const boundary = (tool: string, args: Record<string, unknown>) => isInspector(tool, args) ? null : claudeToolBoundary({
    cwd: ctx.cwd, mode: sandboxMode, tool, args, protectedPaths: ctx.protectedPaths
  });
  const boundaryDecisions = new Map<string, PermissionResult>();
  let escapesApproved = ctx.sandboxEscapesApproved === true;
  const checkBoundary = async (tool: string, args: Record<string, unknown>, toolUseID: string, options: CanUseToolOptions = {}): Promise<PermissionResult | null> => {
    const reason = boundary(tool, args);
    if (!reason) return null;
    // approval_policy=never disables escalation, it never disables the sandbox.
    if (ctx.readOnly || sandboxMode === "read-only" || ctx.autoApproveAll) return { behavior: "deny", message: reason };
    const escape = tool === "Bash" && args.dangerouslyDisableSandbox === true;
    if (escape && escapesApproved) return { behavior: "allow", updatedInput: args };
    const key = JSON.stringify([toolUseID, tool, args]);
    const saved = boundaryDecisions.get(key);
    if (saved) return saved;
    const request = approvalRequestFor(ctx, tool, args, toolUseID, { ...options, decisionReason: `${reason} Approval grants this action outside the sandbox boundary.` });
    const decision = await ctx.requestApproval({ approvalId: randomUUID(), requestId: toolUseID, method: request.method,
      params: escape ? { ...request.params, sandboxEscape: true } : request.params, isCanceled: () => Boolean(options.signal?.aborted) });
    // One session approval covers every later escape; the server persists it for later turns (sandbox.escape_grant).
    if (escape && decision === "acceptForSession") escapesApproved = true;
    const result: PermissionResult = decision === "accept" || decision === "acceptForSession"
      ? { behavior: "allow", updatedInput: args }
      : { behavior: "deny", message: reason };
    boundaryDecisions.set(key, result);
    return result;
  };
  const resumeSessionId = fromClaudeThreadId(ctx.threadId);
  const input = ctx.threadId && !resumeSessionId
    ? [{ type: "text" as const, text: providerSwitchNote("Codex") }, ...ctx.input]
    : ctx.input;

  const mapper = new ClaudeStreamMapper();
  const inbox = new AsyncQueue<unknown>();
  let sessionId = resumeSessionId ?? "";
  let threadId: string | null = resumeSessionId ? ctx.threadId : null;
  let pushed = 0;
  let results = 0;
  let finished = false;
  let failure: string | null = null;
  let rateLimitMessage: string | null = null;
  let limitReached = false;
  let nativeActivity = false;
  let promptSuggestion: string | null = null;
  const usage: ClaudeUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  let costUsd = 0;

  const push = (parts: ClaudeInputPart[]) => {
    pushed += 1;
    inbox.push(buildClaudeUserMessage(parts, sessionId));
  };

  const canUseTool = async (toolName: string, toolInput: Record<string, unknown>, options: CanUseToolOptions = {}): Promise<PermissionResult> => {
    const toolUseId = options.toolUseID ?? randomUUID();
    if (toolName === "AskUserQuestion") return askUserQuestion(ctx, toolInput, toolUseId, options);
    if (isInspector(toolName, toolInput)) return { behavior: "allow", updatedInput: toolInput };
    const boundaryDecision = await checkBoundary(toolName, toolInput, toolUseId, options);
    if (boundaryDecision) return boundaryDecision;
    if (toolName === "ExitPlanMode") {
      const plan = typeof toolInput.plan === "string" ? toolInput.plan : "";
      if (plan.trim()) {
        mapper.lastAgentText = plan;
        await ctx.emitEvent("item", { id: `${toolUseId}:plan`, eventType: "item.completed", itemType: "agent_message", text: plan } satisfies StreamItem);
      }
      return { behavior: "deny", message: "Threadex recorded this plan for the user to review. Do not implement it in this turn; end the turn now." };
    }
    if (ctx.readOnly && isMutatingTool(toolName)) {
      return { behavior: "deny", message: "This Threadex turn is read-only. Do not modify files or run mutating commands; describe the change instead." };
    }
    if (ctx.autoApproveAll) return { behavior: "allow", updatedInput: toolInput };

    const request = approvalRequestFor(ctx, toolName, toolInput, toolUseId, options);
    const decision = await ctx.requestApproval({
      approvalId: randomUUID(),
      requestId: toolUseId,
      method: request.method,
      params: request.params,
      isCanceled: () => Boolean(options.signal?.aborted)
    });
    if (decision === "accept") return { behavior: "allow", updatedInput: toolInput };
    if (decision === "acceptForSession" || (decision && typeof decision === "object")) {
      // Keep "approve session" in memory for this Claude session only; never write settings files.
      const updatedPermissions = (options.suggestions ?? []).flatMap((suggestion) =>
        suggestion && typeof suggestion === "object" ? [{ ...(suggestion as Record<string, unknown>), destination: "session" }] : []);
      return { behavior: "allow", updatedInput: toolInput, ...(updatedPermissions.length ? { updatedPermissions } : {}) };
    }
    mapper.markDeclined(toolUseId);
    if (decision === "decline") return { behavior: "deny", message: "The user declined this action. Choose another approach or ask the user." };
    return { behavior: "deny", message: "The user cancelled this action.", interrupt: true };
  };

  push(input);
  const options: Record<string, unknown> = {
    cwd: ctx.cwd,
    ...claudeSandboxOptions(sandboxMode, ctx.cwd, ctx.protectedPaths,
      Boolean(ctx.approvedInspectorCommands?.length) || (!ctx.autoApproveAll && sandboxMode === "workspace-write")),
    hooks: { PreToolUse: [{ hooks: [async (input: { tool_name?: string; tool_input?: Record<string, unknown> }, toolUseID?: string, options: CanUseToolOptions = {}) => {
      const decision = await checkBoundary(input.tool_name ?? "", input.tool_input ?? {}, toolUseID ?? randomUUID(), options);
      return decision ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision.behavior,
        ...(decision.behavior === "deny" ? { permissionDecisionReason: decision.message } : {}) } } : {};
    }] }], SubagentStart: [{ hooks: [async (input: { cwd?: string }) => ({
      hookSpecificOutput: {
        hookEventName: "SubagentStart",
        additionalContext: await buildSubagentStartupSnapshot(input.cwd ?? "",
          ctx.input.some(item => item.type === "text" && /[\u3400-\u9fff]/u.test(String(item.text))))
      }
    })] }] },
    model: ctx.model,
    ...(claudeEffort(ctx.reasoningEffort, ctx.model) ? { effort: claudeEffort(ctx.reasoningEffort, ctx.model) } : {}),
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    includePartialMessages: true,
    // The suggestion follows the final result; the loop below keeps reading
    // after the inbox closes, so it arrives before the stream ends.
    promptSuggestions: true,
    permissionMode: ctx.permissionMode,
    canUseTool,
    systemPrompt: { type: "preset", preset: "claude_code", append: ctx.appendSystemPrompt },
    settingSources: ["user", "project", "local"],
    ...(Object.keys(ctx.mcpServers).length ? { mcpServers: ctx.mcpServers } : {}),
    ...(ctx.allowedTools.length ? { allowedTools: ctx.allowedTools } : {}),
    env: claudeEnvironment(process.env, ctx.extraEnv),
    ...(process.env.THREADEX_CLAUDE_PATH ? { pathToClaudeCodeExecutable: process.env.THREADEX_CLAUDE_PATH } : {}),
    stderr: (data: string) => ctx.appendInternalLog("runner.claude_stderr", { message: data })
  };

  const query = sdk.query({ prompt: inbox, options });
  const onSigterm = () => {
    try { query.close?.(); } catch { /* exiting */ }
    process.exit(143);
  };
  process.once("SIGTERM", onSigterm);

  const processedSteers = new Set<string>();
  const steerTimer = setInterval(() => {
    for (const command of ctx.pendingSteerCommands()) {
      if (processedSteers.has(command.id)) continue;
      // Wait for the session id so queued input joins the same Claude session.
      if (!finished && !sessionId) break;
      processedSteers.add(command.id);
      if (finished) {
        const result = { ok: false, notSent: true, commandId: command.id, turnId: ctx.turnId, appTurnId: null, error: "The target turn has already finished; steer was not sent." };
        void ctx.emitEvent("steer.rejected", result);
        ctx.writeSteerResult(result);
        continue;
      }
      push(command.buildInput());
      void ctx.emitEvent("steer.accepted", { commandId: command.id, appTurnId: null, message: command.message });
      ctx.writeSteerResult({ ok: true, commandId: command.id, turnId: ctx.turnId, appTurnId: null });
    }
  }, 200);

  try {
    for await (const message of query) {
      logSdkMessage(ctx, message);
      for (const output of mapper.handle(message)) {
        if (output.kind === "session") {
          sessionId = output.sessionId;
          threadId = toClaudeThreadId(output.sessionId);
          await ctx.emitEvent("session", { sessionId: ctx.sessionId, turnId: ctx.turnId, threadId, message: "Claude session ready" });
          if (output.permissionMode && output.permissionMode !== ctx.permissionMode) {
            const fallback = claudePermissionFallback(ctx.permissionMode, output.permissionMode);
            let applied = false;
            if (fallback && query.setPermissionMode) {
              try {
                await query.setPermissionMode(fallback);
                applied = true;
              } catch (error) {
                ctx.appendInternalLog("claude.permission_mode_fallback_error", { message: error instanceof Error ? error.message : String(error) });
              }
            }
            ctx.appendInternalLog("claude.permission_mode_mismatch", { requested: ctx.permissionMode, reported: output.permissionMode, fallback, applied });
          }
        } else if (output.kind === "item") {
          nativeActivity = true;
          await ctx.emitEvent("item", output.item);
        } else if (output.kind === "rate_limit") {
          if (output.status === "rejected") {
            limitReached = true;
            rateLimitMessage = `Claude plan limit reached${ctx.accountLabel ? ` for ${ctx.accountLabel}` : ""}${output.resetsAt ? `; it resets at ${output.resetsAt}` : ""}.`;
          }
          await reportAccountEvent(ctx, "rate_limit", output.info);
        } else if (output.kind === "api_error") {
          if (output.error === "rate_limit") {
            limitReached = true;
            failure = rateLimitMessage ?? `Claude plan limit reached. ${output.text}`.trim();
          } else if (output.error === "authentication_failed" || output.error === "oauth_org_not_allowed") {
            failure = `Claude login failed${ctx.accountLabel ? ` for ${ctx.accountLabel}` : ""} (${output.error}). Log in again from Accounts → Claude.${output.text ? ` ${output.text}` : ""}`;
            await reportAccountEvent(ctx, "auth_failed", { error: output.error, text: output.text });
          } else {
            failure = `Claude API error (${output.error})${output.text ? `: ${output.text}` : ""}`;
          }
        } else if (output.kind === "prompt_suggestion") {
          promptSuggestion = output.suggestion;
        } else if (output.kind === "result") {
          results += 1;
          // Only a suggestion after the last result predicts the next prompt.
          promptSuggestion = null;
          if (output.usage) {
            usage.inputTokens += output.usage.inputTokens;
            usage.outputTokens += output.usage.outputTokens;
            usage.cacheReadInputTokens += output.usage.cacheReadInputTokens;
            usage.cacheCreationInputTokens += output.usage.cacheCreationInputTokens;
          }
          costUsd += output.costUsd ?? 0;
          if (!output.ok) failure = failure ?? rateLimitMessage ?? output.errors.join("\n");
          if (results >= pushed) {
            finished = true;
            inbox.close();
          }
        }
      }
      // A rejected request need not be followed by a result: with streaming
      // input the SDK can remain alive waiting for another prompt indefinitely.
      // Release the session through the pending path instead of waiting for EOF.
      if (limitReached) {
        finished = true;
        inbox.close();
        try { query.close?.(); } catch (error) {
          ctx.appendInternalLog("claude.close_error", { message: error instanceof Error ? error.message : String(error) });
        }
        break;
      }
    }
  } catch (error) {
    failure = failure ?? (error instanceof Error ? error.message : String(error));
  } finally {
    finished = true;
    clearInterval(steerTimer);
    inbox.close();
    process.removeListener("SIGTERM", onSigterm);
  }

  if (resumeSessionId && ctx.recoveryInput && failure && !nativeActivity && !processedSteers.size &&
    /no conversation found with session id|(?:session|conversation) (?:id )?[^\n]*\bnot found\b/i.test(failure)) {
    await ctx.emitEvent("context_recovery", { sessionId: ctx.sessionId, turnId: ctx.turnId,
      sourceThreadId: ctx.threadId, reason: failure }, { waitForCallback: true });
    await runClaudeTurn({ ...ctx, threadId: null, input: ctx.recoveryInput, recoveryInput: undefined }, sdk);
    return;
  }

  // Answer controls that arrived after the final result so callers are not left waiting.
  for (const command of ctx.pendingSteerCommands()) {
    if (processedSteers.has(command.id)) continue;
    const result = { ok: false, notSent: true, commandId: command.id, turnId: ctx.turnId, appTurnId: null, error: "The target turn has already finished; steer was not sent." };
    await ctx.emitEvent("steer.rejected", result);
    ctx.writeSteerResult(result);
  }

  if (!failure && results === 0) failure = rateLimitMessage ?? "Claude ended the turn without a result.";
  ctx.appendInternalLog("claude.usage", { ...usage, costUsd, model: ctx.model, account: ctx.accountLabel ?? null, elapsedMs: Date.now() - startedAt });
  if (limitReached) {
    // Like Codex usage limits: keep the prompt as a pending turn that retries after the reset.
    await ctx.emitEvent("pending", {
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      threadId,
      message: `${rateLimitMessage ?? failure ?? "Claude plan limit reached."} The turn is saved and will retry after the reset.`,
      queued: true,
      reason: "rate_limit",
      needsLogin: false,
      accountId: null
    }, { waitForCallback: true });
    await ctx.emitEvent("done", { ok: true }, { waitForCallback: true });
    return;
  }
  if (failure) {
    await ctx.emitEvent("error", { message: failure }, { waitForCallback: true });
    await ctx.emitEvent("done", { ok: true }, { waitForCallback: true });
    process.exitCode = 1;
    return;
  }

  await ctx.emitEvent("result", {
    sessionId: ctx.sessionId,
    threadId,
    appTurnId: null,
    elapsedMs: Date.now() - startedAt,
    reply: mapper.lastAgentText || "Turn completed without a final agent message.",
    tokenIn: usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
    tokenOut: usage.outputTokens,
    ...(promptSuggestion ? { promptSuggestion } : {})
  }, { waitForCallback: true });
  await ctx.emitEvent("done", { ok: true }, { waitForCallback: true });
}

async function reportAccountEvent(ctx: ClaudeRunnerContext, kind: "rate_limit" | "auth_failed", info: Record<string, unknown>) {
  try {
    await ctx.reportAccountEvent?.(kind, info);
  } catch (error) {
    ctx.appendInternalLog("claude.account_report_error", { kind, message: error instanceof Error ? error.message : String(error) });
  }
}

async function askUserQuestion(
  ctx: ClaudeRunnerContext,
  toolInput: Record<string, unknown>,
  toolUseId: string,
  options: CanUseToolOptions
): Promise<PermissionResult> {
  const questions = (Array.isArray(toolInput.questions) ? toolInput.questions : [])
    .flatMap((value) => value && typeof value === "object" ? [value as Record<string, unknown>] : []);
  const params = {
    questions: questions.map((question, index) => ({
      id: String(index),
      header: typeof question.header === "string" ? question.header : `Question ${index + 1}`,
      question: typeof question.question === "string" ? question.question : "",
      isOther: true,
      options: (Array.isArray(question.options) ? question.options : []).flatMap((option) => {
        const record = option && typeof option === "object" ? option as Record<string, unknown> : null;
        return typeof record?.label === "string"
          ? [{ label: record.label, description: typeof record.description === "string" ? record.description : "" }]
          : [];
      })
    }))
  };
  const decision = await ctx.requestApproval({
    approvalId: randomUUID(),
    requestId: toolUseId,
    method: USER_INPUT_METHOD,
    params,
    isCanceled: () => Boolean(options.signal?.aborted)
  });
  const answers = decision && typeof decision === "object"
    ? (decision as { answers?: Record<string, { answers?: string[] }> }).answers
    : undefined;
  if (!answers) return { behavior: "deny", message: "The user dismissed the question without answering." };
  return {
    behavior: "allow",
    updatedInput: {
      questions: toolInput.questions,
      answers: Object.fromEntries(questions.map((question, index) => [
        String(question.question ?? ""),
        answers[String(index)]?.answers?.join(", ") ?? ""
      ]))
    }
  };
}

function approvalRequestFor(
  ctx: ClaudeRunnerContext,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
  options: CanUseToolOptions
) {
  const base = { threadId: ctx.threadId, turnId: ctx.turnId, itemId: toolUseId, tool: toolName };
  if (toolName === "Bash") {
    return {
      method: "item/commandExecution/requestApproval",
      params: {
        ...base,
        command: typeof toolInput.command === "string" ? toolInput.command : "",
        cwd: ctx.cwd,
        reason: options.decisionReason ?? (typeof toolInput.description === "string" ? toolInput.description : undefined)
      }
    };
  }
  if (isClaudeEditTool(toolName)) {
    const path = typeof toolInput.file_path === "string" ? toolInput.file_path
      : typeof toolInput.notebook_path === "string" ? toolInput.notebook_path : "";
    return {
      method: "item/fileChange/requestApproval",
      params: { ...base, reason: [`Claude wants to ${toolName === "Write" ? "write" : "edit"} ${path}`, options.decisionReason].filter(Boolean).join(" — "), ...(options.blockedPath ? { grantRoot: options.blockedPath } : {}) }
    };
  }
  return {
    method: "item/commandExecution/requestApproval",
    params: { ...base, command: summarizeClaudeToolForApproval(toolName, toolInput), reason: options.decisionReason ?? `Claude wants to use ${toolName}.` }
  };
}

function isMutatingTool(toolName: string) {
  return toolName === "Bash" || isClaudeEditTool(toolName);
}

function readImage(part: { path: string; mimeType: string }) {
  if (!IMAGE_MEDIA_TYPES.has(part.mimeType)) return { type: "text", text: `[Attached image ${part.path} has an unsupported type ${part.mimeType}.]` };
  try {
    if (statSync(part.path).size > MAX_IMAGE_BYTES) return { type: "text", text: `[Attached image ${part.path} is larger than 5 MB; read it from disk if needed.]` };
    return { type: "image", source: { type: "base64", media_type: part.mimeType, data: readFileSync(part.path).toString("base64") } };
  } catch {
    return { type: "text", text: `[Attached image ${part.path} could not be read.]` };
  }
}

function logSdkMessage(ctx: ClaudeRunnerContext, message: unknown) {
  const record = message && typeof message === "object" ? message as Record<string, unknown> : null;
  const type = typeof record?.type === "string" ? record.type : "unknown";
  if (type === "stream_event" || type === "assistant" || type === "user") return;
  ctx.appendInternalLog("claude.message", { type, subtype: record?.subtype ?? null });
}

export async function loadSdk(): Promise<SdkModule> {
  try {
    // A variable specifier keeps the SDK optional for Codex-only installs.
    const specifier: string = SDK_PACKAGE;
    return await import(specifier) as SdkModule;
  } catch (error) {
    throw new Error(`Claude models need ${SDK_PACKAGE}. Run "npm install ${SDK_PACKAGE}" in Threadex and restart the server. (${error instanceof Error ? error.message : String(error)})`);
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as T, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as T, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined as T, done: true });
      }
    };
  }
}
