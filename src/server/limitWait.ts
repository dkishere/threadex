import { pendingInLimitWaitScope, type LimitWaitScope } from "./pendingTurnRouting";

type LimitWaitTurn = {
  turnId: string;
  sessionId: string;
  workspaceId: string;
  provider: "codex" | "claude";
  rateLimited: boolean;
};

type LimitWaitSubscription = { eventId: string; turnId: string | null; actionType: string };

export type LimitWaitDeps<T extends LimitWaitTurn> = {
  listPending: () => Promise<T[]>;
  /** Accounts the turn is bound to or would run on; only consulted when the scope names an account. */
  accountIds: (turn: T, accountId: string) => Promise<string[]>;
  clearTimer: (turnId: string) => void;
  listWaitingSubscriptions: (sessionId: string) => Promise<LimitWaitSubscription[]>;
  cancelTurnSubscriptions: (turnId: string) => Promise<unknown>;
  /** Cancels the quota event once no other waiter remains on it. */
  releaseQuotaEvent: (eventId: string) => Promise<unknown>;
  /** Re-evaluates quota and resumes or reschedules; must not throw synchronously. */
  resume: (turnId: string) => void;
};

/**
 * Releases rate-limit waits in scope after a manual reset or account switch:
 * drops their timers and quota wake subscriptions, then hands each turn to a
 * quota re-evaluation that resumes the original session or reschedules it.
 * Only rate-limited turns match, so stopped, auth and queued turns stay put.
 */
export async function clearLimitWaits<T extends LimitWaitTurn>(scope: LimitWaitScope, deps: LimitWaitDeps<T>) {
  const cleared: string[] = [];
  for (const turn of await deps.listPending()) {
    if (!turn.rateLimited) continue;
    const accountIds = scope.accountId ? await deps.accountIds(turn, scope.accountId) : [];
    if (!pendingInLimitWaitScope({ ...turn, accountIds }, scope)) continue;

    deps.clearTimer(turn.turnId);
    const waits = (await deps.listWaitingSubscriptions(turn.sessionId))
      .filter((subscription) => subscription.turnId === turn.turnId && subscription.actionType === "retry_turn");
    await deps.cancelTurnSubscriptions(turn.turnId);
    for (const eventId of new Set(waits.map((subscription) => subscription.eventId))) {
      await deps.releaseQuotaEvent(eventId);
    }
    cleared.push(turn.turnId);
  }
  for (const turnId of cleared) deps.resume(turnId);
  return { turnIds: cleared };
}
