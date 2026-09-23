import assert from "node:assert/strict";
import test from "node:test";
import { EventStore, jsonValuesEqual, type WaitSubscription } from "./eventStore";

test("versioned heartbeats retain omitted state and apply explicit deletions", async (t) => {
  const store = new EventStore();
  const urls: URL[] = [];
  const payloads = [
    { stateVersion: "a.b.c", statusMonitor: [{ id: "other", active_sessions: [] }], processMonitors: [{ id: "process" }], grillSummaries: [{ sessionId: "session", turnId: "turn", revision: 1, pending: true }] },
    { stateVersion: "a.b.c" },
    { stateVersion: "a.d.e", processMonitors: [], grillSummaries: [] }
  ];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(new URL(url, "http://fixture"));
    return Response.json(payloads.shift());
  });
  await store.poll();
  const first = store.getState();
  await store.poll();
  assert.equal(store.getState(), first);
  assert.equal(urls[0].searchParams.get("view"), "client");
  assert.equal(urls[0].searchParams.has("stateVersion"), false);
  assert.equal(urls[1].searchParams.get("stateVersion"), "a.b.c");
  await store.poll();
  assert.deepEqual(store.getState().processMonitors, []);
  assert.deepEqual(store.getState().grillSummaries, []);
  assert.equal(store.getState().statusMonitor, first.statusMonitor);
});

test("backlog pages drain in the same poll without losing or duplicating events", async (t) => {
  const store = new EventStore();
  const afters: string[] = [];
  const positions: number[] = [];
  store.subscribeTo(["runner.done"], event => { positions.push(event.pos); });
  let page = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    afters.push(new URL(url, "http://fixture").searchParams.get("after")!);
    page++;
    return Response.json({ events: [{ pos: page, eventId: String(page), type: "runner.done", workspaceId: "one", sessionId: "session", turnId: "turn", payload: null, timestamp: "now" }], nextPos: page, hasMore: page < 3 });
  });
  await Promise.all([store.poll(), store.poll()]);
  assert.deepEqual(afters, ["0", "1", "2"]);
  assert.deepEqual(positions, [1, 2, 3]);
  assert.equal(store.getCursor(), 3);
});

test("workspace snapshots invalidate in-flight pages and their state versions", async (t) => {
  const store = new EventStore();
  let finish!: (response: Response) => void;
  const urls: URL[] = [];
  let calls = 0;
  t.mock.method(globalThis, "fetch", (url: string) => {
    urls.push(new URL(url, "http://fixture"));
    if (++calls === 1) return Promise.resolve(Response.json({ stateVersion: "old.version.token" }));
    if (calls === 2) return new Promise<Response>(resolve => { finish = resolve; });
    return Promise.resolve(Response.json({ workspaceId: "new", stateVersion: "new.version.token" }));
  });
  await store.poll();
  const pending = store.poll();
  store.setWorkspaceSnapshot({ activeWorkspace: { id: "new" }, processMonitors: [{ id: "new-process" }] }, store.getState().sessionPage, null, 20);
  finish(Response.json({ workspaceId: "old", nextPos: 100, stateVersion: "stale.version.token", processMonitors: [], hasMore: true }));
  assert.equal(await pending, false);
  assert.equal(store.getCursor(), 20);
  assert.equal(store.getState().processMonitors[0].id, "new-process");
  await store.poll();
  assert.equal(urls[2].searchParams.get("after"), "20");
  assert.equal(urls[2].searchParams.has("stateVersion"), false);
});

test("a server workspace mismatch requests a fresh snapshot without applying its events", async (t) => {
  const store = new EventStore();
  store.setWorkspaceSnapshot({ activeWorkspace: { id: "one" } }, store.getState().sessionPage, null, 20);
  t.mock.method(globalThis, "fetch", async () => Response.json({ workspaceId: "two", nextPos: 25, processMonitors: [{ id: "wrong" }] }));
  assert.equal(await store.poll(), true);
  assert.equal(store.getCursor(), 20);
  assert.deepEqual(store.getState().processMonitors, []);
});

test("feature retries share successful event heartbeats without extra renders or poll requests", async (t) => {
  const store = new EventStore();
  let finish!: (response: Response) => void;
  const fetch = t.mock.method(globalThis, "fetch", () => new Promise<Response>(resolve => { finish = resolve; }));
  let heartbeats = 0;
  let renders = 0;
  store.subscribe(() => { renders++; });
  const unsubscribe = store.subscribePoll(() => { heartbeats++; });
  const first = store.poll();
  const second = store.poll();
  finish(Response.json({ events: [], nextPos: 0 }));
  await Promise.all([first, second]);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(heartbeats, 1);
  assert.equal(renders, 0);
  unsubscribe();
  const next = store.poll();
  finish(Response.json({ events: [], nextPos: 0 }));
  await next;
  assert.equal(heartbeats, 1);
});

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
