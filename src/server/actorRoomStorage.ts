import { createHash } from "node:crypto";
import type { ActorRoom } from "../domainActors";
import { shareJsonDocument } from "./jsonDocument";
import type { SessionDbConnection } from "./sessionDb";

/** Actor room storage. actor_room keeps the small, frequently changed core document; rounds grow without
 * bound, so each round is one actor_round row, and the frozen actor snapshots inside rounds (memory, avatar)
 * are content-addressed once in actor_snapshot, since most rounds repeat the same actor versions.
 * Every write bumps the core revision in the same transaction as its round rows, so the core row's xmin
 * still validates a cached room, and the per-round xmin lets a reload fetch only changed rounds.
 * Callers keep seeing the same assembled ActorRoom; shared snapshots are frozen and never copied. */

type Run = SessionDbConnection["run"];
type JsonObject = Record<string, unknown>;
type ActorRound = ActorRoom["rounds"][number];

export const ACTOR_ROOM_STORAGE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS actor_round (
    workspace_id VARCHAR NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    round_id VARCHAR NOT NULL, position INTEGER NOT NULL, state JSONB NOT NULL,
    PRIMARY KEY (workspace_id, round_id)
  )`,
  "CREATE INDEX IF NOT EXISTS actor_round_position_idx ON actor_round (workspace_id, position)",
  `CREATE TABLE IF NOT EXISTS actor_snapshot (
    workspace_id VARCHAR NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    hash VARCHAR NOT NULL, state JSONB NOT NULL,
    PRIMARY KEY (workspace_id, hash)
  )`
];

const SNAPSHOT_REFERENCE = "$actorSnapshot";
const BATCH_BYTES = 4 * 1024 * 1024;
const INSERT_SNAPSHOTS_SQL = `INSERT INTO actor_snapshot (workspace_id, hash, state)
  SELECT $workspaceId, item->>'hash', item->'state' FROM jsonb_array_elements($items::JSONB) AS item
  ON CONFLICT (workspace_id, hash) DO NOTHING`;
const UPSERT_ROUNDS_SQL = `INSERT INTO actor_round (workspace_id, round_id, position, state)
  SELECT $workspaceId, item->>'id', (item->>'position')::INTEGER, item->'state' FROM jsonb_array_elements($items::JSONB) AS item
  ON CONFLICT (workspace_id, round_id) DO UPDATE SET position = EXCLUDED.position, state = EXCLUDED.state
  RETURNING round_id, xmin::text AS version`;

/** Hash of each shared snapshot object; shared objects are frozen, so the hash cannot go stale. */
const snapshotHashes = new WeakMap<object, string>();

export type ActorRoomCache = {
  /** xmin of the actor_room core row. */
  version: string;
  /** Assembled room; never handed out without cloneJsonDocument. */
  room: ActorRoom;
  coreText: string;
  rounds: ReadonlyMap<string, { version: string; position: number; text: string }>;
  /** Committed snapshots only, so a rolled-back write can never leave a round referencing a missing row. */
  snapshots: ReadonlyMap<string, object>;
};

export type ActorRoomLoad = { kind: "room"; cache: ActorRoomCache } | { kind: "legacy" } | { kind: "missing" };

export type ActorRoomWritePlan = {
  changed: boolean;
  rounds: { id: string; position: number; text: string }[];
  removedRoundIds: string[];
  snapshots: Map<string, { text: string; object: object }>;
  hashes: Map<object, string>;
};

/** Thrown inside a write transaction when the room still holds rounds inline; migrate, then retry. */
export class LegacyActorRoomError extends Error {
  constructor() { super("Actor room still stores rounds inline."); }
}

export function actorRoomCore(room: ActorRoom): JsonObject {
  const { rounds: _rounds, ...core } = room as ActorRoom & JsonObject;
  return core;
}

function parseJson(value: unknown): JsonObject {
  return (typeof value === "string" ? JSON.parse(value) : value) as JsonObject;
}

async function rowsOf(result: ReturnType<Run>) {
  return (await result).getRowObjectsJS();
}

function snapshotHash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function shareSnapshot(snapshot: object, hash: string) {
  shareJsonDocument(snapshot);
  snapshotHashes.set(snapshot, hash);
  return snapshot;
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The stored form of a round: snapshots become `{ $actorSnapshot: hash }` references. */
function storedRound(round: JsonObject, referenceOf: (snapshot: object) => string): JsonObject {
  const stored: JsonObject = { ...round };
  if (Array.isArray(round.actorSnapshots)) {
    stored.actorSnapshots = round.actorSnapshots.map(actor => isObject(actor) ? { [SNAPSHOT_REFERENCE]: referenceOf(actor) } : actor);
  }
  if (Array.isArray(round.candidateSnapshots)) {
    stored.candidateSnapshots = round.candidateSnapshots.map(candidate => isObject(candidate) && isObject(candidate.actor)
      ? { ...candidate, actor: { [SNAPSHOT_REFERENCE]: referenceOf(candidate.actor) } } : candidate);
  }
  return stored;
}

function referenceHash(value: unknown) {
  return isObject(value) && typeof value[SNAPSHOT_REFERENCE] === "string" ? value[SNAPSHOT_REFERENCE] as string : null;
}

function snapshotReferences(stored: JsonObject): string[] {
  const hashes: string[] = [];
  for (const actor of Array.isArray(stored.actorSnapshots) ? stored.actorSnapshots : []) {
    const hash = referenceHash(actor);
    if (hash) hashes.push(hash);
  }
  for (const candidate of Array.isArray(stored.candidateSnapshots) ? stored.candidateSnapshots : []) {
    const hash = isObject(candidate) ? referenceHash(candidate.actor) : null;
    if (hash) hashes.push(hash);
  }
  return hashes;
}

function assembleRound(stored: JsonObject, snapshots: ReadonlyMap<string, object>): ActorRound {
  const resolve = (value: unknown) => {
    const hash = referenceHash(value);
    if (!hash) return value;
    const snapshot = snapshots.get(hash);
    if (!snapshot) throw new Error(`Actor snapshot ${hash} is missing.`);
    return snapshot;
  };
  const round: JsonObject = { ...stored };
  if (Array.isArray(stored.actorSnapshots)) round.actorSnapshots = stored.actorSnapshots.map(resolve);
  if (Array.isArray(stored.candidateSnapshots)) {
    round.candidateSnapshots = stored.candidateSnapshots.map(candidate => isObject(candidate) && referenceHash(candidate.actor)
      ? { ...candidate, actor: resolve(candidate.actor) } : candidate);
  }
  return round as unknown as ActorRound;
}

async function insertBatches(run: Run, sql: string, workspaceId: string, items: string[]) {
  const results: Record<string, unknown>[] = [];
  let batch: string[] = [];
  let bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    results.push(...await rowsOf(run(sql, { workspaceId, items: `[${batch.join(",")}]` })));
    batch = [];
    bytes = 0;
  };
  for (const item of items) {
    if (bytes + item.length > BATCH_BYTES) await flush();
    batch.push(item);
    bytes += item.length;
  }
  await flush();
  return results;
}

const versionSql = "SELECT xmin::text AS version FROM actor_room WHERE workspace_id = $workspaceId";

/** Load the room, reusing every round and snapshot of `cached` whose row version is unchanged. */
export async function loadActorRoom(run: Run, workspaceId: string, cached: ActorRoomCache | undefined): Promise<ActorRoomLoad> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const [current] = await rowsOf(run(versionSql, { workspaceId }));
    if (!current) return { kind: "missing" };
    if (cached?.version === String(current.version)) return { kind: "room", cache: cached };
    const [coreRow] = await rowsOf(run("SELECT xmin::text AS version, state FROM actor_room WHERE workspace_id = $workspaceId", { workspaceId }));
    if (!coreRow) return { kind: "missing" };
    const core = parseJson(coreRow.state);
    if (Array.isArray(core.rounds)) return { kind: "legacy" };
    const index = (await rowsOf(run("SELECT round_id, position, xmin::text AS version FROM actor_round WHERE workspace_id = $workspaceId ORDER BY position, round_id",
      { workspaceId }))).map(row => ({ id: String(row.round_id), position: Number(row.position), version: String(row.version) }));
    const staleIds = index.filter(row => cached?.rounds.get(row.id)?.version !== row.version).map(row => row.id);
    const fetched = new Map<string, { version: string; state: JsonObject }>();
    if (staleIds.length) {
      for (const row of await rowsOf(run(`SELECT round_id, xmin::text AS version, state FROM actor_round
        WHERE workspace_id = $workspaceId AND round_id = ANY($roundIds::VARCHAR[])`, { workspaceId, roundIds: staleIds }))) {
        fetched.set(String(row.round_id), { version: String(row.version), state: parseJson(row.state) });
      }
    }
    const snapshots = new Map(cached?.snapshots ?? []);
    const missing = [...new Set([...fetched.values()].flatMap(round => snapshotReferences(round.state)))].filter(hash => !snapshots.has(hash));
    if (missing.length) {
      for (const row of await rowsOf(run("SELECT hash, state FROM actor_snapshot WHERE workspace_id = $workspaceId AND hash = ANY($hashes::VARCHAR[])",
        { workspaceId, hashes: missing }))) {
        snapshots.set(String(row.hash), shareSnapshot(parseJson(row.state), String(row.hash)));
      }
    }
    // Every write updates the core row in the same transaction, so an unchanged core version and
    // matching round versions prove these separate reads saw one committed state.
    const [after] = await rowsOf(run(versionSql, { workspaceId }));
    if (String(after?.version) !== String(coreRow.version)) continue;
    if (staleIds.some(id => fetched.get(id)?.version !== index.find(row => row.id === id)!.version)) continue;
    const cachedRounds = new Map((cached?.room.rounds ?? []).map(round => [round.id, round]));
    const rounds: ActorRound[] = [];
    const roundMeta = new Map<string, { version: string; position: number; text: string }>();
    for (const row of index) {
      const fresh = fetched.get(row.id);
      if (fresh) {
        rounds.push(assembleRound(fresh.state, snapshots));
        roundMeta.set(row.id, { version: fresh.version, position: row.position, text: JSON.stringify(fresh.state) });
      } else {
        rounds.push(cachedRounds.get(row.id)!);
        roundMeta.set(row.id, { ...cached!.rounds.get(row.id)!, position: row.position });
      }
    }
    const room = { ...core, rounds } as unknown as ActorRoom;
    return { kind: "room", cache: { version: String(coreRow.version), room, coreText: JSON.stringify(core), rounds: roundMeta, snapshots } };
  }
  throw new Error("Actor room kept changing while it was read; retry.");
}

/** Compare a changed room with its loaded cache. `next` must be the caller's own detached copy. */
export function planActorRoomWrite(cache: ActorRoomCache, next: ActorRoom): ActorRoomWritePlan {
  const snapshots = new Map<string, { text: string; object: object }>();
  const hashes = new Map<object, string>();
  const referenceOf = (snapshot: object) => {
    const known = snapshotHashes.get(snapshot) ?? hashes.get(snapshot);
    if (known) return known;
    const text = JSON.stringify(snapshot);
    const hash = snapshotHash(text);
    hashes.set(snapshot, hash);
    if (!cache.snapshots.has(hash) && !snapshots.has(hash)) snapshots.set(hash, { text, object: snapshot });
    return hash;
  };
  const rounds: ActorRoomWritePlan["rounds"] = [];
  const seen = new Set<string>();
  // Positions only need to increase: a kept round keeps its stored position, so removing or appending
  // a round rewrites no other row. Only a round now out of order is renumbered.
  let lastPosition = -1;
  for (const round of next.rounds) {
    const id = (round as { id?: unknown }).id;
    if (typeof id !== "string" || seen.has(id)) throw new Error(`Actor round ID ${String(id)} is missing or duplicated.`);
    seen.add(id);
    const text = JSON.stringify(storedRound(round as unknown as JsonObject, referenceOf));
    const previous = cache.rounds.get(id);
    const position = previous && previous.position > lastPosition ? previous.position : lastPosition + 1;
    lastPosition = position;
    if (previous?.text !== text || previous.position !== position) rounds.push({ id, position, text });
  }
  const removedRoundIds = [...cache.rounds.keys()].filter(id => !seen.has(id));
  const changed = rounds.length > 0 || removedRoundIds.length > 0 || JSON.stringify(actorRoomCore(next)) !== cache.coreText;
  return { changed, rounds, removedRoundIds, snapshots, hashes };
}

/** Write a planned change inside the caller's transaction. Null when the revision CAS lost to another writer.
 * The returned cache is valid only once that transaction commits. */
export async function writeActorRoom(run: Run, workspaceId: string, cache: ActorRoomCache, next: ActorRoom,
  plan: ActorRoomWritePlan, previousRevision: number): Promise<ActorRoomCache | null> {
  const coreText = JSON.stringify(actorRoomCore(next));
  const updated = await run(`UPDATE actor_room SET state = $state::JSONB
    WHERE workspace_id = $workspaceId AND COALESCE((state->>'revision')::BIGINT, 0) = $previousRevision
    RETURNING xmin::text AS version`, { workspaceId, state: coreText, previousRevision });
  if (updated.rowCount !== 1) return null;
  const [{ version }] = await updated.getRowObjectsJS();
  await insertBatches(run, INSERT_SNAPSHOTS_SQL, workspaceId,
    [...plan.snapshots].map(([hash, snapshot]) => `{"hash":${JSON.stringify(hash)},"state":${snapshot.text}}`));
  const roundVersions = new Map((await insertBatches(run, UPSERT_ROUNDS_SQL, workspaceId,
    plan.rounds.map(round => `{"id":${JSON.stringify(round.id)},"position":${round.position},"state":${round.text}}`)))
    .map(row => [String(row.round_id), String(row.version)]));
  if (plan.removedRoundIds.length) {
    await run("DELETE FROM actor_round WHERE workspace_id = $workspaceId AND round_id = ANY($roundIds::VARCHAR[])",
      { workspaceId, roundIds: plan.removedRoundIds });
  }

  const snapshots = new Map(cache.snapshots);
  for (const [hash, snapshot] of plan.snapshots) snapshots.set(hash, shareSnapshot(snapshot.object, hash));
  const sharedSnapshot = (snapshot: unknown) => {
    if (!isObject(snapshot)) return snapshot;
    const hash = snapshotHashes.get(snapshot) ?? plan.hashes.get(snapshot);
    return (hash && snapshots.get(hash)) || snapshot;
  };
  const written = new Map(plan.rounds.map(round => [round.id, round]));
  const cachedRounds = new Map(cache.room.rounds.map(round => [round.id, round]));
  const roundMeta = new Map<string, { version: string; position: number; text: string }>();
  const rounds = next.rounds.map(round => {
    const change = written.get(round.id);
    if (!change) {
      roundMeta.set(round.id, cache.rounds.get(round.id)!);
      return cachedRounds.get(round.id)!;
    }
    roundMeta.set(round.id, { version: roundVersions.get(round.id)!, position: change.position, text: change.text });
    const value = round as unknown as JsonObject;
    if (Array.isArray(value.actorSnapshots)) value.actorSnapshots = value.actorSnapshots.map(sharedSnapshot);
    if (Array.isArray(value.candidateSnapshots)) {
      value.candidateSnapshots = value.candidateSnapshots.map(candidate => isObject(candidate) && isObject(candidate.actor)
        ? { ...candidate, actor: sharedSnapshot(candidate.actor) } : candidate);
    }
    return round;
  });
  return { version: String(version), room: { ...next, rounds }, coreText, rounds: roundMeta, snapshots };
}

/** Move inline rounds of a legacy (or older-process) core document into rows, merging by round ID.
 * Lossless and idempotent; run in its own transaction. */
export async function migrateLegacyActorRoom(run: Run, workspaceId: string): Promise<boolean> {
  const [row] = await rowsOf(run("SELECT state FROM actor_room WHERE workspace_id = $workspaceId FOR UPDATE", { workspaceId }));
  if (!row) return false;
  const state = parseJson(row.state);
  if (!Array.isArray(state.rounds)) return false;
  const existing = await rowsOf(run("SELECT round_id, position FROM actor_round WHERE workspace_id = $workspaceId", { workspaceId }));
  const positions = new Map(existing.map(round => [String(round.round_id), Number(round.position)]));
  let nextPosition = existing.length ? Math.max(...positions.values()) + 1 : 0;
  const snapshots = new Map<string, string>();
  const referenceOf = (snapshot: object) => {
    const text = JSON.stringify(snapshot);
    const hash = snapshotHash(text);
    snapshots.set(hash, text);
    return hash;
  };
  const items = (state.rounds as JsonObject[]).map(round => {
    if (typeof round.id !== "string") throw new Error("A legacy actor round has no ID.");
    const position = positions.get(round.id) ?? nextPosition++;
    return `{"id":${JSON.stringify(round.id)},"position":${position},"state":${JSON.stringify(storedRound(round, referenceOf))}}`;
  });
  await insertBatches(run, INSERT_SNAPSHOTS_SQL, workspaceId, [...snapshots].map(([hash, text]) => `{"hash":${JSON.stringify(hash)},"state":${text}}`));
  await insertBatches(run, UPSERT_ROUNDS_SQL, workspaceId, items);
  const { rounds: _rounds, ...core } = state;
  await run("UPDATE actor_room SET state = $state::JSONB WHERE workspace_id = $workspaceId", { workspaceId, state: JSON.stringify(core) });
  return true;
}
