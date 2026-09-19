import assert from "node:assert/strict";
import test from "node:test";
import { EventStore, jsonValuesEqual, type WaitSubscription } from "./eventStore";

test("confirmed wait cancellation survives stale snapshots and in-flight polls", async (t) => {
  const store = new EventStore();
  const waiting = { id: "cancel-me", status: "waiting", updated: "2026-09-19T10:00:00Z" } as WaitSubscription;
  const snapshot = { waitSubscriptions: [waiting, { ...waiting, id: "keep-me" }] };
  const page = store.getState().sessionPage;
  store.setWorkspaceSnapshot(snapshot, page, null, 0);
  let finishPoll!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>((resolve) => { finishPoll = resolve; }));
  const pendingPoll = store.poll();
  store.applyWaitSubscription({ ...waiting, status: "cancelled", updated: "2026-09-19T10:01:00Z" });
  store.setWorkspaceSnapshot(snapshot, page, null, 0);
  assert.deepEqual(store.getState().waitSubscriptions.map((item) => item.id), ["keep-me"]);
  finishPoll(new Response(JSON.stringify(snapshot)));
  await pendingPoll;
  assert.deepEqual(store.getState().waitSubscriptions.map((item) => item.id), ["keep-me"]);
});

test("Grill summaries update background sessions without clearing sibling turns or accepting stale polls", async () => {
  const store = new EventStore();
  const originalFetch = globalThis.fetch;
  let payload = [
    { sessionId: "background", turnId: "one", revision: 2, pending: true },
    { sessionId: "background", turnId: "two", revision: 2, pending: true }
  ];
  globalThis.fetch = async () => new Response(JSON.stringify({ events: [], grillSummaries: payload }));
  try {
    await store.poll();
    store.reportGrill("background", "one", { revision: 3, contentVersion: 1, acknowledgedVersion: 1,
      status: "ready", updated: "", error: null, issues: [], rounds: [] });
    await store.poll();
    assert.deepEqual(store.getState().grillSummaries.filter((item) => item.pending).map((item) => item.turnId), ["two"]);
    payload = [{ sessionId: "background", turnId: "one", revision: 4, pending: true }, payload[1]];
    await store.poll();
    assert.equal(store.getState().grillSummaries.filter((item) => item.pending).length, 2);
    const snapshot = store.getState();
    await store.poll();
    assert.equal(store.getState(), snapshot, "unchanged summaries do not trigger a render or panel fetch");
  } finally { globalThis.fetch = originalFetch; }
});

test("jsonValuesEqual compares parsed event-poll payloads structurally", () => {
  assert.equal(jsonValuesEqual([{ id: "one", nested: { status: "running" } }], [{ id: "one", nested: { status: "running" } }]), true);
  assert.equal(jsonValuesEqual([{ id: "one" }], [{ id: "two" }]), false);
});

test("cursor-only event polls do not notify full-state subscribers", async () => {
  const store = new EventStore();
  let stateNotifications = 0;
  let cursorNotifications = 0;
  store.subscribe(() => { stateNotifications += 1; });
  store.subscribeCursor(() => { cursorNotifications += 1; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    events: [],
    nextPos: 42,
    resetRequired: false,
    statusMonitor: [],
    processMonitors: []
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    assert.equal(await store.poll(), false);
    assert.equal(store.getCursor(), 42);
    assert.equal(stateNotifications, 0);
    assert.equal(cursorNotifications, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("structurally identical monitor payloads preserve the render snapshot", async () => {
  const store = new EventStore();
  let stateNotifications = 0;
  store.subscribe(() => { stateNotifications += 1; });
  const payloads = [
    { events: [], nextPos: 1, statusMonitor: [{ id: "workspace", name: "Workspace", active_sessions: [] }], processMonitors: [] },
    { events: [], nextPos: 2, statusMonitor: [{ id: "workspace", name: "Workspace", active_sessions: [] }], processMonitors: [] }
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(payloads.shift()), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
  try {
    await store.poll();
    const firstSnapshot = store.getState();
    await store.poll();
    assert.equal(stateNotifications, 1);
    assert.equal(store.getState(), firstSnapshot);
    assert.equal(store.getCursor(), 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("identical session pages do not notify full-state subscribers", () => {
  const store = new EventStore();
  let stateNotifications = 0;
  store.subscribe(() => { stateNotifications += 1; });
  const page = {
    sessions: [{ id: "session-one", title: "One" }],
    offset: 0,
    limit: 20,
    hasMore: false,
    nextOffset: null,
    projects: []
  };
  store.setSessionPage(page);
  store.setSessionPage({ ...page, sessions: [{ id: "session-one", title: "One" }] });
  assert.equal(stateNotifications, 1);
});

test("removing a wait subscription updates the local view without a poll", () => {
  const store = new EventStore();
  store.setWorkspaceSnapshot({ waitSubscriptions: [{ id: "remove-now" }, { id: "keep" }] }, {
    sessions: [], offset: 0, limit: 20, hasMore: false, nextOffset: null, projects: []
  }, null, 0);

  store.removeWaitSubscription("remove-now");

  assert.deepEqual(store.getState().waitSubscriptions.map((subscription) => subscription.id), ["keep"]);
});
