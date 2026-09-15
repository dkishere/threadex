import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { ProcessMonitorService } from "./processMonitor.js";
import { SessionStore } from "./sessionStore.js";
import { WaitEventService } from "./waitEvent.js";

test("one durable event dispatches subscriptions for multiple sessions", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "wait-event-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const dispatched: string[] = [];
  const service = new WaitEventService(store, {
    onDispatch: async (subscription) => {
      dispatched.push(subscription.sessionId);
    }
  });
  try {
    await store.ready();
    await service.start();
    const event = await service.ensureEvent({
      workspaceId: "default",
      topic: "quota.available",
      subjectKey: "account-1:reset-1",
      expectedAt: new Date(Date.now() + 50).toISOString(),
      payload: { accountId: "account-1" }
    });
    await service.subscribe({
      id: "subscription-a",
      eventId: event.id,
      workspaceId: "default",
      sessionId: "session-a",
      turnId: "turn-a",
      actionType: "retry_turn"
    });
    await service.subscribe({
      id: "subscription-b",
      eventId: event.id,
      workspaceId: "default",
      sessionId: "session-b",
      turnId: "turn-b",
      actionType: "retry_turn"
    });

    await waitFor(async () => (await store.listWaitSubscriptions({ eventId: event.id, status: "done" })).length === 2);
    assert.deepEqual(new Set(dispatched), new Set(["session-a", "session-b"]));
    assert.equal((await store.getWaitEvent(event.id))?.status, "fired");
  } finally {
    service.stop();
    await store.close();
  }
});

test("a retained fired event immediately dispatches a late subscription", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "wait-event-retained-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const dispatched: string[] = [];
  const service = new WaitEventService(store, {
    onDispatch: async (subscription) => {
      dispatched.push(subscription.id);
    }
  });
  try {
    await store.ready();
    await service.start();
    const event = await service.ensureEvent({
      workspaceId: "default",
      topic: "process.exited",
      subjectKey: "monitor-1:run-1"
    });
    await service.fire(event.id, { exitCode: 0 });
    const subscription = await service.subscribe({
      id: "late-subscription",
      eventId: event.id,
      workspaceId: "default",
      sessionId: "session-late",
      actionType: "notify"
    });

    assert.equal(subscription.status, "done");
    assert.deepEqual(dispatched, ["late-subscription"]);
  } finally {
    service.stop();
    await store.close();
  }
});

test("service restart recovers a subscription left dispatching", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "wait-event-recovery-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const dispatched: string[] = [];
  const service = new WaitEventService(store, {
    onDispatch: async (subscription) => {
      dispatched.push(subscription.id);
    }
  });
  try {
    await store.ready();
    const event = await store.ensureWaitEvent({
      workspaceId: "default",
      topic: "process.exited",
      subjectKey: "monitor-recovery:run-1"
    });
    await store.createWaitSubscription({
      id: "interrupted-subscription",
      eventId: event.id,
      workspaceId: "default",
      sessionId: "session-recovery",
      actionType: "notify"
    });
    await store.claimWaitSubscription("interrupted-subscription");
    await store.fireWaitEvent(event.id, { exitCode: 0 });

    await service.start();

    await waitFor(async () => (await store.listWaitSubscriptions({ eventId: event.id }))[0]?.status === "done");
    assert.deepEqual(dispatched, ["interrupted-subscription"]);
  } finally {
    service.stop();
    await store.close();
  }
});

test("one process-exit event wakes multiple subscribed sessions", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "wait-event-process-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const dispatched: string[] = [];
  const waits = new WaitEventService(store, {
    onDispatch: async (subscription) => {
      dispatched.push(subscription.sessionId);
    }
  });
  const processes = new ProcessMonitorService(store, {
    onExit: async (monitor) => {
      const event = await waits.ensureEvent({
        workspaceId: monitor.workspaceId,
        topic: "process.exited",
        subjectKey: `${monitor.id}:${monitor.startedAt ?? monitor.created}`
      });
      await waits.fire(event.id, { monitorId: monitor.id, exitCode: monitor.lastExitCode });
    }
  });
  try {
    await store.ready();
    await waits.start();
    const workspace = await store.getActiveWorkspace();
    const monitor = await processes.monitor(workspace, {
      label: "shared-process-exit",
      exe: process.execPath,
      args: ["-e", "setTimeout(() => {}, 100)"]
    });
    const event = await waits.ensureEvent({
      workspaceId: workspace.id,
      topic: "process.exited",
      subjectKey: `${monitor.id}:${monitor.startedAt ?? monitor.created}`
    });
    for (const sessionId of ["session-a", "session-b"]) {
      await waits.subscribe({
        id: `${event.id}:${sessionId}`,
        eventId: event.id,
        workspaceId: workspace.id,
        sessionId,
        actionType: "notify"
      });
    }

    await waitFor(async () => (await store.listWaitSubscriptions({ eventId: event.id, status: "done" })).length === 2);
    assert.deepEqual(new Set(dispatched), new Set(["session-a", "session-b"]));
    assert.equal((await store.getWaitEvent(event.id))?.status, "fired");
  } finally {
    processes.stop();
    waits.stop();
    await store.close();
  }
});

test("editing a retry subscription updates both its display payload and pending turn", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "wait-event-edit-retry-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const service = new WaitEventService(store, { onDispatch: async () => undefined });
  try {
    await store.ready();
    await store.upsertSession({ id: "session-edit", workspaceId: "default" });
    await store.recordSessionTurn({
      id: "turn-edit",
      sessionId: "session-edit",
      userInput: "old prompt",
      agentResponse: "Waiting",
      tokenIn: 0,
      tokenOut: 0,
      status: "todo"
    });
    await service.start();
    const event = await service.ensureEvent({
      workspaceId: "default",
      topic: "quota.available",
      subjectKey: "edit-retry"
    });
    await service.subscribe({
      id: "retry-edit-subscription",
      eventId: event.id,
      workspaceId: "default",
      sessionId: "session-edit",
      turnId: "turn-edit",
      actionType: "retry_turn",
      actionPayload: { prompt: "old prompt", resetAt: 123 }
    });

    const updated = await service.updateSubscriptionPrompt("retry-edit-subscription", "new prompt");

    assert.deepEqual(updated.actionPayload, { prompt: "new prompt", resetAt: 123 });
    assert.equal((await store.getSessionTurn("turn-edit"))?.userInput, "new prompt");
  } finally {
    service.stop();
    await store.close();
  }
});

test("editing and removing an enqueue subscription changes then cancels the pending action", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "wait-event-edit-enqueue-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const service = new WaitEventService(store, { onDispatch: async () => undefined });
  try {
    await store.ready();
    await service.start();
    const event = await service.ensureEvent({
      workspaceId: "default",
      topic: "process.exited",
      subjectKey: "edit-enqueue"
    });
    await service.subscribe({
      id: "enqueue-edit-subscription",
      eventId: event.id,
      workspaceId: "default",
      sessionId: "session-edit",
      actionType: "enqueue_prompt",
      actionPayload: { message: "old wake prompt", loadBalanceInWorkspace: false }
    });

    const updated = await service.updateSubscriptionPrompt("enqueue-edit-subscription", "new wake prompt");
    assert.deepEqual(updated.actionPayload, { message: "new wake prompt", loadBalanceInWorkspace: false });

    const removed = await service.cancelSubscription("enqueue-edit-subscription");
    assert.equal(removed.status, "cancelled");
  } finally {
    service.stop();
    await store.close();
  }
});

test("cancelling a wait event cancels all undelivered subscriptions", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "wait-event-cancel-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const service = new WaitEventService(store, { onDispatch: async () => undefined });
  try {
    await store.ready();
    await service.start();
    const event = await service.ensureEvent({
      workspaceId: "default",
      topic: "process.exited",
      subjectKey: "monitor-cancel:run-1"
    });
    await service.subscribe({
      id: "cancelled-subscription",
      eventId: event.id,
      workspaceId: "default",
      sessionId: "session-cancel",
      actionType: "notify"
    });

    await service.cancel(event.id);

    assert.equal((await store.getWaitEvent(event.id))?.status, "cancelled");
    assert.equal((await store.listWaitSubscriptions({ eventId: event.id }))[0]?.status, "cancelled");
  } finally {
    service.stop();
    await store.close();
  }
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.fail("Timed out waiting for durable wait event state.");
}
