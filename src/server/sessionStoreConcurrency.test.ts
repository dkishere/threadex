import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { SessionStore } from "./sessionStore";
import type { SessionDbConnection } from "./sessionDb";

type StoreInternals = { write<T>(operation: (connection: SessionDbConnection) => Promise<T>): Promise<T> };

test("reads do not wait behind a slow serialised write", async () => {
  if (process.env.SESSION_PG_SCHEMA) throw new Error("Requires an isolated generated schema; unset SESSION_PG_SCHEMA.");
  const store = new SessionStore(`/private/tmp/store-concurrency-${randomUUID()}`);
  try {
    await store.ready();
    const slowWrite = (store as unknown as StoreInternals).write(connection => connection.run("SELECT pg_sleep(1.5)"));
    await new Promise(resolve => setTimeout(resolve, 100));
    const started = Date.now();
    await store.listWorkspaces();
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
