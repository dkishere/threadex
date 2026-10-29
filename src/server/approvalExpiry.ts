import { INTENT_APPROVAL_METHOD } from "../intentApproval";

export const APPROVAL_EXPIRED_ERROR = "This approval request expired; nothing is waiting for an answer.";

export type ExpirableApproval = {
  method: string;
  decision?: unknown;
  lastSeenAt?: number;
  resolve?: unknown;
};

// Runners re-register a waiting request every ~30s. A request that stops
// refreshing, with no runner attached to /wait, has lost its waiter. Intention
// approvals are host-owned and expire with their turn instead.
export function isRunnerApprovalStale(approval: ExpirableApproval, now: number, staleMs: number) {
  return approval.method !== INTENT_APPROVAL_METHOD
    && approval.decision === undefined
    && !approval.resolve
    && approval.lastSeenAt !== undefined
    && now - approval.lastSeenAt > staleMs;
}

export type ApprovalOwnerTurn = { sessionId: string; status: string } | null | undefined;

// A runner request belongs to its turn. Once that turn stops running (stopped,
// finished, requeued or deleted), nothing can deliver an answer, even if an
// orphaned runner process still holds /wait or keeps re-registering.
export function isApprovalTurnInactive(approval: ExpirableApproval & { sessionId: string }, turn: ApprovalOwnerTurn) {
  return approval.method !== INTENT_APPROVAL_METHOD
    && approval.decision === undefined
    && (!turn || turn.sessionId !== approval.sessionId || turn.status !== "running");
}

// A persisted request without a resolution row is answerable only while the
// server still holds it; otherwise it is shown as expired, never re-armed.
export function markExpiredApprovalItems(items: unknown[], isPending: (approvalId: string) => boolean) {
  return items.map((item) => {
    if (!item || typeof item !== "object") return item;
    const record = item as Record<string, unknown>;
    if (record.itemType !== "approval" || record.status !== "pending" || typeof record.approvalId !== "string") return item;
    return isPending(record.approvalId) ? item : { ...record, eventType: "item.completed", status: "expired" };
  });
}
