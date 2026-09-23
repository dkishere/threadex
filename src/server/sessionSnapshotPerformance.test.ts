import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./sessionStore";
import type { SessionDbConnection } from "./sessionDb";

const netDiff = "diff --git a/current.ts b/current.ts\n--- a/current.ts\n+++ b/current.ts\n@@ -1 +1 @@\n-old\n+new";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "snapshot-diffs-"));
  const store = new SessionStore(join(root, "test.postgres"));
  await store.ready();
  await store.upsertSession({ id: "session", workspaceId: "default", cwd: root });
  const connection = await (store as unknown as { connectionPromise: Promise<SessionDbConnection> }).connectionPromise;
  const diff = (id: string, turnId: string, text: string) => store.recordSessionTurnEvent({
    id, sessionId: "session", turnId, eventName: "codex", refreshRunnerHeartbeat: false,
    payload: { method: "turn/diff/updated", params: { turnId: `native-${turnId}`, diff: text } }
  });
  return { store, connection, diff, close: async () => { await store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("snapshot reads only the latest cumulative diff per turn, including tied timestamps and raw-only turns", async t => {
  const { store, connection, diff, close } = await fixture();
  try {
    for (let index = 0; index < 24; index++) {
      await diff(`history-${String(index).padStart(2, "0")}`, "turn", `${netDiff}\n+${"x".repeat(128 * 1024)}`);
    }
    await diff("z-final", "turn", netDiff);
    await diff("z-other-turn", "other-turn", netDiff.replaceAll("current.ts", "other.ts"));
    await connection.run("UPDATE session_turn_event SET created = '2026-01-01T00:00:00Z'::TIMESTAMPTZ WHERE session_id = $sessionId", { sessionId: "session" });
    // A later tool output mentioning the method must not mask the actual diff.
    await store.recordSessionTurnEvent({ id: "zz-output", sessionId: "session", turnId: "turn", eventName: "codex", refreshRunnerHeartbeat: false,
      payload: { method: "item/commandExecution/outputDelta", params: { output: `turn/diff/updated ${"y".repeat(128 * 1024)}` } } });
    await store.recordSessionTurnEvent({ id: "unrelated-session", sessionId: "other-session", turnId: "turn", eventName: "codex", refreshRunnerHeartbeat: false,
      payload: { method: "turn/diff/updated", params: { diff: netDiff.replaceAll("current.ts", "wrong.ts") } } });

    const returnedDiffs: string[] = [];
    const run = connection.run.bind(connection);
    t.mock.method(connection, "run", async (...[sql, params]: Parameters<SessionDbConnection["run"]>) => {
      const result = await run(sql, params);
      for (const row of await result.getRowObjectsJS()) {
        if (typeof row.diff === "string") returnedDiffs.push(row.diff);
      }
      return result;
    });
    const items = await store.listSessionLiveItems("session") as Record<string, Array<{ changes: Array<{ path: string }> }>>;
    assert.deepEqual(items.turn[0].changes.map(change => change.path), ["current.ts"]);
    assert.deepEqual(items["other-turn"][0].changes.map(change => change.path), ["other.ts"]);
    assert.equal(returnedDiffs.length, 2, "historical diff bodies must stay in the database");
    assert.ok(returnedDiffs.reduce((bytes, text) => bytes + Buffer.byteLength(text), 0) < 1024);
    returnedDiffs.length = 0;
    await store.listSessionTurnLiveItems("session", "turn");
    assert.deepEqual(returnedDiffs, [netDiff], "turn lookups must retain their scope");
    assert.equal((await store.runSqlQuery({ sql: "SELECT count(*) AS count FROM session_turn_event WHERE session_id = 'session'" })).rows[0].count, 27);
    await store.recordSessionTurnEvent({ id: "saved-diff", sessionId: "session", turnId: "turn", eventName: "item", refreshRunnerHeartbeat: false,
      payload: { id: "turn-diff:native-turn", itemType: "file_change", eventType: "item.completed", status: "completed", authoritative: true,
        changes: [{ path: "current.ts", kind: "update", diff: netDiff }] } });
    returnedDiffs.length = 0;
    const saved = await store.listSessionTurnLiveItems("session", "turn") as Array<{ changes: Array<{ path: string }> }>;
    assert.deepEqual(saved[0].changes.map(change => change.path), ["current.ts"]);
    assert.deepEqual(returnedDiffs, [], "a saved authoritative diff without failed edits needs no historical diff body");
  } finally { await close(); }
});

test("latest-diff lookup walks past repeated failed empty diffs but preserves a successful empty revert", async () => {
  const { store, connection, diff, close } = await fixture();
  try {
    await diff("a-valid", "turn", netDiff);
    await diff("b-empty", "turn", "");
    await diff("c-empty", "turn", "  ");
    await connection.run("UPDATE session_turn_event SET created = '2026-01-02T00:00:00Z'::TIMESTAMPTZ WHERE session_id = $sessionId", { sessionId: "session" });
    await store.recordSessionTurnEvent({ id: "failed", sessionId: "session", turnId: "turn", eventName: "item", refreshRunnerHeartbeat: false,
      payload: { id: "failed", itemType: "file_change", eventType: "item.completed", status: "failed", changes: [{ path: "denied.ts", kind: "update" }] } });
    await connection.run("UPDATE session_live_item SET created = '2026-01-01T00:00:00Z'::TIMESTAMPTZ WHERE session_id = $sessionId", { sessionId: "session" });
    const recovered = await store.listSessionLiveItems("session") as Record<string, Array<{ authoritative?: boolean; changes: Array<{ path: string }> }>>;
    assert.deepEqual(recovered.turn.find(item => item.authoritative)?.changes.map(change => change.path), ["current.ts"]);
    await store.recordSessionTurnEvent({ id: "revert", sessionId: "session", turnId: "turn", eventName: "item", refreshRunnerHeartbeat: false,
      payload: { id: "revert", itemType: "file_change", eventType: "item.completed", status: "completed", changes: [{ path: "current.ts", kind: "update" }] } });
    await diff("successful-revert", "turn", "");
    const reverted = await store.listSessionLiveItems("session") as typeof recovered;
    assert.deepEqual(reverted.turn.find(item => item.authoritative)?.changes, []);
  } finally { await close(); }
});
