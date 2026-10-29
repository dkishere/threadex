import { randomUUID } from "node:crypto";
import { buildSubagentStartupSnapshot } from "./subagentStartup";
import { approvedInspectorCommand, inspectorAliases, inspectorArgv, inspectorScript } from "./sessionInspectorCommand";
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
import { REPLY_LANGUAGE_INSTRUCTIONS } from "./replyLanguage";

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
  /** How long the stream may stay open after the final result before the runner closes it. */
  resultGraceMs?: number;
  backgroundWaitMaxMs?: number;
  backgroundHeartbeatMs?: number;
  /** A running subagent quiet for this long gets a heartbeat event. */
  subagentHeartbeatMs?: number;
  /** Heartbeats stop this long after a subagent's last real sign of life, so a hung one cannot keep the runner looking busy. */
  subagentStallMs?: number;
  /** Actor tool credentials. The PreToolUse hook injects the calling agent's own credential into
   * session-inspector actor calls, so none is present in the model-visible environment. */
  actorCredentials?: ActorToolCredentials;
  /** Native split children as SDK agent definitions keyed by agent name (subagent_type). */
  agents?: Record<string, { description: string; prompt: string; model: string; effort?: string }>;
};

export type ActorToolCredentials = {
  /** The session's own actor: the main thread and its non-actor helpers. */
  main?: string;
  /** Native split children by agent name; each acts only as its own actor work item. */
  children: Record<string, { workItemId: string; capability: string }>;
  toolNames: string[];
};

const quoteArg = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** Rewrites a tool call so actor identity follows the calling agent: session-inspector
 * actor commands receive that agent's credential, and an actor child's Agent call keeps
 * its system-fixed model, foreground run and working directory. Returns null when unchanged. */
export function actorCredentialedInput(credentials: ActorToolCredentials | undefined, agentNames: readonly string[], tool: string,
  args: Record<string, unknown>, agent: { agentId?: string; agentType?: string }): { updatedInput: Record<string, unknown> } | { deny: string } | null {
  if ((tool === "Agent" || tool === "Task") && typeof args.subagent_type === "string" && agentNames.includes(args.subagent_type)) {
    if (agent.agentId) return { deny: "Only the split host session starts actor sub-agents." };
    const { model: _model, effort: _effort, isolation: _isolation, name: _name, ...rest } = args;
    return { updatedInput: { ...rest, run_in_background: false } };
  }
  // SendMessage output is not a sub-agent result; rework reruns the actor agent so its outcome is recorded.
  if (tool === "SendMessage" && typeof args.to === "string" && agentNames.includes(args.to))
    return { deny: "Actor sub-agent rework must start the same subagent_type again with the Agent tool, including its previous result and the changes needed." };
  if (!credentials || tool !== "Bash") return null;
  const argv = inspectorArgv(args.command);
  if (!argv || argv[0] !== process.execPath || argv[1] !== inspectorScript || argv.length > 4) return null;
  const name = inspectorAliases[argv[2]] ?? argv[2];
  if (!credentials.toolNames.includes(name)) return null;
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(argv[3] ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    input = parsed as Record<string, unknown>;
  } catch { return null; }
  const { _actorCredential: _credential, _actorWorkItem: _workItem, ...clean } = input;
  const child = agent.agentId && agent.agentType ? credentials.children[agent.agentType] : undefined;
  const credentialed = child ? { ...clean, _actorCredential: child.capability, _actorWorkItem: child.workItemId }
    : credentials.main ? { ...clean, _actorCredential: credentials.main } : clean;
  return { updatedInput: { ...args, command: [process.execPath, inspectorScript, argv[2], JSON.stringify(credentialed)].map(quoteArg).join(" ") } };
}

// Prompt suggestions arrive a few seconds after the final result; anything
// still holding the CLI open well after that would only keep the turn running.
const RESULT_GRACE_MS = 30_000;
// Background tasks (async subagents, background shells) live in the CLI process, so the
// turn stays open while they run; the cap keeps a never-ending task (a dev server) bounded.
const BACKGROUND_WAIT_MAX_MS = Number(process.env.THREADEX_CLAUDE_BACKGROUND_WAIT_MS ?? 60 * 60_000);
// Log movement while waiting so the stale-runner watchdog does not abandon a quiet test run.
const BACKGROUND_HEARTBEAT_MS = 60_000;
const SUBAGENT_HEARTBEAT_MS = 30_000;
const SUBAGENT_STALL_MS = Number(process.env.THREADEX_SUBAGENT_STALL_MS ?? 10 * 60_000);

/** Live non-ambient background task ids from a background_tasks_changed level message, else null. */
export function backgroundTaskIds(message: unknown): string[] | null {
  const record = message as { type?: unknown; subtype?: unknown; tasks?: unknown } | null;
  if (record?.type !== "system" || record.subtype !== "background_tasks_changed" || !Array.isArray(record.tasks)) return null;
  return record.tasks.flatMap((task: { task_id?: unknown; ambient?: unknown }) =>
    typeof task?.task_id === "string" && task.ambient !== true ? [task.task_id] : []);
}

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

// Every Claude query (new, resume, recovery retry, actor and managed turns)
// rebuilds its system prompt here, so the reply-language rule is added once per query.
export function claudeSystemPromptAppend(appendSystemPrompt: string) {
  return appendSystemPrompt.includes(REPLY_LANGUAGE_INSTRUCTIONS)
    ? appendSystemPrompt
    : [appendSystemPrompt, REPLY_LANGUAGE_INSTRUCTIONS].filter(Boolean).join("\n\n");
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
  // A quiet subagent may only be waiting on the user; its heartbeats say so instead of looking hung.
  const pendingWaits = new Map<string, "approval" | "input">();
  const currentWait = () => [...pendingWaits.values()].includes("approval") ? "approval" as const : pendingWaits.size ? "input" as const : undefined;
  let beatSubagents: (quietMs: number) => void = () => undefined;
  const whileWaiting = async <T,>(kind: "approval" | "input", run: () => Promise<T>): Promise<T> => {
    const id = randomUUID();
    pendingWaits.set(id, kind);
    beatSubagents(0);
    try { return await run(); } finally { pendingWaits.delete(id); }
  };
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
    const decision = await whileWaiting("approval", () => ctx.requestApproval({ approvalId: randomUUID(), requestId: toolUseID, method: request.method,
      params: escape ? { ...request.params, sandboxEscape: true } : request.params, isCanceled: () => Boolean(options.signal?.aborted) }));
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

  // Agent calls to these definitions run with the definition's model, effort and system prompt, so their cards show those.
  const mapper = new ClaudeStreamMapper(Object.fromEntries(Object.entries(ctx.agents ?? {}).map(([name, agent]) => {
    const effort = claudeEffort(agent.effort, agent.model);
    return [name, { model: agent.model, ...(effort ? { effort } : {}), prompt: agent.prompt }];
  })));
  const inbox = new AsyncQueue<unknown>();
  let sessionId = resumeSessionId ?? "";
  let threadId: string | null = resumeSessionId ? ctx.threadId : null;
  // Prompts the CLI has not yet answered with a result. A steer the CLI folds
  // into the running turn is answered by that turn's result, so counting
  // results against sends would wait forever for a result that never comes.
  const unanswered = new Set<string>();
  let results = 0;
  let finished = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let closedAfterResult = false;
  let stopReading = () => {};
  // Ends the read loop even if a closed query never settles its pending read.
  const stopped = new Promise<void>((resolve) => { stopReading = resolve; });
  let failure: string | null = null;
  let rateLimitMessage: string | null = null;
  let limitReached = false;
  let nativeActivity = false;
  let promptSuggestion: string | null = null;
  const usage: ClaudeUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  let costUsd = 0;

  const push = (parts: ClaudeInputPart[]) => {
    const uuid = randomUUID();
    unanswered.add(uuid);
    inbox.push({ ...buildClaudeUserMessage(parts, sessionId), uuid });
  };

  const canUseTool = async (toolName: string, toolInput: Record<string, unknown>, options: CanUseToolOptions = {}): Promise<PermissionResult> => {
    const toolUseId = options.toolUseID ?? randomUUID();
    if (toolName === "AskUserQuestion") return whileWaiting("input", () => askUserQuestion(ctx, toolInput, toolUseId, options));
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
    const decision = await whileWaiting("approval", () => ctx.requestApproval({
      approvalId: randomUUID(),
      requestId: toolUseId,
      method: request.method,
      params: request.params,
      isCanceled: () => Boolean(options.signal?.aborted)
    }));
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
    hooks: { PreToolUse: [{ hooks: [async (input: { tool_name?: string; tool_input?: Record<string, unknown>; agent_id?: string; agent_type?: string }, toolUseID?: string, options: CanUseToolOptions = {}) => {
      const actor = actorCredentialedInput(ctx.actorCredentials, Object.keys(ctx.agents ?? {}), input.tool_name ?? "", input.tool_input ?? {},
        { agentId: input.agent_id, agentType: input.agent_type });
      if (actor && "deny" in actor) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: actor.deny } };
      const toolInput = actor?.updatedInput ?? input.tool_input ?? {};
      const decision = await checkBoundary(input.tool_name ?? "", toolInput, toolUseID ?? randomUUID(), options);
      if (decision) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision.behavior,
        ...(decision.behavior === "deny" ? { permissionDecisionReason: decision.message } : actor ? { updatedInput: toolInput } : {}) } };
      // Credentialed inspector calls and actor-agent launches are already within policy.
      return actor ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: toolInput } } : {};
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
    systemPrompt: { type: "preset", preset: "claude_code", append: claudeSystemPromptAppend(ctx.appendSystemPrompt) },
    settingSources: ["user", "project", "local"],
    ...(Object.keys(ctx.mcpServers).length ? { mcpServers: ctx.mcpServers } : {}),
    ...(ctx.agents && Object.keys(ctx.agents).length ? { agents: Object.fromEntries(Object.entries(ctx.agents).map(([name, agent]) => [name, {
      description: agent.description, prompt: agent.prompt, model: agent.model,
      ...(claudeEffort(agent.effort, agent.model) ? { effort: claudeEffort(agent.effort, agent.model) } : {}) }])) } : {}),
    ...(ctx.allowedTools.length ? { allowedTools: ctx.allowedTools } : {}),
    env: claudeEnvironment(process.env, ctx.extraEnv),
    ...(process.env.THREADEX_CLAUDE_PATH ? { pathToClaudeCodeExecutable: process.env.THREADEX_CLAUDE_PATH } : {}),
    stderr: (data: string) => ctx.appendInternalLog("runner.claude_stderr", { message: data })
  };

  const query = sdk.query({ prompt: inbox, options });
  let backgroundTasks = new Set<string>();
  let backgroundWaitTimer: ReturnType<typeof setTimeout> | undefined;
  let backgroundHeartbeat: ReturnType<typeof setInterval> | undefined;
  let backgroundIdleTimer: ReturnType<typeof setTimeout> | undefined;
  const clearBackgroundWait = () => {
    clearTimeout(backgroundWaitTimer);
    clearInterval(backgroundHeartbeat);
    clearTimeout(backgroundIdleTimer);
    backgroundWaitTimer = backgroundHeartbeat = backgroundIdleTimer = undefined;
  };
  const finishTurn = () => {
    if (finished) return;
    clearBackgroundWait();
    finished = true;
    inbox.close();
    const graceMs = ctx.resultGraceMs ?? RESULT_GRACE_MS;
    graceTimer = setTimeout(() => {
      ctx.appendInternalLog("claude.closed_after_result", { graceMs, backgroundTasks: backgroundTasks.size,
        message: "Claude stream stayed open after the final result; closing it so the turn can finish." });
      closedAfterResult = true;
      try { query.close?.(); } catch (error) {
        ctx.appendInternalLog("claude.close_error", { message: error instanceof Error ? error.message : String(error) });
      }
      stopReading();
    }, graceMs);
  };
  // Keep the CLI, and the background work it owns, alive until that work settles.
  const awaitBackground = () => {
    clearTimeout(backgroundIdleTimer);
    backgroundIdleTimer = undefined;
    if (backgroundWaitTimer) return;
    const maxMs = ctx.backgroundWaitMaxMs ?? BACKGROUND_WAIT_MAX_MS;
    const waitStartedAt = Date.now();
    ctx.appendInternalLog("claude.awaiting_background_tasks", { tasks: [...backgroundTasks], maxMs });
    backgroundHeartbeat = setInterval(() => ctx.appendInternalLog("claude.background_tasks_heartbeat",
      { tasks: [...backgroundTasks], elapsedMs: Date.now() - waitStartedAt }), ctx.backgroundHeartbeatMs ?? BACKGROUND_HEARTBEAT_MS);
    backgroundWaitTimer = setTimeout(() => {
      ctx.appendInternalLog("claude.background_wait_expired", { tasks: [...backgroundTasks], maxMs });
      finishTurn();
    }, maxMs);
  };
  const onSigterm = () => {
    try { query.close?.(); } catch { /* exiting */ }
    process.exit(143);
  };
  process.once("SIGTERM", onSigterm);

  const subagentQuietMs = ctx.subagentHeartbeatMs ?? SUBAGENT_HEARTBEAT_MS;
  beatSubagents = (quietMs) => {
    for (const output of mapper.heartbeats({ quietMs, stallMs: ctx.subagentStallMs ?? SUBAGENT_STALL_MS,
      processAlive: !closedAfterResult, waiting: currentWait() })) {
      if (output.kind === "subagent_activity") void ctx.emitEvent("subagent_activity", output.payload);
    }
  };
  const subagentBeatTimer = setInterval(() => beatSubagents(subagentQuietMs), Math.max(10, Math.min(15_000, subagentQuietMs / 2)));

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
    for await (const message of readUntil(query, stopped)) {
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
        } else if (output.kind === "subagent_activity") {
          await ctx.emitEvent("subagent_activity", output.payload);
        } else if (output.kind === "subagent_usage") {
          await ctx.emitEvent("subagent_usage", { agentId: output.agentId, source: "claude", tokenUsage: output.tokenUsage });
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
          const answered = output.userMessageUuids.filter((uuid) => unanswered.has(uuid));
          // Results without uuids (older CLIs, error results) answer the oldest send.
          for (const uuid of answered.length ? answered : [...unanswered].slice(0, 1)) unanswered.delete(uuid);
          // An empty CLI queue means no send is waiting for another turn: any
          // send still unanswered was folded into this one without a uuid echo.
          const clearedByEmptyQueue = output.queuedTurnCount === 0 ? unanswered.size : 0;
          if (clearedByEmptyQueue) unanswered.clear();
          ctx.appendInternalLog("claude.result", { subtype: output.subtype, answered: answered.length,
            unanswered: unanswered.size, clearedByEmptyQueue, queuedTurnCount: output.queuedTurnCount });
          if (unanswered.size === 0 && !finished) {
            if (backgroundTasks.size) awaitBackground();
            else finishTurn();
          }
        }
      }
      const liveTasks = backgroundTaskIds(message);
      if (liveTasks) {
        backgroundTasks = new Set(liveTasks);
        // The CLI answers the completion notification with another result; finish without
        // one only if it stays idle for the grace period.
        if (!backgroundTasks.size && backgroundWaitTimer) {
          clearBackgroundWait();
          backgroundIdleTimer = setTimeout(finishTurn, ctx.resultGraceMs ?? RESULT_GRACE_MS);
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
    // Closing a lingering stream after the final result is not a turn failure.
    if (!closedAfterResult) failure = failure ?? (error instanceof Error ? error.message : String(error));
  } finally {
    finished = true;
    clearTimeout(graceTimer);
    clearBackgroundWait();
    clearInterval(steerTimer);
    clearInterval(subagentBeatTimer);
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
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
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

async function* readUntil<T>(source: AsyncIterable<T>, stopped: Promise<void>): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  const stop = stopped.then(() => ({ done: true, value: undefined }) as IteratorResult<T>);
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), stop]);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // Not awaited: a stopped query may never settle its pending read.
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
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
