import type { ActorRoom } from "../domainActors";
import { ACTOR_MEMORY_FIELD_EXCERPT_BYTES } from "./domainActorContext";

const MEMORY_FIELDS = ["rolePrompt", "roleSummary", "longTerm", "rolling"] as const;
export type ActorRoutingMetricsEntry = {
  actorId: string; name: string; parentActorId: string | null;
  /** Work items this actor executes now, created in the window. */
  executed: number;
  /** Delivered follow-up updates on those work items: a rework signal. */
  followUps: number;
  /** Work items moved from this actor to another executor (a misrouting signal), and moved to it. */
  reassignedAway: number; reassignedTo: number;
  /** Follow-ups handed to another actor's domain, and received. */
  handoffsSent: number; handoffsReceived: number;
  /** Memory fields longer than the per-field context excerpt: those are injected truncated. */
  truncatedMemoryFields: Array<{ field: typeof MEMORY_FIELDS[number]; bytes: number }>;
};
export type ActorRoutingMetrics = { workspaceId: string; since: string | null; until: string | null; excerptBytes: number;
  /** Latest applied reorganization, a natural window boundary for before/after comparison. */
  lastReorganizationAt: string | null;
  actors: ActorRoutingMetricsEntry[] };

/** Routing-quality signals of the current registry over work created in [since, until). Read-only. */
export function actorRoutingMetrics(room: ActorRoom, window: { since?: string; until?: string } = {}): ActorRoutingMetrics {
  const since = window.since ? Date.parse(window.since) : null, until = window.until ? Date.parse(window.until) : null;
  if (Number.isNaN(since) || Number.isNaN(until)) throw new Error("since and until must be ISO timestamps.");
  const inWindow = (created: string) => { const time = Date.parse(created); return (since === null || time >= since) && (until === null || time < until); };
  const entries = new Map(room.actors.map(actor => [actor.id, {
    actorId: actor.id, name: actor.name, parentActorId: actor.parentActorId,
    executed: 0, followUps: 0, reassignedAway: 0, reassignedTo: 0, handoffsSent: 0, handoffsReceived: 0,
    truncatedMemoryFields: MEMORY_FIELDS.map(field => ({ field, bytes: Buffer.byteLength(actor.memory[field]) }))
      .filter(({ bytes }) => bytes > ACTOR_MEMORY_FIELD_EXCERPT_BYTES)
  } satisfies ActorRoutingMetricsEntry]));
  const works = room.workItems.filter(work => inWindow(work.created));
  const delivered = new Map<string, number>();
  for (const update of room.taskUpdates ?? []) if (update.status === "delivered") delivered.set(update.workItemId, (delivered.get(update.workItemId) ?? 0) + 1);
  for (const work of works) {
    const executor = entries.get(work.executorActorId);
    if (executor) { executor.executed++; executor.followUps += delivered.get(work.id) ?? 0; }
    // Each earlier executor that differs from the next one lost the work to it.
    const executors = [...work.executionHistory.map(execution => execution.executorActorId), work.executorActorId]
      .filter((id, index, all) => index === 0 || id !== all[index - 1]);
    for (let index = 1; index < executors.length; index++) {
      const from = entries.get(executors[index - 1]), to = entries.get(executors[index]);
      if (from) from.reassignedAway++;
      if (to) to.reassignedTo++;
    }
    if (work.handoff) {
      const source = entries.get(work.handoff.sourceActorId);
      if (source) source.handoffsSent++;
      if (executor) executor.handoffsReceived++;
    }
  }
  const lastReorganizationAt = room.reorganizations?.at(-1)?.created ?? null;
  return { workspaceId: room.workspaceId, since: window.since ?? null, until: window.until ?? null, excerptBytes: ACTOR_MEMORY_FIELD_EXCERPT_BYTES,
    lastReorganizationAt, actors: [...entries.values()] };
}
