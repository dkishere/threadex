import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { SessionStore } from "./sessionStore";
import type { SessionDbConnection } from "./sessionDb";

test("actor room no-ops skip revisions and returned values cannot mutate the cache", async () => {
  if (process.env.SESSION_PG_SCHEMA) throw new Error("Requires an isolated generated schema; unset SESSION_PG_SCHEMA.");
  const store = new SessionStore(`/private/tmp/actor-room-copy-${randomUUID()}`);
  try {
    await store.ready();
    const result = await store.changeDomainActorRoom("default", room => {
      const error = { actorId: "a", eventId: "e", error: "history".repeat(100_000), created: "2026-01-01" };
      room.memoryErrors.push(error);
      return error;
    });
    result.error = "caller mutation";
    const first = await store.getDomainActorRoom("default");
    assert.equal(first.memoryErrors[0].error.length, 700_000);
    await store.changeDomainActorRoom("default", room => { room.conclusions = undefined; });
    assert.equal((await store.getDomainActorRoom("default")).revision, first.revision);
    first.memoryErrors[0].error = "read mutation";
    assert.equal((await store.getDomainActorRoom("default")).memoryErrors[0].error.length, 700_000);
  } finally { await store.close(); }
});

type StoreInternals = { write<T>(operation: (connection: SessionDbConnection) => Promise<T>): Promise<T> };

test("reads do not wait behind a slow serialised write", async () => {
  if (process.env.SESSION_PG_SCHEMA) throw new Error("Requires an isolated generated schema; unset SESSION_PG_SCHEMA.");
  const store = new SessionStore(`/private/tmp/store-concurrency-${randomUUID()}`);
  try {
    await store.ready();
    const preferences = await store.getWorkspaceModelPreferences("default");
    const slowWrite = (store as unknown as StoreInternals).write(connection => connection.run("SELECT pg_sleep(1.5)"));
    await new Promise(resolve => setTimeout(resolve, 100));
    const started = Date.now();
    await store.listWorkspaces();
    assert.deepEqual(await store.getWorkspaceModelPreferences("default"), preferences);
    assert.ok(Date.now() - started < 1000, `read waited ${Date.now() - started}ms behind the write`);
    await slowWrite;
  } finally { await store.close(); }
});

test("concurrent actor room changes on separate stores keep every update", async () => {
  if (process.env.SESSION_PG_SCHEMA) throw new Error("Requires an isolated generated schema; unset SESSION_PG_SCHEMA.");
  const id = `/private/tmp/actor-room-revision-${randomUUID()}`;
  const first = new SessionStore(id), second = new SessionStore(id);
  try {
    await Promise.all([first.ready(), second.ready()]);
    await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second)
      .changeDomainActorRoom("default", room => {
        room.memoryErrors.push({ actorId: "actor", eventId: `update-${index}`, error: "", created: new Date().toISOString() });
      })));
    const room = await first.getDomainActorRoom("default");
    assert.equal(room.revision, 8);
    assert.deepEqual(room.memoryErrors.map(entry => entry.eventId).sort(), Array.from({ length: 8 }, (_, index) => `update-${index}`).sort());
  } finally { await Promise.all([first.close(), second.close()]); }
});

test("concurrent actor room readers share one cold load and recover after a failed refresh", async t => {
  if (process.env.SESSION_PG_SCHEMA) throw new Error("Requires an isolated generated schema; unset SESSION_PG_SCHEMA.");
  const id = `/private/tmp/actor-room-readers-${randomUUID()}`;
  const writer = new SessionStore(id), reader = new SessionStore(id);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const loading = new Promise<void>(resolve => { started = resolve; });
  try {
    await Promise.all([writer.ready(), reader.ready()]);
    await writer.changeDomainActorRoom("default", room => {
      room.memoryErrors.push({ actorId: "a", eventId: "e", error: "history".repeat(100_000), created: "2026-01-01" });
    });
    const connection = await (reader as unknown as { connectionPromise: Promise<SessionDbConnection> }).connectionPromise;
    const run = connection.reader.run.bind(connection.reader);
    let loads = 0, failNextLoad = false;
    t.mock.method(connection.reader, "run", async (...args: Parameters<typeof run>) => {
      if (args[0].includes("SELECT xmin::text AS version, state FROM actor_room")) {
        loads++;
        started();
        await gate;
        if (failNextLoad) { failNextLoad = false; throw new Error("fixture connection lost"); }
      }
      return run(...args);
    });
    const reads = Array.from({ length: 16 }, () => reader.getDomainActorRoom("default"));
    await loading;
    release();
    const rooms = await Promise.all(reads);
    assert.equal(loads, 1, "a cold cache must issue only one full-document read");
    rooms[0].memoryErrors[0].error = "caller mutation";
    assert.equal(rooms[1].memoryErrors[0].error.length, 700_000);
    assert.equal((await reader.getDomainActorRoom("default")).memoryErrors[0].error.length, 700_000);
    assert.equal(loads, 1, "a warm cache must not reload the document");

    await writer.changeDomainActorRoom("default", room => { room.memoryErrors[0].error = "updated"; });
    failNextLoad = true;
    await assert.rejects(Promise.all(Array.from({ length: 4 }, () => reader.getDomainActorRoom("default"))), /fixture connection lost/);
    assert.equal((await reader.getDomainActorRoom("default")).memoryErrors[0].error, "updated");
    assert.equal(loads, 3, "a failed shared read must allow a fresh retry");
  } finally { release(); await Promise.all([writer.close(), reader.close()]); }
});
