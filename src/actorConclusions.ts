import { actorPublishableConclusions, type ActorDialogConclusion, type ActorRoom } from "./domainActors";

/** Consume the producer's publication gate; never infer a verdict from task completion. */
export function newActorConclusions(room: ActorRoom): ActorDialogConclusion[] {
  const known = new Set((room.conclusions ?? []).map(conclusion => conclusion.id));
  return room.workItems.flatMap(actorPublishableConclusions).filter(conclusion => {
    if (known.has(conclusion.id)) return false;
    known.add(conclusion.id);
    return true;
  }).map(conclusion => ({ ...conclusion }));
}

export function captureActorConclusions(room: ActorRoom): void {
  const additions = newActorConclusions(room);
  if (additions.length) (room.conclusions ??= []).push(...additions);
}

/** Exact executor matching: parent ownership does not grant a second dialog notification. */
export function actorDialogConclusions(room: Pick<ActorRoom, "conclusions">, actorId: string): ActorDialogConclusion[] {
  return [...new Map((room.conclusions ?? []).filter(conclusion => conclusion.actorId === actorId)
    .map(conclusion => [conclusion.id, conclusion])).values()];
}
