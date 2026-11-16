import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import type { ActorWorkItem } from "../domainActors";
import { MODEL_CATALOG } from "../modelCatalog";
import { DomainActorService, type DomainActorDependencies } from "./domainActorService";
import { ActorHierarchyConflict, DomainActorStore } from "./domainActorStore";
import { SessionStore } from "./sessionStore";
import express from "express";
import { createDomainActorRouter } from "./domainActorRoutes";
import type { CollaborationService } from "./collaborationService";

const memory = { rolePrompt: "Role", roleSummary: "Summary", longTerm: "Knowledge", rolling: "Recent" };
const work = (extra: Partial<ActorWorkItem> = {}): ActorWorkItem => ({
  id: "host", roundId: "round", ownerActorId: "root", executorActorId: "child", model: MODEL_CATALOG.luna.id,
  dispatchKey: "dispatch", taskSessionId: "session", taskTurnId: "missing", status: "assigned", dispatchError: null,
  created: "2020-01-01T00:00:00Z", updated: "2020-01-01T00:00:00Z", dispatched: true, dispatchLease: null,
  executionRevision: 1, executionHistory: [], assignmentRequests: [], ...extra
});
async function fixture(t: TestContext) {
  const path = `/private/tmp/actor-cancel-${randomUUID()}`;
  const sessions = new SessionStore(path);
  await sessions.ready();
  t.after(() => sessions.close());
  const store = new DomainActorStore(sessions);
  for (const [id, parentActorId] of [["root", undefined], ["child", "root"], ["other", undefined]] as const)
    await store.create("default", { id, parentActorId, name: id, model: MODEL_CATALOG.luna.id, memory });
  const stops: string[] = [];
  const service = new DomainActorService(store, { stopTaskSession: async id => { stops.push(id); },
    stopTaskTurn: async (id, turnId) => { stops.push(`${id}:${turnId}`); } } as DomainActorDependencies);
  return { sessions, store, service, stops, path };
}

test("idle assigned missing turn cancels its unfinished native children and permits promotion", async t => {
  const h = await fixture(t);
  const items = [work(), work({ id: "native", hostWorkItemId: "host" }),
    work({ id: "completed", hostWorkItemId: "host", status: "completed" }),
    work({ id: "other", roundId: "other-round", ownerActorId: "other", executorActorId: "other", taskSessionId: "other" })];
  await h.store.change("default", room => {
    room.workItems = items;
    room.rounds = [{ id: "round", requestId: "request", userPrompt: "Work", namedActorIds: ["child"], candidateSnapshots: [],
      stakeholderIds: [], replies: [], actorSnapshots: room.actors, routingDecisions: {}, policies: {
        shPick: { order: ["fake"], threshold: { fake: 0.5 } }, claimTiebreak: { order: ["fake"], threshold: { fake: 0.5 } }
      }, ownerActorId: "root", workItemId: "host", workItemIds: items.slice(0, 3).map(item => item.id), status: "awaiting_pickup",
      error: "Unpicked", created: "2020", deadline: "2020", lease: null }];
  });
  const move = { parentActorId: null, expectedParentActorId: "root", expectedRootActorId: "root" };
  await assert.rejects(h.store.reparent("default", "child", move), ActorHierarchyConflict);
  const cancelled = await h.service.cancelWork("default", "host");
  assert.ok(cancelled.cancelledAt); assert.equal(cancelled.status, "assigned");
  assert.equal((await h.service.cancelWork("default", "host")).cancelledAt, cancelled.cancelledAt);
  const after = (await h.store.getRoom("default")).workItems;
  assert.equal(after[1].cancelledAt, cancelled.cancelledAt);
  assert.deepEqual(after.slice(2), items.slice(2));
  assert.deepEqual(h.stops, [], "idle cancellation never invokes runner Stop");
  assert.equal((await h.store.getRoom("default")).rounds[0].status, "assigned", "terminal pickup no longer blocks hierarchy");
  assert.equal((await h.store.reparent("default", "child", move)).parentActorId, null);
});

test("started stopped Todo and completed turns are idle; shared turns and loops survive cancellation", async t => {
  for (const status of ["todo", "done"] as const) await t.test(status, async t => {
    const h = await fixture(t);
    const session = await h.sessions.upsertSession({ id: "session", title: "Shared", cwd: "/private/tmp" });
    await h.sessions.recordSessionTurn({ id: "bound", sessionId: session.id, userInput: "Bound", status: "todo", agentResponse: "", tokenIn: 0, tokenOut: 0 });
    await h.sessions.updateSessionTurn({ id: "bound", status, pendingReason: status === "todo" ? "stopped" : null, agentResponse: "Stopped", runnerExitCode: status === "done" ? 0 : null, tokenIn: 0, tokenOut: 0 });
    await h.sessions.recordSessionTurn({ id: "other-loop", sessionId: session.id, userInput: "Loop", status: "running", agentResponse: "", tokenIn: 0, tokenOut: 0 });
    await h.sessions.enableTurnLoopMode("other-loop");
    await h.sessions.updateSessionTurn({ id: "other-loop", status: "done", agentResponse: "Complete", tokenIn: 0, tokenOut: 0, runnerExitCode: 0 });
    const loopBefore = await h.sessions.getLoopContinuation("other-loop");
    assert.ok(loopBefore);
    await h.sessions.recordSessionTurn({ id: "other-live", sessionId: session.id, userInput: "Other", status: "running", agentResponse: "", tokenIn: 0, tokenOut: 0 });
    await h.store.change("default", room => { room.workItems = [work({ taskSessionId: session.id, taskTurnId: "bound", status: "started", sessionScope: "turn" })]; });
    const otherBefore = await h.sessions.getSessionTurn("other-live");
    await h.service.cancelWork("default", "host");
    assert.deepEqual(h.stops, []);
    assert.deepEqual(await h.sessions.getSessionTurn("other-live"), otherBefore);
    assert.deepEqual(await h.sessions.getLoopContinuation("other-loop"), loopBefore);
    await assert.rejects(h.sessions.updateSessionTurn({ id: "bound", status: "running", agentResponse: "Retry", tokenIn: 0, tokenOut: 0 }), /cancelled/);
    await h.sessions.updateSessionTurn({ id: "other-live", status: "running", agentResponse: "Unaffected", tokenIn: 0, tokenOut: 0 });
  });
});

test("live and queued bound execution blocks cancellation, including a second active turn", async t => {
  for (const status of ["running", "todo"] as const) await t.test(status, async t => {
    const h = await fixture(t);
    const session = await h.sessions.upsertSession({ id: "session", title: "Live", cwd: "/private/tmp" });
    await h.sessions.recordSessionTurn({ id: "other", sessionId: session.id, userInput: "Other", status: status === "running" ? "todo" : "running", agentResponse: "", tokenIn: 0, tokenOut: 0 });
    await h.sessions.recordSessionTurn({ id: "bound", sessionId: session.id, userInput: "Bound", status, agentResponse: "", tokenIn: 0, tokenOut: 0 });
    await h.store.change("default", room => { room.workItems = [work({ taskSessionId: session.id, taskTurnId: "bound", sessionScope: "turn", status: "started" })]; });
    await assert.rejects(h.service.cancelWork("default", "host"), /running, queued or loop/);
    assert.equal((await h.store.getRoom("default")).workItems[0].cancelledAt, undefined);
    assert.deepEqual(h.stops, []);
  });
});

test("dispatch and pending operations on native children reject atomically", async t => {
  const cases: Array<[string, Partial<ActorWorkItem>]> = [
    ["lease", { dispatchLease: { owner: "dispatcher", until: Date.now() + 60_000 } }],
    ["assignment", { assignmentRequests: [{ requestId: "assign", executorActorId: "child", model: MODEL_CATALOG.luna.id, status: "pending" }] }],
    ["recovery", { nativeAgent: { name: "child", provider: "codex", recovery: { requestId: "recover", userPrompt: "Recover", turnId: "recover", status: "pending" } } }]
  ];
  for (const [name, extra] of cases) await t.test(name, async t => {
    const h = await fixture(t);
    await h.store.change("default", room => { room.workItems = [work(), work({ id: "native", hostWorkItemId: "host", ...extra })]; });
    const before = await h.store.getRoom("default");
    await assert.rejects(h.service.cancelWork("default", "host"), /launched|pending operation/);
    assert.deepEqual(await h.store.getRoom("default"), before);
    assert.deepEqual(h.stops, []);
  });
});

test("a pending loop on the bound turn blocks cancellation", async t => {
  const h = await fixture(t);
  await h.sessions.upsertSession({ id: "session" });
  await h.sessions.recordSessionTurn({ id: "bound", sessionId: "session", userInput: "Loop", status: "running", agentResponse: "", tokenIn: 0, tokenOut: 0 });
  await h.sessions.enableTurnLoopMode("bound");
  await h.sessions.updateSessionTurn({ id: "bound", status: "done", agentResponse: "Complete", tokenIn: 0, tokenOut: 0, runnerExitCode: 0 });
  await h.store.change("default", room => { room.workItems = [work({ taskTurnId: "bound", status: "started", sessionScope: "turn" })]; });
  const before = await h.sessions.getLoopContinuation("bound");
  assert.ok(before);
  await assert.rejects(h.service.cancelWork("default", "host"), /running, queued or loop/);
  assert.deepEqual(await h.sessions.getLoopContinuation("bound"), before);
  assert.deepEqual(h.stops, []);
});

test("cancel and runner admission across independent stores have exactly one winner", async t => {
  const h = await fixture(t);
  await h.sessions.upsertSession({ id: "session" });
  await h.sessions.recordSessionTurn({ id: "bound", sessionId: "session", userInput: "Stopped", status: "todo", pendingReason: "stopped", agentResponse: "", tokenIn: 0, tokenOut: 0 });
  await h.store.change("default", room => { room.workItems = [work({ taskTurnId: "bound", status: "started", sessionScope: "turn" })]; });
  const other = new SessionStore(h.path);
  await other.ready(); t.after(() => other.close());
  const results = await Promise.allSettled([
    h.service.cancelWork("default", "host"),
    other.updateSessionTurn({ id: "bound", status: "running", agentResponse: "Resume", tokenIn: 0, tokenOut: 0 })
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const failure = results.find(result => result.status === "rejected") as PromiseRejectedResult;
  assert.match(failure.reason.message, /cancelled|running, queued or loop/);
  const cancelled = (await h.store.getRoom("default")).workItems[0].cancelledAt;
  const turn = await other.getSessionTurn("bound");
  assert.equal(Boolean(cancelled), turn?.status !== "running");
  assert.deepEqual(h.stops, []);
});

test("native child cancellation preserves its host and sibling history", async t => {
  const h = await fixture(t);
  const host = work({ id: "parent", status: "completed" }), sibling = work({ id: "sibling", hostWorkItemId: "parent", status: "completed" });
  await h.store.change("default", room => { room.workItems = [host, work({ hostWorkItemId: "parent", dispatchLease: { owner: "expired", until: 1 } }), sibling]; });
  await h.service.cancelWork("default", "host");
  const after = (await h.store.getRoom("default")).workItems;
  assert.deepEqual(after[0], host); assert.deepEqual(after[2], sibling); assert.ok(after[1].cancelledAt);
  assert.deepEqual(h.stops, []);
});

test("missing turn cannot be inserted after cancellation; unrelated shared turns remain admissible", async t => {
  const h = await fixture(t);
  await h.sessions.upsertSession({ id: "session" });
  await h.store.change("default", room => { room.workItems = [work({ sessionScope: "turn" })]; });
  await h.service.cancelWork("default", "host");
  await assert.rejects(h.sessions.recordSessionTurn({ id: "missing", sessionId: "session", userInput: "Late launch", status: "todo", agentResponse: "", tokenIn: 0, tokenOut: 0 }), /cancelled/);
  await h.sessions.recordSessionTurn({ id: "unrelated", sessionId: "session", userInput: "Other request", status: "todo", agentResponse: "", tokenIn: 0, tokenOut: 0 });
  assert.equal((await h.sessions.getSessionTurn("unrelated"))?.status, "todo");
});

test("session-owned work rejects cancellation while any follow-up is queued and cannot restart after cancel", async t => {
  const h = await fixture(t);
  await h.sessions.upsertSession({ id: "session" });
  await h.sessions.recordSessionTurn({ id: "followup", sessionId: "session", userInput: "Follow-up", status: "todo", agentResponse: "", tokenIn: 0, tokenOut: 0 });
  await h.store.change("default", room => { room.workItems = [work({ status: "started" })]; });
  await assert.rejects(h.service.cancelWork("default", "host"), /running, queued or loop/);
  await h.sessions.updateSessionTurn({ id: "followup", status: "todo", pendingReason: "stopped", agentResponse: "Stopped", tokenIn: 0, tokenOut: 0 });
  await h.service.cancelWork("default", "host");
  await assert.rejects(h.sessions.recordSessionTurn({ id: "retry", sessionId: "session", userInput: "Retry", status: "todo", agentResponse: "", tokenIn: 0, tokenOut: 0 }), /cancelled/);
  assert.deepEqual(h.stops, []);
});

test("HTTP cancel keeps the signed-in route contract and returns the idle cancelled record", async t => {
  const h = await fixture(t);
  await h.store.change("default", room => { room.workItems = [work()]; });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { res.locals.threadexUserAuthenticated = req.headers["x-test-user"] === "signed-in"; next(); });
  app.use(createDomainActorRouter(h.service, h.store, h.sessions, {} as CollaborationService, { verify: async () => false }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/default/work-items/host/cancel`;
  assert.equal((await fetch(url, { method: "POST" })).status, 403);
  const response = await fetch(url, { method: "POST", headers: { "x-test-user": "signed-in" } });
  assert.equal(response.status, 200);
  const item = await response.json(); assert.ok(item.cancelledAt); assert.equal(item.status, "assigned");
  assert.deepEqual(h.stops, []);
});
