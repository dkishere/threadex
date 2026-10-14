import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ClaudeQuotaSnapshot, ClaudeQuotaWindow } from "./claudeAccountStore";

/**
 * Claude account operations that need the Claude Code CLI or Agent SDK:
 * per-account login (`claude auth login`), status (`claude auth status`) and
 * plan usage (`/usage`). Every call is scoped to the account's CLAUDE_CONFIG_DIR.
 */

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const LOGIN_TTL_MS = 15 * 60 * 1000;
const STATUS_TIMEOUT_MS = 20_000;
const USAGE_TIMEOUT_MS = 60_000;

export type ClaudeAuthStatus = {
  loggedIn: boolean;
  authMethod: string | null;
  email: string | null;
  organization: string | null;
  subscriptionType: string | null;
  error: string | null;
};

export type ClaudeLogin = {
  id: string;
  accountId: string;
  configDir: string;
  child: ChildProcessWithoutNullStreams;
  output: string;
  loginUrl: string | null;
  exited: boolean;
  exitCode: number | null;
  startedAt: number;
};

const pendingLogins = new Map<string, ClaudeLogin>();

export function claudeCliPath() {
  return process.env.THREADEX_CLAUDE_PATH || "claude";
}

/** Environment for a process that must act as one Claude account and nothing else. */
export function claudeAccountEnv(configDir: string, base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, CLAUDE_CONFIG_DIR: configDir, CLAUDE_AGENT_SDK_CLIENT_APP: "threadex/0.1.0" };
  // A global token or API key would silently override the account's own login.
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  if (base.THREADEX_CLAUDE_USE_API_KEY !== "1") delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDECODE;
  return env;
}

export function manualLoginCommand(configDir: string) {
  return `CLAUDE_CONFIG_DIR=${shellQuote(configDir)} ${claudeCliPath()} auth login`;
}

export function parseClaudeAuthStatus(stdout: string, exitCode: number | null): ClaudeAuthStatus {
  let record: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(stdout.trim() || "null");
    record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    record = null;
  }
  const authMethod = findString(record, ["authMethod", "auth_method"]);
  const explicit = findBoolean(record, ["loggedIn", "logged_in", "isLoggedIn", "authenticated"]);
  const loggedIn = explicit ?? (exitCode === 0 && authMethod !== "none" && record !== null);
  return {
    loggedIn,
    authMethod,
    email: findString(record, ["email", "emailAddress", "email_address", "userEmail"]),
    organization: findString(record, ["orgName", "organizationName", "organization_name", "organization", "org"]),
    subscriptionType: findString(record, ["subscriptionType", "subscription_type", "subscription", "plan", "planType"]),
    error: record ? null : (stdout.trim().slice(0, 300) || `claude auth status exited with ${exitCode ?? "unknown"}`)
  };
}

export async function readClaudeAuthStatus(configDir: string): Promise<ClaudeAuthStatus> {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  try {
    const { stdout, stderr, code } = await runCli(["auth", "status"], configDir, STATUS_TIMEOUT_MS);
    const status = parseClaudeAuthStatus(stdout, code);
    return status.error && stderr.trim() ? { ...status, error: stderr.trim().slice(0, 300) } : status;
  } catch (error) {
    return { loggedIn: false, authMethod: null, email: null, organization: null, subscriptionType: null, error: errorMessage(error) };
  }
}

/** Removes the account's stored login (on macOS this also clears its Keychain entry). */
export async function logoutClaude(configDir: string) {
  await runCli(["auth", "logout"], configDir, STATUS_TIMEOUT_MS);
}

export function startClaudeLogin(accountId: string, configDir: string): ClaudeLogin {
  cleanupClaudeLogins();
  for (const login of pendingLogins.values()) {
    if (login.accountId === accountId && !login.exited) return login;
  }
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const child = spawn(claudeCliPath(), ["auth", "login"], {
    env: claudeAccountEnv(configDir) as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const login: ClaudeLogin = {
    id: randomUUID(),
    accountId,
    configDir,
    child,
    output: "",
    loginUrl: null,
    exited: false,
    exitCode: null,
    startedAt: Date.now()
  };
  const onData = (chunk: Buffer | string) => {
    login.output = `${login.output}${String(chunk)}`.slice(-8000);
    login.loginUrl ??= extractLoginUrl(login.output);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (error) => {
    login.output = `${login.output}\n${error.message}`.slice(-8000);
    login.exited = true;
  });
  child.on("exit", (code) => {
    login.exited = true;
    login.exitCode = code;
  });
  pendingLogins.set(login.id, login);
  return login;
}

export function getClaudeLogin(loginId: string) {
  cleanupClaudeLogins();
  return pendingLogins.get(loginId) ?? null;
}

/** Some login flows ask for the code shown in the browser to be pasted back. */
export function sendClaudeLoginCode(loginId: string, code: string) {
  const login = getClaudeLogin(loginId);
  if (!login || login.exited) throw new Error("Login session not found or already finished.");
  login.child.stdin.write(`${code.trim()}\n`);
}

export function finishClaudeLogin(loginId: string) {
  const login = pendingLogins.get(loginId);
  if (!login) return;
  pendingLogins.delete(loginId);
  if (!login.exited) login.child.kill("SIGTERM");
}

export function claudeLoginOutputTail(login: ClaudeLogin) {
  return stripAnsi(login.output).split("\n").map((line) => line.trimEnd()).filter(Boolean).slice(-6).join("\n");
}

export function extractLoginUrl(output: string) {
  const match = stripAnsi(output).match(/https:\/\/[^\s"'<>]+/);
  return match ? match[0].replace(/[).,]+$/, "") : null;
}

function cleanupClaudeLogins() {
  const now = Date.now();
  for (const [id, login] of pendingLogins) {
    if (now - login.startedAt > LOGIN_TTL_MS) finishClaudeLogin(id);
  }
}

/** Runs `/usage` for the account (a local command; it does not call the model). */
export async function fetchClaudeUsage(configDir: string): Promise<{ quota: ClaudeQuotaSnapshot; email: string | null; subscriptionType: string | null; organization: string | null }> {
  const sdk = await loadSdk();
  const workdir = resolveWorkdir();
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  async function* prompt() {
    yield { type: "user", message: { role: "user", content: "/usage" }, parent_tool_use_id: null, session_id: "" };
    await done;
  }
  const query = sdk.query({
    prompt: prompt(),
    options: {
      cwd: workdir,
      settingSources: [],
      maxTurns: 1,
      env: claudeAccountEnv(configDir),
      ...(process.env.THREADEX_CLAUDE_PATH ? { pathToClaudeCodeExecutable: process.env.THREADEX_CLAUDE_PATH } : {})
    }
  });
  const timer = setTimeout(() => {
    resolveDone();
    try { query.close?.(); } catch { /* ignore */ }
  }, USAGE_TIMEOUT_MS);
  let report: unknown = null;
  let text = "";
  let account: Record<string, unknown> | null = null;
  try {
    try {
      account = toRecord(await query.accountInfo?.());
    } catch {
      account = null;
    }
    for await (const message of query) {
      const record = toRecord(message);
      if (record?.type === "assistant") {
        report = record.usage_report ?? report;
        const content = toRecord(record.message)?.content;
        text = Array.isArray(content)
          ? content.map((block) => typeof toRecord(block)?.text === "string" ? String(toRecord(block)?.text) : "").join("\n").trim() || text
          : text;
        if (record.error) throw new Error(`Claude returned ${String(record.error)}${text ? `: ${text}` : ""}`);
      }
      if (record?.type === "result") break;
    }
  } finally {
    clearTimeout(timer);
    resolveDone();
    try { query.close?.(); } catch { /* ignore */ }
  }
  const windows = quotaFromUsageReport(report);
  return {
    quota: { ...windows, ...(text ? { reportText: text.slice(0, 2000) } : {}), source: "usage" },
    email: findString(account, ["email", "emailAddress"]),
    subscriptionType: findString(account, ["subscriptionType", "subscription_type", "plan"]),
    organization: findString(account, ["organization", "organizationName", "orgName"])
  };
}

/** Best-effort parse of SDKUsageReport; the exact shape is not documented, so search by name. */
export function quotaFromUsageReport(report: unknown): Pick<ClaudeQuotaSnapshot, "fiveHour" | "weekly"> {
  const result: Pick<ClaudeQuotaSnapshot, "fiveHour" | "weekly"> = {};
  visit(report, (key, value) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const window = quotaWindow(value);
    if (!window) return;
    if (!result.fiveHour && /fivehour|5h|session/.test(normalized)) result.fiveHour = window;
    else if (!result.weekly && /sevenday|weekly|week|7d/.test(normalized) && !/opus|sonnet|fable/.test(normalized)) result.weekly = window;
  });
  return result;
}

/** Turns an SDK rate_limit_event's rate_limit_info into a quota patch. */
export function quotaFromRateLimitInfo(info: Record<string, unknown>): ClaudeQuotaSnapshot {
  const status = typeof info.status === "string" ? info.status : undefined;
  const resetsAt = epochMs(info.resetsAt ?? info.resets_at);
  const limitType = typeof info.rateLimitType === "string" ? info.rateLimitType
    : typeof info.rate_limit_type === "string" ? info.rate_limit_type : null;
  const usedPercent = percent(info.utilization);
  const window: ClaudeQuotaWindow | undefined = resetsAt !== null || usedPercent !== null
    ? { usedPercent: usedPercent ?? (status === "rejected" ? 100 : null), resetsAt }
    : undefined;
  const normalizedType = (limitType ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return {
    status,
    limitResetsAt: status === "rejected" ? resetsAt : null,
    limitType,
    source: "run",
    ...(window && /fivehour|session/.test(normalizedType) ? { fiveHour: window } : {}),
    ...(window && /sevenday|week/.test(normalizedType) && !/opus|sonnet|fable/.test(normalizedType) ? { weekly: window } : {})
  };
}

/** Epoch ms when a rate-limited Claude account can be retried, or null if unknown or past. */
export function claudeQuotaRetryAt(quota: ClaudeQuotaSnapshot | null, now = Date.now()) {
  if (!quota) return null;
  const candidates = [
    quota.status === "rejected" ? quota.limitResetsAt ?? null : null,
    quota.fiveHour && (quota.fiveHour.usedPercent ?? 0) >= 100 ? quota.fiveHour.resetsAt : null,
    quota.weekly && (quota.weekly.usedPercent ?? 0) >= 100 ? quota.weekly.resetsAt : null
  ].filter((value): value is number => typeof value === "number" && value > now);
  return candidates.length ? Math.max(...candidates) : null;
}

function quotaWindow(value: unknown): ClaudeQuotaWindow | null {
  const record = toRecord(value);
  if (!record) return null;
  const usedPercent = percent(record.utilization ?? record.used_percentage ?? record.usedPercent ?? record.percent_used ?? record.percentUsed ?? record.used);
  const resetsAt = epochMs(record.resets_at ?? record.resetsAt ?? record.reset_at ?? record.resetAt);
  return usedPercent === null && resetsAt === null ? null : { usedPercent, resetsAt };
}

function visit(value: unknown, callback: (key: string, value: unknown) => void, depth = 0) {
  if (depth > 5) return;
  const record = toRecord(value);
  if (record) {
    for (const [key, entry] of Object.entries(record)) {
      callback(key, entry);
      visit(entry, callback, depth + 1);
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      const item = toRecord(entry);
      const label = typeof item?.name === "string" ? item.name : typeof item?.type === "string" ? item.type : typeof item?.id === "string" ? item.id : "";
      if (label) callback(label, entry);
      visit(entry, callback, depth + 1);
    }
  }
}

function percent(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round((value <= 1 ? value * 100 : value) * 10) / 10;
}

function epochMs(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function findString(record: Record<string, unknown> | null, keys: string[]): string | null {
  let found: string | null = null;
  visit(record, (key, value) => {
    if (found === null && keys.includes(key) && typeof value === "string" && value.trim()) found = value;
  });
  return found;
}

function findBoolean(record: Record<string, unknown> | null, keys: string[]): boolean | null {
  if (!record) return null;
  for (const key of keys) {
    if (typeof record[key] === "boolean") return record[key] as boolean;
  }
  return null;
}

async function runCli(args: string[], configDir: string, timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolveRun, rejectRun) => {
    const child = spawn(claudeCliPath(), args, { env: claudeAccountEnv(configDir) as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectRun(new Error(`claude ${args.join(" ")} timed out.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(new Error(`Cannot run ${claudeCliPath()}: ${error.message}. Install Claude Code or set THREADEX_CLAUDE_PATH.`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolveRun({ stdout, stderr, code });
    });
  });
}

type SdkModule = {
  query: (input: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => AsyncIterable<unknown> & {
    close?: () => void;
    accountInfo?: () => Promise<unknown>;
  };
};

async function loadSdk(): Promise<SdkModule> {
  try {
    const specifier: string = SDK_PACKAGE;
    return await import(specifier) as SdkModule;
  } catch {
    throw new Error(`Run "npm install ${SDK_PACKAGE}" in Threadex to read Claude usage.`);
  }
}

function resolveWorkdir() {
  const dir = `${tmpdir()}/threadex-claude-usage`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stripAnsi(value: string) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, "");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
