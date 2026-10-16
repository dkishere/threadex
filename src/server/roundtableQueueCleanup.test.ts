import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { RoundtableRound } from "../roundtable";
import type { SessionDbConnection } from "./sessionDb";
import { SessionStore } from "./sessionStore";

async function fixture() {
  const store = new SessionStore(`/private/tmp/roundtable-queue-cleanup-${randomUUID()}`);
  await store.ready();
  await store.upsertSession({ id: "host", workspaceId: "default", cwd: "/private/tmp" });
  const round: RoundtableRound = {
    turnId: "round", sessionId: "host", revision: 1, prompt: "Discuss this",
    created: new Date().toISOString(), status: "queued", context: null,
    summarizerModel: "gpt-6", hostModel: "gpt-6", hostEffort: "low",
    answers: [], summary: "", error: null, tokenIn: 0, tokenOut: 0
  };
  await store.createRoundtableRound(round);
  return store;
}

test("deleting a queued round removes its background state and allows the next prompt", async () => {
  const store = await fixture();
  try {
    assert.deepEqual(await store.listActiveSessionExecutionStatuses("default"), { host: "running" });
    assert.equal(await store.deleteQueuedSessionTurn("round", "other-session"), false);
    assert.ok(await store.getRoundtableRound("round"));
    assert.equal(await store.deleteQueuedSessionTurn("round", "host"), true);
    assert.equal(await store.getRoundtableRound("round"), null);
    assert.deepEqual(await store.listActiveSessionExecutionStatuses("default"), {});
    assert.deepEqual(await store.listWorkspaceMonitorSessions(), []);
    const claim = await store.claimSessionTurn({ id: "next", sessionId: "host", userInput: "Continue",
      agentResponse: "", tokenIn: 0, tokenOut: 0, status: "running" });
    assert.equal(claim.disposition, "started");
  } finally { await store.close(); }
});

test("legacy orphaned rounds are inspectable but cannot report session activity or block a prompt", async () => {
  const store = await fixture();
  try {
    // Reproduce the old deletion path in this isolated test database.
    await (store as unknown as { write<T>(callback: (connection: SessionDbConnection) => Promise<T>): Promise<T> })
      .write(connection => connection.run("DELETE FROM session_turn WHERE id = 'round'"));
    const inspection = await store.inspectSession({ sessionId: "host" });
    assert.deepEqual(inspection?.backgroundActivity, [
      { kind: "roundtable", turn_id: "round", status: "queued", turn_status: null }
    ]);
    assert.deepEqual(await store.listRoundtableRounds("host"), []);
    assert.deepEqual(await store.listActiveSessionExecutionStatuses("default"), {});
    assert.deepEqual(await store.listWorkspaceMonitorSessions(), []);
    const claim = await store.claimSessionTurn({ id: "next", sessionId: "host", userInput: "Continue",
      agentResponse: "", tokenIn: 0, tokenOut: 0, status: "running" });
    assert.equal(claim.disposition, "started");
  } finally { await store.close(); }
});

test("deleting a running round is rejected and preserves its activity", async () => {
  const store = await fixture();
  try {
    assert.equal((await store.claimPendingSessionTurn("round", "host")).disposition, "started");
    assert.equal(await store.deleteQueuedSessionTurn("round", "host"), false);
    assert.ok(await store.getRoundtableRound("round"));
    assert.deepEqual(await store.listActiveSessionExecutionStatuses("default"), { host: "running" });
  } finally { await store.close(); }
});
