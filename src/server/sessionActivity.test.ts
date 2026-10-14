import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SessionStore } from "./sessionStore";
import type { RoundtableRound } from "../roundtable";

test("session display includes background work and Concurrent parents, and clears settled activity", async () => {
  const store = new SessionStore(`/private/tmp/session-activity-${randomUUID()}`);
  await store.ready();
  try {
    for (const id of ["main", "worker", "round", "grill", "idle"]) {
      await store.upsertSession({ id, workspaceId: "default", cwd: "/private/tmp", title: id });
    }
    await store.changeCollaboration("group", {
      id: "group", workspaceId: "default", mainSessionId: "main", revision: 0,
      created: new Date().toISOString(), updated: new Date().toISOString(), lease: null,
      messages: [], results: [], members: ["main", "worker"].map(id => ({
        localId: id, sessionId: id, task: id, sourceSessionId: "main", sourceTurnId: null,
        fork: null, model: "gpt-6", effort: "low", stopped: false, observed: {}
      }))
    }, () => {});
    await store.recordSessionTurn({ id: "worker-turn", sessionId: "worker", userInput: "Work",
      agentResponse: "", tokenIn: 0, tokenOut: 0, status: "running" });
    const round: RoundtableRound = { turnId: "rt_activity", sessionId: "round", revision: 1,
      prompt: "Discuss", created: new Date().toISOString(), status: "queued", context: null,
      summarizerModel: "gpt-6", hostModel: "gpt-6", hostEffort: "low", answers: [], summary: "",
      error: null, tokenIn: 0, tokenOut: 0 };
    await store.createRoundtableRound(round);
    const grill = { revision: 1, status: "running" as const, updated: new Date().toISOString(),
      issues: [], rounds: [], error: null };
    await store.saveTurnGrill("grill", "grill-turn", 0, grill);
    const expected = { main: "running", worker: "running", round: "running", grill: "running" };
    assert.deepEqual(await store.listActiveSessionExecutionStatuses("default"), expected);
    assert.deepEqual(await store.listActiveSessionExecutionStatuses(), expected);
    assert.deepEqual(await store.listActiveSessionExecutionStatuses("other-workspace"), {});
    assert.deepEqual((await store.listWorkspaceMonitorSessions()).map(s => s.sessionId).sort(), Object.keys(expected).sort());
    assert.equal(await store.getLatestRunningTurn("main"), null, "display does not occupy the host writer");

    await store.updateSessionTurn({ id: "worker-turn", status: "done", agentResponse: "Done", tokenIn: 0, tokenOut: 0 });
    await store.saveRoundtableRound({ ...round, revision: 2, status: "done" }, 1);
    await store.saveTurnGrill("grill", "grill-turn", 1, { ...grill, revision: 2, status: "ready" });
    assert.deepEqual(await store.listActiveSessionExecutionStatuses(), {});
    assert.deepEqual(await store.listWorkspaceMonitorSessions(), []);

    await store.changeCollaboration("group", null, group => { group.messages.push({
      id: "wait", from: "main", to: "worker", text: "Dependency", reason: "Wait", kind: "followup",
      wait: true, completed: false, state: "delivered", parentId: null, depth: 0, targetTurnId: "worker-turn",
      error: null, created: new Date().toISOString()
    }); });
    assert.deepEqual(await store.listActiveSessionExecutionStatuses(), { main: "running" });
    await store.changeCollaboration("group", null, group => { group.messages[0].completed = true; });
    assert.deepEqual(await store.listActiveSessionExecutionStatuses(), {});
  } finally { await store.close(); }
});
