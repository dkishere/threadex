import type { LimitWaitScope } from "./pendingTurnRouting";

/** A pending turn as seen by an account-switch trigger; read-only projection. */
export type AccountSwitchPendingTurn = {
  sessionId: string;
  workspaceId: string;
  provider: "codex" | "claude";
  rateLimited: boolean;
  sessionAccountId: string | null;
  turnAccountId: string | null;
  /** The turn picks its account from the workspace load-balance pool. */
  usesWorkspacePool: boolean;
};

export type CodexAccountSwitch = {
  workspaceId: string;
  /** The account the workspace (and the rebound session, if any) now uses. */
  accountId: string;
  /** The workspace's active account before the switch. */
  previousActiveAccountId: string | null;
  /** Set when the switch also rebound one session to `accountId`. */
  session?: { id: string; previousAccountId: string | null };
};

/**
 * Which rate-limited Codex turns a manual account switch moves onto the new
 * account, as clearLimitWait scopes. Only turns that will actually run on the
 * new account are released: the rebound session, plus sessions in the same
 * workspace that follow its active account or draw from its pool. Turns already
 * bound to the new account, or pinned to another account, keep their wait.
 */
export function codexAccountSwitchLimitWaitScopes(
  pending: AccountSwitchPendingTurn[],
  change: CodexAccountSwitch
): LimitWaitScope[] {
  const waiting = pending.filter((turn) =>
    turn.provider === "codex" && turn.rateLimited && turn.workspaceId === change.workspaceId);
  const sessionIds = new Set<string>();
  const reboundId = change.session?.id;
  if (change.session && change.session.previousAccountId !== change.accountId &&
    waiting.some((turn) => turn.sessionId === reboundId)) {
    sessionIds.add(change.session.id);
  }
  if (change.previousActiveAccountId !== change.accountId) {
    for (const turn of waiting) {
      if (turn.sessionId === reboundId) continue;
      if (turn.sessionAccountId !== null && !turn.usesWorkspacePool) continue;
      if (turn.turnAccountId === change.accountId) continue;
      sessionIds.add(turn.sessionId);
    }
  }
  return [...sessionIds].map((sessionId) => ({ provider: "codex" as const, workspaceId: change.workspaceId, sessionId }));
}
