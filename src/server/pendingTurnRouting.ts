export type PendingTurnReason = "queued" | "rate_limit" | "auth" | "stopped" | null;

type PendingLoadBalanceInput = {
  pendingReason: PendingTurnReason;
  persistedLoadBalance: boolean | null;
  workspaceLoadBalanceEnabled: boolean;
};

/**
 * Keep the routing choice on the turn itself. The server's enabled-workspace
 * set is intentionally ephemeral, so it cannot be the only signal when a
 * runner reports a limit after the server has restarted.
 */
export function pendingLoadBalanceForUpdate(input: PendingLoadBalanceInput) {
  // Session/account affinity is intentionally soft. Any usage or credit
  // exhaustion may fail over to another account in the workspace, even when
  // the original turn was started with an explicitly selected account.
  return input.pendingReason === "rate_limit";
}

export function pendingUsesWorkspaceAccountPool(input: {
  sessionAccountId: string | null;
  turnAccountId: string | null;
  pendingLoadBalance: boolean | null;
  workspaceLoadBalanceEnabled: boolean;
}) {
  return input.sessionAccountId !== input.turnAccountId ||
    input.pendingLoadBalance === true ||
    input.workspaceLoadBalanceEnabled;
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
