import type { ActorRoom, DomainActor } from "../domainActors";

export type SessionOwnerActor = {
  actor: Pick<DomainActor, "id" | "name" | "avatar">;
  /** "owner" runs the session itself; "guest" runs @mentioned turns or native sub-agent tasks inside it. */
  kind: "owner" | "guest";
  /** Name of the parent actor when this one is a sub-actor. */
  parentActorName: string | null;
};

/**
 * Actors currently responsible for a session, owner first. Uses the same binding as the server's
 * Pick owner check (a non-turn-scoped top-level work item), so the badge and Pick owner never disagree about the owner.
 * The executing actor is shown, never the parent that only claimed the work.
 */
export function sessionOwnerActors(room: Pick<ActorRoom, "workItems" | "actors"> | null, sessionId: string | null): SessionOwnerActor[] {
  if (!room || !sessionId) return [];
  const here = room.workItems.filter(work => work.taskSessionId === sessionId && !work.cancelledAt);
  const ownerWork = here.find(work => !work.hostWorkItemId && work.sessionScope !== "turn");
  const ordered = [...(ownerWork ? [ownerWork] : []), ...here.filter(work => work !== ownerWork)];
  const seen = new Set<string>();
  const result: SessionOwnerActor[] = [];
  for (const work of ordered) {
    if (!work.executorActorId || seen.has(work.executorActorId)) continue;
    seen.add(work.executorActorId);
    const actor = room.actors.find(candidate => candidate.id === work.executorActorId);
    if (!actor) continue;
    const parent = actor.parentActorId ? room.actors.find(candidate => candidate.id === actor.parentActorId) : null;
    result.push({ actor, kind: work === ownerWork ? "owner" : "guest", parentActorName: parent?.name ?? null });
  }
  return result;
}
