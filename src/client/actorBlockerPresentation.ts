import { actorBlockerActive, actorBlockerPendingDecision, type ActorBlocker, type ActorBlockerEscalationReason, type ActorBlockerKind, type ActorBlockerProposal, type ActorBlockerStatus } from "../actorBlockers";

export type ActorBlockerView = ActorBlocker & { ownerActorName?: string; taskSessionTitle?: string };

export const BLOCKER_STATUS_LABELS: Record<ActorBlockerStatus, string> = {
  open: "Open", solution_proposed: "Solution proposed", attempting: "Fix in progress", resolved: "Resolved",
  rejected: "Proposal rejected", failed: "Fix failed", escalated: "Escalated", dismissed: "Dismissed"
};
export const BLOCKER_KIND_LABELS: Record<ActorBlockerKind, string> = {
  "dependency-task": "Dependency", approval: "Approval", permission: "Permission", "rate-limit": "Usage limit",
  external: "External", "design-decision": "Design decision", error: "Error", other: "Other"
};
export const BLOCKER_ESCALATION_LABELS: Record<ActorBlockerEscalationReason, string> = {
  proposal_failed: "the proposed fix failed", proposal_rejected: "the proposal was rejected",
  unresolvable: "its owner declared it unresolvable", no_proposal_timeout: "no solution was proposed in time"
};

/** Active blockers the user should see: self-clearing waits are excluded, escalated ones first, then newest. */
export function visibleBlockers<T extends ActorBlocker>(blockers: readonly T[] | undefined): T[] {
  return (blockers ?? []).filter(blocker => actorBlockerActive(blocker) && !blocker.selfClearing)
    .sort((a, b) => Number(b.status === "escalated") - Number(a.status === "escalated") || b.updated.localeCompare(a.updated));
}

export function taskBlockers<T extends ActorBlocker>(blockers: readonly T[] | undefined, sessionId: string | null | undefined) {
  return sessionId ? visibleBlockers(blockers).filter(blocker => blocker.taskSessionId === sessionId) : [];
}

/** Counted under the executing actor, matching actorBlockerOverview: a sub-actor's blockers are not added to its parent. */
export function actorBlockers<T extends ActorBlocker>(blockers: readonly T[] | undefined, actorId: string) {
  return visibleBlockers(blockers).filter(blocker => blocker.executorActorId === actorId);
}

export function blockerCounts(blockers: readonly ActorBlocker[]) {
  return { active: blockers.length, escalated: blockers.filter(blocker => blocker.status === "escalated").length,
    pendingDecision: blockers.filter(blocker => actorBlockerPendingDecision(blocker)).length };
}

export function blockerCountLabel(counts: ReturnType<typeof blockerCounts>) {
  return [`${counts.active} active blocker${counts.active === 1 ? "" : "s"}`,
    counts.escalated ? `${counts.escalated} escalated` : "",
    counts.pendingDecision ? `${counts.pendingDecision} awaiting your decision` : ""].filter(Boolean).join(", ");
}

export function blockerProposalState(proposal: ActorBlockerProposal) {
  if (proposal.outcome === "rejected") return "Rejected";
  if (proposal.outcome === "failed") return "Failed";
  if (proposal.outcome === "succeeded") return "Succeeded";
  if (proposal.outcome === "attempting") return "In progress";
  if (proposal.approval) return "Approved by you";
  return proposal.requiresApproval ? "Awaiting your approval" : "Proposed";
}
