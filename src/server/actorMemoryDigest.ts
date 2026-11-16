import { actorProjectIds, UNASSIGNED_ACTOR_PROJECT, type ActorMemoryDigestRecord, type ActorMemoryDigestTurnSummary, type ActorRoom } from "../domainActors";

/** Collective memory digest: a per-project catch-up of actor memory from every session's finished turns,
 * including ordinary sessions and changes no actor event delivered. See docs/domain-actors.md#collective-memory-digest. */
export const MEMORY_DIGEST_MIN_TURNS = 20;
export const MEMORY_DIGEST_IDLE_MS = 15 * 60_000;
export const MEMORY_DIGEST_TICK_MS = 2 * 60_000;
/** A turn whose summary still fails this long after its batch started is skipped, so one turn cannot hold a project's digest. */
export const MEMORY_DIGEST_SUMMARY_GIVE_UP_MS = 60 * 60_000;
/** Saved before/after diffs kept per actor, newest last. */
export const MEMORY_DIGEST_RECORD_LIMIT = 20;

/** One session turn of a workspace, already mapped to its project by the session's cwd. */
export type ActorMemoryDigestTurn = {
  sessionId: string; turnId: string;
  /** Registered project whose most specific root contains the session cwd, otherwise UNASSIGNED_ACTOR_PROJECT. */
  projectKey: string;
  status: "done" | "running" | "queued";
  /** ISO time of the turn's last runner activity (its end for a finished turn), at millisecond precision. */
  lastActivityAt: string;
  userInput: string; agentResponse: string; changedFiles: string[]; runnerExitCode: number | null;
};

export type MemoryDigestReadiness = { state: "busy" | "waiting"; completedTurns: number }
  | { state: "due"; batch: ActorMemoryDigestTurn[]; watermark: string };

const byActivity = (left: ActorMemoryDigestTurn, right: ActorMemoryDigestTurn) =>
  left.lastActivityAt.localeCompare(right.lastActivityAt) || left.turnId.localeCompare(right.turnId);

/** Finished turns of one project after `watermark`, up to `until` when given, oldest first. */
export function memoryDigestFinishedTurns(turns: readonly ActorMemoryDigestTurn[], projectKey: string, watermark: string, until?: string) {
  const after = Date.parse(watermark), upTo = until === undefined ? Infinity : Date.parse(until);
  return turns.filter(turn => turn.projectKey === projectKey && turn.status === "done"
    && Date.parse(turn.lastActivityAt) > after && Date.parse(turn.lastActivityAt) <= upTo).sort(byActivity);
}

/** A project's digest is due once at least `minTurns` turns finished after its watermark and the project has been idle
 * for `idleMs`: no running turn, no queued turn active within `idleMs` (a turn queued for weeks never makes a project
 * busy), and its last finished turn at least `idleMs` ago. */
export function memoryDigestReadiness(input: { turns: readonly ActorMemoryDigestTurn[]; projectKey: string; watermark: string;
  now: number; minTurns: number; idleMs: number }): MemoryDigestReadiness {
  const finished = memoryDigestFinishedTurns(input.turns, input.projectKey, input.watermark);
  if (input.turns.some(turn => turn.projectKey === input.projectKey && (turn.status === "running"
    || turn.status === "queued" && input.now - Date.parse(turn.lastActivityAt) < input.idleMs))) return { state: "busy", completedTurns: finished.length };
  const lastActivity = finished.length ? Date.parse(finished.at(-1)!.lastActivityAt) : -Infinity;
  if (finished.length < input.minTurns || input.now - lastActivity < input.idleMs) return { state: "waiting", completedTurns: finished.length };
  return { state: "due", batch: finished, watermark: new Date(lastActivity).toISOString() };
}

export function memoryDigestSourceEventId(projectKey: string, watermark: string) {
  return `digest:${projectKey}:${watermark}`;
}

/** Actors a project's digest maintains: every root and sub-actor of the project's worker trees; Unassigned reaches every actor. */
export function memoryDigestActorIds(room: Pick<ActorRoom, "actors">, projectKey: string) {
  return room.actors.filter(actor => projectKey === UNASSIGNED_ACTOR_PROJECT || actorProjectIds(room.actors, actor.id).includes(projectKey))
    .map(actor => actor.id);
}

/** Whether the actor already maintained its memory from this turn as its executor, owner or stakeholder: a recorded room
 * event of that turn, in that session or a work item executed there, is among its memory sources. A recorded failure is not. */
export function actorHandledTurn(room: Pick<ActorRoom, "actors" | "events" | "workItems">, actorId: string, sessionId: string, turnId: string) {
  const actor = room.actors.find(actor => actor.id === actorId);
  if (!actor) return false;
  const sources = new Set(actor.memory.sourceEventIds);
  return room.events.some(event => event.taskTurnId === turnId && sources.has(event.id) && (event.taskSessionId === sessionId || (() => {
    const work = room.workItems.find(item => item.id === event.workItemId);
    return !!work && (work.taskSessionId === sessionId || work.executionHistory.some(execution => execution.taskSessionId === sessionId));
  })()));
}

/** Turn summaries an actor has not already received through its own room events. No count limit applies. */
export function memoryDigestSummariesFor(room: Pick<ActorRoom, "actors" | "events" | "workItems">, actorId: string, summaries: readonly ActorMemoryDigestTurnSummary[]) {
  return summaries.filter(summary => summary.summary.trim() && !actorHandledTurn(room, actorId, summary.sessionId, summary.turnId));
}

/** Saves a digest write's diff inside the memory write's transaction; each actor keeps its newest MEMORY_DIGEST_RECORD_LIMIT. */
export function recordMemoryDigest(room: ActorRoom, record: ActorMemoryDigestRecord) {
  const digests = room.memoryDigests ??= { projects: {}, records: [] };
  if (digests.records.some(existing => existing.id === record.id)) return;
  digests.records.push(record);
  const own = digests.records.filter(existing => existing.actorId === record.actorId);
  if (own.length > MEMORY_DIGEST_RECORD_LIMIT) {
    const dropped = new Set(own.slice(0, own.length - MEMORY_DIGEST_RECORD_LIMIT));
    digests.records = digests.records.filter(existing => !dropped.has(existing));
  }
}

/** Repairs a partially saved digest state; idempotent. */
export function normalizeMemoryDigests(room: ActorRoom) {
  if (!room.memoryDigests) return room;
  room.memoryDigests.projects ??= {};
  room.memoryDigests.records ??= [];
  return room;
}
