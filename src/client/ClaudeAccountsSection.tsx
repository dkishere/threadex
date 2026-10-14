import { Loader2, RefreshCw, Trash2, UserPlus } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { formatQuotaPercent, formatQuotaWindowReset } from "./accountFormatters";
import { formatTimestampShort } from "./formatters";

type QuotaWindow = { usedPercent: number | null; resetsAt: number | null };

export type ClaudeAccount = {
  id: string;
  name: string;
  configDir: string;
  email: string | null;
  organization: string | null;
  subscriptionType: string | null;
  loggedIn: boolean;
  quotaSnapshot: {
    fiveHour?: QuotaWindow;
    weekly?: QuotaWindow;
    status?: string;
    limitResetsAt?: number | null;
    reportText?: string;
  } | null;
  quotaUpdatedAt: string | null;
  quotaError: string | null;
};

type Listing = {
  accounts: ClaudeAccount[];
  workspaceId: string;
  workspaceAccountId: string | null;
  sessionAccountId: string | null;
  effectiveAccountId: string | null;
};

type LoginState = {
  accountId: string;
  loginId: string;
  loginUrl: string | null;
  manualCommand: string;
  output: string;
  exited: boolean;
};

export const CLAUDE_NO_LOAD_BALANCE = "Claude accounts are used for Claude models and can't join load balancing.";

/** Shared Claude account listing for Settings › Accounts and the header account popover. */
export function useClaudeAccounts(workspaceId: string | null, sessionId: string | null) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const query = new URLSearchParams({ ...(workspaceId ? { workspaceId } : {}), ...(sessionId ? { sessionId } : {}) }).toString();

  const load = useCallback(async () => {
    try {
      setListing(await request<Listing>(`/api/claude-accounts?${query}`));
      setError("");
    } catch (loadError) {
      setError(messageOf(loadError));
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(id: string, operation: () => Promise<void>) {
    setBusyId(id);
    try {
      await operation();
      setError("");
    } catch (operationError) {
      setError(messageOf(operationError));
    } finally {
      setBusyId(null);
    }
  }

  return {
    listing,
    accounts: listing?.accounts ?? [],
    error,
    busyId,
    workspaceId,
    sessionId,
    load,
    setListing,
    select: (accountId: string | null, scope: "workspace" | "session") => run(accountId ?? "__clear__", async () => {
      setListing(await request<Listing>("/api/claude-accounts/select", {
        method: "POST",
        body: JSON.stringify({ accountId, scope, workspaceId, sessionId })
      }));
    }),
    refresh: (account: ClaudeAccount) => run(account.id, async () => {
      await request(`/api/claude-accounts/${encodeURIComponent(account.id)}/refresh`, { method: "POST" });
      await load();
    }),
    remove: (account: ClaudeAccount) => {
      if (!window.confirm(`Remove Claude account ${account.name}? This logs it out on this computer.`)) return Promise.resolve();
      return run(account.id, async () => {
        setListing(await request<Listing>(`/api/claude-accounts/${encodeURIComponent(account.id)}?${query}`, { method: "DELETE" }));
      });
    }
  };
}

export type ClaudeAccounts = ReturnType<typeof useClaudeAccounts>;

/** "Claude login" tab of the Settings › Accounts add/login panel. */
export function ClaudeLoginForm({ claude, accountName, onAccountNameChange, targetAccount, onComplete }: {
  claude: ClaudeAccounts;
  accountName: string;
  onAccountNameChange: (name: string) => void;
  targetAccount: ClaudeAccount | null;
  onComplete: () => void;
}) {
  const [login, setLogin] = useState<LoginState | null>(null);
  const [loginCode, setLoginCode] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const autoStartedFor = useRef<string | null>(null);

  async function startLogin() {
    setStarting(true);
    setError("");
    try {
      if (targetAccount) {
        const result = await request<{ login: Omit<LoginState, "accountId"> }>(`/api/claude-accounts/${encodeURIComponent(targetAccount.id)}/login`, { method: "POST" });
        setLogin({ ...result.login, accountId: targetAccount.id });
      } else {
        const result = await request<Listing & { account: ClaudeAccount; login: Omit<LoginState, "accountId"> }>("/api/claude-accounts", {
          method: "POST",
          body: JSON.stringify({ name: accountName.trim(), workspaceId: claude.workspaceId, sessionId: claude.sessionId })
        });
        claude.setListing(result);
        setLogin({ ...result.login, accountId: result.account.id });
      }
    } catch (startError) {
      setError(messageOf(startError));
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    if (!targetAccount || autoStartedFor.current === targetAccount.id) return;
    autoStartedFor.current = targetAccount.id;
    void startLogin();
  }, [targetAccount?.id]);

  useEffect(() => {
    if (!login) return;
    let timer: number | null = null;
    let cancelled = false;
    const finish = async () => {
      await claude.load();
      if (!cancelled) onComplete();
    };
    const poll = async () => {
      try {
        const status = await request<{ complete: boolean } & LoginState>(`/api/claude-accounts/login/${encodeURIComponent(login.loginId)}`);
        if (cancelled) return;
        if (status.complete) {
          await finish();
          return;
        }
        setLogin((current) => current && current.loginId === login.loginId
          ? { ...current, loginUrl: status.loginUrl, output: status.output, exited: status.exited }
          : current);
      } catch (pollError) {
        if (cancelled) return;
        if (pollError instanceof ApiError && pollError.status === 404) {
          // The pending login lives in server memory, so a Threadex restart loses it even when the CLI finished signing in.
          if (await accountLoggedIn(login.accountId)) {
            await finish();
            return;
          }
          if (cancelled) return;
          setError("The login session ended before Threadex saw it finish. Sign in again.");
          setLogin(null);
          return;
        }
        // Network errors and 5xx while Threadex restarts: keep polling.
      }
      timer = window.setTimeout(() => void poll(), 2000);
    };
    timer = window.setTimeout(() => void poll(), 1500);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [login?.loginId]);

  async function sendCode(event: FormEvent) {
    event.preventDefault();
    if (!login || !loginCode.trim()) return;
    try {
      await request(`/api/claude-accounts/login/${encodeURIComponent(login.loginId)}/code`, { method: "POST", body: JSON.stringify({ code: loginCode }) });
      setLoginCode("");
    } catch (codeError) {
      setError(messageOf(codeError));
    }
  }

  return (
    <div className="account-login-form">
      <label>
        <span>Account name</span>
        <input value={targetAccount?.name ?? accountName} onChange={(event) => onAccountNameChange(event.target.value)} placeholder="Claude Max" readOnly={Boolean(targetAccount)} autoFocus />
      </label>
      {login && (
        <div className="login-link-panel claude-login-panel">
          <span>Login link</span>
          {login.loginUrl
            ? <a href={login.loginUrl} target="_blank" rel="noreferrer">{login.loginUrl}</a>
            : <span>Waiting for the login page… If nothing opens, run this in Terminal:</span>}
          {!login.loginUrl && <code>{login.manualCommand}</code>}
          {login.exited && login.output && <pre>{login.output}</pre>}
          <form className="device-code-row" onSubmit={(event) => void sendCode(event)}>
            <span>Complete sign-in in the browser. Paste the code here if Claude shows one.</span>
            <input value={loginCode} onChange={(event) => setLoginCode(event.target.value)} placeholder="Login code" aria-label="Claude login code" />
            <button className="secondary" type="submit" disabled={!loginCode.trim()}>Send</button>
          </form>
        </div>
      )}
      {error && <p className="claude-login-error" role="alert">{error}</p>}
      <div className="account-login-actions">
        <button className="secondary" type="button" onClick={() => void startLogin()} disabled={(!targetAccount && !accountName.trim()) || starting || Boolean(login)}>
          {starting ? <Loader2 className="spin" aria-hidden="true" /> : <UserPlus aria-hidden="true" />}
          Sign in with Claude
        </button>
      </div>
    </div>
  );
}

/** Claude rows of the Settings › Workspace accounts table. Claude accounts never join load balancing. */
export function ClaudeAccountRows({ claude, onRelogin }: { claude: ClaudeAccounts; onRelogin: (account: ClaudeAccount) => void }) {
  return (
    <>
      {claude.accounts.map((account) => {
        const busy = claude.busyId === account.id;
        return (
          <div key={account.id} className="load-balance-row claude-account-row" role="row">
            <span className="claude-account-no-lb" title={CLAUDE_NO_LOAD_BALANCE} aria-label={CLAUDE_NO_LOAD_BALANCE}>—</span>
            <span>
              <strong>{account.name}</strong>
              <small>Claude · {account.email ?? (account.loggedIn ? "Logged in" : "Not logged in")}{account.subscriptionType ? ` · ${account.subscriptionType}` : ""}</small>
            </span>
            <span>{formatClaudeRemaining(account)}</span>
            <span>{formatClaudeReset(account)}</span>
            <span>{formatClaudeStatus(account, claude.listing?.effectiveAccountId ?? null)}</span>
            <span className="settings-account-actions">
              <button className="secondary" type="button" onClick={() => onRelogin(account)} disabled={Boolean(claude.busyId)} aria-label={`Relogin ${account.name}`}>Relogin</button>
              <button className="settings-delete-account" type="button" onClick={() => void claude.remove(account)} disabled={Boolean(claude.busyId)} title={`Delete ${account.name}`} aria-label={`Delete ${account.name}`}>
                {busy ? <Loader2 className="spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
              </button>
            </span>
          </div>
        );
      })}
      {claude.error && <p className="claude-login-error" role="alert">{claude.error}</p>}
    </>
  );
}

/** Header account popover: choose which Claude account runs Claude models. Adding and login live in Settings › Accounts. */
export function ClaudeAccountsSection({ claude, onLogin }: { claude: ClaudeAccounts; onLogin: (account: ClaudeAccount) => void }) {
  const { listing, accounts, busyId, sessionId } = claude;
  return (
    <section className="claude-accounts-section" aria-label="Claude accounts">
      <header className="claude-accounts-header">
        <strong>Claude</strong>
        <small>Used for Claude models · not in load balancing</small>
      </header>
      <div className="claude-accounts-list">
        {accounts.map((account) => {
          const effective = listing?.effectiveAccountId === account.id;
          const pinned = listing?.sessionAccountId === account.id;
          const quota = account.quotaSnapshot;
          const limited = isClaudeLimited(account);
          return (
            <article key={account.id} className="account-popover-card claude-account-card" data-selected={effective}>
              <button type="button" className="account-popover-select" onClick={() => void claude.select(account.id, "workspace")} disabled={busyId === account.id} title="Use for Claude models in this workspace">
                <span className="account-popover-identity">
                  <strong>{account.name}{pinned ? " · this session" : listing?.workspaceAccountId === account.id ? " · workspace" : ""}</strong>
                  <small>{account.email ?? (account.loggedIn ? "Logged in" : "Not logged in")}{account.subscriptionType ? ` · ${account.subscriptionType}` : ""}</small>
                </span>
                <span className="account-popover-quota">
                  {limited && <span>Limit <strong>0%</strong><small>Reset: {formatQuotaWindowReset({ resetAt: quota?.limitResetsAt ?? null }, "relative")}</small></span>}
                  {!limited && quota?.fiveHour && <span>5hr <strong>{formatQuotaPercent(claudeQuotaWindow(quota.fiveHour))}</strong><small>Auto reset: {formatQuotaWindowReset({ resetAt: quota.fiveHour.resetsAt }, "relative")}</small></span>}
                  {!limited && quota?.weekly && <span>Weekly <strong>{formatQuotaPercent(claudeQuotaWindow(quota.weekly))}</strong><small>Reset: {formatQuotaWindowReset({ resetAt: quota.weekly.resetsAt }, "dateTime")}</small></span>}
                  {!limited && !quota?.fiveHour && !quota?.weekly && <span>{account.loggedIn ? "Usage unavailable" : "—"}</span>}
                </span>
              </button>
              <div className="claude-account-actions">
                {!account.loggedIn && <button type="button" className="account-popover-login" onClick={() => onLogin(account)}>Log in</button>}
                {sessionId && (pinned
                  ? <button type="button" onClick={() => void claude.select(null, "session")} disabled={Boolean(busyId)}>Unpin session</button>
                  : <button type="button" onClick={() => void claude.select(account.id, "session")} disabled={Boolean(busyId)}>Use in this session</button>)}
                <button type="button" className="ghost-icon" onClick={() => void claude.refresh(account)} disabled={busyId === account.id} title="Refresh login and usage" aria-label={`Refresh ${account.name}`}>
                  <RefreshCw className={busyId === account.id ? "spin" : undefined} aria-hidden="true" />
                </button>
              </div>
              {account.quotaError && <small className="account-popover-error claude-account-error">{account.quotaError}</small>}
            </article>
          );
        })}
        {listing && accounts.length === 0 && (
          <p className="account-popover-empty">No Claude accounts. Add one in Settings › Accounts; until then Claude models use this computer's default Claude login.</p>
        )}
      </div>
      {claude.error && <small className="account-popover-error claude-account-error">{claude.error}</small>}
    </section>
  );
}

function isClaudeLimited(account: ClaudeAccount, now = Date.now()) {
  const quota = account.quotaSnapshot;
  return quota?.status === "rejected" && (quota.limitResetsAt ?? 0) > now;
}

function claudeWindows(account: ClaudeAccount) {
  const quota = account.quotaSnapshot;
  return [quota?.fiveHour, quota?.weekly].filter((window): window is QuotaWindow => Boolean(window));
}

export function formatClaudeRemaining(account: ClaudeAccount, now = Date.now()) {
  if (isClaudeLimited(account, now)) return "0%";
  const used = claudeWindows(account).flatMap((window) => window.usedPercent === null ? [] : [window.usedPercent]);
  if (used.length === 0) return account.quotaError ? "Error" : "Unknown";
  return `${Math.round(Math.max(0, 100 - Math.max(...used)))}%`;
}

function formatClaudeReset(account: ClaudeAccount, now = Date.now()) {
  const resetAt = isClaudeLimited(account, now)
    ? account.quotaSnapshot?.limitResetsAt ?? null
    : Math.min(...claudeWindows(account).flatMap((window) => window.resetsAt ? [window.resetsAt] : []));
  if (resetAt && Number.isFinite(resetAt)) return formatTimestampShort(new Date(resetAt).toISOString());
  return account.quotaUpdatedAt ? formatTimestampShort(account.quotaUpdatedAt) : "Unknown";
}

export function formatClaudeStatus(account: ClaudeAccount, effectiveAccountId: string | null, now = Date.now()) {
  if (!account.loggedIn) return "Logged out";
  if (isClaudeLimited(account, now)) return "Limited";
  if (account.quotaError) return claudeWindows(account).length > 0 ? "Stale" : "Error";
  return account.id === effectiveAccountId ? "Active" : "Ready";
}

async function accountLoggedIn(accountId: string) {
  try {
    const result = await request<{ account: ClaudeAccount | null }>(`/api/claude-accounts/${encodeURIComponent(accountId)}/refresh`, { method: "POST" });
    return Boolean(result.account?.loggedIn);
  } catch {
    return false;
  }
}

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new ApiError(body?.error ?? `API returned ${response.status}`, response.status);
  return body as T;
}

/** Adapts a Claude window to the Codex quota-window shape so both popovers show remaining % and resets alike. */
export function claudeQuotaWindow(window: QuotaWindow) {
  return window.usedPercent === null
    ? null
    : { remaining: Math.max(0, Math.min(100, 100 - window.usedPercent)), resetAt: window.resetsAt };
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
