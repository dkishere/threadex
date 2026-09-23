import { createHash } from "node:crypto";
import { CLIENT_EVENT_TYPES, EVENT_STATE_FIELDS, encodeEventStateVersions, type EventStateVersions } from "../eventProtocol";
import type { RingEvent } from "./eventRingLog";

const clientTypes = new Set<string>(CLIENT_EVENT_TYPES);
type EventPollState = Record<typeof EVENT_STATE_FIELDS[number], unknown[]>;

export function versionEventState<T extends EventPollState>(workspaceId: string, state: T) {
  const versions = Object.fromEntries(EVENT_STATE_FIELDS.map((field) => [field,
    createHash("sha256").update(workspaceId).update("\0").update(JSON.stringify(state[field])).digest("hex").slice(0, 16)
  ])) as EventStateVersions;
  return { ...state, versions };
}

export function changedEventState(state: EventPollState & { versions: EventStateVersions }, known = ""): Partial<EventPollState> & { stateVersion: string } {
  const previous = known.split(".");
  return {
    ...Object.fromEntries(EVENT_STATE_FIELDS.filter((field, index) => state.versions[field] !== previous[index])
      .map((field) => [field, state[field]])),
    stateVersion: encodeEventStateVersions(state.versions)
  };
}

export function clientEvent(event: RingEvent): RingEvent | null {
  if (!clientTypes.has(event.type)) return null;
  const data = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
  let payload: unknown = null;
  switch (event.type) {
    // These are displayed directly; do not truncate approval questions,
    // instructions or Todo state. All other types only invalidate local state.
    case "runner.approval.requested":
    case "runner.developer_instructions":
    case "todo.changed":
      payload = event.payload;
      break;
    case "runner.approval.resolved": payload = { approvalId: data.approvalId }; break;
    case "runner.runner.callback_error": payload = { event: data.event }; break;
    case "session.title.updated": payload = { title: data.title }; break;
  }
  return { ...event, payload };
}

export function clientEventPage(entries: readonly RingEvent[], workspaceId: string, after: number, limits = { count: 128, bytes: 128 * 1024 }) {
  const latestPos = entries.at(-1)?.pos ?? 0;
  const oldestPos = entries[0]?.pos ?? 0;
  const resetRequired = after > 0 && (latestPos === 0 || after > latestPos || after < oldestPos - 1);
  const events: RingEvent[] = [];
  if (resetRequired) return { workspaceId, events, nextPos: latestPos, resetRequired, hasMore: false };
  let nextPos = after;
  let bytes = 0;
  for (const entry of entries) {
    if (entry.pos <= after) continue;
    const event = !entry.workspaceId || entry.workspaceId === workspaceId ? clientEvent(entry) : null;
    if (event) {
      const size = Buffer.byteLength(JSON.stringify(event));
      // Deliver at least one event even if a required approval/instruction is
      // larger than the page budget. Never truncate it or skip its cursor.
      if (events.length && (events.length >= limits.count || bytes + size > limits.bytes)) {
        return { workspaceId, events, nextPos, resetRequired, hasMore: true };
      }
      events.push(event);
      bytes += size;
    }
    nextPos = entry.pos;
  }
  return { workspaceId, events, nextPos: latestPos, resetRequired, hasMore: false };
}
