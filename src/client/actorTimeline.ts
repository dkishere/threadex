import type { ActorDialogConclusion, ActorRoom, ActorRoomEvent, ActorRound, DomainActor } from "../domainActors";
import { actorDialogConclusions } from "../actorConclusions";
import { actorTreeIds } from "./actorRoomPresentation";

export type ActorTimelineEntry = { id: string; created: string } & (
  | { kind: "conversation"; source: "direct" | "group"; round: ActorRound }
  | { kind: "task"; event: ActorRoomEvent }
  | { kind: "conclusion"; conclusion: ActorDialogConclusion }
);

/** A round the actor's tree only saw as unrelated (declared outside its role, no claim, no task, not named) stays out of its timeline. */
function declinedByTree(round: ActorRound, tree: Set<string>, works: ActorRoom["workItems"]) {
  const involved = [...new Set([...round.stakeholderIds, ...round.replies.map(reply => reply.actorId)])].filter(id => tree.has(id));
  if (!involved.length || round.namedActorIds.some(id => tree.has(id)) || (round.ownerActorId && tree.has(round.ownerActorId))) return false;
  if (works.some(work => work.roundId === round.id || round.workItemIds?.includes(work.id) || round.continuation?.workItem?.id === work.id)) return false;
  return involved.every(id => {
    const reply = round.replies.find(reply => reply.actorId === id);
    return reply?.status === "opinion" && reply.intent === "work" && reply.inRole === false;
  });
}

/** Replies have no timestamps: keep each exchange together at its request time. */
export function actorTimeline(room: ActorRoom, actor: DomainActor): ActorTimelineEntry[] {
  const tree = actorTreeIds([...room.actors.filter(item => item.id !== actor.id), actor], actor.id);
  const works = room.workItems.filter(work => tree.has(work.ownerActorId) || tree.has(work.executorActorId)
    || work.executionHistory.some(execution => tree.has(execution.executorActorId)));
  const workIds = new Set(works.map(work => work.id));
  const entries = new Map<string, ActorTimelineEntry>();
  for (const round of room.rounds) {
    if (declinedByTree(round, tree, works)) continue;
    if (![...round.namedActorIds, ...round.stakeholderIds, ...round.replies.map(reply => reply.actorId), round.ownerActorId]
      .some(id => id && tree.has(id)) && !works.some(work => work.roundId === round.id || round.workItemIds?.includes(work.id)
        || round.continuation?.workItem?.id === work.id)) continue;
    const id = `round:${round.id}`;
    entries.set(id, { id, created: round.created, kind: "conversation", source: round.namedActorIds.length === 1 ? "direct" : "group", round });
  }
  for (const event of room.events) {
    if (event.type === "sh.completed" || !(event.actorIds.some(id => tree.has(id)) || event.workItemId && workIds.has(event.workItemId))) continue;
    // A repeated delivery of the same lifecycle event must not duplicate a row.
    const id = event.type !== "task.needs_user" && event.workItemId && event.taskSessionId && event.taskTurnId
      ? `task:${event.workItemId}:${event.taskSessionId}:${event.taskTurnId}:${event.type}` : `event:${event.id}`;
    if (!entries.has(id)) entries.set(id, { id, created: event.created, kind: "task", event });
  }
  for (const conclusion of actorDialogConclusions(room, actor.id)) {
    const id = `conclusion:${conclusion.id}`;
    entries.set(id, { id, created: conclusion.created, kind: "conclusion", conclusion });
  }
  const rank = { conversation: 0, task: 1, conclusion: 2 };
  return [...entries.values()].sort((a, b) => (Date.parse(a.created) || 0) - (Date.parse(b.created) || 0)
    || rank[a.kind] - rank[b.kind] || a.id.localeCompare(b.id));
}

export function actorTimelineTime(created: string): string {
  const date = new Date(created);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString();
}
