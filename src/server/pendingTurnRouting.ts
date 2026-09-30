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
