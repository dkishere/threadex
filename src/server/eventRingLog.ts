import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
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
      if (fileBytes > 0) {
        const descriptor = openSync(this.path, "r");
        const lastByte = Buffer.allocUnsafe(1);
        try {
          readSync(descriptor, lastByte, 0, 1, fileBytes - 1);
        } finally {
          closeSync(descriptor);
        }
        if (lastByte[0] !== 0x0a) this.compact();
      }
    } catch {
      // A later append will surface any real filesystem error.
    }
  }

  private compact() {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    try {
      const descriptor = openSync(temporaryPath, "w", 0o600);
      try {
        // The retained ring can exceed V8's string limit even when each event is small.
        for (const entry of this.entriesValue) {
          writeFileSync(descriptor, `${JSON.stringify(entry)}\n`, "utf8");
        }
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporaryPath, this.path);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
    this.staleWritesSinceCompaction = 0;
  }
}

export function loadEventRing(path: string, capacity: number): RingEvent[] {
  if (!existsSync(path)) return [];

  try {
    const parsed: RingEvent[] = [];
    for (const line of eventRingLines(path)) {
      if (!line) continue;
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
        if (pos === null || !eventId || typeof event.type !== "string" || !timestamp) continue;
        parsed.push({
          pos,
          eventId,
          type: event.type,
          workspaceId: typeof event.workspaceId === "string" ? event.workspaceId : null,
          sessionId: typeof event.sessionId === "string" ? event.sessionId : null,
          turnId: typeof event.turnId === "string" ? event.turnId : null,
          payload: "payload" in event ? event.payload : event.data ?? null,
          timestamp
        });
      } catch {
        // Ignore a malformed record without losing the rest of the replay log.
      }
    }
    parsed.sort((left, right) => left.pos - right.pos);
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

/** Decode one JSONL record at a time, including UTF-8 split across read boundaries. */
function* eventRingLines(path: string): Generator<string> {
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  try {
    let bytesRead: number;
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      const chunk = buffer.subarray(0, bytesRead);
      let start = 0;
      let end: number;
      while ((end = chunk.indexOf(0x0a, start)) >= 0) {
        const fragment = chunk.subarray(start, end);
        yield fragments.length > 0
          ? Buffer.concat([...fragments, fragment], fragmentBytes + fragment.length).toString("utf8")
          : fragment.toString("utf8");
        fragments = [];
        fragmentBytes = 0;
        start = end + 1;
      }
      if (start < bytesRead) {
        const fragment = Buffer.from(chunk.subarray(start));
        fragments.push(fragment);
        fragmentBytes += fragment.length;
      }
    }
    if (fragments.length > 0) yield Buffer.concat(fragments, fragmentBytes).toString("utf8");
  } finally {
    closeSync(descriptor);
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
