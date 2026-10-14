import { tmpdir } from "node:os";
import { inspectorApprovalGate, inspectorInstructions, type InspectorCliConfig } from "./sessionInspectorCommand";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { ClaudeStreamMapper, type ClaudeUsage } from "./claudeEvents";
import { buildClaudeUserMessage, claudeEffort, claudeEnvironment, loadSdk, type SdkModule } from "./claudeRunner";
import type { ModelTokenUsage } from "./modelTokenUsage";
import { claudeAuthHome, claudeCredentialStore, prepareClaudeHome, type ClaudeCredentialStore } from "./claudeHome";

/**
 * One isolated, non-interactive Claude request for background helpers such as
 * the session summarizer and the turn griller. Unlike runClaudeTurn it has no
 * session events, approvals or steering: no user settings, hooks or CLAUDE.md
 * files are loaded, nothing is persisted unless the caller resumes later, and
 * only the listed tools may run.
 */
export type ClaudeOneShotOptions = {
  model: string;
  prompt: string;
  systemPrompt: string;
  /** A Threadex Claude account; null uses the machine's default Claude login. */
  configDir?: string | null;
  /** Defaults to an empty temp directory. */
  cwd?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: unknown) => void;
  mcpServers?: Record<string, { type: "stdio"; command: string; args: string[]; env: Record<string, string> }>;
  /** Built-in tools to expose (e.g. Read, Grep, Glob). Defaults to none. */
  builtinTools?: string[];
  /** Tools that run without approval; every other tool call is denied. */
  allowedTools?: string[];
  inspectorCli?: InspectorCliConfig;
  maxTurns?: number;
  /**
   * A private writable directory (also the cwd) for scripts. Bash runs in the
   * OS sandbox, which only allows writes there, and file-writing tools are
   * denied outside it.
   */
  scratchDir?: string;
  /** With `scratchDir`: let sandboxed Bash reach loopback (local databases and dev servers); external network stays blocked. */
  allowLocalNetwork?: boolean;
  /**
   * Keep the Claude session on disk (under a private helper home) so a later
   * request can continue it with `resume`. Resumed requests must use the same cwd.
   */
  persistSession?: boolean;
  /** Stable workspace + logical session identity; required for persisted helpers. */
  sessionScope?: string;
  resume?: string | null;
};

export type ClaudeOneShotResult = {
  responseText: string;
  usage: ModelTokenUsage;
  sessionId: string | null;
};

const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
function isWithin(root: string, target: string) {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export async function runClaudeOneShot(options: ClaudeOneShotOptions, sdkOverride?: SdkModule,
  credentials: ClaudeCredentialStore = claudeCredentialStore): Promise<ClaudeOneShotResult> {
  options.signal?.throwIfAborted();
  if (options.persistSession && !options.sessionScope) throw new Error("Persisted Claude helpers require a workspace/session scope.");
  const source = options.configDir ?? claudeAuthHome();
  const home = options.persistSession
    ? resolve(tmpdir(), "threadex-claude-helper-homes", createHash("sha256").update(JSON.stringify([source, options.sessionScope])).digest("hex"))
    : mkdtempSync(resolve(tmpdir(), "threadex-claude-helper-"));
  let auth: ReturnType<typeof prepareClaudeHome> | undefined;
  try {
    auth = prepareClaudeHome(home, source, credentials);
    return await runClaudeOneShotQuery(options, home, sdkOverride);
  } finally {
    try { auth?.syncAuth(); } catch { console.warn("Could not synchronize refreshed Claude helper login credentials."); }
    if (!options.persistSession) {
      // A macOS refresh may have created a Keychain entry for the temporary home.
      try { if (auth) credentials.write(home, null); }
      catch { console.warn("Could not remove temporary Claude helper login credentials."); }
      finally { rmSync(home, { recursive: true, force: true }); }
    }
  }
}

async function runClaudeOneShotQuery(options: ClaudeOneShotOptions, home: string, sdkOverride?: SdkModule): Promise<ClaudeOneShotResult> {
  options.signal?.throwIfAborted();
  const sdk = sdkOverride ?? await loadSdk();
  const allowed = new Set(options.allowedTools ?? []);
  const approveInspector = options.inspectorCli ? inspectorApprovalGate(options.inspectorCli) : () => false;
  const mapper = new ClaudeStreamMapper();
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  let releaseInput: () => void = () => {};
  const inputDone = new Promise<void>((resolve) => { releaseInput = resolve; });
  async function* input() {
    yield buildClaudeUserMessage([{ type: "text", text: options.prompt }], "");
    // Keep the input stream open until the result arrives, as runClaudeTurn does.
    await inputDone;
  }

  const effort = claudeEffort(options.reasoningEffort, options.model);
  const scratch = options.scratchDir ? resolve(options.scratchDir) : null;
  const outsideScratch = (toolName: string, toolInput: Record<string, unknown>) => {
    if (!scratch || !FILE_WRITE_TOOLS.has(toolName)) return false;
    const target = toolInput.file_path ?? toolInput.notebook_path;
    return typeof target !== "string" || !isWithin(scratch, resolve(scratch, target));
  };
  const query = sdk.query({
    prompt: input(),
    options: {
      cwd: scratch ?? options.cwd ?? tmpdir(),
      ...(scratch ? { sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: Boolean(options.inspectorCli), autoAllowBashIfSandboxed: !options.inspectorCli,
        ...(options.allowLocalNetwork ? { network: { allowLocalBinding: true } } : {}) } } : {}),
      model: options.model,
      ...(effort ? { effort } : {}),
      systemPrompt: [options.inspectorCli ? inspectorInstructions : undefined, options.systemPrompt].filter(Boolean).join("\n\n"),
      settingSources: [],
      persistSession: options.persistSession === true,
      ...(options.onEvent ? { includePartialMessages: true } : {}),
      ...(options.resume ? { resume: options.resume } : {}),
      tools: [...new Set([...(options.builtinTools ?? []), ...(options.inspectorCli ? ["Bash"] : [])])],
      ...(options.mcpServers && Object.keys(options.mcpServers).length ? { mcpServers: options.mcpServers, strictMcpConfig: true } : {}),
      // Bare allowedTools entries skip canUseTool, so scratch jobs leave every decision to it.
      ...(allowed.size && !scratch && !options.inspectorCli ? { allowedTools: [...allowed] } : {}),
      canUseTool: async (toolName: string, toolInput: Record<string, unknown>) => (
        toolName === "Bash" && approveInspector(toolInput.command)
      ) || (allowed.has(toolName) && !outsideScratch(toolName, toolInput) && !(toolName === "Bash" && toolInput.dangerouslyDisableSandbox === true))
        ? { behavior: "allow", updatedInput: toolInput }
        : { behavior: "deny", message: scratch && allowed.has(toolName) ? `Write only inside ${scratch}.` : "This background task may not use that tool." },
      permissionMode: "default",
      ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
      abortController,
      env: claudeEnvironment(process.env, { ...options.inspectorCli?.env, CLAUDE_CONFIG_DIR: home, ...(!options.configDir ? { THREADEX_CLAUDE_DEFAULT_AUTH: "1" } : {}) }),
      ...(process.env.THREADEX_CLAUDE_PATH ? { pathToClaudeCodeExecutable: process.env.THREADEX_CLAUDE_PATH } : {})
    }
  });

  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = options.timeoutMs ? setTimeout(() => abortController.abort(), options.timeoutMs) : null;
  const usage: ClaudeUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  let failure: string | null = null;
  let rateLimitMessage: string | null = null;
  let resultText: string | null = null;
  let sessionId: string | null = null;
  let finished = false;
  try {
    for await (const message of query) {
      options.onEvent?.(message);
      for (const output of mapper.handle(message)) {
        if (output.kind === "session") {
          sessionId = output.sessionId;
        } else if (output.kind === "rate_limit" && output.status === "rejected") {
          rateLimitMessage = `Claude plan limit reached${output.resetsAt ? `; it resets at ${output.resetsAt}` : ""}.`;
        } else if (output.kind === "api_error") {
          failure = output.error === "rate_limit"
            ? rateLimitMessage ?? `Claude plan limit reached. ${output.text}`.trim()
            : `Claude API error (${output.error})${output.text ? `: ${output.text}` : ""}`;
        } else if (output.kind === "result") {
          finished = true;
          sessionId = output.sessionId ?? sessionId;
          if (output.usage) {
            usage.inputTokens += output.usage.inputTokens;
            usage.outputTokens += output.usage.outputTokens;
            usage.cacheReadInputTokens += output.usage.cacheReadInputTokens;
            usage.cacheCreationInputTokens += output.usage.cacheCreationInputTokens;
          }
          if (output.ok) resultText = output.text;
          else failure = failure ?? rateLimitMessage ?? (output.errors.join("\n") || `Claude ended with ${output.subtype}.`);
          releaseInput();
        }
      }
    }
  } catch (error) {
    failure = failure ?? (abortController.signal.aborted
      ? options.signal?.aborted ? "Claude request cancelled." : `Claude ${options.model} timed out after ${options.timeoutMs}ms.`
      : error instanceof Error ? error.message : String(error));
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (timer) clearTimeout(timer);
    releaseInput();
    try { query.close?.(); } catch { /* already closed */ }
  }

  if (!failure && !finished) failure = rateLimitMessage ?? "Claude ended without a result.";
  if (failure) throw new Error(failure);
  const inputTokens = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
  return {
    responseText: resultText?.trim() ? resultText : mapper.lastAgentText,
    usage: {
      inputTokens,
      cachedInputTokens: usage.cacheReadInputTokens,
      outputTokens: usage.outputTokens,
      reasoningOutputTokens: 0,
      totalTokens: inputTokens + usage.outputTokens
    },
    sessionId
  };
}
