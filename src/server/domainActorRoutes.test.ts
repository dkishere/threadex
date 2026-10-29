import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { actorTreeGroupId, createDomainActorRouter } from "./domainActorRoutes";
import type { DomainActorService } from "./domainActorService";
import { DomainActorStore, type ActorPersistence } from "./domainActorStore";
import { MODEL_CATALOG } from "../modelCatalog";
import type { SessionStore } from "./sessionStore";
import type { CollaborationService } from "./collaborationService";
import { actorJobSnapshot, DomainActorAuth } from "./domainActorAuth";

function capabilityStore() {
  const rows = new Map<string, string>();
  const key = (scope: { workspaceId: string; sessionId: string; turnId: string; workItemId?: string }) => JSON.stringify([scope.workspaceId, scope.sessionId, scope.turnId, scope.workItemId ?? null]);
  return { rows,
    setDomainActorCapability: async (input: { workspaceId: string; sessionId: string; turnId: string; tokenHash: string; workItemId?: string }) => { rows.set(key(input), input.tokenHash); },
    getDomainActorCapability: async (input: { workspaceId: string; sessionId: string; turnId: string; workItemId?: string }) => rows.get(key(input)) ?? null
  };
}

test("worker DELETE requires sign-in, reports conflicts, validates workspace scope and returns the deleted ID", async () => {
  const rooms = new Map<string, any>();
  const persistence = {
    getWorkspace: async (id: string) => ["workspace", "other"].includes(id) ? { id } : null,
    getDomainActorRoom: async (id: string) => structuredClone(rooms.get(id) ?? { workspaceId: id, revision: 0, actors: [], rounds: [], workItems: [], events: [], memoryErrors: [] }),
    changeDomainActorRoom: async (id: string, change: (room: any) => unknown) => {
      const room = await persistence.getDomainActorRoom(id); const result = change(room); rooms.set(id, room); return result;
    }
  } as unknown as ActorPersistence;
  const store = new DomainActorStore(persistence);
  const memory = { rolePrompt: "role", roleSummary: "role", longTerm: "", rolling: "" };
  await store.create("workspace", { id: "root", name: "Root", model: MODEL_CATALOG.luna.id, memory });
  await store.create("workspace", { id: "child", name: "Child", parentActorId: "root", model: MODEL_CATALOG.luna.id, memory });
  const service = { deleteActor: (workspace: string, id: string) => store.delete(workspace, id) } as unknown as DomainActorService;
  const app = express();
  app.use((req, res, next) => { res.locals.threadexUserAuthenticated = req.headers["x-test-user"] === "signed-in"; next(); });
  app.use(createDomainActorRouter(service, store, {} as SessionStore, {} as CollaborationService, new DomainActorAuth(capabilityStore())));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const call = (workspace: string, id: string, signedIn = true) => fetch(`http://127.0.0.1:${address.port}/${workspace}/actors/${id}`, {
    method: "DELETE", headers: signedIn ? { "x-test-user": "signed-in" } : {}
  });
  try {
    assert.equal((await call("workspace", "child", false)).status, 403);
    const conflict = await call("workspace", "root"); assert.equal(conflict.status, 409); assert.match((await conflict.json()).error, /sub-workers first/);
    assert.equal((await call("other", "child")).status, 400);
    assert.equal((await call("missing", "child")).status, 400);
    const deleted = await call("workspace", "child"); assert.equal(deleted.status, 200); assert.deepEqual(await deleted.json(), { deletedActorId: "child" });
    assert.equal((await call("workspace", "child")).status, 400);
    assert.equal((await call("workspace", "root")).status, 200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("worker avatar registry API validates, preserves and clears avatars", async () => {
  let room: any = { workspaceId: "workspace", revision: 0, actors: [], rounds: [], workItems: [], events: [], memoryErrors: [] };
  const persistence = {
    getWorkspace: async () => ({}), getDomainActorRoom: async () => structuredClone(room),
    changeDomainActorRoom: async (_workspace: string, change: (room: any) => unknown) => {
      const next = structuredClone(room); const result = change(next); room = next; return result;
    }
  } as unknown as ActorPersistence;
  const store = new DomainActorStore(persistence);
  const service = { createActor: (workspace: string, input: any) => store.create(workspace, input),
    updateActor: (workspace: string, id: string, input: any) => store.update(workspace, id, input) } as unknown as DomainActorService;
  const app = express(); app.use(express.json({ limit: "200kb" }));
  app.use((_req, res, next) => { res.locals.threadexUserAuthenticated = true; next(); });
  app.use(createDomainActorRouter(service, store, {} as SessionStore, {} as CollaborationService, new DomainActorAuth(capabilityStore())));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/workspace/actors`;
  const call = (url: string, method: string, body: object) => fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const avatar = "data:image/png;base64,YQ==";
  try {
    const created = await call(base, "POST", { id: "root", name: "Root", model: MODEL_CATALOG.luna.id, avatar,
      memory: { rolePrompt: "Role", roleSummary: "Summary", longTerm: "Knowledge", rolling: "Recent" } });
    assert.equal(created.status, 200); const original = await created.json(); assert.equal(original.avatar, avatar);
    const url = `${base}/root`;
    const replacement = "data:image/jpeg;base64,Yg==";
    const changed = await call(url, "PATCH", { avatar: replacement }); assert.equal(changed.status, 200);
    const updated = await changed.json(); assert.equal(updated.avatar, replacement);
    assert.deepEqual({ ...updated, avatar: original.avatar, updated: original.updated }, original);
    for (const invalid of ["https://example.com/avatar.png", `data:image/png;base64,${"A".repeat(65536)}`, 123]) {
      const response = await call(url, "PATCH", { avatar: invalid });
      assert.equal(response.status, 400); assert.match((await response.json()).error, /Avatar/);
    }
    const unchanged = await call(url, "PATCH", {}); assert.equal(unchanged.status, 200);
    const preserved = await unchanged.json();
    assert.deepEqual({ ...preserved, updated: updated.updated }, updated);
    const cleared = await call(url, "PATCH", { avatar: null }); assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).avatar, undefined);
    const invalidCreate = await call(base, "POST", { id: "bad", name: "Bad", model: MODEL_CATALOG.luna.id, avatar: null, memory: original.memory });
    assert.equal(invalidCreate.status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("chat reply Stop requires a signed-in user and forwards the exact workspace, round and actor", async () => {
  const calls: string[][] = [];
  const service = { stopReply: async (...ids: string[]) => { calls.push(ids); return { actorId: ids[2], status: "stopped", text: "Reply stopped." }; } } as unknown as DomainActorService;
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { res.locals.threadexUserAuthenticated = req.headers["x-test-user"] === "signed-in"; next(); });
  app.use(createDomainActorRouter(service, {} as DomainActorStore, {} as SessionStore, {} as CollaborationService, new DomainActorAuth(capabilityStore())));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/workspace/rounds/round-one/replies/actor-one/stop`;
  try {
    assert.equal((await fetch(url, { method: "POST" })).status, 403);
    assert.deepEqual(calls, []);
    const result = await fetch(url, { method: "POST", headers: { "x-test-user": "signed-in" } });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).status, "stopped");
    assert.deepEqual(calls, [["workspace", "round-one", "actor-one"]]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("actor actions authorize the stored task binding and reject sub-actor management or cross-tree steer", async () => {
  let created = 0, sent = 0, updated = 0;
  let active = true;
  let createdInput: any;
  let parallelInput: any;
  let parallelTarget = false;
  let allocationTarget = false;
  let initialActorTurn = true;
  let sentGroup: string | undefined;
  const auth = new DomainActorAuth(capabilityStore());
  const actorToken = await auth.issue("workspace", "task", "turn");
  const rootToken = await auth.issue("workspace", "root-task", "root-turn");
  const workerToken = await auth.issue("workspace", "worker-task", "worker-turn");
  const service = {
    getRoom: async () => ({ rounds: [{ id: "split", ...(allocationTarget ? { allocation: {}, workItemIds: ["work", "outside"] } : {}) }], actors: [
      { id: "root", rootActorId: "root", parentActorId: null, allowedModels: ["gpt-6-luna"] },
      { id: "sub", rootActorId: "root", parentActorId: "root", allowedModels: ["gpt-6-luna"] },
      { id: "sibling", rootActorId: "root", parentActorId: "root" },
      { id: "other", rootActorId: "other", parentActorId: null }
    ].map(actor => ({ ...actor, memory: { roleSummary: "Summary", longTerm: "Large private memory is loaded explicitly" } })), workItems: [
      { id: "work", roundId: "split", executorActorId: "sub", taskSessionId: "task", taskTurnId: initialActorTurn ? "turn" : "initial-turn", executionHistory: [{ executorActorId: "root", taskSessionId: "root-task" }] },
      { id: "outside", roundId: "split", executorActorId: "other", taskSessionId: "outside-task", ...(parallelTarget ? { parentWorkItemId: "work" } : {}) },
      { id: "sibling-work", executorActorId: "sibling", taskSessionId: "sibling-task" }
    ] }),
    createActor: async (_workspaceId: string, input: unknown) => { created++; createdInput = input; return { ok: true }; },
    runningSessions: async () => [{ actorId: "sub", sessionId: "task", turnId: "turn", workItemId: "work", status: "running" }],
    updateActor: async () => { updated++; return { ok: true }; },
    delegateParallel: async (input: unknown) => { parallelInput = input; return { status: "assigned", workItems: [] }; }
  } as unknown as DomainActorService;
  const sessions = {
    getSession: async (id: string) => ({ id, workspaceId: "workspace" }),
    getSessionTurn: async (id: string) => ({ id, sessionId: id === "turn" ? "task" : id === "root-turn" ? "root-task" : id === "worker-turn" ? "worker-task" : "other-task", status: active ? "running" : "done",
      created: "2026-10-27 12:30:00+00",
      requestMetadata: initialActorTurn ? { message: "Original request plus actor-written brief: ask everyone to work" }
        : { message: "Please ask peer actors to work concurrently", clientLayout: "desktop" } }),
    listSessionTurns: async () => [
      { id: "initial-turn", status: "done", created: "2026-10-27 09:00:00+00", requestMetadata: { message: "Actor envelope", clientLayout: "desktop" } },
      { id: "user-followup", status: "done", created: "2026-10-27 11:00:00+00", requestMetadata: { message: "not updating logo on primo", clientLayout: "desktop" } },
      { id: "wait_resume", status: "done", created: "2026-10-27 11:30:00+00", requestMetadata: { message: "Actor-written resume instruction" } },
      { id: "turn", status: "running", created: "2026-10-27 12:30:00+00", requestMetadata: { message: "current", clientLayout: "desktop" } },
      { id: "queued", status: "todo", created: "2026-10-27 12:40:00+00", requestMetadata: { message: "queued later", clientLayout: "desktop" } }
    ],
    getLatestRunningTurn: async () => ({ id: "sibling-turn", status: "running" }),
    changeCollaboration: async (_id: string, initial: unknown, change: (group: unknown) => unknown) => change(initial)
  } as unknown as SessionStore;
  const collaboration = { send: async (_session: string, _body: unknown, groupId?: string) => { sent++; sentGroup = groupId; } } as unknown as CollaborationService;
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.headers["x-test-user"] === "signed-in") res.locals.threadexUserAuthenticated = true; next(); });
  app.use(createDomainActorRouter(service, {} as DomainActorStore, sessions, collaboration, auth));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const call = (body: object) => fetch(`http://127.0.0.1:${address.port}/sessions/task/action`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-threadex-actor-capability": actorToken }, body: JSON.stringify(body)
  });
  try {
    const forged = await call({ action: "actor_create_sub", sourceTurnId: "turn", actorId: "root", parentActorId: "root" });
    assert.equal(forged.status, 400); assert.match((await forged.json()).error, /Only a root/);
    const outside = await call({ action: "actor_steer", sourceTurnId: "turn", sessionId: "outside-task", message: "hello", requestId: "r" });
    assert.equal(outside.status, 400); assert.match((await outside.json()).error, /own actor tree/);
    const wrongTurn = await call({ action: "actor_tree_status", sourceTurnId: "other-turn" });
    assert.equal(wrongTurn.status, 400); assert.match((await wrongTurn.json()).error, /bound running task/);
    const root = await fetch(`http://127.0.0.1:${address.port}/sessions/root-task/action`, { method: "POST",
      headers: { "Content-Type": "application/json", "x-threadex-actor-capability": rootToken }, body: JSON.stringify({ action: "actor_update_sub", sourceTurnId: "root-turn", actorId: "sub", name: "Updated" }) });
    assert.equal(root.status, 200); assert.equal(updated, 1);
    const createSub = await fetch(`http://127.0.0.1:${address.port}/sessions/root-task/action`, { method: "POST", headers: { "Content-Type": "application/json", "x-threadex-actor-capability": rootToken },
      body: JSON.stringify({ action: "actor_create_sub", sourceTurnId: "root-turn", name: "New", model: "gpt-6-luna", allowedModels: ["gpt-6-astra"], memory: {} }) });
    assert.equal(createSub.status, 200); assert.deepEqual(createdInput.allowedModels, ["gpt-6-luna"]); assert.equal(createdInput.parentActorId, "root");
    const tokenless = await fetch(`http://127.0.0.1:${address.port}/sessions/root-task/action`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "actor_tree_status", sourceTurnId: "root-turn" }) });
    assert.equal(tokenless.status, 400); assert.match((await tokenless.json()).error, /capability/);
    const ordinary = await fetch(`http://127.0.0.1:${address.port}/sessions/worker-task/action`, { method: "POST", headers: { "Content-Type": "application/json",
      "x-threadex-actor-capability": workerToken }, body: JSON.stringify({ action: "actor_tree_status", sourceTurnId: "worker-turn" }) });
    assert.equal(ordinary.status, 400); assert.match((await ordinary.json()).error, /system-owned actor binding/);
    const registry = `http://127.0.0.1:${address.port}/workspace/actors`;
    const untrusted = await fetch(registry, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(untrusted.status, 403); assert.equal((await untrusted.json()).code, "AUTH_REQUIRED");
    const trusted = await fetch(registry, { method: "POST", headers: { "Content-Type": "application/json", "x-test-user": "signed-in" }, body: "{}" });
    assert.equal(trusted.status, 200);
    const parent = await call({ action: "actor_steer", sourceTurnId: "turn", sessionId: "root-task", message: "hello", requestId: "r" });
    assert.equal(parent.status, 400); assert.match((await parent.json()).error, /only siblings/);
    const sibling = await call({ action: "actor_steer", sourceTurnId: "turn", sessionId: "sibling-task", message: "new context", requestId: "sibling-notice" });
    assert.equal(sibling.status, 200); assert.equal(sent, 1);
    const tasks = [{ executorActorId: "other", task: "Implement the API" }];
    const parallel = await call({ action: "actor_assign_many", sourceTurnId: "turn", actorId: "root", workItemId: "outside", requestId: "parallel", tasks });
    assert.equal(parallel.status, 200);
    assert.equal(parallelInput.sourceActorId, "sub"); assert.equal(parallelInput.workItemId, "work");
    assert.equal(parallelInput.sourceSessionId, "task"); assert.deepEqual(parallelInput.tasks, tasks);
    assert.equal(parallelInput.currentUserPrompt, undefined, "an initial actor envelope is not an additional canonical user message");
    assert.equal(parallelInput.kind, undefined, "actor_assign_many keeps the parallel contract");
    const handoffTask = { executorActorId: "other", task: "Build the settings UI" };
    const handoff = await call({ action: "actor_handoff", sourceTurnId: "turn", requestId: "handoff-one", ...handoffTask });
    assert.equal(handoff.status, 200);
    assert.equal(parallelInput.kind, "handoff"); assert.deepEqual(parallelInput.tasks, [handoffTask]);
    assert.equal(parallelInput.sourceSessionId, "task"); assert.equal(parallelInput.sourceActorId, "sub");
    assert.equal(parallelInput.workItemId, "work"); assert.equal(parallelInput.requestId, "handoff-one");
    initialActorTurn = false;
    const followupParallel = await call({ action: "actor_assign_many", sourceTurnId: "turn", requestId: "parallel-followup", tasks });
    assert.equal(followupParallel.status, 200);
    assert.equal(parallelInput.currentUserPrompt, "Please ask peer actors to work concurrently", "a genuine later user turn remains authorization evidence");
    const goHandoff = await call({ action: "actor_handoff", sourceTurnId: "turn", requestId: "handoff-go", ...handoffTask });
    assert.equal(goHandoff.status, 200);
    assert.deepEqual(parallelInput.priorUserPrompts, ["not updating logo on primo"],
      "earlier direct user follow-ups count; the actor envelope, automation resumes and queued turns do not");
    assert.equal(parallelInput.currentUserPrompt, "Please ask peer actors to work concurrently");
    parallelTarget = true;
    const related = await call({ action: "actor_steer", sourceTurnId: "turn", sessionId: "outside-task", message: "Coordinate shared files", requestId: "parallel-message" });
    assert.equal(related.status, 200); assert.equal(sent, 2);
    assert.equal(sentGroup, actorTreeGroupId("workspace", "parallel:work"));
    parallelTarget = false;
    allocationTarget = true;
    const splitPeer = await call({ action: "actor_steer", sourceTurnId: "turn", sessionId: "outside-task", message: "API contract is ready", requestId: "allocation-message" });
    assert.equal(splitPeer.status, 200); assert.equal(sent, 3);
    assert.equal(sentGroup, actorTreeGroupId("workspace", "allocation:split"));
    const splitStatus = await call({ action: "actor_tree_status", sourceTurnId: "turn", limit: 20 });
    assert.equal(splitStatus.status, 200);
    assert.ok((await splitStatus.json()).workItems.some((item: { id: string }) => item.id === "outside"));
    allocationTarget = false;
    const unrelated = await call({ action: "actor_steer", sourceTurnId: "turn", sessionId: "outside-task", message: "No saved allocation", requestId: "unrelated-message" });
    assert.equal(unrelated.status, 400, "a shared round alone cannot authorize cross-tree coordination");
    const status = await call({ action: "actor_tree_status", sourceTurnId: "turn", limit: 1 });
    assert.equal(status.status, 200);
    const statusData = await status.json();
    assert.equal(statusData.actors.length, 1); assert.equal(statusData.nextOffset, 1);
    assert.equal(JSON.stringify(statusData).includes("Large private memory"), false);
    assert.equal(statusData.runningSessions[0].turnId, "turn");
    const memoryRead = await call({ action: "actor_read_memory", sourceTurnId: "turn", field: "longTerm", offset: 0, bytes: 12, actorId: "other" });
    assert.equal(memoryRead.status, 200);
    assert.ok(Buffer.byteLength((await memoryRead.json()).text) <= 12);
    const createRoot = await call({ action: "actor_create_root", sourceTurnId: "turn", name: "BDD", model: "gpt-6-luna",
      workspaceId: "outside", parentActorId: "other", allowedModels: ["gpt-6-astra"], memory: { rolePrompt: "BDD", roleSummary: "BDD", longTerm: "", rolling: "" } });
    assert.equal(createRoot.status, 200);
    assert.equal(createdInput.parentActorId, null);
    assert.deepEqual(createdInput.allowedModels, ["gpt-6-luna"]);
    assert.equal(createdInput.workspaceId, undefined);
    const unauthenticatedRoot = await fetch(`http://127.0.0.1:${address.port}/sessions/task/action`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "actor_create_root", sourceTurnId: "turn" }) });
    assert.equal(unauthenticatedRoot.status, 400);
    active = false;
    const completedCreate = await call({ action: "actor_create_root", sourceTurnId: "turn", name: "BDD" });
    assert.equal(completedCreate.status, 400);
    const completed = await call({ action: "actor_tree_status", sourceTurnId: "turn" });
    assert.equal(completed.status, 400); assert.match((await completed.json()).error, /bound running task/);
    assert.equal(created, 3);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("a native split child acts only as its own actor work item inside the running host turn", async () => {
  const auth = new DomainActorAuth(capabilityStore());
  const tokens = { host: await auth.issue("workspace", "s-host", "t-host"), child: await auth.issue("workspace", "s-host", "t-host", "child"),
    stale: await auth.issue("workspace", "s-host", "t-old", "child"), notChild: await auth.issue("workspace", "s-host", "t-host", "other") };
  const work = (id: string, extra: object = {}) => ({ id, roundId: "split", ownerActorId: `${id}-actor`, executorActorId: `${id}-actor`, allocationId: `a-${id}`, model: "gpt-6-luna",
    taskSessionId: "s-host", taskTurnId: "t-host", status: "started", dispatched: true, executionHistory: [], ...extra });
  const room: any = {
    actors: ["host-actor", "child-actor", "other-actor"].map(id => ({ id, name: id, rootActorId: id, parentActorId: null, effort: "medium",
      allowedModels: ["gpt-6-luna"], memory: { version: 1, rolePrompt: `${id} role`, roleSummary: id, longTerm: "", rolling: "" } })),
    rounds: [{ id: "split", allocation: { requirements: [], assignments: [], review: { overlaps: [], conflicts: [], uncovered: [] }, integrationAssignmentId: "a-host" },
      workItemIds: ["child", "host", "other"], replies: [] }],
    // The child is listed first: binding by session must still resolve the host, never a native child.
    workItems: [work("child", { hostWorkItemId: "host", nativeAgent: { name: "actor_child", provider: "claude" } }), work("host"),
      work("other", { taskSessionId: "s-other", taskTurnId: "t-other" })]
  };
  const service = { getRoom: async () => structuredClone(room) } as unknown as DomainActorService;
  const sessions = {
    getSession: async (id: string) => ({ id, workspaceId: "workspace" }),
    getSessionTurn: async (id: string) => ({ id, sessionId: "s-host", status: "running" })
  } as unknown as SessionStore;
  const app = express(); app.use(express.json());
  app.use(createDomainActorRouter(service, {} as DomainActorStore, sessions, {} as CollaborationService, auth));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const call = (token: string, body: object, workItem?: string) => fetch(`http://127.0.0.1:${address.port}/sessions/s-host/action`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-threadex-actor-capability": token, ...(workItem ? { "x-threadex-actor-work-item": workItem } : {}) },
    body: JSON.stringify({ sourceTurnId: "t-host", ...body }) });
  const memory = { action: "actor_read_memory", field: "rolePrompt" };
  try {
    const child = await call(tokens.child, memory, "child");
    assert.equal(child.status, 200); assert.equal((await child.json()).text, "child-actor role");
    const host = await call(tokens.host, memory);
    assert.equal(host.status, 200); assert.equal((await host.json()).text, "host-actor role");
    for (const [token, workItem] of [[tokens.host, "child"], [tokens.child, undefined], [tokens.stale, "child"]] as const) {
      const denied = await call(token, memory, workItem);
      assert.equal(denied.status, 400); assert.match((await denied.json()).error, /capability is missing/);
    }
    const notChild = await call(tokens.notChild, memory, "other");
    assert.equal(notChild.status, 400); assert.match((await notChild.json()).error, /does not belong to this host session/);
    const steer = await call(tokens.child, { action: "actor_steer", sessionId: "s-other", message: "Take over", requestId: "r" }, "child");
    assert.equal(steer.status, 400); assert.match((await steer.json()).error, /host session coordinates/);
    room.actors[1].allowedModels = ["gpt-6-astra"];
    const revoked = await call(tokens.child, memory, "child");
    assert.equal(revoked.status, 400); assert.match((await revoked.json()).error, /no longer permits its model/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("actor summary requires a signed-in user and returns per-actor workload counts without memory", async () => {
  const requested: string[] = [];
  const service = {
    getRoom: async (workspaceId: string) => { requested.push(`room:${workspaceId}`); return { workspaceId, revision: 3, rounds: [], actors: [
      { id: "root", name: "Root", rootActorId: "root", parentActorId: null, model: "gpt-6-luna", memory: { longTerm: "Large private memory" } },
      { id: "sub", name: "Sub", rootActorId: "root", parentActorId: "root", model: "gpt-6-astra", memory: { longTerm: "Large private memory" } }
    ], workItems: [
      { id: "w1", ownerActorId: "root", executorActorId: "sub", status: "started" },
      { id: "w2", ownerActorId: "root", executorActorId: "root", status: "needs_user" }
    ], blockers: [
      { id: "b-old", taskSessionId: "s-titled", status: "escalated", selfClearing: false, updated: "2026-10-25T00:00:00Z" },
      { id: "b-new", taskSessionId: "s-untitled", status: "solution_proposed", selfClearing: false, updated: "2026-10-26T00:00:00Z" },
      { id: "b-wait", taskSessionId: "s-titled", status: "open", selfClearing: true, updated: "2026-10-26T01:00:00Z" },
      { id: "b-done", taskSessionId: "s-titled", status: "resolved", selfClearing: false, updated: "2026-10-26T02:00:00Z" }
    ] }; },
    runningSessions: async (workspaceId: string) => { requested.push(`running:${workspaceId}`);
      return [{ actorId: "sub", sessionId: "task", turnId: "turn", workItemId: "w1", status: "running" }]; },
    listProjects: async (workspaceId: string) => { requested.push(`projects:${workspaceId}`); return [{ id: "p", name: "Project" }]; }
  } as unknown as DomainActorService;
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.headers["x-test-user"] === "signed-in") res.locals.threadexUserAuthenticated = true; next(); });
  const sessions = { getSession: async (id: string) => { requested.push(`session:${id}`); return id === "s-titled" ? { id, title: "Fix the build" } : null; } } as unknown as SessionStore;
  app.use(createDomainActorRouter(service, {} as DomainActorStore, sessions, {} as CollaborationService, new DomainActorAuth(capabilityStore())));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/workspace/actors/summary`;
  try {
    const anonymous = await fetch(url);
    assert.equal(anonymous.status, 403); assert.equal((await anonymous.json()).code, "AUTH_REQUIRED");
    assert.deepEqual(requested, [], "unauthenticated requests never load the room");
    const response = await fetch(url, { headers: { "x-test-user": "signed-in" } });
    assert.equal(response.status, 200);
    const body = await response.json();
    const blockers = [
      { id: "b-new", taskSessionId: "s-untitled", status: "solution_proposed", selfClearing: false, updated: "2026-10-26T00:00:00Z" },
      { id: "b-old", taskSessionId: "s-titled", status: "escalated", selfClearing: false, updated: "2026-10-25T00:00:00Z", taskSessionTitle: "Fix the build" }
    ];
    assert.deepEqual(body.blockers, blockers, "active, non-self-clearing blockers newest first, titled when the task session has a title");
    assert.deepEqual(requested, ["room:workspace", "session:s-untitled", "session:s-titled", "running:workspace", "projects:workspace"]);
    assert.deepEqual(body, { workspaceId: "workspace", revision: 3, groups: [
      { key: "p", projectId: "p", name: "Project", registered: true, actorIds: [] },
      { key: "unassigned", projectId: null, name: "Unassigned", registered: true, actorIds: ["root"] }
    ], actors: [
      { type: "worker", id: "root", name: "Root", rootActorId: "root", parentActorId: null, model: "gpt-6-luna", counts: { open: 1, attention: 1 }, running: 0, unreadConclusions: 0 },
      { type: "worker", id: "sub", name: "Sub", rootActorId: "root", parentActorId: "root", model: "gpt-6-astra", counts: { open: 1, attention: 0 }, running: 1, unreadConclusions: 0 }
    ], blockers });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("room chat query returns only that project's group rounds; no query keeps the full room", async () => {
  const rounds = [{ id: "p1", namedActorIds: [], chatProjectId: "p" }, { id: "legacy", namedActorIds: [] },
    { id: "direct", namedActorIds: ["a"] }, { id: "q1", namedActorIds: [], chatProjectId: "q" }];
  const service = { getRoom: async (workspaceId: string) => ({ workspaceId, revision: 1, actors: [], rounds }) } as unknown as DomainActorService;
  const app = express(); app.use(express.json());
  app.use((_req, res, next) => { res.locals.threadexUserAuthenticated = true; next(); });
  app.use(createDomainActorRouter(service, {} as DomainActorStore, {} as SessionStore, {} as CollaborationService, new DomainActorAuth(capabilityStore())));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const ids = async (query: string) => ((await (await fetch(`http://127.0.0.1:${address.port}/ws/room${query}`)).json()).rounds as Array<{ id: string }>).map(round => round.id);
  try {
    assert.deepEqual(await ids("?chat=p"), ["p1"]);
    assert.deepEqual(await ids("?chat=unassigned"), ["legacy"]);
    assert.deepEqual(await ids(""), ["p1", "legacy", "direct", "q1"]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("pending blocker list is not read as a workspace route and adds task session titles; approve forwards proposalId", async () => {
  const calls: unknown[] = [];
  const service = {
    pendingBlockerDecisions: async (ids: string[]) => { calls.push(["pending", ids]); return [
      { id: "b1", workspaceId: "w1", taskSessionId: "s1", ownerActorName: "Root", updated: "2026-10-26T00:00:00Z" },
      { id: "b2", workspaceId: "w2", taskSessionId: "gone", updated: "2026-10-25T00:00:00Z" }
    ]; },
    getRoom: async (workspaceId: string) => { calls.push(["room", workspaceId]); return {}; },
    userBlockerAction: async (input: unknown) => { calls.push(["action", input]); return { id: "b1" }; }
  } as unknown as DomainActorService;
  const sessions = { listWorkspaces: async () => [{ id: "w1" }, { id: "w2" }],
    getSession: async (id: string) => id === "s1" ? { id, title: "Fix the build" } : null } as unknown as SessionStore;
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.headers["x-test-user"] === "signed-in") res.locals.threadexUserAuthenticated = true; next(); });
  app.use(createDomainActorRouter(service, {} as DomainActorStore, sessions, {} as CollaborationService, new DomainActorAuth(capabilityStore())));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/blockers/pending`)).status, 403);
    const response = await fetch(`${base}/blockers/pending`, { headers: { "x-test-user": "signed-in" } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.blockers.map((blocker: { id: string; taskSessionTitle?: string }) => [blocker.id, blocker.taskSessionTitle ?? null]), [["b1", "Fix the build"], ["b2", null]]);
    const action = await fetch(`${base}/w1/blockers/b1/action`, { method: "POST", headers: { "x-test-user": "signed-in", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve", proposalId: "b1:proposal:1", note: "go" }) });
    assert.equal(action.status, 200);
    assert.deepEqual(calls, [["pending", ["w1", "w2"]], ["action", { workspaceId: "w1", blockerId: "b1", action: "approve", note: "go", proposalId: "b1:proposal:1" }]]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("actor collaboration identity includes the workspace even when root IDs match", () => {
  assert.notEqual(actorTreeGroupId("workspace-a", "root"), actorTreeGroupId("workspace-b", "root"));
  assert.equal(actorTreeGroupId("workspace-a", "root"), actorTreeGroupId("workspace-a", "root"));
});

test("opaque actor capabilities survive a service restart using only persisted digests", async () => {
  const store = capabilityStore();
  const first = new DomainActorAuth(store);
  const token = await first.issue("workspace", "session", "turn");
  assert.ok([...store.rows.values()].every(value => value !== token));
  const restarted = new DomainActorAuth(store);
  assert.equal(await restarted.verify(token, "workspace", "session", "turn"), true);
  assert.equal(await restarted.verify(token, "other", "session", "turn"), false);
  assert.equal(await restarted.verify(token, "workspace", "other", "turn"), false);
  assert.equal(await restarted.verify(token, "workspace", "session", "other"), false);
  assert.equal(await restarted.verify("0".repeat(64), "workspace", "session", "turn"), false);
  assert.equal(await restarted.verify(undefined, "workspace", "session", "turn"), false);
  const snapshot = actorJobSnapshot({ sessionId: "session", turnId: "turn", domainActorCapability: token, domainActor: true });
  assert.equal(JSON.stringify(snapshot).includes(token), false);
  assert.equal(Object.hasOwn(snapshot, "domainActorCapability"), false);
});
