import { actorProjectGroups, actorRoundInGroupChat, type ActorProjectGroup, type ActorProject, type ActorRoom, type ActorRunningSession, type ActorSummary, type ActorSummaryBlocker, type ActorWorkItem } from "../domainActors";
import { actorDialogConclusions } from "../actorConclusions";
import { actorBlockerActive, actorBlockerAskingUser, type ActorBlocker } from "../actorBlockers";

/** Upper bound on summary blockers; the shell polls the summary, so it must stay light. */
export const ACTOR_SUMMARY_BLOCKER_LIMIT = 50;

/** Active, non-self-clearing blockers, newest `updated` first, capped. Pass a room read through
 * DomainActorService.getRoom so overdue proposal deadlines are already escalated. */
export function actorSummaryBlockers(room: Pick<ActorRoom, "blockers">): ActorBlocker[] {
  return (room.blockers ?? []).filter(blocker => actorBlockerActive(blocker) && !blocker.selfClearing)
    .sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, ACTOR_SUMMARY_BLOCKER_LIMIT);
}

/** Adds each group chat's latest activity: its newest round or the newest update of work its rounds created. */
function actorGroupsWithActivity(room: Pick<ActorRoom, "rounds" | "workItems">, groups: ActorProjectGroup[]): ActorProjectGroup[] {
  const updatedByRound = new Map<string, string>();
  for (const item of room.workItems) {
    const known = updatedByRound.get(item.roundId);
    if (!known || item.updated > known) updatedByRound.set(item.roundId, item.updated);
  }
  return groups.map(group => {
    let latest = "";
    for (const round of room.rounds) {
      if (!actorRoundInGroupChat(round, group.projectId)) continue;
      for (const time of [round.created, updatedByRound.get(round.id)]) if (time && time > latest) latest = time;
    }
    return latest ? { ...group, lastActivityAt: latest } : group;
  });
}

const OPEN_STATUSES =new Set<ActorWorkItem["status"]>(["claimed", "assigned", "started"]);

/** Needs you is derived from what the work still waits on, not trusted from its stored status, which can outlive it:
 * - a decision question still being asked is a reminder whatever the task's own status, since it never gates the task;
 * - needs_user holds only while an approval is pending in a live turn
 *   (an approval cannot outlive its turn; a late or replayed request must not revive the badge);
 * - failed holds until the same executor is dispatched again for the same round, which supersedes the failed attempt. */
function actorWorkNeedsUser(room: Pick<ActorRoom, "workItems" | "blockers">, item: ActorWorkItem, liveWorkItemIds: ReadonlySet<string>) {
  if (!item.cancelledAt && (room.blockers ?? []).some(blocker => blocker.workItemId === item.id && actorBlockerAskingUser(blocker))) return true;
  if (item.status === "needs_user") {
    return liveWorkItemIds.has(item.id) && (item.pendingApprovalIds === undefined || item.pendingApprovalIds.length > 0);
  }
  if (item.status !== "failed") return false;
  return !(item.roundId && item.created && room.workItems.some(later => later.id !== item.id && !later.cancelledAt
    && later.roundId === item.roundId && later.executorActorId === item.executorActorId && later.created > item.created));
}

/** Per-actor workload counts. Sub-actors count the work they execute; root
 * actors roll up work owned or executed anywhere in their tree. `running` counts
 * only sessions run by that actor, so summing it never counts a session twice. */
export function actorSummary(room: ActorRoom, running: ActorRunningSession[], taskSessionTitles: ReadonlyMap<string, string | undefined> = new Map(), projects: ActorProject[] | null = null): ActorSummary {
  const blockers = actorSummaryBlockers(room).map((blocker): ActorSummaryBlocker => {
    const taskSessionTitle = taskSessionTitles.get(blocker.taskSessionId);
    return taskSessionTitle ? { ...structuredClone(blocker), taskSessionTitle } : structuredClone(blocker);
  });
  const liveWorkItemIds = new Set(running.map(session => session.workItemId));
  return { workspaceId: room.workspaceId, revision: room.revision, blockers, ...(projects ? { groups: actorGroupsWithActivity(room, actorProjectGroups(room.actors, projects)) } : {}), actors: room.actors.map(actor => {
    const members = new Set(actor.parentActorId === null
      ? [actor.id, ...room.actors.filter(candidate => candidate.parentActorId === actor.id).map(candidate => candidate.id)]
      : [actor.id]);
    const items = new Map<string, ActorWorkItem>();
    for (const item of room.workItems) {
      const belongs = actor.parentActorId === null
        ? members.has(item.ownerActorId) || members.has(item.executorActorId)
        : item.executorActorId === actor.id;
      if (belongs) items.set(item.id, item);
    }
    const counts = { open: 0, attention: 0 };
    for (const item of items.values()) {
      if (item.cancelledAt) continue;
      if (actorWorkNeedsUser(room, item, liveWorkItemIds)) counts.attention++;
      else if (OPEN_STATUSES.has(item.status)) counts.open++;
    }
    return { type: "worker" as const, id: actor.id, name: actor.name, rootActorId: actor.rootActorId, parentActorId: actor.parentActorId, model: actor.model,
      ...(actor.avatar !== undefined ? { avatar: actor.avatar } : {}), ...(actor.projectIds?.length ? { projectIds: [...actor.projectIds] } : {}), counts, running: new Set(running.filter(session => session.actorId === actor.id).map(session => session.sessionId)).size,
      unreadConclusions: actorDialogConclusions(room, actor.id).filter(conclusion => !conclusion.acknowledgedAt).length };
  }) };
}
