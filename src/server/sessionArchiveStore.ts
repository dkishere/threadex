import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { ActorRoom } from "../domainActors";
import type { SessionDbConnection } from "./sessionDb";

export const SESSION_ARCHIVE_FORMAT = "gzip+json";
export const SESSION_ARCHIVE_FORMAT_VERSION = 1;
/** Kept in place: import file metadata deduplicates re-imports, token usage feeds account and cost history. */
export const SESSION_ARCHIVE_RETAINED_TABLES: ReadonlySet<string> = new Set(["local_session_file", "token_usage"]);
const ARCHIVE_TABLES = new Set(["sessions", "session_archive", "session_archive_run"]);
const ACTIVE_ACTOR_WORK = new Set(["claimed", "assigned", "started", "needs_user"]);

export type SessionArchiveReason = "manual" | "auto";
export type SessionNativeThread = { provider: "codex" | "claude"; threadId: string; nativeHome: string; cwd: string };
export type NativeArchiveOutcome = SessionNativeThread & { status: "archived" | "not_found" | "unsupported"; detail?: string };
export type SessionArchivePayload = {
  formatVersion: number; sessionId: string; archivedAt: string;
  tables: Record<string, Record<string, unknown>[]>;
};
export type SessionArchiveRecord = {
  sessionId: string; workspaceId: string; title: string; reason: SessionArchiveReason;
  turnCount: number; eventCount: number; rowCounts: Record<string, number>; nativeThreadIds: string[];
  nativeArchive: NativeArchiveOutcome[]; uncompressedBytes: number; compressedBytes: number;
  checksum: string; archivedAt: string; removedFromActorList: boolean;
};
export type SessionArchiveCandidate = { sessionId: string; workspaceId: string; turnCount: number; eventCount: number; lastActivity: string };

export class SessionArchiveBlocked extends Error {}

export async function ensureSessionArchiveSchema(connection: SessionDbConnection) {
  await connection.run(`CREATE TABLE IF NOT EXISTS session_archive (
    session_id VARCHAR PRIMARY KEY,
    workspace_id VARCHAR NOT NULL,
    title VARCHAR NOT NULL,
    reason VARCHAR NOT NULL CHECK (reason IN ('manual', 'auto')),
    native_thread_ids VARCHAR[] NOT NULL DEFAULT '{}',
    native_archive JSONB NOT NULL DEFAULT '[]'::JSONB,
    turn_count BIGINT NOT NULL,
    event_count BIGINT NOT NULL,
    row_counts JSONB NOT NULL,
    format VARCHAR NOT NULL,
    format_version INTEGER NOT NULL,
    payload BYTEA NOT NULL,
    uncompressed_bytes BIGINT NOT NULL,
    compressed_bytes BIGINT NOT NULL,
    checksum VARCHAR NOT NULL,
    session_created TIMESTAMPTZ,
    last_activity TIMESTAMPTZ,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await connection.run("CREATE INDEX IF NOT EXISTS session_archive_thread_idx ON session_archive USING GIN (native_thread_ids)");
  await connection.run("CREATE INDEX IF NOT EXISTS session_archive_workspace_idx ON session_archive (workspace_id, archived_at)");
  await connection.run(`CREATE TABLE IF NOT EXISTS session_archive_run (
    run_day DATE PRIMARY KEY,
    started TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished TIMESTAMPTZ,
    result JSONB
  )`);
}

/** Tombstone check: an archived session or any of its native threads must not be imported again. */
export async function isArchivedSessionIdentity(connection: SessionDbConnection, input: { sessionId?: string | null; threadId?: string | null }) {
  if (!input.sessionId && !input.threadId) return false;
  const rows = await (await connection.run(`SELECT 1 AS found FROM session_archive
    WHERE session_id = $sessionId OR $threadId = ANY(native_thread_ids) LIMIT 1`,
  { sessionId: input.sessionId ?? null, threadId: input.threadId ?? null })).getRowObjectsJS();
  return rows.length > 0;
}

export async function listSessionNativeThreads(connection: SessionDbConnection, sessionId: string): Promise<SessionNativeThread[]> {
  const rows = await (await connection.run(`SELECT p.provider, p.thread_id, p.native_home, p.cwd
      FROM session_provider_thread p WHERE p.session_id = $sessionId
    UNION
    SELECT CASE WHEN starts_with(s.thread_id, 'claude:') THEN 'claude' ELSE 'codex' END, s.thread_id, w.codex_home, s.cwd
      FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.id = $sessionId AND s.thread_id IS NOT NULL AND btrim(s.thread_id) <> ''
        AND NOT EXISTS (SELECT 1 FROM session_provider_thread p WHERE p.session_id = s.id AND p.thread_id = s.thread_id)`,
  { sessionId })).getRowObjectsJS();
  return rows.map(row => ({ provider: row.provider === "claude" ? "claude" : "codex", threadId: String(row.thread_id),
    nativeHome: String(row.native_home ?? ""), cwd: String(row.cwd ?? "") }));
}

const blockedSessionSql = (activeSessionSql: string) => `
  EXISTS (SELECT 1 FROM workspace_manager m WHERE m.session_id = s.id)
  OR EXISTS (SELECT 1 FROM workspace_manager_archive m WHERE m.session_id = s.id OR m.replaced_by_session_id = s.id)
  OR EXISTS (SELECT 1 FROM sessions child WHERE child.parent_session_id = s.id)
  OR EXISTS (SELECT 1 FROM session_turn t WHERE t.session_id = s.id AND t.status <> 'done' AND t.pending_reason IS DISTINCT FROM 'stopped')
  OR EXISTS (SELECT 1 FROM wait_subscription w WHERE w.session_id = s.id AND w.status = 'waiting')
  OR s.id IN (${activeSessionSql})`;

/** Sessions idle for at least the minimum age with no running, queued or waiting work. */
export async function listSessionArchiveCandidates(connection: SessionDbConnection, input: { minIdleDays: number; activeSessionSql: string }): Promise<SessionArchiveCandidate[]> {
  const rows = await (await connection.run(`SELECT s.id, s.workspace_id, COALESCE(t.turns, 0) AS turn_count, COALESCE(e.events, 0) AS event_count,
      GREATEST(s.created, s.updated, t.last_turn, e.last_event) AS last_activity
    FROM sessions s
    LEFT JOIN (SELECT session_id, count(*) AS turns, max(created) AS last_turn FROM session_turn GROUP BY session_id) t ON t.session_id = s.id
    LEFT JOIN (SELECT session_id, count(*) AS events, max(created) AS last_event FROM session_turn_event GROUP BY session_id) e ON e.session_id = s.id
    WHERE GREATEST(s.created, s.updated, t.last_turn, e.last_event) <= now() - make_interval(days => $minIdleDays)
      AND NOT (${blockedSessionSql(input.activeSessionSql)})`, { minIdleDays: Math.ceil(input.minIdleDays) })).getRowObjectsJS();
  return rows.map(row => ({ sessionId: String(row.id), workspaceId: String(row.workspace_id), turnCount: Number(row.turn_count),
    eventCount: Number(row.event_count), lastActivity: new Date(row.last_activity as string | Date).toISOString() }));
}

const quoteIdentifier = (value: string) => `"${value.replaceAll("\"", "\"\"")}"`;

async function sessionTables(run: SessionDbConnection["run"]) {
  const rows = await (await run(`SELECT c.table_name, bool_or(c.column_name = 'session_id') AS has_session, bool_or(c.column_name = 'turn_id') AS has_turn
    FROM information_schema.columns c JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = current_schema() AND c.column_name IN ('session_id', 'turn_id')
    GROUP BY c.table_name ORDER BY c.table_name`)).getRowObjectsJS();
  const usable = rows.map(row => ({ name: String(row.table_name), hasSession: row.has_session === true, hasTurn: row.has_turn === true }))
    .filter(table => !ARCHIVE_TABLES.has(table.name) && !SESSION_ARCHIVE_RETAINED_TABLES.has(table.name));
  const references = await (await run(`SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent
    FROM pg_constraint WHERE contype = 'f' AND connamespace = current_schema()::regnamespace`)).getRowObjectsJS();
  return {
    bySession: childrenFirst(usable.filter(table => table.hasSession).map(table => table.name),
      references.map(row => [String(row.child), String(row.parent)] as const)),
    // Loop bookkeeping tables are keyed only by the turn they describe.
    byTurn: usable.filter(table => !table.hasSession && table.hasTurn).map(table => table.name)
  };
}

/** Deletes referencing tables before the tables they reference, so a cascade never removes rows uncounted. */
export function childrenFirst(names: string[], references: ReadonlyArray<readonly [child: string, parent: string]>) {
  const remaining = new Set(names);
  const ordered: string[] = [];
  while (remaining.size) {
    const next = [...remaining].find(name => !references.some(([child, parent]) => parent === name && child !== name && remaining.has(child)))
      ?? [...remaining][0];
    ordered.push(next);
    remaining.delete(next);
  }
  return ordered;
}

export function encodeSessionArchive(payload: SessionArchivePayload) {
  const json = JSON.stringify(payload);
  return { json, checksum: createHash("sha256").update(json).digest("hex"), compressed: gzipSync(json) };
}

export function decodeSessionArchive(compressed: Buffer, checksum: string): SessionArchivePayload {
  const json = gunzipSync(compressed).toString("utf8");
  if (createHash("sha256").update(json).digest("hex") !== checksum) throw new Error("Session archive checksum mismatch.");
  return JSON.parse(json) as SessionArchivePayload;
}

function rowCountsOf(tables: SessionArchivePayload["tables"]) {
  return Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length]));
}

function stringValues(rows: Record<string, unknown>[] | undefined, key: string) {
  return (rows ?? []).flatMap(row => typeof row[key] === "string" && row[key].trim() ? [row[key] as string] : []);
}

/**
 * Backs up every Threadex row owned by the session, verifies the stored copy, then removes the
 * originals and the actor-list entry. One transaction: a failure at any step leaves the session intact.
 */
export async function archiveSessionRows(connection: SessionDbConnection, input: {
  sessionId: string; reason: SessionArchiveReason; nativeArchive: NativeArchiveOutcome[]; activeSessionSql: string;
}): Promise<SessionArchiveRecord> {
  const { sessionId } = input;
  return connection.withTransaction(async run => {
    const [session] = await (await run(`SELECT to_jsonb(s) AS row, (${blockedSessionSql(input.activeSessionSql)}) AS blocked
      FROM sessions s WHERE s.id = $sessionId FOR UPDATE`, { sessionId })).getRowObjectsJS();
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.blocked === true) throw new SessionArchiveBlocked("Session has running, queued or dependent work and cannot be archived.");
    const sessionRow = session.row as Record<string, unknown>;
    const workspaceId = String(sessionRow.workspace_id);

    const roomRows = await (await run("SELECT state FROM actor_room WHERE workspace_id = $workspaceId FOR UPDATE", { workspaceId })).getRowObjectsJS();
    const room = roomRows[0] ? (typeof roomRows[0].state === "string" ? JSON.parse(roomRows[0].state) : roomRows[0].state) as ActorRoom : null;
    const actorWork = room?.workItems.filter(work => work.taskSessionId === sessionId
      || work.executionHistory.some(entry => entry.taskSessionId === sessionId)) ?? [];
    if (actorWork.some(work => work.taskSessionId === sessionId && ACTIVE_ACTOR_WORK.has(work.status)))
      throw new SessionArchiveBlocked("Session belongs to an unfinished actor task and cannot be archived.");

    const archivedAt = new Date().toISOString();
    const { bySession, byTurn } = await sessionTables(run);
    const tables: SessionArchivePayload["tables"] = { sessions: [sessionRow] };
    const turnIds = "SELECT id FROM session_turn WHERE session_id = $sessionId";
    for (const name of byTurn) {
      const rows = await (await run(`SELECT to_jsonb(t) AS row FROM ${quoteIdentifier(name)} t WHERE t.turn_id IN (${turnIds})`, { sessionId })).getRowObjectsJS();
      if (rows.length) tables[name] = rows.map(row => row.row as Record<string, unknown>);
    }
    for (const name of bySession) {
      const rows = await (await run(`SELECT to_jsonb(t) AS row FROM ${quoteIdentifier(name)} t WHERE t.session_id = $sessionId`, { sessionId })).getRowObjectsJS();
      if (rows.length) tables[name] = rows.map(row => row.row as Record<string, unknown>);
    }
    const rowCounts = rowCountsOf(tables);
    const nativeThreadIds = [...new Set([...stringValues(tables.sessions, "thread_id"), ...stringValues(tables.session_provider_thread, "thread_id"),
      ...stringValues(tables.session_turn, "native_thread_id"), ...input.nativeArchive.map(thread => thread.threadId)])];
    const turnCount = rowCounts.session_turn ?? 0;
    const eventCount = rowCounts.session_turn_event ?? 0;
    const encoded = encodeSessionArchive({ formatVersion: SESSION_ARCHIVE_FORMAT_VERSION, sessionId, archivedAt, tables });

    await run(`INSERT INTO session_archive (session_id, workspace_id, title, reason, native_thread_ids, native_archive, turn_count, event_count,
        row_counts, format, format_version, payload, uncompressed_bytes, compressed_bytes, checksum, session_created, last_activity, archived_at)
      VALUES ($sessionId, $workspaceId, $title, $reason, $nativeThreadIds, $nativeArchive::JSONB, $turnCount, $eventCount,
        $rowCounts::JSONB, $format, $formatVersion, $payload, $uncompressedBytes, $compressedBytes, $checksum,
        $sessionCreated::TIMESTAMPTZ, $lastActivity::TIMESTAMPTZ, $archivedAt::TIMESTAMPTZ)`, {
      sessionId, workspaceId, title: String(sessionRow.title ?? ""), reason: input.reason, nativeThreadIds,
      nativeArchive: JSON.stringify(input.nativeArchive), turnCount, eventCount, rowCounts: JSON.stringify(rowCounts),
      format: SESSION_ARCHIVE_FORMAT, formatVersion: SESSION_ARCHIVE_FORMAT_VERSION, payload: encoded.compressed,
      uncompressedBytes: Buffer.byteLength(encoded.json), compressedBytes: encoded.compressed.length, checksum: encoded.checksum,
      sessionCreated: (sessionRow.created as string | null) ?? null, lastActivity: (sessionRow.updated as string | null) ?? null, archivedAt
    });

    // Verify the stored bytes, not the in-memory copy, before any original row is removed.
    const [stored] = await (await run("SELECT payload, checksum FROM session_archive WHERE session_id = $sessionId", { sessionId })).getRowObjectsJS();
    const verified = decodeSessionArchive(stored.payload as Buffer, String(stored.checksum));
    if (JSON.stringify(rowCountsOf(verified.tables)) !== JSON.stringify(rowCounts)) throw new Error("Session archive verification failed: row counts differ.");

    // A row committed after the snapshot would be deleted without a backup; the count check rolls that back.
    const remove = async (name: string, sql: string) => {
      const deleted = (await run(sql, { sessionId })).rowCount;
      if (deleted !== (rowCounts[name] ?? 0)) throw new Error(`Session ${sessionId} changed during archive (${name}: ${deleted} != ${rowCounts[name] ?? 0}).`);
    };
    for (const name of byTurn) await remove(name, `DELETE FROM ${quoteIdentifier(name)} WHERE turn_id IN (${turnIds})`);
    for (const name of bySession) await remove(name, `DELETE FROM ${quoteIdentifier(name)} WHERE session_id = $sessionId`);
    await remove("sessions", "DELETE FROM sessions WHERE id = $sessionId");

    let removedFromActorList = false;
    if (room && actorWork.length && !room.archivedSessionIds?.includes(sessionId)) {
      const previousRevision = Number(room.revision) || 0;
      room.archivedSessionIds = [...room.archivedSessionIds ?? [], sessionId];
      room.revision = previousRevision + 1;
      const updated = await run(`UPDATE actor_room SET state = $state::JSONB
        WHERE workspace_id = $workspaceId AND COALESCE((state->>'revision')::BIGINT, 0) = $previousRevision`,
        { workspaceId, state: JSON.stringify(room), previousRevision });
      if (updated.rowCount !== 1) throw new Error("Actor room changed during archive; retry.");
      removedFromActorList = true;
    }
    return { sessionId, workspaceId, title: String(sessionRow.title ?? ""), reason: input.reason, turnCount, eventCount, rowCounts,
      nativeThreadIds, nativeArchive: input.nativeArchive, uncompressedBytes: Buffer.byteLength(encoded.json),
      compressedBytes: encoded.compressed.length, checksum: encoded.checksum, archivedAt, removedFromActorList };
  });
}

export async function readSessionArchive(connection: SessionDbConnection, sessionId: string): Promise<SessionArchivePayload | null> {
  const [row] = await (await connection.run("SELECT payload, checksum FROM session_archive WHERE session_id = $sessionId", { sessionId })).getRowObjectsJS();
  return row ? decodeSessionArchive(row.payload as Buffer, String(row.checksum)) : null;
}

/** Claims the day's run across API processes; an unfinished claim older than six hours is presumed crashed. */
export async function claimSessionArchiveRun(connection: SessionDbConnection, day: string) {
  const result = await connection.run(`INSERT INTO session_archive_run (run_day) VALUES ($day::DATE)
    ON CONFLICT (run_day) DO UPDATE SET started = now(), finished = NULL, result = NULL
    WHERE session_archive_run.finished IS NULL AND session_archive_run.started < now() - interval '6 hours'`, { day });
  return result.rowCount === 1;
}

export async function finishSessionArchiveRun(connection: SessionDbConnection, day: string, result: unknown) {
  await connection.run("UPDATE session_archive_run SET finished = now(), result = $result::JSONB WHERE run_day = $day::DATE",
    { day, result: JSON.stringify(result) });
}
