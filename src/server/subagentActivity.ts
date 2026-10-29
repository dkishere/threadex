import type { SubagentActivityPayload, SubagentActivityStatus } from "../eventProtocol";

/**
 * Snapshot view of one sub-agent for a turn. `state` is "ended" when the turn
 * is no longer running but no `finished` event arrived (runner exited or the
 * event was lost), so a reload never shows a stale live card as running.
 */
export type SubagentActivitySnapshot = {
  agentId: string;
  state: "running" | "finished" | "ended";
  status?: SubagentActivityStatus;
  latestSeq: number;
  lastActivityAt: string;
  heartbeat?: SubagentActivityPayload;
  events: SubagentActivityPayload[];
};

export function summarizeSubagentActivity(activity: readonly SubagentActivityPayload[], turnRunning: boolean): SubagentActivitySnapshot[] {
  const byAgent = new Map<string, SubagentActivityPayload[]>();
  for (const entry of activity) {
    const entries = byAgent.get(entry.agentId) ?? [];
    entries.push(entry);
    byAgent.set(entry.agentId, entries);
  }
  return [...byAgent.entries()].map(([agentId, entries]) => {
    const ordered = [...new Map(entries.map((entry) => [entry.seq, entry])).values()].sort((left, right) => left.seq - right.seq);
    const heartbeat = ordered.filter((entry) => entry.kind === "heartbeat").at(-1);
    const events = ordered.filter((entry) => entry.kind !== "heartbeat");
    const finished = events.filter((entry) => entry.kind === "finished").at(-1);
    const activityTimes = [...events.map((entry) => entry.at), ...(heartbeat?.lastActivityAt ? [heartbeat.lastActivityAt] : [])];
    const lastActivityAt = activityTimes.sort().at(-1) ?? heartbeat?.at ?? ordered[0]!.at;
    return {
      agentId,
      state: finished ? "finished" : turnRunning ? "running" : "ended",
      ...(finished?.status ? { status: finished.status } : {}),
      latestSeq: ordered.at(-1)!.seq,
      lastActivityAt,
      ...(heartbeat ? { heartbeat } : {}),
      events
    };
  });
}

/** Coalesces SSE replay so a backlog of heartbeats sends only the latest per agent. */
export function subagentHeartbeatStreamKey(event: string, activity: SubagentActivityPayload | null): string | null {
  return event === "subagent_activity" && activity?.kind === "heartbeat" ? `subagent_heartbeat:${activity.agentId}` : null;
}
