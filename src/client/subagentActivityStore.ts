import { useCallback, useSyncExternalStore } from "react";
import { normalizeSubagentActivity, SUBAGENT_ACTIVITY_RETAINED_PER_AGENT, type SubagentActivityPayload, type SubagentActivityStatus } from "../eventProtocol";

/**
 * Client view of one sub-agent's `subagent_activity` stream, keyed by the
 * Agent tool_use id (the same id as its `subagent` live item). Live SSE events
 * and reload snapshots (`turn.subagentActivity[]`) merge by (agentId, seq).
 */
export type SubagentActivityView = {
  agentId: string;
  state: "running" | "finished" | "ended";
  status?: SubagentActivityStatus;
  /** Last real activity reported by the runner (events or heartbeat.lastActivityAt). */
  lastActivityAt: string;
  /** Last time the runner said anything about this agent, heartbeats included. */
  lastSignalAt: string;
  heartbeat?: SubagentActivityPayload;
  events: SubagentActivityPayload[];
};

/** Runner heartbeats arrive after 30 s of silence; no signal for this long means the runner stopped reporting. */
export const SUBAGENT_SIGNAL_LOST_MS = 120_000;
/** Activity older than this is shown as quiet even while heartbeats confirm the process. */
export const SUBAGENT_QUIET_MS = 60_000;

type SnapshotEntry = {
  agentId?: unknown;
  state?: unknown;
  heartbeat?: unknown;
  events?: unknown;
};

const views = new Map<string, SubagentActivityView>();
const listeners = new Map<string, Set<() => void>>();
const pendingNotify = new Set<string>();

function latestTime(values: Array<string | undefined>) {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1);
}

function rebuild(agentId: string, entries: SubagentActivityPayload[], previous: SubagentActivityView | undefined, snapshotState?: SubagentActivityView["state"]): SubagentActivityView {
  const ordered = [...new Map(entries.map((entry) => [entry.seq, entry])).values()].sort((left, right) => left.seq - right.seq);
  const heartbeat = ordered.filter((entry) => entry.kind === "heartbeat").at(-1);
  const lifecycle = ordered.filter((entry) => entry.kind === "started" || entry.kind === "finished");
  const activity = ordered.filter((entry) => entry.kind !== "heartbeat" && entry.kind !== "started" && entry.kind !== "finished")
    .slice(-SUBAGENT_ACTIVITY_RETAINED_PER_AGENT);
  const events = [...lifecycle, ...activity].sort((left, right) => left.seq - right.seq);
  const finished = events.filter((entry) => entry.kind === "finished").at(-1);
  const first = ordered[0]!;
  const lastActivityAt = latestTime([...events.map((entry) => entry.at), heartbeat?.lastActivityAt]) ?? first.at;
  const lastSignalAt = latestTime([lastActivityAt, heartbeat?.at]) ?? first.at;
  // A finished event wins; otherwise a snapshot may report the turn ended, and
  // that verdict sticks until a newer live event proves the agent is running.
  const state = finished ? "finished"
    : snapshotState ?? (previous?.state === "ended" && previous.lastSignalAt >= lastSignalAt ? "ended" : "running");
  return {
    agentId,
    state,
    ...(finished?.status ? { status: finished.status } : {}),
    lastActivityAt,
    lastSignalAt,
    ...(heartbeat ? { heartbeat } : {}),
    events
  };
}

function storedEntries(view: SubagentActivityView | undefined) {
  return view ? [...view.events, ...(view.heartbeat ? [view.heartbeat] : [])] : [];
}

function notify(agentId: string) {
  // Snapshots are merged inside state updaters; defer so subscribers never
  // update while another component renders.
  if (pendingNotify.size === 0) {
    queueMicrotask(() => {
      const ids = [...pendingNotify];
      pendingNotify.clear();
      for (const id of ids) for (const listener of listeners.get(id) ?? []) listener();
    });
  }
  pendingNotify.add(agentId);
}

/** Applies one live `subagent_activity` SSE payload; ignores invalid or duplicate events. */
export function applySubagentActivity(value: unknown) {
  const activity = normalizeSubagentActivity(value);
  if (!activity) return;
  const previous = views.get(activity.agentId);
  const entries = storedEntries(previous);
  if (entries.some((entry) => entry.seq === activity.seq)) return;
  views.set(activity.agentId, rebuild(activity.agentId, [...entries, activity], previous));
  notify(activity.agentId);
}

/** Merges a turn snapshot's `subagentActivity[]` into the live view. */
export function applySubagentActivitySnapshot(value: unknown) {
  if (!Array.isArray(value)) return;
  for (const raw of value as SnapshotEntry[]) {
    const agentId = typeof raw?.agentId === "string" ? raw.agentId : "";
    if (!agentId) continue;
    const incoming = [...(Array.isArray(raw.events) ? raw.events : []), raw.heartbeat]
      .map((entry) => normalizeSubagentActivity(entry))
      .filter((entry): entry is SubagentActivityPayload => Boolean(entry && entry.agentId === agentId));
    const previous = views.get(agentId);
    const merged = [...storedEntries(previous), ...incoming];
    if (merged.length === 0) continue;
    const snapshotState = raw.state === "ended" || raw.state === "finished" ? raw.state : undefined;
    const next = rebuild(agentId, merged, previous, snapshotState === "ended" ? "ended" : undefined);
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) continue;
    views.set(agentId, next);
    notify(agentId);
  }
}

export function getSubagentActivity(agentId: string) {
  return views.get(agentId);
}

function subscribe(agentId: string, listener: () => void) {
  const set = listeners.get(agentId) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(agentId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(agentId);
  };
}

/** The activity view for the first id that has one (a card can carry several agent ids). */
export function useSubagentActivity(agentIds: readonly string[]): SubagentActivityView | undefined {
  const key = agentIds.join("\u0000");
  const subscribeAll = useCallback((listener: () => void) => {
    const unsubscribes = key.split("\u0000").filter(Boolean).map((agentId) => subscribe(agentId, listener));
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [key]);
  const getSnapshot = useCallback(() => {
    for (const agentId of key.split("\u0000")) {
      const view = agentId ? views.get(agentId) : undefined;
      if (view) return view;
    }
    return undefined;
  }, [key]);
  return useSyncExternalStore(subscribeAll, getSnapshot, getSnapshot);
}

export type SubagentActivityPresentation = {
  tone: "running" | "waiting" | "quiet" | "stalled" | "done" | "error";
  /** Short status-pill label, or undefined to keep the card's own status. */
  label?: string;
  /** One-line description of the latest activity. */
  detail?: string;
  /** Visible explanation of liveness, e.g. "Last activity 3m ago". */
  liveness?: string;
};

export function formatElapsed(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function describeSubagentActivityEvent(event: SubagentActivityPayload) {
  const text = event.text?.replace(/\s+/g, " ").trim();
  switch (event.kind) {
    case "started": return event.description ? `Started: ${event.description}` : "Started";
    case "tool": return [event.toolName ? `Using ${event.toolName}` : "Using a tool", event.description ?? text].filter(Boolean).join(" · ");
    case "message": return text || "Sent a message";
    case "progress": return [event.description ?? text ?? "Working", event.toolUses !== undefined ? `${event.toolUses} tool uses` : ""].filter(Boolean).join(" · ");
    case "waiting": return event.waiting === "approval" ? "Waiting for approval" : event.waiting === "input" ? "Waiting for your input" : "Waiting";
    case "finished": return event.status === "failed" ? "Failed" : event.status === "stopped" ? "Stopped" : "Finished";
    case "heartbeat": return "Still running";
    case "send_message": return event.sendMessage ? `Message to ${event.sendMessage.to}${event.sendMessage.summary ? ` · ${event.sendMessage.summary}` : ""}` : "Sent a message";
  }
}

/** Liveness of one sub-agent at `now`; heartbeats stop after the runner's stall window, which reads as stalled here. */
export function presentSubagentActivity(view: SubagentActivityView, now: number): SubagentActivityPresentation {
  const latest = view.events.filter((event) => event.kind !== "finished").at(-1);
  const latestWork = view.events.filter((event) => event.kind !== "finished" && event.kind !== "waiting").at(-1);
  const detail = latestWork ? describeSubagentActivityEvent(latestWork) : undefined;
  if (view.state === "finished") {
    const tone = view.status === "failed" ? "error" : view.status === "stopped" ? "error" : "done";
    return { tone, label: view.status === "failed" ? "Failed" : view.status === "stopped" ? "Stopped" : "Completed", detail };
  }
  if (view.state === "ended") {
    return { tone: "quiet", label: "Ended", detail, liveness: "The turn ended before this agent reported finishing." };
  }
  const sinceActivity = now - Date.parse(view.lastActivityAt);
  const sinceSignal = now - Date.parse(view.lastSignalAt);
  const lastActivity = `Last activity ${formatElapsed(sinceActivity)} ago`;
  if (view.heartbeat?.processAlive === false || sinceSignal >= SUBAGENT_SIGNAL_LOST_MS) {
    return { tone: "stalled", label: "May be stuck", detail, liveness: `${lastActivity}; no heartbeat for ${formatElapsed(sinceSignal)}.` };
  }
  // While waiting the runner sends `waiting` instead of heartbeats, so the newest signal decides.
  const newest = view.heartbeat && (!latest || view.heartbeat.seq > latest.seq) ? view.heartbeat : latest;
  if (newest?.kind === "waiting") {
    return { tone: "waiting", label: newest.waiting === "approval" ? "Waiting for approval" : newest.waiting === "input" ? "Waiting for input" : "Waiting", detail: undefined, liveness: `Checked ${formatElapsed(sinceSignal)} ago` };
  }
  if (sinceActivity >= SUBAGENT_QUIET_MS) {
    return { tone: "quiet", label: "Quiet", detail, liveness: `${lastActivity}; heartbeat ${formatElapsed(sinceSignal)} ago.` };
  }
  return { tone: "running", detail, liveness: lastActivity };
}

/** Test hook. */
export function resetSubagentActivityStore() {
  views.clear();
  pendingNotify.clear();
}
