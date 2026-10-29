import type { ActorRoom, ActorWorkItem } from "../domainActors";

/** How another actor or session delivered a prompt into a turn. */
export const PROMPT_ORIGIN_TRIGGERS = [
  "decision-dispatch", "fast-track", "task-update", "handoff", "assignment", "recovery",
  "session-tool", "manager", "concurrent", "task-wake"
] as const;
export type PromptOriginTrigger = typeof PROMPT_ORIGIN_TRIGGERS[number];

/**
 * Durable source of a prompt that an actor or another session wrote into a turn, stored as
 * turn.requestMetadata.promptOrigin. Absent on prompts a user typed. At least one of
 * sourceActorId or sourceSessionId is present; an Actors-chat dispatch has a round, not a session.
 */
export type PromptOrigin = {
  kind: "inter-actor";
  trigger: PromptOriginTrigger;
  sourceActorId?: string;
  sourceActorName?: string;
  sourceSessionId?: string;
  sourceTurnId?: string;
  sourceRoundId?: string;
};

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;

export function normalizePromptOrigin(value: unknown): PromptOrigin | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const trigger = PROMPT_ORIGIN_TRIGGERS.find(item => item === raw.trigger);
  if (raw.kind !== "inter-actor" || !trigger) return undefined;
  const origin: PromptOrigin = { kind: "inter-actor", trigger, sourceActorId: text(raw.sourceActorId), sourceActorName: text(raw.sourceActorName),
    sourceSessionId: text(raw.sourceSessionId), sourceTurnId: text(raw.sourceTurnId), sourceRoundId: text(raw.sourceRoundId) };
  if (!origin.sourceActorId && !origin.sourceSessionId) return undefined;
  return Object.fromEntries(Object.entries(origin).filter(([, item]) => item !== undefined)) as PromptOrigin;
}

/** Origin of an actor task's first prompt: a handoff, an actor_assign_many child, or a Decision dispatch from the Actors chat. */
export function actorTaskPromptOrigin(room: Pick<ActorRoom, "actors" | "workItems">, work: ActorWorkItem): PromptOrigin {
  const parent = work.parentWorkItemId ? room.workItems.find(item => item.id === work.parentWorkItemId) : undefined;
  const sourceActorId = work.handoff?.sourceActorId ?? work.ownerActorId;
  const sourceActorName = room.actors.find(actor => actor.id === sourceActorId)?.name;
  const source = work.handoff
    ? { trigger: "handoff" as const, sourceSessionId: work.handoff.sourceSessionId }
    : parent ? { trigger: "assignment" as const, sourceSessionId: parent.taskSessionId, sourceTurnId: parent.activeTurnId ?? parent.taskTurnId }
      : { trigger: "decision-dispatch" as const };
  return normalizePromptOrigin({ kind: "inter-actor", sourceActorId, sourceActorName, sourceRoundId: work.roundId, ...source })!;
}

/**
 * The single write-side gate for prompt origins: a prompt from the user's own client is never
 * inter-actor, and an actor task session's executor and actor name are filled from the room.
 */
export async function resolvePromptOrigin(input: { promptOrigin?: unknown; fromUser: boolean; workspaceId?: string },
  getRoom: (workspaceId: string) => Promise<Pick<ActorRoom, "actors" | "workItems"> | null>): Promise<PromptOrigin | undefined> {
  const origin = input.fromUser ? undefined : normalizePromptOrigin(input.promptOrigin);
  if (!origin || !input.workspaceId || origin.sourceActorId && origin.sourceActorName) return origin;
  const room = await getRoom(input.workspaceId).catch(() => null);
  if (!room) return origin;
  const sourceActorId = origin.sourceActorId
    ?? room.workItems.find(work => work.taskSessionId === origin.sourceSessionId)?.executorActorId;
  const sourceActorName = origin.sourceActorName ?? room.actors.find(actor => actor.id === sourceActorId)?.name;
  return { ...origin, ...(sourceActorId ? { sourceActorId } : {}), ...(sourceActorName ? { sourceActorName } : {}) };
}
