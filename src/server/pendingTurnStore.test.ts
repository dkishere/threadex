import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { SessionStore } from "./sessionStore";

test("idle-only continuation cannot insert behind running or queued work, including a simultaneous continuation", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "idle-continuation-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertSession({ id: "session" });
    const input = { sessionId: "session", userInput: "Continue", agentResponse: "Queued", tokenIn: 0, tokenOut: 0, status: "todo" as const, pendingReason: "queued" as const, requireIdleSession: true };
    const results = await Promise.allSettled([store.recordSessionTurn({ ...input, id: "first" }), store.recordSessionTurn({ ...input, id: "second" })]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.match(String((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason), /running or queued/);
    assert.equal((await store.listPendingSessionTurns()).filter(item => item.session.id === "session").length, 1);
    await store.upsertSession({ id: "running" });
    await store.recordSessionTurn({ ...input, id: "active", sessionId: "running", status: "running", requireIdleSession: false });
    await assert.rejects(store.recordSessionTurn({ ...input, id: "blocked", sessionId: "running" }), /running or queued/);
    assert.equal(await store.getSessionTurn("blocked"), null);
  } finally { await store.close(); }
});

test("pending turns carry their provider and native thread so a Claude limit is not routed as Codex", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "pending-provider-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertSession({ id: "session" });
    await store.recordSessionTurn({ id: "limited", sessionId: "session", userInput: "Go", agentResponse: "", tokenIn: 0, tokenOut: 0,
      status: "running", requestMetadata: { model: "claude-fable-5-1" } });
    await store.recordSessionNativeThread({ sessionId: "session", turnId: "limited", threadId: "claude:abc" });
    await store.updateSessionTurn({ id: "limited", agentResponse: "Claude plan limit reached", tokenIn: 0, tokenOut: 0,
      status: "todo", pendingReason: "rate_limit", expectedStatus: "running" });
    const pending = (await store.listPendingSessionTurns()).find(({ turn }) => turn.id === "limited");
    assert.equal(pending?.turn.provider, "claude");
    assert.equal(pending?.turn.nativeThreadId, "claude:abc");
    assert.equal(pending?.turn.requestMetadata?.model, "claude-fable-5-1");
  } finally { await store.close(); }
});

test("forced Managed mode marker is set and cleared without touching the requested setting", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "managed-forced-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertSession({ id: "session" });
    await store.recordSessionTurn({ id: "turn", sessionId: "session", userInput: "Go", agentResponse: "", tokenIn: 0, tokenOut: 0,
      status: "running", requestMetadata: { managedMode: false, model: "gpt-6-sol" } });
    await store.setSessionTurnManagedModeForced("turn", true);
    assert.deepEqual((await store.getSessionTurn("turn"))?.requestMetadata, { managedMode: false, model: "gpt-6-sol", managedModeForced: "actor-tier" });
    await store.setSessionTurnManagedModeForced("turn", false);
    assert.deepEqual((await store.getSessionTurn("turn"))?.requestMetadata, { managedMode: false, model: "gpt-6-sol" });
    await store.setSessionTurnManagedModeForced("missing", true);
  } finally { await store.close(); }
});

test("automatic Todo selection skips a stopped turn but keeps it stored", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "pending-turn-store-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertSession({ id: "session-1" });
    await store.recordSessionTurn({
      id: "turn-a-stopped",
      sessionId: "session-1",
      userInput: "stopped work",
      agentResponse: "Agent stopped. Turn saved as todo and can be retried.",
      tokenIn: 0,
      tokenOut: 0,
      status: "todo",
      pendingReason: "stopped"
    });
    await store.recordSessionTurn({
      id: "turn-b-rate-limit",
      sessionId: "session-1",
      userInput: "later work",
      agentResponse: "Usage limit reached.",
      tokenIn: 0,
      tokenOut: 0,
      status: "todo",
      pendingReason: "rate_limit",
      pendingLoadBalance: true
    });

    assert.equal((await store.getNextTodoTurn("session-1"))?.id, "turn-b-rate-limit");
    assert.deepEqual(
      (await store.listPendingSessionTurns())
        .filter((candidate) => candidate.session.id === "session-1")
        .map((candidate) => candidate.turn.id),
      ["turn-a-stopped", "turn-b-rate-limit"]
    );
  } finally {
    await store.close();
  }
});

test("fast-track follow-up waits behind an active turn and is claimed once after completion", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "fast-track-queue-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertSession({ id: "fast-session" });
    const base = { sessionId: "fast-session", agentResponse: "", tokenIn: 0, tokenOut: 0 };
    await store.recordSessionTurn({ ...base, id: "fast-active", userInput: "First edit", status: "running" });
    await store.recordSessionTurn({ ...base, id: "actor_followup_stable", userInput: "Another edit", status: "todo", pendingReason: "queued", requireIdleSession: false });
    assert.equal((await store.getSessionTurn("fast-active"))?.status, "running");
    assert.equal((await store.getSessionTurn("fast-active"))?.userInput, "First edit");
    assert.equal((await store.claimPendingSessionTurn("actor_followup_stable", "fast-session")).disposition, "blocked");
    await store.updateSessionTurn({ id: "fast-active", agentResponse: "Done", tokenIn: 0, tokenOut: 0, status: "done", expectedStatus: "running" });
    const claims = await Promise.all([
      store.claimPendingSessionTurn("actor_followup_stable", "fast-session"),
      store.claimPendingSessionTurn("actor_followup_stable", "fast-session")
    ]);
    assert.equal(claims.filter(claim => claim.disposition === "started").length, 1);
  } finally { await store.close(); }
});

test("pending prompt metadata and order survive reload and claim exactly once", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "pending-turn-durable-test-"));
  const databasePath = resolve(root, "threadex.postgres");
  const firstStore = new SessionStore(databasePath);
  await firstStore.ready();
  await firstStore.upsertSession({ id: "session-queue" });
  await firstStore.recordSessionTurn({
    id: "queued-first",
    sessionId: "session-queue",
    userInput: "first prompt",
    agentResponse: "Queued. Waiting for the current turn to finish.",
    tokenIn: 0,
    tokenOut: 0,
    status: "todo",
    pendingReason: "queued",
    requestMetadata: {
      executionMode: "goal",
      managedMode: true,
      skills: [{ name: "release" }],
      attachments: [{ id: "attachment-1", name: "release.txt", path: "/uploads/queued-first/release.txt" }]
    }
  });
  await firstStore.recordSessionTurn({
    id: "queued-second",
    sessionId: "session-queue",
    userInput: "second prompt",
    agentResponse: "Queued. Waiting for the current turn to finish.",
    tokenIn: 0,
    tokenOut: 0,
    status: "todo",
    pendingReason: "queued",
    requestMetadata: { executionMode: "default" }
  });
  await firstStore.close();

  const store = new SessionStore(databasePath);
  await store.ready();
  try {
    const pending = (await store.listPendingSessionTurns())
      .filter(candidate => candidate.session.id === "session-queue");
    assert.deepEqual(pending.map(candidate => candidate.turn.id), ["queued-first", "queued-second"]);
    assert.equal(pending[0].turn.requestMetadata?.executionMode, "goal");
    assert.equal(pending[0].turn.requestMetadata?.managedMode, true);
    assert.deepEqual(pending[0].turn.requestMetadata?.attachments, [
      { id: "attachment-1", name: "release.txt", path: "/uploads/queued-first/release.txt" }
    ]);
    const edited = await store.updatePendingSessionTurn({
      id: "queued-first", sessionId: "session-queue", userInput: "edited prompt", message: "edited prompt"
    });
    assert.equal(edited.requestMetadata?.message, "edited prompt");
    assert.equal(edited.requestMetadata?.executionMode, "goal");
    assert.equal(edited.requestMetadata?.managedMode, true);
    assert.deepEqual(edited.requestMetadata?.attachments, pending[0].turn.requestMetadata?.attachments);

    const firstClaim = await store.claimPendingSessionTurn("queued-first", "session-queue");
    assert.equal(firstClaim.disposition, "started");
    const blockedSecond = await store.claimPendingSessionTurn("queued-second", "session-queue");
    assert.equal(blockedSecond.disposition, "blocked");

    await store.updateSessionTurn({
      id: "queued-first",
      agentResponse: "done",
      tokenIn: 0,
      tokenOut: 0,
      status: "done",
      pendingReason: null,
      expectedStatus: "running"
    });
    const secondClaim = await store.claimPendingSessionTurn("queued-second", "session-queue");
    assert.equal(secondClaim.disposition, "started");
  } finally {
    await store.close();
  }
});

test("queued prompts can be deleted or reserved for steer without dispatching twice", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "pending-turn-actions-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertSession({ id: "session-actions" });
    for (const id of ["active", "queued-steer", "queued-steer-success", "queued-delete"]) {
      await store.recordSessionTurn({
        id, sessionId: "session-actions", userInput: id, agentResponse: "", tokenIn: 0, tokenOut: 0,
        status: id === "active" ? "running" : "todo",
        pendingReason: id === "active" ? null : "queued"
      });
    }
    assert.equal(await store.deleteQueuedSessionTurn("queued-delete", "session-actions"), true);
    assert.equal(await store.getSessionTurn("queued-delete"), null);
    assert.equal(await store.deleteQueuedSessionTurn("active", "session-actions"), false);

    assert.ok(await store.reserveQueuedSessionTurnForSteer("queued-steer", "session-actions", "active"));
    assert.equal(await store.reserveQueuedSessionTurnForSteer("queued-steer", "session-actions", "active"), null);
    assert.equal(await store.deleteQueuedSessionTurn("queued-steer", "session-actions"), false);
    assert.equal((await store.getSessionTurn("queued-steer"))?.pendingReason, "queued", "the UI keeps showing the prompt in Queue during steer delivery");
    assert.equal((await store.listPendingSessionTurns()).some(({ turn }) => turn.id === "queued-steer"), false);
    assert.ok(await store.reserveQueuedSessionTurnForSteer("queued-steer-success", "session-actions", "active"));
    assert.equal(await store.deleteQueuedSessionTurn("queued-steer-success", "session-actions", true), true);
    assert.equal(await store.getSessionTurn("queued-steer-success"), null);
    await store.updateSessionTurn({ id: "active", agentResponse: "done", tokenIn: 0, tokenOut: 0, status: "done", expectedStatus: "running" });
    assert.equal(await store.getNextTodoTurn("session-actions"), null);
    assert.equal((await store.claimPendingSessionTurn("queued-steer", "session-actions")).disposition, "blocked");
    assert.equal(await store.restoreQueuedSessionTurnAfterSteerFailure("queued-steer", "session-actions"), true);
    assert.equal(await store.deleteQueuedSessionTurn("queued-steer", "session-actions"), true);
    assert.equal(await store.getSessionTurn("queued-steer"), null);
  } finally {
    await store.close();
  }
});
