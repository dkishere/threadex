import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { emptyActorRoom, type ActorRoom } from "../domainActors";
import type { SessionDbConnection } from "./sessionDb";
import { SessionStore } from "./sessionStore";

function connectionOf(store: SessionStore) {
  return (store as unknown as { connectionPromise: Promise<SessionDbConnection> }).connectionPromise;
}
async function rows(store: SessionStore, sql: string) {
  return (await (await connectionOf(store)).run(sql)).getRowObjectsJS();
}
const actor = (id: string, rolling: string) => ({ id, workspaceId: "default", rootActorId: id, parentActorId: null, name: id, model: "m", effort: "low",
  avatar: `data:image/png;base64,${"A".repeat(2_000)}`, memory: { version: 1, sourceEventIds: ["e1"], rolePrompt: "Role", roleSummary: "Domain", longTerm: "", rolling },
  created: "2026-01-01", updated: "2026-01-01" });
const round = (id: string, snapshot: ReturnType<typeof actor>) => ({ id, requestId: `request-${id}`, status: "assigned", userPrompt: `prompt ${id}`,
  actorSnapshots: [snapshot], candidateSnapshots: [{ actorId: snapshot.id, memoryVersion: 1, actor: snapshot }], replies: [], stakeholderIds: [] });

test("an inline legacy room moves rounds into rows losslessly and stores repeated snapshots once", async () => {
  if (process.env.SESSION_PG_SCHEMA) throw new Error("Requires an isolated generated schema; unset SESSION_PG_SCHEMA.");
  const store = new SessionStore(`/private/tmp/actor-room-storage-${randomUUID()}`);
  try {
    await store.ready();
    const shared = actor("alpha", "same");
    const legacy = { ...emptyActorRoom("default"), revision: 4, actors: [shared], rounds: [round("r1", shared), round("r2", shared), round("r3", actor("alpha", "newer"))] };
    await (await connectionOf(store)).run("INSERT INTO actor_room (workspace_id, state) VALUES ('default', $state::JSONB)", { state: JSON.stringify(legacy) });

    const room = await store.getDomainActorRoom("default");
    assert.deepEqual(JSON.parse(JSON.stringify(room)), JSON.parse(JSON.stringify(legacy)));
    assert.deepEqual(await rows(store, "SELECT state ? 'rounds' AS inline FROM actor_room WHERE workspace_id = 'default'"), [{ inline: false }]);
    assert.deepEqual((await rows(store, "SELECT round_id FROM actor_round WHERE workspace_id = 'default' ORDER BY position")).map(row => row.round_id), ["r1", "r2", "r3"]);
    assert.equal((await rows(store, "SELECT hash FROM actor_snapshot WHERE workspace_id = 'default'")).length, 2, "two distinct actor versions");
    assert.throws(() => { (room.rounds[0].actorSnapshots[0] as { name: string }).name = "changed"; }, TypeError, "shared snapshots are frozen");
    room.rounds[0].replies.push({ actorId: "alpha", status: "opinion", text: "local copy" } as never);
    assert.equal((await store.getDomainActorRoom("default")).rounds[0].replies.length, 0, "round containers are still copied per read");
  } finally { await store.close(); }
});

test("room writes touch only changed round rows and another store reloads them incrementally", async () => {
  if (process.env.SESSION_PG_SCHEMA) throw new Error("Requires an isolated generated schema; unset SESSION_PG_SCHEMA.");
  const path = `/private/tmp/actor-room-storage-${randomUUID()}`;
  const writer = new SessionStore(path), reader = new SessionStore(path);
  try {
    await Promise.all([writer.ready(), reader.ready()]);
    const alpha = actor("alpha", "v1");
    await writer.changeDomainActorRoom("default", room => { room.actors = [alpha as never]; room.rounds = [round("r1", alpha), round("r2", alpha)] as never; });
    assert.equal((await reader.getDomainActorRoom("default")).rounds.length, 2);
    const versions = async () => Object.fromEntries((await rows(writer, "SELECT round_id, xmin::text AS version FROM actor_round WHERE workspace_id = 'default'"))
      .map(row => [row.round_id, row.version]));
    const before = await versions();

    await writer.changeDomainActorRoom("default", room => { (room.rounds[1] as { userPrompt: string }).userPrompt = "edited"; });
    const after = await versions();
    assert.equal(after.r1, before.r1, "an unchanged round row is not rewritten");
    assert.notEqual(after.r2, before.r2);
    assert.equal((await reader.getDomainActorRoom("default")).rounds[1].userPrompt, "edited");

    const revision = (await writer.getDomainActorRoom("default")).revision;
    assert.equal(await writer.changeDomainActorRoom("default", room => room.rounds.length), 2);
    assert.equal((await writer.getDomainActorRoom("default")).revision, revision, "a no-op change writes nothing");

    await writer.changeDomainActorRoom("default", room => { room.rounds = [...room.rounds.slice(1), round("r3", actor("alpha", "v2"))] as never; });
    assert.equal((await versions()).r2, after.r2, "removing the oldest round does not renumber the others");
    const reloaded = await reader.getDomainActorRoom("default");
    assert.deepEqual(reloaded.rounds.map(item => item.id), ["r2", "r3"]);
    assert.equal(reloaded.rounds[1].actorSnapshots[0].memory.rolling, "v2");
    assert.equal(reloaded.revision, revision + 1);
  } finally { await Promise.all([writer.close(), reader.close()]); }
});

test("a failed change leaves no partial round rows", async () => {
  if (process.env.SESSION_PG_SCHEMA) throw new Error("Requires an isolated generated schema; unset SESSION_PG_SCHEMA.");
  const store = new SessionStore(`/private/tmp/actor-room-storage-${randomUUID()}`);
  try {
    await store.ready();
    const alpha = actor("alpha", "v1");
    await store.changeDomainActorRoom("default", room => { room.rounds = [round("r1", alpha)] as never; });
    await assert.rejects(store.changeDomainActorRoom("default", (room: ActorRoom) => {
      room.rounds = [...room.rounds, { ...round("r1", alpha) }] as never;
    }), /duplicated/);
    assert.deepEqual((await rows(store, "SELECT round_id FROM actor_round WHERE workspace_id = 'default'")).map(row => row.round_id), ["r1"]);
    assert.equal((await store.getDomainActorRoom("default")).rounds.length, 1);
  } finally { await store.close(); }
});
