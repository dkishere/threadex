export type PendingTurnReason = "queued" | "rate_limit" | "auth" | "stopped" | null;

type PendingLoadBalanceInput = {
  pendingReason: PendingTurnReason;
  persistedLoadBalance: boolean | null;
  workspaceLoadBalanceEnabled: boolean;
};

/** A saved turn preference never overrides the workspace's current LB switch. */
export function pendingLoadBalanceForUpdate(input: PendingLoadBalanceInput) {
  return input.pendingReason === "rate_limit" &&
    input.workspaceLoadBalanceEnabled &&
    input.persistedLoadBalance !== false;
}

export function pendingUsesWorkspaceAccountPool(input: {
  sessionAccountId: string | null;
  turnAccountId: string | null;
  pendingLoadBalance: boolean | null;
  workspaceLoadBalanceEnabled: boolean;
}) {
  // Different session/turn accounts can result from a manual account switch.
  // That rebind authorizes retrying on the selected account, not choosing one.
  return input.workspaceLoadBalanceEnabled && input.pendingLoadBalance !== false;
}

export function pendingTurnRunsAutomatically(reason: PendingTurnReason) {
  return reason !== "stopped" && reason !== "auth";
}

export function pendingRetryAt(input: {
  alternateAccountAvailable: boolean;
  resetTimes: number[];
  nowMs?: number;
}) {
  const nowMs = input.nowMs ?? Date.now();
  if (input.alternateAccountAvailable) {
    return nowMs;
  }
  const futureResetTimes = input.resetTimes.filter((resetAt) => Number.isFinite(resetAt) && resetAt > nowMs);
  return futureResetTimes.length > 0 ? Math.min(...futureResetTimes) : null;
}

/**
 * Epoch ms when a rate-limited Codex account can be retried, or null when no
 * window in its snapshot is blocked. Only exhausted windows count: a weekly
 * window at 1% must not hold a turn until the weekly reset.
 */
export function codexQuotaRetryAt(quota: Record<string, unknown> | null, nowMs = Date.now()) {
  if (!quota) return null;
  const windows = ["primary", "secondary"].flatMap((key) => {
    const window = quota[key];
    if (!window || typeof window !== "object" || Array.isArray(window)) return [];
    const record = window as Record<string, unknown>;
    const raw = finiteNumber(record.resetsAt) ?? finiteNumber(record.resets_at);
    if (raw === null) return [];
    const resetAt = raw > 10_000_000_000 ? raw : raw * 1000;
    const usedPercent = finiteNumber(record.usedPercent) ?? finiteNumber(record.used_percent);
    return resetAt > nowMs ? [{ resetAt, exhausted: (usedPercent ?? 0) >= 100 }] : [];
  });
  const exhausted = windows.filter((window) => window.exhausted).map((window) => window.resetAt);
  if (exhausted.length > 0) return Math.max(...exhausted);
  // The service reported a limit without saying which window is exhausted.
  const reachedType = quota.rateLimitReachedType ?? quota.rate_limit_reached_type;
  if (typeof reachedType === "string" && reachedType && windows.length > 0) {
    return Math.min(...windows.map((window) => window.resetAt));
  }
  return null;
}

/** Which rate-limited pending turns a manual reset or account switch releases. */
export type LimitWaitScope = {
  provider?: "codex" | "claude";
  accountId?: string;
  workspaceId?: string;
  sessionId?: string;
};

/**
 * Whether a rate-limited turn falls within a clearLimitWait scope. `accountIds`
 * lists every account the turn is bound to or could run on. An empty scope
 * matches nothing, so a missing filter cannot release every waiting turn.
 */
export function pendingInLimitWaitScope(
  turn: { provider: "codex" | "claude"; workspaceId: string; sessionId: string; accountIds: string[] },
  scope: LimitWaitScope
) {
  if (!scope.provider && !scope.accountId && !scope.workspaceId && !scope.sessionId) return false;
  return (!scope.provider || scope.provider === turn.provider) &&
    (!scope.workspaceId || scope.workspaceId === turn.workspaceId) &&
    (!scope.sessionId || scope.sessionId === turn.sessionId) &&
    (!scope.accountId || turn.accountIds.includes(scope.accountId));
}

/** Retry delay when the reset time is unknown; doubles per attempt so a stale snapshot cannot hot-loop. */
export function rateLimitFallbackDelayMs(attempt: number, baseMs: number, maxMs = 30 * 60_000) {
  const exponent = Math.min(Math.max(0, Math.floor(attempt)), 20);
  return Math.min(maxMs, Math.max(0, baseMs) * 2 ** exponent);
}

export function isClaudePendingTurn(
  turn: { provider?: string | null; model?: string | null; requestMetadata?: Record<string, unknown> | null },
  isClaudeModel: (model: string | null | undefined) => boolean
) {
  if (turn.provider === "claude") return true;
  if (turn.provider === "codex") return false;
  const requestedModel = turn.requestMetadata?.model;
  return isClaudeModel(turn.model) || (typeof requestedModel === "string" && isClaudeModel(requestedModel));
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
