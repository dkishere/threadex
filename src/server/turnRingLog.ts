import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_TURN_RING_MAX_BYTES = 100 * 1024 * 1024;

export type TurnRingEntry = {
  version: 1;
  eventId?: string;
  timestamp: string;
  event: "user_prompt" | "agent_response";
  source: string;
  sessionId: string;
  turnId: string;
  userPrompt?: string;
  agentResponse?: string;
  status?: string;
};

type UserPromptEntryInput = {
  eventId?: string;
  source: string;
  sessionId: string;
  turnId: string;
  userPrompt: string;
  timestamp?: string;
};

type AgentResponseEntryInput = {
  eventId?: string;
  source: string;
  sessionId: string;
  turnId: string;
  agentResponse: string;
  status: string;
  timestamp?: string;
};

/**
 * An append-oriented JSONL log that keeps only the newest complete entries.
 *
 * Writes are serialized in-process. When the next entry would exceed the byte
 * limit, the oldest entries are removed with an atomic rewrite, leaving some
 * headroom so normal-sized writes do not force a rewrite on every append.
 */
export class TurnRingLog {
  private writeQueue = Promise.resolve();
  private seenEventIds = new Set<string>();

  constructor(
    readonly path: string,
    readonly maxBytes = DEFAULT_TURN_RING_MAX_BYTES
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("Turn ring log maxBytes must be a positive safe integer.");
    }
    this.rebuildSeenEventIds();
  }

  appendUserPrompt(input: UserPromptEntryInput): Promise<void> {
    return this.append({
      version: 1,
      ...(input.eventId ? { eventId: input.eventId } : {}),
      timestamp: input.timestamp ?? new Date().toISOString(),
      event: "user_prompt",
      source: input.source,
      sessionId: input.sessionId,
      turnId: input.turnId,
      userPrompt: input.userPrompt
    });
  }

  appendAgentResponse(input: AgentResponseEntryInput): Promise<void> {
    return this.append({
      version: 1,
      ...(input.eventId ? { eventId: input.eventId } : {}),
      timestamp: input.timestamp ?? new Date().toISOString(),
      event: "agent_response",
      source: input.source,
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentResponse: input.agentResponse,
      status: input.status
    });
  }

  private append(entry: TurnRingEntry): Promise<void> {
    const next = this.writeQueue.then(() => this.appendSync(entry));
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private appendSync(entry: TurnRingEntry): void {
    if (entry.eventId && this.seenEventIds.has(entry.eventId)) {
      return;
    }

    const line = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
    if (line.length > this.maxBytes) {
      throw new Error(
        `Turn ring log entry is ${line.length} bytes, exceeding the ${this.maxBytes}-byte limit.`
      );
    }

    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.repairTrailingPartialLine();

    const currentBytes = existsSync(this.path) ? statSync(this.path).size : 0;
    if (currentBytes + line.length > this.maxBytes) {
      this.compactForIncomingEntry(line.length);
    }

    appendFileSync(this.path, line, { mode: 0o600 });
    chmodSync(this.path, 0o600);
    if (entry.eventId) {
      this.seenEventIds.add(entry.eventId);
    }
  }

  private repairTrailingPartialLine(): void {
    if (!existsSync(this.path)) {
      return;
    }

    const size = statSync(this.path).size;
    if (size === 0) {
      return;
    }

    const descriptor = openSync(this.path, "r");
    const lastByte = Buffer.allocUnsafe(1);
    try {
      readSync(descriptor, lastByte, 0, 1, size - 1);
    } finally {
      closeSync(descriptor);
    }
    if (lastByte[0] === 0x0a) {
      return;
    }

    const existing = readFileSync(this.path);
    const lastNewline = existing.lastIndexOf(0x0a);
    this.atomicRewrite(lastNewline >= 0 ? existing.subarray(0, lastNewline + 1) : Buffer.alloc(0));
  }

  private compactForIncomingEntry(incomingBytes: number): void {
    const existing = existsSync(this.path) ? readFileSync(this.path) : Buffer.alloc(0);
    const completeEnd = existing.lastIndexOf(0x0a) + 1;
    if (completeEnd <= 0) {
      this.atomicRewrite(Buffer.alloc(0));
      return;
    }

    const targetTotalBytes = Math.floor(this.maxBytes * 0.9);
    const retainedBudget = Math.max(0, targetTotalBytes - incomingBytes);
    if (retainedBudget === 0) {
      this.atomicRewrite(Buffer.alloc(0));
      return;
    }

    const earliestCandidate = Math.max(0, completeEnd - retainedBudget);
    let retainedStart = 0;
    if (earliestCandidate > 0) {
      const precedingNewline = existing.indexOf(0x0a, earliestCandidate);
      retainedStart = precedingNewline >= 0 && precedingNewline + 1 < completeEnd
        ? precedingNewline + 1
        : completeEnd;
    }
    this.atomicRewrite(existing.subarray(retainedStart, completeEnd));
  }

  private atomicRewrite(content: Buffer): void {
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporaryPath, content, { mode: 0o600 });
    renameSync(temporaryPath, this.path);
    chmodSync(this.path, 0o600);
    this.rebuildSeenEventIds(content);
  }

  private rebuildSeenEventIds(content?: Buffer): void {
    const existing = content ?? (existsSync(this.path) ? readFileSync(this.path) : Buffer.alloc(0));
    this.seenEventIds = new Set(
      existing.toString("utf8")
        .split("\n")
        .flatMap((line) => {
          if (!line.trim()) return [];
          try {
            const entry = JSON.parse(line) as Partial<TurnRingEntry>;
            return typeof entry.eventId === "string" ? [entry.eventId] : [];
          } catch {
            return [];
          }
        })
    );
  }
}
