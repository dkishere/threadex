import type { SessionStore } from "./sessionStore";
import {
  SessionArchiveBlocked, type NativeArchiveOutcome, type SessionArchiveCandidate, type SessionArchiveReason,
  type SessionArchiveRecord, type SessionNativeThread
} from "./sessionArchiveStore";

/**
 * Retention grows with session size, so short sessions are archived first:
 * days = min(max, minimum + daysPerTurn·turns + daysPerEventDoubling·log2(1 + events)).
 */
export const SESSION_ARCHIVE_POLICY = {
  minRetentionDays: 3,
  daysPerTurn: 0.5,
  daysPerEventDoubling: 0.5,
  maxRetentionDays: 90,
  batchLimit: 50
} as const;
export type SessionArchivePolicy = { [K in keyof typeof SESSION_ARCHIVE_POLICY]: number };

const DAY_MS = 86_400_000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;

export function archiveRetentionDays(turnCount: number, eventCount: number, policy: SessionArchivePolicy = SESSION_ARCHIVE_POLICY) {
  const days = policy.minRetentionDays + policy.daysPerTurn * Math.max(0, turnCount)
    + policy.daysPerEventDoubling * Math.log2(1 + Math.max(0, eventCount));
  return Math.max(policy.minRetentionDays, Math.min(policy.maxRetentionDays, days));
}

/** Due sessions, shortest retention first, then longest idle. */
export function dueArchiveCandidates(candidates: SessionArchiveCandidate[], now: Date, policy: SessionArchivePolicy = SESSION_ARCHIVE_POLICY) {
  return candidates
    .map(candidate => ({ ...candidate, retentionDays: archiveRetentionDays(candidate.turnCount, candidate.eventCount, policy) }))
    .filter(candidate => now.getTime() - Date.parse(candidate.lastActivity) >= candidate.retentionDays * DAY_MS)
    .sort((a, b) => a.retentionDays - b.retentionDays || Date.parse(a.lastActivity) - Date.parse(b.lastActivity) || a.sessionId.localeCompare(b.sessionId))
    .slice(0, policy.batchLimit);
}

export function localDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export type SessionArchiveRunResult = {
  day: string; considered: number; archived: string[];
  skipped: Array<{ sessionId: string; reason: string }>; failed: Array<{ sessionId: string; error: string }>;
};

type ArchiveStore = Pick<SessionStore, "listSessionNativeThreads" | "listSessionArchiveCandidates" | "archiveSessionData"
  | "claimSessionArchiveRun" | "finishSessionArchiveRun" | "listActiveSessionExecutionStatuses">;

export class SessionArchiveService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<SessionArchiveRunResult | null> | null = null;
  private readonly policy: SessionArchivePolicy;

  constructor(private readonly deps: {
    store: ArchiveStore;
    /** Native CLI archive; throwing aborts the Threadex archive so it is retried on the next run. */
    archiveNative(thread: SessionNativeThread): Promise<NativeArchiveOutcome>;
    published(record: SessionArchiveRecord): Promise<void>;
    now?: () => Date;
    policy?: Partial<SessionArchivePolicy>;
    log?: (message: string) => void;
  }) {
    this.policy = { ...SESSION_ARCHIVE_POLICY, ...deps.policy };
  }

  async archiveSession(sessionId: string, reason: SessionArchiveReason): Promise<SessionArchiveRecord> {
    // In-memory side chats are invisible to the SQL guard inside the archive transaction.
    if ((await this.deps.store.listActiveSessionExecutionStatuses())[sessionId])
      throw new SessionArchiveBlocked("Session is running and cannot be archived.");
    const nativeArchive: NativeArchiveOutcome[] = [];
    for (const thread of await this.deps.store.listSessionNativeThreads(sessionId)) nativeArchive.push(await this.deps.archiveNative(thread));
    const record = await this.deps.store.archiveSessionData({ sessionId, reason, nativeArchive });
    await this.deps.published(record).catch(error => this.log(`Session archive event for ${sessionId} failed: ${String(error)}`));
    return record;
  }

  /** Runs at most once per local day across processes; returns null when the day was already claimed. */
  async runDaily(): Promise<SessionArchiveRunResult | null> {
    this.running ??= this.runDue().finally(() => { this.running = null; });
    return this.running;
  }

  start() {
    if (this.timer) return;
    const schedule = (delay: number) => {
      this.timer = setTimeout(() => {
        void this.runDaily().catch(error => this.log(`Daily session archive failed: ${String(error)}`))
          .finally(() => { if (this.timer) schedule(CHECK_INTERVAL_MS); });
      }, delay);
      this.timer.unref?.();
    };
    schedule(STARTUP_DELAY_MS);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async runDue(): Promise<SessionArchiveRunResult | null> {
    const now = this.deps.now?.() ?? new Date();
    const day = localDay(now);
    if (!await this.deps.store.claimSessionArchiveRun(day)) return null;
    const result: SessionArchiveRunResult = { day, considered: 0, archived: [], skipped: [], failed: [] };
    try {
      const candidates = await this.deps.store.listSessionArchiveCandidates(this.policy.minRetentionDays);
      result.considered = candidates.length;
      for (const candidate of dueArchiveCandidates(candidates, now, this.policy)) {
        try {
          await this.archiveSession(candidate.sessionId, "auto");
          result.archived.push(candidate.sessionId);
        } catch (error) {
          if (error instanceof SessionArchiveBlocked) result.skipped.push({ sessionId: candidate.sessionId, reason: error.message });
          else result.failed.push({ sessionId: candidate.sessionId, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } finally {
      await this.deps.store.finishSessionArchiveRun(day, result);
    }
    this.log(`Daily session archive ${day}: ${result.archived.length} archived, ${result.skipped.length} skipped, ${result.failed.length} failed.`);
    return result;
  }

  private log(message: string) {
    (this.deps.log ?? console.warn)(message);
  }
}
