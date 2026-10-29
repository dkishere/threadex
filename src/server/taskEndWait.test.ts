import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { SessionStore } from "./sessionStore.js";
import { WaitEventService } from "./waitEvent.js";
import { fireTaskEnd, recoverTaskEndWaits, subscribeTaskEnd, taskEndWakeMessage } from "./taskEndWait.js";

async function fixture() {
  const store = new SessionStore(resolve(mkdtempSync(resolve(tmpdir(), "task-end-wait-")), "sessions.postgres"));
  await store.ready();
  const woken: Array<{ sessionId: string; message: string }> = [];
  const waits = new WaitEventService(store, { onDispatch: async (subscription, event) => {
    woken.push({ sessionId: subscription.sessionId, message: taskEndWakeMessage(String((subscription.actionPayload as { message: string }).message), event) });
  } });
  await waits.start();
  for (const id of ["blocker", "other-blocker", "waiter", "second-waiter"]) await store.upsertSession({ id, workspaceId: "default" });
  for (const [id, sessionId] of [["blocker-turn", "blocker"], ["other-turn", "other-blocker"], ["waiter-turn", "waiter"], ["second-turn", "second-waiter"]]) {
    await store.recordSessionTurn({ id, sessionId, userInput: "Work", agentResponse: "", tokenIn: 0, tokenOut: 0, status: "running" });
  }
  const end = (id: string, status: "done" | "todo", extra: { runnerExitCode?: number; pendingReason?: "stopped" | "rate_limit" } = {}) =>
    store.updateSessionTurn({ id, agentResponse: "Ended", tokenIn: 0, tokenOut: 0, status, ...extra });
  const wait = (waiterSessionId: string, targetSessionId: string, targetTurnId?: string) =>
    subscribeTaskEnd(store, waits, { workspaceId: "default", waiterSessionId, targetSessionId, targetTurnId, message: `Resume ${waiterSessionId}` });
  return { store, waits, woken, end, wait };
}

test("a blocked task subscribes to the running blocker and is woken exactly once when it completes, fails or stops", async () => {
  for (const [status, extra, outcome] of [
    ["done", { runnerExitCode: 0 }, "completed"], ["done", { runnerExitCode: 1 }, "failed"], ["todo", { pendingReason: "stopped" }, "stopped"]
  ] as const) {
    const { store, waits, woken, end, wait } = await fixture();
    try {
      const result = await wait("waiter", "blocker");
      assert.equal(result.status, "subscribed"); assert.equal(result.targetTurnId, "blocker-turn");
      await end("blocker-turn", "todo", { pendingReason: "rate_limit" });
      assert.equal(await fireTaskEnd(store, waits, "blocker-turn"), false, "a requeued turn has not ended");
      assert.equal(woken.length, 0);
      await end("blocker-turn", status, extra);
      assert.equal(await fireTaskEnd(store, waits, "blocker-turn"), true);
      assert.equal(await fireTaskEnd(store, waits, "blocker-turn"), false);
      assert.equal(await recoverTaskEndWaits(store, waits), 0);
      assert.equal(woken.length, 1, "duplicate end signals never wake twice");
      assert.equal(woken[0].sessionId, "waiter");
      assert.match(woken[0].message, new RegExp(`^Resume waiter[\\s\\S]*blocker turn blocker-turn ended \\(${outcome}\\)`));
      assert.equal((await wait("waiter", "blocker", "blocker-turn")).status, "already_ended");
    } finally { waits.stop(); await store.close(); }
  }
});

test("an end that races the subscription still wakes the waiter; an already ended blocker means continue now", async () => {
  const { store, waits, woken, end } = await fixture();
  try {
    const racing = Object.create(store) as SessionStore;
    racing.getLatestRunningTurn = async sessionId => {
      const turn = await store.getLatestRunningTurn(sessionId);
      await end("blocker-turn", "done", { runnerExitCode: 0 }); // ends after lookup, before the subscription is written
      return turn;
    };
    const result = await subscribeTaskEnd(racing, waits, { workspaceId: "default", waiterSessionId: "waiter", targetSessionId: "blocker", message: "Resume" });
    assert.equal(result.status, "subscribed");
    assert.equal(woken.length, 1);
    const ended = await subscribeTaskEnd(store, waits, { workspaceId: "default", waiterSessionId: "second-waiter", targetSessionId: "blocker", message: "Resume" });
    assert.deepEqual({ status: ended.status, turn: ended.targetTurnId }, { status: "already_ended", turn: null });
    assert.equal(woken.length, 1, "a live caller continues itself instead of waiting");
  } finally { waits.stop(); await store.close(); }
});

test("several waiters and several blockers each wake independently; cancelled waits never wake", async () => {
  const { store, waits, woken, end, wait } = await fixture();
  try {
    await wait("waiter", "blocker"); await wait("waiter", "other-blocker");
    const cancelled = await wait("second-waiter", "blocker");
    assert.equal((await wait("waiter", "blocker")).subscriptionId, (await wait("waiter", "blocker")).subscriptionId, "repeat calls reuse one subscription");
    await waits.cancelSubscription(cancelled.status === "subscribed" ? cancelled.subscriptionId : "");
    await end("blocker-turn", "done", { runnerExitCode: 0 }); await fireTaskEnd(store, waits, "blocker-turn");
    assert.deepEqual(woken.map(wake => wake.sessionId), ["waiter"]);
    await end("other-turn", "done", { runnerExitCode: 0 }); await fireTaskEnd(store, waits, "other-turn");
    assert.deepEqual(woken.map(wake => wake.sessionId), ["waiter", "waiter"], "each blocker wakes the waiter to re-check the rest");
  } finally { waits.stop(); await store.close(); }
});

test("waiting on yourself or on a task that already waits for you is rejected as a deadlock", async () => {
  const { store, waits, wait } = await fixture();
  try {
    await assert.rejects(wait("waiter", "waiter"), /cannot wait for its own end/);
    await wait("waiter", "blocker");
    await wait("blocker", "other-blocker");
    await assert.rejects(wait("other-blocker", "waiter"), /Deadlock: waiter -> blocker already waits for other-blocker/);
    await assert.rejects(wait("blocker", "waiter"), /Deadlock/);
  } finally { waits.stop(); await store.close(); }
});

test("an end missed while no server observed it is recovered", async () => {
  const { store, waits, woken, end, wait } = await fixture();
  try {
    await wait("waiter", "blocker");
    waits.stop();
    await end("blocker-turn", "done", { runnerExitCode: 0 });
    const restarted = new WaitEventService(store, { onDispatch: async subscription => { woken.push({ sessionId: subscription.sessionId, message: "" }); } });
    await restarted.start();
    assert.equal(await recoverTaskEndWaits(store, restarted), 1);
    assert.equal(await recoverTaskEndWaits(store, restarted), 0);
    assert.deepEqual(woken.map(wake => wake.sessionId), ["waiter"]);
    restarted.stop();
  } finally { await store.close(); }
});
