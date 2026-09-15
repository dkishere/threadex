import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

export type RingEvent = {
  pos: number;
  eventId: string;
  type: string;
  workspaceId: string | null;
  sessionId: string | null;
  turnId: string | null;
  payload: unknown;
  timestamp: string;
};

type RingEventInput = Omit<RingEvent, "pos" | "timestamp"> & { timestamp?: string };

export class EventRingLog {
  private entriesValue: RingEvent[];
  private eventIds: Set<string>;
  private coalescedEventIdsByKey: Map<string, string>;
  private nextPosition: number;
  private writeQueue = Promise.resolve();
  private staleWritesSinceCompaction = 0;
  private readonly compactionInterval: number;

  constructor(
    private readonly path: string,
    private readonly capacity: number
  ) {
    this.entriesValue = loadEventRing(path, capacity);
    this.eventIds = new Set(this.entriesValue.map((event) => event.eventId));
    this.coalescedEventIdsByKey = new Map(
      this.entriesValue.flatMap((event) => {
        const key = eventCoalescingKey(event);
        return key ? [[key, event.eventId] as const] : [];
      })
    );
    this.nextPosition = Math.max(0, ...this.entriesValue.map((event) => event.pos)) + 1;
    this.compactionInterval = Math.max(1, Math.min(256, Math.ceil(capacity / 4)));
    this.compactOversizedOrTruncatedLog();
  }

  get entries(): readonly RingEvent[] {
    return this.entriesValue;
  }

  get latestPosition(): number {
    return this.entriesValue.at(-1)?.pos ?? 0;
  }

  append(input: RingEventInput): Promise<boolean> {
    const next = this.writeQueue.then(() => this.appendNow(input));
    this.writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private appendNow(input: RingEventInput): boolean {
    if (this.eventIds.has(input.eventId)) return false;

    const event: RingEvent = {
      ...input,
      pos: this.nextPosition,
      timestamp: input.timestamp ?? new Date().toISOString()
    };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });

    const coalescingKey = eventCoalescingKey(event);
    const supersededEventId = coalescingKey
      ? this.coalescedEventIdsByKey.get(coalescingKey) ?? null
      : null;
    if (supersededEventId) {
      this.entriesValue = this.entriesValue.filter((entry) => entry.eventId !== supersededEventId);
      this.eventIds.delete(supersededEventId);
      this.staleWritesSinceCompaction += 1;
    }
    const dropped = this.entriesValue.length >= this.capacity
      ? this.entriesValue[0]
      : null;
    this.entriesValue = [...this.entriesValue, event].slice(-this.capacity);
    this.eventIds.add(event.eventId);
    if (coalescingKey) this.coalescedEventIdsByKey.set(coalescingKey, event.eventId);
    if (dropped) {
      this.eventIds.delete(dropped.eventId);
      const droppedKey = eventCoalescingKey(dropped);
      if (droppedKey && this.coalescedEventIdsByKey.get(droppedKey) === dropped.eventId) {
        this.coalescedEventIdsByKey.delete(droppedKey);
      }
      this.staleWritesSinceCompaction += 1;
    }
    this.nextPosition += 1;

    if (this.staleWritesSinceCompaction >= this.compactionInterval) {
      this.compact();
    }
    return true;
  }

  private compactOversizedOrTruncatedLog() {
    if (!existsSync(this.path)) return;
    try {
      const retainedBytes = this.entriesValue.reduce(
        (total, entry) => total + Buffer.byteLength(JSON.stringify(entry)) + 1,
        0
      );
      const fileBytes = statSync(this.path).size;
      const clearlyOversized = fileBytes > retainedBytes + Math.max(1024 * 1024, Math.ceil(retainedBytes / 4));
      if (clearlyOversized) {
        this.compact();
        return;
      }
      const contents = readFileSync(this.path, "utf8");
      if (contents.length > 0 && !contents.endsWith("\n")) this.compact();
    } catch {
      // A later append will surface any real filesystem error.
    }
  }

  private compact() {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    const contents = this.entriesValue.length > 0
      ? `${this.entriesValue.map((entry) => JSON.stringify(entry)).join("\n")}\n`
      : "";
    writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, this.path);
    this.staleWritesSinceCompaction = 0;
  }
}

export function loadEventRing(path: string, capacity: number): RingEvent[] {
  if (!existsSync(path)) return [];

  try {
    const parsed = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const event = JSON.parse(line) as Partial<RingEvent> & {
            id?: unknown;
            data?: unknown;
            createdAt?: unknown;
          };
          const pos = typeof event.pos === "number" && Number.isSafeInteger(event.pos) && event.pos > 0
            ? event.pos
            : null;
          const eventId = typeof event.eventId === "string"
            ? event.eventId
            : typeof event.id === "string" ? event.id : null;
          const timestamp = typeof event.timestamp === "string"
            ? event.timestamp
            : typeof event.createdAt === "string" ? event.createdAt : null;
          if (pos === null || !eventId || typeof event.type !== "string" || !timestamp) return [];
          return [{
            pos,
            eventId,
            type: event.type,
            workspaceId: typeof event.workspaceId === "string" ? event.workspaceId : null,
            sessionId: typeof event.sessionId === "string" ? event.sessionId : null,
            turnId: typeof event.turnId === "string" ? event.turnId : null,
            payload: "payload" in event ? event.payload : event.data ?? null,
            timestamp
          } satisfies RingEvent];
        } catch {
          return [];
        }
      })
      .sort((left, right) => left.pos - right.pos);
    const seenEventIds = new Set<string>();
    const seenPositions = new Set<number>();
    const unique = parsed
      .filter((event) => {
        if (seenEventIds.has(event.eventId) || seenPositions.has(event.pos)) return false;
        seenEventIds.add(event.eventId);
        seenPositions.add(event.pos);
        return true;
      });
    const seenCoalescingKeys = new Set<string>();
    return unique
      .filter((event, index) => {
        const key = eventCoalescingKey(event);
        if (!key) return true;
        if (unique.slice(index + 1).some((candidate) => eventCoalescingKey(candidate) === key)) return false;
        seenCoalescingKeys.add(key);
        return true;
      })
      .slice(-capacity);
  } catch {
    return [];
  }
}

function eventCoalescingKey(event: RingEvent): string | null {
  if (event.type !== "runner.item" || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return null;
  }
  const payload = event.payload as Record<string, unknown>;
  const itemId = typeof payload.id === "string" ? payload.id : null;
  if (!itemId) return null;
  const originThreadId = typeof payload.originThreadId === "string" ? payload.originThreadId : "";
  return [event.type, event.sessionId ?? "", event.turnId ?? "", originThreadId, itemId].join(":");
}
