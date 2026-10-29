import type { ActorRoom, ActorRound, ActorWorkItem, ActorWorkloadCounts, DomainActor } from "../domainActors";
import { mentionedActors, SIDE_CHAT_MAX_ACTORS } from "../sideChatRoom";

export function actorRoundWorkItems(room: ActorRoom, round: ActorRound) {
  return room.workItems.filter(item => item.roundId === round.id || round.workItemIds?.includes(item.id)
    || round.continuation?.workItem?.id === item.id);
}

export function actorMentionPreview(prompt: string, actors: DomainActor[]) {
  const named = mentionedActors(prompt, actors);
  return { named, tooMany: named.length > SIDE_CHAT_MAX_ACTORS };
}

export function actorRoutingFailure(round: ActorRound, actors: DomainActor[]) {
  if (!round.error?.startsWith("Claim arbitration failed")) return round.error;
  const decision = round.routingDecisions.owner;
  const owner = decision?.ok ? decision.answers.owner : undefined;
  if (owner?.kind !== "choice") return round.error;
  const reason = owner.choice === "other" ? "Decision did not find a suitable claimant."
    : "Decision could not select a claimant with enough confidence.";
  const timeouts = round.replies.filter(reply => reply.status === "timeout").map(reply =>
    actors.find(actor => actor.id === reply.actorId)?.name ?? round.actorSnapshots.find(actor => actor.id === reply.actorId)?.name ?? reply.actorId);
  return `${reason}${timeouts.length ? ` Timed out before selection: ${timeouts.join(", ")}.` : ""} Retry the request to ask the actors again, or address an actor directly.`;
}

export function actorTaskPresentation(item: ActorWorkItem, events: ActorRoom["events"]) {
  const started = item.status === "started" && events.some(event => event.type === "task.started" && event.workItemId === item.id &&
    event.taskSessionId === item.taskSessionId && event.taskTurnId === (item.activeTurnId ?? item.taskTurnId));
  const stopped = !!item.dispatched && !!item.stoppedAt && (!item.lastEventAt || item.stoppedAt >= item.lastEventAt) && item.status !== "completed";
  const label = item.cancelledAt ? "Cancelled" : stopped ? "Stopped" : started ? "Started" : item.status === "started" ? "Waiting for start confirmation"
    : ({ claimed: "Claimed", assigned: "Assigned · waiting to start", completed: "Completed", failed: "Failed", needs_user: "Needs your input" } as const)[item.status];
  return { started, label };
}

export function actorOwnerExplanation(round: Pick<ActorRound, "namedActorIds" | "ownerActorId" | "replies" | "routingDecisions">, actors: DomainActor[]) {
  const name = (id: string) => actors.find(actor => actor.id === id)?.name ?? id;
  if (round.namedActorIds.length === 1) return `You directly addressed ${name(round.namedActorIds[0])}.`;
  const claims = round.replies.filter(reply => reply.status === "claimed");
  if (claims.length === 1) return `${name(claims[0].actorId)} was the only actor offering to take this request.`;
  const alternatives = claims.filter(reply => reply.actorId !== round.ownerActorId).map(reply => name(reply.actorId));
  const decision = round.routingDecisions.owner;
  const answer = decision?.ok ? Object.values(decision.answers).find(answer => answer.kind === "choice") : undefined;
  const probabilities = answer?.kind === "choice" && answer.probabilities
    ? ` Selection scores: ${Object.entries(answer.probabilities).map(([id, value]) => `${name(id)} ${Math.round(value * 100)}%`).join(", ")}.` : "";
  return `${round.ownerActorId ? name(round.ownerActorId) : "An actor"} was selected${alternatives.length ? ` over ${alternatives.join(", ")}` : ""}, based on the offers above.${probabilities}`;
}

export type ActorDialogMode = "individual" | "group";
type TreeActor = Pick<DomainActor, "id" | "parentActorId" | "rootActorId">;

/** A root actor's tree is itself plus its direct sub-actors; a sub-actor is only itself. */
export function actorTreeIds(actors: TreeActor[], actorId: string): Set<string> {
  const actor = actors.find(candidate => candidate.id === actorId);
  if (actor?.parentActorId) return new Set([actorId]);
  return new Set([actorId, ...actors.filter(candidate => candidate.parentActorId === actorId).map(candidate => candidate.id)]);
}

function isIndividualRound(round: Pick<ActorRound, "namedActorIds">, actorId: string) {
  return round.namedActorIds.length === 1 && round.namedActorIds[0] === actorId;
}

/** Individual: rounds addressed only to the actor. Group: other rounds the actor's tree took part in. */
export function actorDialogRounds(room: Pick<ActorRoom, "rounds" | "actors">, actor: DomainActor, mode: ActorDialogMode): ActorRound[] {
  if (mode === "individual") return room.rounds.filter(round => isIndividualRound(round, actor.id));
  const tree = actorTreeIds(room.actors.some(candidate => candidate.id === actor.id) ? room.actors : [...room.actors, actor], actor.id);
  return room.rounds.filter(round => !isIndividualRound(round, actor.id) && (
    round.stakeholderIds.some(id => tree.has(id)) || round.replies.some(reply => tree.has(reply.actorId)) ||
    (round.ownerActorId !== null && tree.has(round.ownerActorId))));
}

export type ActorOwnedSession = { workItem: ActorWorkItem; sessionId: string; current: boolean; executorActorId: string; status: ActorWorkItem["status"] };

/** Sessions an actor is accountable for: roots by tree ownership, sub-actors by their own execution. Newest work first. */
export function actorOwnedSessions(room: Pick<ActorRoom, "workItems" | "actors" | "archivedSessionIds">, actor: DomainActor): ActorOwnedSession[] {
  const archived = new Set(room.archivedSessionIds ?? []);
  return actorSessionEntries(room, actor).filter(entry => !archived.has(entry.sessionId));
}

function actorSessionEntries(room: Pick<ActorRoom, "workItems" | "actors">, actor: DomainActor): ActorOwnedSession[] {
  const sub = !!actor.parentActorId;
  const tree = actorTreeIds(room.actors.some(candidate => candidate.id === actor.id) ? room.actors : [...room.actors, actor], actor.id);
  const items = room.workItems
    .map((workItem, index) => ({ workItem, index }))
    .filter(({ workItem }) => sub
      ? workItem.executorActorId === actor.id || workItem.executionHistory.some(entry => entry.executorActorId === actor.id)
      : tree.has(workItem.ownerActorId))
    .sort((a, b) => (Date.parse(b.workItem.updated) || 0) - (Date.parse(a.workItem.updated) || 0) || b.index - a.index)
    .map(({ workItem }) => workItem);
  const currentOf = (workItem: ActorWorkItem) => !!workItem.taskSessionId && (!sub || workItem.executorActorId === actor.id);
  // A session that is still some work item's current execution is never listed as an earlier one.
  const currentIds = new Set(items.filter(currentOf).map(workItem => workItem.taskSessionId));
  const entries = new Map<string, ActorOwnedSession>();
  for (const workItem of items) {
    if (currentOf(workItem) && !entries.has(workItem.taskSessionId))
      entries.set(workItem.taskSessionId, { workItem, sessionId: workItem.taskSessionId, current: true, executorActorId: workItem.executorActorId, status: workItem.status });
    for (const entry of [...workItem.executionHistory].reverse()) {
      if (!entry.taskSessionId || (sub && entry.executorActorId !== actor.id) || currentIds.has(entry.taskSessionId) || entries.has(entry.taskSessionId)) continue;
      entries.set(entry.taskSessionId, { workItem, sessionId: entry.taskSessionId, current: false, executorActorId: entry.executorActorId, status: entry.status });
    }
  }
  return [...entries.values()];
}

/** Group dialog recipients: the actor first, then other mentioned actors (deduplicated). A group round needs at least one other actor. */
export function actorGroupRecipients(actor: Pick<DomainActor, "id">, mentioned: Array<Pick<DomainActor, "id">>): { ids: string[]; ready: boolean; tooMany: boolean } {
  const ids = [...new Set([actor.id, ...mentioned.map(candidate => candidate.id)])];
  return { ids, ready: ids.length > 1, tooMany: ids.length > SIDE_CHAT_MAX_ACTORS };
}

export function actorWorkloadBadge(counts: ActorWorkloadCounts): { open: string; attention: string | null } {
  return { open: `Open ${counts.open}`, attention: counts.attention > 0 ? `Needs you ${counts.attention}` : null };
}

export type ActorStoppableTurn = { workItemId: string; sessionId: string; turnId: string };

/** Dispatched tasks of the visible rounds that are still running; an explicit Stop ends a task unless a later event supersedes it.
 * Native split children run in their host's turn: stopping the host stops them, so they have no turn of their own. */
export function actorStoppableTurns(workItems: ActorWorkItem[], rounds: Pick<ActorRound, "id">[]): ActorStoppableTurn[] {
  const visible = new Set(rounds.map(round => round.id));
  return workItems.filter(item => visible.has(item.roundId) && !item.hostWorkItemId && item.dispatched && !item.dispatchError && !!item.taskSessionId
    && (item.status === "assigned" || item.status === "started")
    && !(item.stoppedAt && (!item.lastEventAt || item.stoppedAt >= item.lastEventAt)))
    .map(item => ({ workItemId: item.id, sessionId: item.taskSessionId, turnId: item.activeTurnId ?? item.taskTurnId }))
    .filter(turn => !!turn.turnId);
}
