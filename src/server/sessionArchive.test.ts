import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { ActorWorkItem, DomainActor } from "../domainActors";
import { actorOwnedSessions } from "../client/actorRoomPresentation";
import { archiveRetentionDays, dueArchiveCandidates, SESSION_ARCHIVE_POLICY, SessionArchiveService } from "./sessionArchive";
import { childrenFirst, SessionArchiveBlocked, type NativeArchiveOutcome, type SessionArchiveRecord, type SessionNativeThread } from "./sessionArchiveStore";
import type { SessionDbConnection } from "./sessionDb";
import { SessionStore } from "./sessionStore";

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "session-archive-test-"));
  const store = new SessionStore(resolve(root, `archive-${randomUUID()}.postgres`));
  await store.ready();
  const sql = (statement: string, params: Record<string, unknown> = {}) =>
    (store as unknown as { write<T>(callback: (connection: SessionDbConnection) => Promise<T>): Promise<T> })
      .write(async connection => (await connection.run(statement, params as never)).getRowObjectsJS());
  const native: SessionNativeThread[] = [];
  const published: SessionArchiveRecord[] = [];
  let failNative = false;
  const service = (policy = {}, now = () => new Date()) => new SessionArchiveService({
    store, now, policy, log: () => undefined,
    archiveNative: async thread => {
      if (failNative) throw new Error("codex app-server exited");
      native.push(thread);
      return { ...thread, status: thread.provider === "codex" ? "archived" : "unsupported" } as NativeArchiveOutcome;
    },
    published: async record => { published.push(record); }
  });
  /** Creates a finished session with the given size, last active `idleDays` ago. */
  const session = async (id: string, input: { turns: number; events: number; idleDays: number; threadId?: string }) => {
    await store.upsertSession({ id, workspaceId: "default", cwd: root, title: `Session ${id}` });
    for (let turn = 0; turn < input.turns; turn++) {
      const turnId = `${id}-turn-${turn}`;
      await store.recordSessionTurn({ id: turnId, sessionId: id, userInput: `prompt ${turn}`, agentResponse: "answer", status: "done", tokenIn: 1, tokenOut: 1 });
      for (let event = 0; event < Math.ceil(input.events / input.turns); event++)
        await store.recordSessionTurnEvent({ turnId, sessionId: id, eventName: "delta", payload: { turn, event } });
    }
    if (input.threadId) await sql(`INSERT INTO session_provider_thread (session_id, provider, native_home, cwd, thread_id)
      VALUES ($id, 'codex', $home, $cwd, $threadId)`, { id, home: resolve(root, "codex-home"), cwd: root, threadId: input.threadId });
    const ago = { ago: `${input.idleDays} days` };
    await sql("UPDATE sessions SET created = now() - $ago::INTERVAL, updated = now() - $ago::INTERVAL WHERE id = $id", { ...ago, id });
    await sql("UPDATE session_turn SET created = now() - $ago::INTERVAL WHERE session_id = $id", { ...ago, id });
    await sql("UPDATE session_turn_event SET created = now() - $ago::INTERVAL WHERE session_id = $id", { ...ago, id });
  };
  const count = async (table: string, id: string) => Number((await sql(`SELECT count(*) AS n FROM ${table} WHERE ${table === "sessions" ? "id" : "session_id"} = $id`, { id }))[0].n);
  return { root, store, sql, native, published, service, session, count, setNativeFailure: (value: boolean) => { failNative = value; } };
}

async function withFixture(run: (f: Fixture) => Promise<void>) {
  const f = await fixture();
  try { await run(f); } finally { await f.store.close(); }
}

test("retention grows with turns and events and stays within the policy bounds", () => {
  assert.equal(archiveRetentionDays(0, 0), SESSION_ARCHIVE_POLICY.minRetentionDays);
  assert.ok(archiveRetentionDays(1, 10) < archiveRetentionDays(5, 10));
  assert.ok(archiveRetentionDays(5, 10) < archiveRetentionDays(5, 1000));
  assert.equal(archiveRetentionDays(10_000, 10_000_000), SESSION_ARCHIVE_POLICY.maxRetentionDays);
  const now = new Date("2026-10-24T00:00:00Z");
  const idle = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const due = dueArchiveCandidates([
    { sessionId: "long", workspaceId: "w", turnCount: 4, eventCount: 60, lastActivity: idle(40) },
    { sessionId: "recent", workspaceId: "w", turnCount: 0, eventCount: 0, lastActivity: idle(2) },
    { sessionId: "short", workspaceId: "w", turnCount: 1, eventCount: 2, lastActivity: idle(5) },
    { sessionId: "large-but-young", workspaceId: "w", turnCount: 30, eventCount: 5000, lastActivity: idle(10) }
  ], now);
  assert.deepEqual(due.map(candidate => candidate.sessionId), ["short", "long"]);
});

test("deletion order removes referencing tables before the tables they reference", () => {
  assert.deepEqual(childrenFirst(["a_parent", "b_child", "c"], [["b_child", "a_parent"]]), ["b_child", "a_parent", "c"]);
});

test("archiving backs up every session row compressed, verifies it and removes the originals", () => withFixture(async f => {
  await f.session("s1", { turns: 2, events: 4, idleDays: 1, threadId: "thread-s1" });
  await f.sql("INSERT INTO local_session_file (path, source, session_id) VALUES ('/tmp/rollout-s1.jsonl', 'sessions', 's1')");
  await f.sql("INSERT INTO turn_loop_mode (turn_id) VALUES ('s1-turn-0')");

  const record = await f.service().archiveSession("s1", "manual");
  assert.equal(record.turnCount, 2);
  assert.equal(record.eventCount, 4);
  assert.equal(record.rowCounts.turn_loop_mode, 1);
  assert.deepEqual(record.nativeThreadIds, ["thread-s1"]);
  assert.deepEqual(f.native.map(thread => thread.threadId), ["thread-s1"]);
  assert.ok(record.compressedBytes < record.uncompressedBytes);

  const backup = await f.store.readSessionArchive("s1");
  assert.equal(backup?.tables.sessions[0].title, "Session s1");
  assert.equal(backup?.tables.session_turn.length, 2);
  assert.equal(backup?.tables.session_turn_event.length, 4);
  assert.equal(backup?.tables.session_provider_thread[0].thread_id, "thread-s1");
  const [stored] = await f.sql("SELECT reason, format, native_archive FROM session_archive WHERE session_id = 's1'");
  assert.equal(stored.reason, "manual");
  assert.equal(stored.format, "gzip+json");
  assert.equal((stored.native_archive as NativeArchiveOutcome[])[0].status, "archived");

  for (const table of ["sessions", "session_turn", "session_turn_event", "session_provider_thread"]) assert.equal(await f.count(table, "s1"), 0, table);
  assert.equal((await f.sql("SELECT count(*) AS n FROM turn_loop_mode WHERE turn_id = 's1-turn-0'"))[0].n, 0);
  assert.equal(await f.count("local_session_file", "s1"), 1, "import metadata stays as a dedupe record");
  assert.equal(await f.store.getSession("s1"), null);
  assert.equal(f.published.length, 1);
  await assert.rejects(f.service().archiveSession("s1", "manual"), /Session not found/);
}));

test("a failure while removing originals rolls back the backup and the deletes", () => withFixture(async f => {
  await f.session("s1", { turns: 1, events: 3, idleDays: 1 });
  await f.sql(`CREATE FUNCTION fail_archive_delete() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''delete blocked''; END'`);
  await f.sql("CREATE TRIGGER fail_archive_delete BEFORE DELETE ON session_turn_event FOR EACH ROW EXECUTE FUNCTION fail_archive_delete()");
  await assert.rejects(f.service().archiveSession("s1", "manual"), /delete blocked/);
  assert.equal(await f.count("sessions", "s1"), 1);
  assert.equal(await f.count("session_turn", "s1"), 1);
  assert.equal(await f.count("session_turn_event", "s1"), 3);
  assert.equal((await f.sql("SELECT count(*) AS n FROM session_archive"))[0].n, 0);
  assert.equal(f.published.length, 0);
}));

test("a native archive failure leaves the Threadex session untouched", () => withFixture(async f => {
  await f.session("s1", { turns: 1, events: 1, idleDays: 10, threadId: "thread-s1" });
  f.setNativeFailure(true);
  await assert.rejects(f.service().archiveSession("s1", "manual"), /app-server exited/);
  assert.equal(await f.count("sessions", "s1"), 1);
  assert.equal(await f.store.readSessionArchive("s1"), null);
}));

test("running, queued and parent sessions are never archived", () => withFixture(async f => {
  await f.session("running", { turns: 1, events: 1, idleDays: 30 });
  await f.sql("UPDATE session_turn SET status = 'running' WHERE session_id = 'running'");
  await f.session("queued", { turns: 1, events: 1, idleDays: 30 });
  await f.sql("UPDATE session_turn SET status = 'todo' WHERE session_id = 'queued'");
  await f.session("parent", { turns: 1, events: 1, idleDays: 30 });
  await f.store.upsertSession({ id: "child", workspaceId: "default", cwd: f.root, parentSessionId: "parent" });
  await assert.rejects(f.service().archiveSession("running", "manual"), SessionArchiveBlocked);
  await assert.rejects(f.service().archiveSession("queued", "manual"), SessionArchiveBlocked);
  await assert.rejects(f.service().archiveSession("parent", "manual"), SessionArchiveBlocked);
  const candidates = (await f.store.listSessionArchiveCandidates(3)).map(candidate => candidate.sessionId);
  assert.deepEqual(candidates, []);
  assert.equal(f.native.length, 0);
}));

test("the daily run archives due short sessions first, keeps young ones and runs once per day", () => withFixture(async f => {
  await f.session("young", { turns: 0, events: 0, idleDays: 2 });
  await f.session("short", { turns: 1, events: 2, idleDays: 6 });
  await f.session("long", { turns: 6, events: 120, idleDays: 20 });
  await f.session("large-not-due", { turns: 40, events: 4000, idleDays: 8 });
  const daily = f.service({ batchLimit: 1 });
  const first = await daily.runDaily();
  assert.deepEqual(first?.archived, ["short"], "batch limit keeps only the shortest due session");
  assert.equal(await daily.runDaily(), null, "the same day is not run twice");
  assert.equal(await f.service({ batchLimit: 1 }).runDaily(), null, "another process cannot claim the same day");

  const tomorrow = new Date(Date.now() + 86_400_000);
  const next = await f.service({}, () => tomorrow).runDaily();
  assert.deepEqual(next?.archived, ["long"]);
  assert.ok(await f.store.getSession("young"));
  assert.ok(await f.store.getSession("large-not-due"));
  const [run] = await f.sql("SELECT finished, result FROM session_archive_run ORDER BY run_day LIMIT 1");
  assert.ok(run.finished);
  assert.deepEqual((run.result as { archived: string[] }).archived, ["short"]);
}));

test("concurrent daily runs in one process share a single claim", () => withFixture(async f => {
  await f.session("short", { turns: 1, events: 1, idleDays: 6 });
  const daily = f.service();
  const [a, b] = await Promise.all([daily.runDaily(), daily.runDaily()]);
  assert.equal(a, b);
  assert.deepEqual(a?.archived, ["short"]);
}));

test("archived sessions leave the actor session list and active actor tasks block archiving", () => withFixture(async f => {
  await f.session("done-task", { turns: 1, events: 1, idleDays: 1 });
  await f.session("active-task", { turns: 1, events: 1, idleDays: 1 });
  const actor = { id: "actor", parentActorId: null, name: "Actor" } as DomainActor;
  const work = (id: string, sessionId: string, status: ActorWorkItem["status"]) => ({ id, ownerActorId: "actor", executorActorId: "actor",
    taskSessionId: sessionId, taskTurnId: `${sessionId}-turn-0`, status, executionHistory: [], updated: new Date().toISOString() }) as unknown as ActorWorkItem;
  await f.store.changeDomainActorRoom("default", room => {
    room.actors.push(actor);
    room.workItems.push(work("w1", "done-task", "completed"), work("w2", "active-task", "started"));
  });
  const before = await f.store.getDomainActorRoom("default");
  assert.deepEqual(actorOwnedSessions(before, actor).map(entry => entry.sessionId).sort(), ["active-task", "done-task"]);

  const record = await f.service().archiveSession("done-task", "manual");
  assert.equal(record.removedFromActorList, true);
  const after = await f.store.getDomainActorRoom("default");
  assert.deepEqual(after.archivedSessionIds, ["done-task"]);
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(actorOwnedSessions(after, actor).map(entry => entry.sessionId), ["active-task"]);
  assert.equal(after.workItems.length, 2, "work history is kept");
  assert.deepEqual(f.published.map(item => [item.sessionId, item.removedFromActorList]), [["done-task", true]]);

  await assert.rejects(f.service().archiveSession("active-task", "manual"), /unfinished actor task/);
  assert.ok(await f.store.getSession("active-task"));
}));

test("an archived Codex transcript is not imported again", () => withFixture(async f => {
  const thread = "eeeeeeee-1111-4222-8333-ffffffffffff";
  const codexHome = resolve(f.root, "codex-home");
  const dir = resolve(codexHome, "sessions", "2026", "10", "01");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `rollout-${thread}.jsonl`);
  writeFileSync(path, [
    { timestamp: "2026-10-01T10:00:00Z", type: "session_meta", payload: { id: thread, cwd: f.root } },
    { timestamp: "2026-10-01T10:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: "native-1" } },
    { timestamp: "2026-10-01T10:00:02Z", type: "event_msg", payload: { type: "user_message", message: "hello" } },
    { timestamp: "2026-10-01T10:00:03Z", type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "hi" } },
    { timestamp: "2026-10-01T10:00:04Z", type: "event_msg", payload: { type: "task_complete", turn_id: "native-1" } }
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  const imported = await f.store.importLocalCodexSessionFile({ path, codexHome, workspaceId: "default" });
  assert.ok(imported.sessionId && !imported.skipped);
  await f.service().archiveSession(imported.sessionId!, "manual");

  const again = await f.store.importLocalCodexSessionFile({ path, codexHome, workspaceId: "default" });
  assert.equal(again.skipped, true);
  assert.equal(await f.store.getSession(imported.sessionId!), null);
  assert.equal((await f.sql("SELECT count(*) AS n FROM sessions WHERE thread_id = $thread", { thread }))[0].n, 0);
}));
