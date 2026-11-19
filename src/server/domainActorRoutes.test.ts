import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { actorRoomClientView, actorTreeGroupId, createDomainActorRouter } from "./domainActorRoutes";
import type { DomainActorService } from "./domainActorService";
import { ActorHierarchyConflict, DomainActorStore, type ActorPersistence } from "./domainActorStore";
import { DOMAIN_ACTOR_TOOLS } from "./domainActorTools";
import { MODEL_CATALOG } from "../modelCatalog";
import type { SessionStore } from "./sessionStore";
import type { CollaborationService } from "./collaborationService";
import { actorJobSnapshot, DomainActorAuth } from "./domainActorAuth";
import { USER_INPUT_METHOD } from "../userInputRequest";
import { actorFollowupTurnId } from "./domainActorContext";

test("polled room view ships round snapshot identities, not runner memory or duplicated avatars", () => {
  const actor = (id: string, extra: Record<string, unknown> = {}) => ({ id, workspaceId: "workspace", rootActorId: id, parentActorId: null, name: `Actor ${id}`,
    model: MODEL_CATALOG.sol61.id, effort: "medium", avatar: `data:image/png;base64,${id}`, memory: { version: 3, sourceEventIds: ["event"], rolePrompt: "Role",
      roleSummary: "Domain", longTerm: "long", rolling: "rolling" }, created: "", updated: "", ...extra });
  const room = { workspaceId: "workspace", revision: 7, actors: [actor("current")], reorganizations: [{ id: "audit" }],
    rounds: [{ id: "round", status: "assigned", actorSnapshots: [actor("current"), actor("removed")],
      candidateSnapshots: [{ actorId: "current", memoryVersion: 3, actor: actor("current") }], replies: [] }] };
  const view = actorRoomClientView(room as never) as unknown as Record<string, any>;
  assert.equal("reorganizations" in view, false);
  assert.equal(view.revision, 7);
  assert.equal(view.actors[0].memory.longTerm, "long", "current actors keep their full permission view");
  assert.ok(Array.isArray(view.actors[0].allowedModels));
  assert.deepEqual(view.rounds[0].candidateSnapshots, []);
  assert.deepEqual(view.rounds[0].actorSnapshots, [
    { id: "current", name: "Actor current", parentActorId: null, rootActorId: "current" },
    { id: "removed", name: "Actor removed", parentActorId: null, rootActorId: "removed", avatar: "data:image/png;base64,removed" }
  ]);
  assert.equal(room.rounds[0].candidateSnapshots.length, 1, "the stored room is not mutated");
});

test("reply retry route forwards the selected gear and retains user authentication", async () => {
  const calls: unknown[][] = [];
  const service = { retryReply: async (...args: unknown[]) => { calls.push(args); return { id: "round" }; } } as unknown as DomainActorService;
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { res.locals.threadexUserAuthenticated = req.headers["x-test-user"] === "signed-in"; next(); });
  app.use(createDomainActorRouter(service, {} as DomainActorStore, {} as SessionStore, {} as CollaborationService, new DomainActorAuth(capabilityStore())));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const responseProfile = { model: MODEL_CATALOG.sol61.id, effort: "high" };
  const url = `http://127.0.0.1:${address.port}/workspace/rounds/round/replies/actor/retry`;
  try {
    assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ responseProfile }) })).status, 403);
    assert.equal(calls.length, 0);
    assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-test-user": "signed-in" }, body: JSON.stringify({ responseProfile }) })).status, 200);
    assert.deepEqual(calls, [["workspace", "round", "actor", responseProfile]]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

function capabilityStore() {
  const rows = new Map<string, string>();
  const key = (scope: { workspaceId: string; sessionId: string; turnId: string; workItemId?: string }) => JSON.stringify([scope.workspaceId, scope.sessionId, scope.turnId, scope.workItemId ?? null]);
  return { rows,
    setDomainActorCapability: async (input: { workspaceId: string; sessionId: string; turnId: string; tokenHash: string; workItemId?: string }) => { rows.set(key(input), input.tokenHash); },
    getDomainActorCapability: async (input: { workspaceId: string; sessionId: string; turnId: string; workItemId?: string }) => rows.get(key(input)) ?? null
  };
}

test("hierarchy settings require sign-in, project fields and return conflicts", async () => {
  const calls: unknown[][] = [];
  const service = { reparentActor: async (...args: unknown[]) => { calls.push(args); if (calls.length === 2) throw new ActorHierarchyConflict("stale hierarchy"); return { ok: true }; } } as unknown as DomainActorService;
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { res.locals.threadexUserAuthenticated = req.headers["x-test-user"] === "signed-in"; next(); });
  app.use(createDomainActorRouter(service, {} as DomainActorStore, {} as SessionStore, {} as CollaborationService, new DomainActorAuth(capabilityStore())));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const input = { parentActorId: null, expectedParentActorId: "root", expectedRootActorId: "root" };
  const call = (signedIn: boolean) => fetch(`http://127.0.0.1:${address.port}/workspace/actors/child/hierarchy`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(signedIn ? { "x-test-user": "signed-in" } : {}) },
    body: JSON.stringify({ ...input, callerActorId: "forged", managementWorkItemId: "forged" })
  });
  try {
    assert.equal((await call(false)).status, 403); assert.deepEqual(calls, []);
    assert.equal((await call(true)).status, 200); assert.deepEqual(calls[0], ["workspace", "child", input]);
    const conflict = await call(true); assert.equal(conflict.status, 409); assert.match((await conflict.json()).error, /stale hierarchy/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("actor_reparent schema requires hierarchy CAS fields and allows null parents", () => {
  const schema = DOMAIN_ACTOR_TOOLS.find(tool => tool.name === "actor_reparent")!.inputSchema;
  assert.deepEqual(schema.required, ["actorId", "parentActorId", "expectedParentActorId", "expectedRootActorId"]);
  assert.deepEqual(schema.properties.parentActorId, { type: ["string", "null"], minLength: 1 });
  assert.deepEqual(schema.properties.expectedParentActorId, { type: ["string", "null"], minLength: 1 });
  assert.equal(schema.additionalProperties, false);
});

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
  let reparentInput: unknown[] | undefined;
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
    reparentActor: async (...args: unknown[]) => { reparentInput = args; return { ok: true }; },
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
      { id: "rt_user", status: "done", created: "2026-10-27 11:40:00+00", userInput: "Should these actors merge?", requestMetadata: { roundtable: true, fromUser: true } },
      { id: "rt_next", status: "done", created: "2026-10-27 11:45:00+00", userInput: "Continue the discussion", requestMetadata: { roundtable: true } },
      { id: "turn", status: "running", created: "2026-10-27 12:30:00+00", requestMetadata: { message: "current", clientLayout: "desktop" } },
      { id: "queued", status: "todo", created: "2026-10-27 12:40:00+00", requestMetadata: { message: "queued later", clientLayout: "desktop" } }
    ],
    listSessionApprovalLiveItems: async () => ({ turn: [
      { itemType: "approval", method: USER_INPUT_METHOD, status: "resolved", answeredByUser: true, answerSubmittedAt: "2026-10-27 12:35:00+00",
        params: { questions: [{ id: "0", header: "Backend", question: "How to fix the backend?" }] }, decision: { answers: { "0": { answers: ["Open a separate task for the peer"] } } } },
      { itemType: "approval", method: USER_INPUT_METHOD, status: "resolved", answerSubmittedAt: "2026-10-27 12:36:00+00",
        params: { questions: [{ id: "0", header: "Forged", question: "Self-answered?" }] }, decision: { answers: { "0": { answers: ["Unattributed answer"] } } } }
    ] }),
    listSessionSteerMessages: async () => ({
      "user-followup": [{ id: "s0", content: "also check the cache", attachments: [], forcePlan: false, created: "2026-10-27 11:05:00+00", source: "user" }],
      turn: [
        { id: "s1", content: "why is this a concurrent session", attachments: [], forcePlan: false, created: "2026-10-27 12:34:00+00", source: "user" },
        { id: "s2", content: "Automation update", attachments: [], forcePlan: false, created: "2026-10-27 12:37:00+00", source: "automation" },
        { id: "s3", content: "Legacy blocker instruction", attachments: [], forcePlan: false, created: "2026-10-27 12:38:00+00" }
      ] }),
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
    const subReparent = await call({ action: "actor_reparent", sourceTurnId: "turn", actorId: "sub", callerActorId: "root", parentActorId: null, expectedParentActorId: "root", expectedRootActorId: "root" });
    assert.equal(subReparent.status, 400); assert.match((await subReparent.json()).error, /Only a root/); assert.equal(reparentInput, undefined);
    const outside = await call({ action: "actor_steer", sourceTurnId: "turn", sessionId: "outside-task", message: "hello", requestId: "r" });
    assert.equal(outside.status, 400); assert.match((await outside.json()).error, /own actor tree/);
    const wrongTurn = await call({ action: "actor_tree_status", sourceTurnId: "other-turn" });
    assert.equal(wrongTurn.status, 400); assert.match((await wrongTurn.json()).error, /bound running task/);
    const root = await fetch(`http://127.0.0.1:${address.port}/sessions/root-task/action`, { method: "POST",
      headers: { "Content-Type": "application/json", "x-threadex-actor-capability": rootToken }, body: JSON.stringify({ action: "actor_update_sub", sourceTurnId: "root-turn", actorId: "sub", name: "Updated" }) });
    assert.equal(root.status, 200); assert.equal(updated, 1);
    const hierarchy = { parentActorId: null, expectedParentActorId: "root", expectedRootActorId: "root" };
    const move = await fetch(`http://127.0.0.1:${address.port}/sessions/root-task/action`, { method: "POST",
      headers: { "Content-Type": "application/json", "x-threadex-actor-capability": rootToken },
      body: JSON.stringify({ action: "actor_reparent", sourceTurnId: "root-turn", actorId: "sub", callerActorId: "other", managementWorkItemId: "forged", ...hierarchy }) });
    assert.equal(move.status, 200); assert.deepEqual(reparentInput, ["workspace", "sub", hierarchy, "root", "work"]);
    const roster = await call({ action: "actor_list", sourceTurnId: "turn" });
    assert.equal(roster.status, 200); assert.equal((await roster.json()).actors.find((a: any) => a.id === "sub").rootActorId, "root");
    const createSub = await fetch(`http://127.0.0.1:${address.port}/sessions/root-task/action`, { method: "POST", headers: { "Content-Type": "application/json", "x-threadex-actor-capability": rootToken },
      body: JSON.stringify({ action: "actor_create_sub", sourceTurnId: "root-turn", name: "New", model: "gpt-6-luna", allowedModels: ["gpt-6-astra"], memory: {} }) });
    assert.equal(createSub.status, 200); assert.deepEqual(createdInput.allowedModelTiers, ["codex-luna"]); assert.equal(createdInput.parentActorId, "root");
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
    assert.equal(parallelInput.mode, undefined, "the service applies the hosted default");
    assert.equal(parallelInput.sourceTurnId, "turn", "the calling turn lets the host start the child in place");
    assert.equal((await call({ action: "actor_handoff", sourceTurnId: "turn", requestId: "handoff-session", mode: "session", ...handoffTask })).status, 200);
    assert.equal(parallelInput.mode, "session");
    initialActorTurn = false;
    const followupParallel = await call({ action: "actor_assign_many", sourceTurnId: "turn", requestId: "parallel-followup", tasks });
    assert.equal(followupParallel.status, 200);
    assert.equal(parallelInput.currentUserPrompt, "Please ask peer actors to work concurrently", "a genuine later user turn remains authorization evidence");
    const goHandoff = await call({ action: "actor_handoff", sourceTurnId: "turn", requestId: "handoff-go", ...handoffTask });
    assert.equal(goHandoff.status, 200);
    assert.deepEqual(parallelInput.priorUserPrompts, ["not updating logo on primo", "also check the cache", "Should these actors merge?"],
      "earlier direct user follow-ups, their steers and the user's own round table prompt count; the actor envelope, automation resumes, Next rounds and queued turns do not");
    assert.equal(parallelInput.currentUserPrompt, "Please ask peer actors to work concurrently");
    assert.deepEqual(parallelInput.currentTurnUserMessages, ["why is this a concurrent session", 'Answer to "How to fix the backend?": Open a separate task for the peer'],
      "the user's own steers and signed-in answers in this turn count; automation, legacy and unattributed inputs do not");
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
    const rootInput = { action: "actor_create_root", sourceTurnId: "turn", name: "BDD", model: "gpt-6-luna",
      parentActorId: "other", allowedModels: ["gpt-6-astra"], memory: { rolePrompt: "BDD", roleSummary: "BDD", longTerm: "", rolling: "" } };
    const createdBefore = created;
    assert.equal((await call({ ...rootInput, workspaceId: "outside" })).status, 400, "another workspace needs the user to name it");
    assert.equal(created, createdBefore);
    const createRoot = await call(rootInput);
    assert.equal(createRoot.status, 200);
    assert.equal(createdInput.parentActorId, null);
    assert.deepEqual(createdInput.allowedModelTiers, ["codex-luna"]);
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

test("a Claude host's in-place hosted handoff returns an Agent tool start with the child's marked, uncredentialed brief", async () => {
  const auth = new DomainActorAuth(capabilityStore());
  const token = await auth.issue("workspace", "s-host", "t-host");
  const actor = (id: string) => ({ id, name: id, rootActorId: id, parentActorId: null, effort: "high", allowedModels: ["claude-opus-5-5"],
    memory: { version: 1, rolePrompt: `${id} role`, roleSummary: id, longTerm: `${id} decisions`, rolling: "" } });
  const child = { id: "child", roundId: "r", ownerActorId: "host-actor", executorActorId: "docs-actor", allocationId: "handoff", model: "claude-opus-5-5",
    parentWorkItemId: "host", hostWorkItemId: "host", handoff: { sourceActorId: "host-actor", sourceSessionId: "s-host" }, delegatedTask: "Document the event",
    nativeAgent: { name: "actor_handoff_abc123", provider: "claude" }, taskSessionId: "s-host", taskTurnId: "t-host", status: "assigned", dispatched: true, executionHistory: [] };
  const room: any = { actors: [actor("host-actor"), actor("docs-actor")], rounds: [{ id: "r", userPrompt: "Add the event and its docs", actorSnapshots: [], replies: [] }],
    workItems: [{ id: "host", roundId: "r", ownerActorId: "host-actor", executorActorId: "host-actor", model: "claude-opus-5-5", taskSessionId: "s-host", taskTurnId: "t-host",
      status: "started", dispatched: true, executionHistory: [] }, child] };
  const service = { getRoom: async () => structuredClone(room), runningSessions: async () => [],
    delegateParallel: async () => ({ status: "assigned", workItems: [child], inPlaceTurnId: "t-host", note: "Hosted in place." }) } as unknown as DomainActorService;
  const sessions = {
    getSession: async (id: string) => ({ id, workspaceId: "workspace" }),
    getSessionTurn: async (id: string) => ({ id, sessionId: "s-host", status: "running", created: "2026-11-11 12:00:00+00", requestMetadata: { message: "Add the event and its docs" } }),
    listSessionTurns: async () => [], listSessionApprovalLiveItems: async () => ({}), listSessionSteerMessages: async () => ({})
  } as unknown as SessionStore;
  const app = express(); app.use(express.json());
  app.use(createDomainActorRouter(service, {} as DomainActorStore, sessions, {} as CollaborationService, auth));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/sessions/s-host/action`, { method: "POST",
      headers: { "Content-Type": "application/json", "x-threadex-actor-capability": token },
      body: JSON.stringify({ sourceTurnId: "t-host", action: "actor_handoff", requestId: "h", executorActorId: "docs-actor", task: "Document the event" }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.start.length, 1);
    const [start] = body.start;
    assert.deepEqual({ ...start, promptPrefix: undefined }, { subagent_type: "general-purpose", description: "docs-actor handoff", model: "opus", effort: "high",
      run_in_background: false, promptPrefix: undefined });
    assert.match(start.promptPrefix, /^\[threadex-actor-assignment:actor_handoff_abc123\]\nYou are domain actor docs-actor/);
    assert.match(start.promptPrefix, /docs-actor decisions/); assert.match(start.promptPrefix, /Do not call actor tools/);
    assert.match(body.note, /Agent tool with exactly subagent_type/);
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
  let reorganizeInput: any;
  const before = { ...room.actors[2], parentActorId: "host-actor", rootActorId: "host-actor" };
  const service = { getRoom: async () => structuredClone(room),
    reorganizeActorsAsActor: async (input: unknown) => { reorganizeInput = input; return { dryRun: true, reorganization: { id: "r1", requestId: "reorg",
      changes: [{ actorId: "other-actor", before, after: { ...before, parentActorId: null, rootActorId: "other-actor", memory: { ...before.memory, version: 2, rolePrompt: "New role" } } }] } }; }
  } as unknown as DomainActorService;
  const sessions = {
    getSession: async (id: string) => ({ id, workspaceId: "workspace" }),
    getSessionTurn: async (id: string) => ({ id, sessionId: "s-host", status: "running", requestMetadata: { message: "Promote other-actor", clientLayout: "desktop" } }),
    listSessionTurns: async () => [], listSessionApprovalLiveItems: async () => ({}), listSessionSteerMessages: async () => ({})
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
    const move = await call(tokens.child, { action: "actor_reparent", actorId: "child-actor", parentActorId: null, expectedParentActorId: null, expectedRootActorId: "child-actor" }, "child");
    assert.equal(move.status, 400); assert.match((await move.json()).error, /host session coordinates/);
    for (const body of [{ action: "actor_handoff", requestId: "h", executorActorId: "other-actor", task: "More" },
      { action: "actor_assign_many", requestId: "m", tasks: [{ executorActorId: "other-actor", task: "More" }] }]) {
      const delegation = await call(tokens.child, body, "child");
      assert.equal(delegation.status, 400); assert.match((await delegation.json()).error, /State in your result which actor is needed.*host session decides/);
    }
    const childPrompt = await call(tokens.child, { action: "actor_prompt_session", sessionId: "s-other", message: "Go" }, "child");
    assert.equal(childPrompt.status, 400); assert.match((await childPrompt.json()).error, /host session coordinates/);
    const selfPrompt = await call(tokens.host, { action: "actor_prompt_session", sessionId: "s-host", message: "Go" });
    assert.equal(selfPrompt.status, 400); assert.match((await selfPrompt.json()).error, /Prompt another session/);
    // No Decision gate: the service mock has no authorization method, so reaching it would fail.
    const otherPrompt = await call(tokens.host, { action: "actor_prompt_session", sessionId: "s-other", message: "Redo it" });
    assert.equal(otherPrompt.status, 200); assert.deepEqual(await otherPrompt.json(), { authorized: true, sessionId: "s-other", workspaceId: "workspace" });
    const reorganize = { action: "actor_reorganize", requestId: "reorg", reason: "Promote", dryRun: true,
      operations: [{ op: "move", actorId: "other-actor", parentActorId: null, expectedParentActorId: "host-actor" }] };
    const childReorganize = await call(tokens.child, reorganize, "child");
    assert.equal(childReorganize.status, 400); assert.match((await childReorganize.json()).error, /host session coordinates/);
    const childPeerMemory = await call(tokens.child, { ...memory, actorId: "other-actor" }, "child");
    assert.equal(childPeerMemory.status, 400); assert.match((await childPeerMemory.json()).error, /only their own memory/);
    const peerMemory = await call(tokens.host, { ...memory, actorId: "other-actor" });
    assert.equal(peerMemory.status, 200); assert.deepEqual(await peerMemory.json(), { actorId: "other-actor", version: 1, field: "rolePrompt", text: "other-actor role", offset: 0, nextOffset: 16, totalChars: 16 });
    const preview = await call(tokens.host, reorganize);
    assert.equal(preview.status, 200);
    assert.deepEqual(await preview.json(), { dryRun: true, reorganizationId: "r1", requestId: "reorg", applied: false, changes: [{ actorId: "other-actor", name: "other-actor",
      before: { parentActorId: "host-actor", rootActorId: "host-actor" }, after: { parentActorId: null, rootActorId: "other-actor" },
      memory: { fromVersion: 1, toVersion: 2, fields: ["rolePrompt"] } }] }, "the result is compact and omits memory text");
    assert.deepEqual({ workItemId: reorganizeInput.workItemId, actorId: reorganizeInput.actorId, sessionId: reorganizeInput.sessionId, turnId: reorganizeInput.turnId,
      currentUserPrompt: reorganizeInput.currentUserPrompt }, { workItemId: "host", actorId: "host-actor", sessionId: "s-host", turnId: "t-host", currentUserPrompt: undefined },
      "the task's initial turn is a system envelope; its user request comes from the work's canonical messages");
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
      { id: "w2", ownerActorId: "root", executorActorId: "root", status: "failed" }
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
  const sessions = { getSession: async (id: string) => {
    requested.push(`session:${id}`);
    if (id === "task") return { id, title: "Update the sidebar" };
    return id === "s-titled" ? { id, title: "Fix the build" } : null;
  } } as unknown as SessionStore;
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
    assert.deepEqual(requested, ["room:workspace", "running:workspace", "session:s-untitled", "session:s-titled", "session:task", "projects:workspace"]);
    assert.deepEqual(body, { workspaceId: "workspace", revision: 3, groups: [
      { key: "p", projectId: "p", name: "Project", registered: true, actorIds: [] },
      { key: "unassigned", projectId: null, name: "Unassigned", registered: true, actorIds: ["root"] }
    ], actors: [
      { type: "worker", id: "root", name: "Root", rootActorId: "root", parentActorId: null, model: "gpt-6-luna", counts: { open: 1, attention: 1 }, running: 0, runningSessions: [], unreadConclusions: 0 },
      { type: "worker", id: "sub", name: "Sub", rootActorId: "root", parentActorId: "root", model: "gpt-6-astra", counts: { open: 1, attention: 0 }, running: 1, runningSessions: [{ sessionId: "task", title: "Update the sidebar" }], unreadConclusions: 0 }
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

test("another workspace's actors are listed and handed work only when one of the task's user messages names them", async () => {
  const auth = new DomainActorAuth(capabilityStore());
  const tokens: Record<string, string> = { "turn": await auth.issue("workspace", "task", "turn"), "initial-turn": await auth.issue("workspace", "task", "initial-turn") };
  const actor = (id: string, name: string) => ({ id, name, rootActorId: id, parentActorId: null, allowedModels: ["gpt-6-luna"], memory: { roleSummary: `${name} role` } });
  const rooms: Record<string, any> = {
    workspace: { workspaceId: "workspace", rounds: [{ id: "round", userPrompt: "Original request", created: "2026-11-03T08:00:00Z" }],
      actors: [actor("src", "初音未來 · Actors協作")], taskUpdates: [],
      workItems: [{ id: "work", roundId: "round", executorActorId: "src", taskSessionId: "task", taskTurnId: "initial-turn", executionHistory: [] }] },
    default: { workspaceId: "default", actors: [actor("devenv", "貓貓 · dev-env"), actor("hub", "Hub owner")] },
    third: { workspaceId: "third", actors: [actor("third-actor", "Third worker")] }
  };
  let turn: any = { id: "turn", requestMetadata: { message: "fix it", clientLayout: "desktop" } };
  let earlier: any[] = [];
  let steers: Record<string, any[]> = {};
  let approvals: Record<string, unknown[]> = {};
  const handoffs: any[] = []; const sameWorkspace: any[] = [];
  const service = { getRoom: async (id: string) => rooms[id],
    handoffAcrossWorkspaces: async (input: unknown) => { handoffs.push(input); return { status: "submitted", crossWorkspace: true }; },
    delegateParallel: async (input: unknown) => { sameWorkspace.push(input); return { status: "assigned", workItems: [] }; } } as unknown as DomainActorService;
  const workspaces = [{ id: "workspace", name: "Threadex" }, { id: "default", name: "Fairshot" }, { id: "third", name: "Third" }];
  const sessions = {
    getSession: async (id: string) => ({ id, workspaceId: "workspace" }),
    getSessionTurn: async (id: string) => ({ sessionId: "task", status: "running", created: "2026-11-03 11:00:00+00", ...turn, id }),
    listSessionTurns: async () => earlier,
    listSessionApprovalLiveItems: async () => approvals, listSessionSteerMessages: async () => steers,
    listWorkspaces: async () => workspaces, getWorkspace: async (id: string) => workspaces.find(workspace => workspace.id === id) ?? null
  } as unknown as SessionStore;
  const app = express(); app.use(express.json());
  app.use(createDomainActorRouter(service, { getRoom: async (id: string) => rooms[id] } as unknown as DomainActorStore, sessions, {} as CollaborationService, auth));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const call = async (body: { sourceTurnId?: string } & Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/sessions/task/action`, { method: "POST",
      headers: { "Content-Type": "application/json", "x-threadex-actor-capability": tokens[body.sourceTurnId ?? "turn"] }, body: JSON.stringify({ sourceTurnId: "turn", ...body }) });
    return { status: response.status, body: await response.json() };
  };
  const ids = (result: { body: { actors: Array<{ id: string }> } }) => result.body.actors.map(entry => entry.id);
  const handoff = { action: "actor_handoff", requestId: "xws", executorActorId: "devenv", task: "貓貓 must create the bucket; the user approved it", workspaceId: "default" };
  try {
    // Same workspace: unchanged roster without workspace fields, and handoff keeps the existing path.
    const own = await call({ action: "actor_list" });
    assert.equal(own.status, 200); assert.deepEqual(own.body.actors.map((entry: object) => Object.keys(entry)), [["type", "id", "name", "parentActorId", "rootActorId", "roleSummary"]]);
    assert.equal((await call({ action: "actor_list", workspaceId: "workspace" })).status, 200);
    assert.equal((await call({ action: "actor_handoff", requestId: "local", executorActorId: "src", task: "x" })).status, 200);
    assert.equal(sameWorkspace.length, 1); assert.equal(handoffs.length, 0);

    // No explicit request: denied with the reason; the actor-written task naming the target does not count.
    for (const body of [{ action: "actor_list", allWorkspaces: true }, { action: "actor_list", workspaceId: "default" }, handoff]) {
      const denied = await call(body);
      assert.equal(denied.status, 400); assert.match(denied.body.error, /user's own messages in this task/);
    }
    assert.equal(handoffs.length, 0);

    // An actor-written resume turn or memory never authorizes.
    turn = { id: "turn", requestMetadata: { message: "[resume] ask 貓貓 in Fairshot" } };
    assert.equal((await call({ action: "actor_list", allWorkspaces: true })).status, 400);
    assert.equal((await call(handoff)).status, 400);
    assert.equal(handoffs.length, 0);

    // The user named the actor in an earlier turn of this task and confirms now: only that actor is found, wherever it lives.
    earlier = [{ id: "old", status: "done", created: "2026-11-03 10:00:00+00", requestMetadata: { message: "你 prompt 到 dev-env 負責人做嗎？貓貓", clientLayout: "desktop" } }];
    turn = { id: "turn", requestMetadata: { message: "係，去做", clientLayout: "desktop" } };
    const found = await call({ action: "actor_list", allWorkspaces: true });
    assert.equal(found.status, 200); assert.deepEqual(ids(found), ["devenv"]);
    assert.deepEqual({ ...found.body.actors[0], roleSummary: undefined }, { type: "worker", id: "devenv", name: "貓貓 · dev-env", parentActorId: null, rootActorId: "devenv",
      roleSummary: undefined, workspaceId: "default", workspaceName: "Fairshot", crossWorkspace: true });
    assert.equal((await call({ action: "actor_list", workspaceId: "third" })).status, 400, "naming one actor does not open another workspace");
    assert.equal((await call({ ...handoff, mode: "hosted" })).status, 400, "a hosted child would run with the source session's binding");
    const sent = await call(handoff);
    assert.equal(sent.status, 200);
    assert.deepEqual(handoffs.at(-1), { workspaceId: "workspace", workspaceName: "Threadex", workItemId: "work", sourceActorId: "src", sourceSessionId: "task", sourceTurnId: "turn",
      userMessages: ["Original request", "你 prompt 到 dev-env 負責人做嗎？貓貓", "係，去做"].map(text => ({ text })),
      requestId: "xws", targetWorkspaceId: "default", targetWorkspaceName: "Fairshot", targetActorId: "devenv", task: handoff.task });
    assert.equal((await call({ ...handoff, executorActorId: "hub", requestId: "hub" })).status, 400, "only the named actor of that workspace");

    const historicalAuthorization = "請叫貓貓補 dev-env 嘅 bucket";
    const generatedRound = "Actor prepared brief naming Third";
    const generatedSnapshot = "Nested work envelope naming Third";
    const generatedTurn = "Inter-actor prompt naming Third";
    rooms.workspace.rounds[0].contextRoundIds = ["historical", "generated"];
    rooms.workspace.rounds.push({ id: "historical", userPrompt: historicalAuthorization, created: "2026-11-03T07:00:00Z" },
      { id: "generated", userPrompt: generatedRound, sessionOrigin: {}, created: "2026-11-03T07:30:00Z" });
    rooms.workspace.rounds.push({ id: "continuation", userPrompt: "Keep the existing bucket labels", continuation: { workItem: { id: "work" } } },
      { id: "other-continuation", userPrompt: "Send it to Third", continuation: { workItem: { id: "another-work" } } });
    rooms.workspace.workItems[0].canonicalUserMessages = [historicalAuthorization, generatedRound, generatedSnapshot, "Original request"];
    earlier = [
      { id: "handoff-envelope", status: "done", created: "2026-11-03T10:00:00Z",
        requestMetadata: { message: generatedTurn, clientLayout: "desktop", promptOrigin: { kind: "inter-actor", trigger: "handoff" } } },
      { id: actorFollowupTurnId("workspace", "work", "edit"), status: "done", created: "2026-11-03T10:01:00Z" },
      { id: actorFollowupTurnId("workspace", "work", "reuse:continuation"), status: "done", created: "2026-11-03T10:02:00Z" },
      { id: actorFollowupTurnId("workspace", "work", "reuse:other-continuation"), status: "done", created: "2026-11-03T10:03:00Z" },
      { id: actorFollowupTurnId("workspace", "work", "queued"), status: "todo", created: "2026-11-03T10:30:00Z" }
    ];
    rooms.workspace.taskUpdates.push(
      { status: "delivered", workItemId: "work", requestId: "edit", userPrompt: "Keep the existing bucket permissions" },
      { status: "delivered", workItemId: "work", requestId: "reuse:continuation", userPrompt: "Actor-made continuation naming Third" },
      { status: "delivered", workItemId: "work", requestId: "reuse:other-continuation", userPrompt: "Actor-made continuation naming Third" },
      { status: "delivered", workItemId: "work", requestId: "queued", userPrompt: "Send it to Third" }
    );
    turn = { id: "turn", requestMetadata: { message: "Use alpha", clientLayout: "desktop" } };
    steers = { turn: [
      { id: "s1", source: "automation", content: "Send it to Third", created: "2026-11-03T11:01:00Z", attachments: [] },
      { id: "s2", source: "user", content: "Correction: use beta", created: "2026-11-03T11:02:00Z", attachments: [] },
      { id: "s3", source: "user", content: "Use alpha", created: "2026-11-03T11:03:00Z", attachments: [] }
    ] };
    approvals = { turn: [{ itemType: "approval", method: USER_INPUT_METHOD, status: "resolved", answeredByUser: true, answerSubmittedAt: "2026-11-03T11:02:30Z",
      params: { questions: [{ id: "0", header: "People", question: "Also send it to Third?" }] }, decision: { answers: { "0": { answers: ["No"] } } } }] };
    assert.equal((await call({ action: "actor_list", workspaceId: "third" })).status, 400, "generated source material cannot grant cross-workspace access");
    assert.equal((await call({ ...handoff, requestId: "source-evidence" })).status, 200);
    assert.deepEqual(handoffs.at(-1).userMessages, [
      ...[historicalAuthorization, "Original request", "Keep the existing bucket permissions", "Keep the existing bucket labels", "Use alpha", "Correction: use beta"].map(text => ({ text })),
      { text: "No", question: "Also send it to Third?" }, { text: "Use alpha" }
    ]);
    steers = {};
    approvals = {};

    // A workspace named by link opens its whole roster; an ASCII name inside a longer word does not.
    turn = { id: "turn", requestMetadata: { message: "see threadex://default/tx_123 and ask them", clientLayout: "desktop" } };
    assert.deepEqual(ids(await call({ action: "actor_list", workspaceId: "default" })), ["devenv", "hub"]);
    turn = { id: "turn", requestMetadata: { message: "the thirdparty lib is broken", clientLayout: "desktop" } };
    assert.equal((await call({ action: "actor_list", workspaceId: "third" })).status, 400);

    // The task's first turn reads the Actors-room request that started it.
    earlier = [];
    rooms.workspace.rounds[0].userPrompt = "Original request in threadex://default/tx_abc";
    turn = { id: "initial-turn", requestMetadata: { message: "actor envelope naming Third" } };
    assert.deepEqual(ids(await call({ action: "actor_list", allWorkspaces: true, sourceTurnId: "initial-turn" })), ["devenv", "hub"]);
    rooms.workspace.rounds[0].crossWorkspaceOrigin = { task: "source actor's description naming Third" };
    rooms.workspace.rounds[0].contextRoundIds = [];
    assert.equal((await call({ action: "actor_list", workspaceId: "default", sourceTurnId: "initial-turn" })).status, 400,
      "an inbound legacy envelope cannot authorize another handoff");
    const scopedInboundMessages = ["Original request in threadex://default/tx_abc", "Follow-up needed to complete this same task"];
    rooms.workspace.rounds[0].userPrompt = scopedInboundMessages.join("\n\n");
    rooms.workspace.rounds[0].crossWorkspaceOrigin.userMessages = scopedInboundMessages;
    assert.deepEqual(ids(await call({ action: "actor_list", allWorkspaces: true, sourceTurnId: "initial-turn" })), ["devenv", "hub"],
      "a new inbound handoff can use verified user messages to authorize a named destination");
    assert.equal((await call({ ...handoff, requestId: "chained", sourceTurnId: "initial-turn" })).status, 200);
    assert.deepEqual(handoffs.at(-1).userMessages, scopedInboundMessages.map(text => ({ text })));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("an ordinary task reads the actor registry and reaches another workspace's memory and roots only as its user names them", async () => {
  const auth = new DomainActorAuth(capabilityStore());
  const token = await auth.issue("default", "plain", "turn");
  const actor = (id: string, name: string) => ({ id, name, rootActorId: id, parentActorId: null, allowedModels: ["gpt-6-luna"],
    memory: { version: 3, rolePrompt: `${name} role`, roleSummary: `${name} summary`, longTerm: `${name} fairshot-hub use cases`, rolling: "" } });
  const rooms: Record<string, any> = {
    default: { workspaceId: "default", rounds: [], taskUpdates: [], workItems: [], actors: [actor("hub", "Hub owner")] },
    threadex: { workspaceId: "threadex", rounds: [], taskUpdates: [], workItems: [], actors: [actor("rem", "雷姆 · BDD"), actor("other", "Other worker")] }
  };
  let turn: any = { id: "turn", model: "gpt-6-astra", requestMetadata: { message: "list the actors", clientLayout: "desktop" } };
  const created: any[] = [];
  const service = { getRoom: async (id: string) => rooms[id],
    createActor: async (workspaceId: string, input: any) => { created.push({ workspaceId, ...input }); return { id: "new", ...input }; } } as unknown as DomainActorService;
  const workspaces = [{ id: "default", name: "Default" }, { id: "threadex", name: "Threadex" }];
  const sessions = {
    getSession: async (id: string) => ({ id, workspaceId: "default" }),
    getSessionTurn: async (id: string) => ({ sessionId: "plain", status: "running", created: "2026-11-04 14:34:00+00", ...turn, id }),
    listSessionTurns: async () => [], listSessionApprovalLiveItems: async () => ({}), listSessionSteerMessages: async () => ({}),
    listWorkspaces: async () => workspaces, getWorkspace: async (id: string) => workspaces.find(workspace => workspace.id === id) ?? null
  } as unknown as SessionStore;
  const app = express(); app.use(express.json());
  app.use(createDomainActorRouter(service, { getRoom: async (id: string) => rooms[id] } as unknown as DomainActorStore, sessions, {} as CollaborationService, auth));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const call = async (body: Record<string, unknown>, capability = token) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/sessions/plain/action`, { method: "POST",
      headers: { "Content-Type": "application/json", "x-threadex-actor-capability": capability }, body: JSON.stringify({ sourceTurnId: "turn", ...body }) });
    return { status: response.status, body: await response.json() };
  };
  const memory = { rolePrompt: "ABC role", roleSummary: "ABC summary", longTerm: "copied", rolling: "" };
  try {
    // Its own workspace is always readable; actor tools and a forged capability stay closed.
    const own = await call({ action: "actor_list" });
    assert.equal(own.status, 200); assert.deepEqual(own.body.actors.map((entry: { id: string }) => entry.id), ["hub"]);
    assert.equal((await call({ action: "actor_list" }, "0".repeat(64))).status, 400);
    assert.match((await call({ action: "actor_tree_status" })).body.error, /no system-owned actor binding/);
    assert.match((await call({ action: "actor_read_memory", field: "longTerm" })).body.error, /actorId/);
    assert.equal((await call({ action: "actor_read_memory", field: "longTerm", actorId: "hub" })).body.text, "Hub owner fairshot-hub use cases");

    // Unnamed: another workspace's roster, memory and creation are refused.
    for (const body of [{ action: "actor_list", allWorkspaces: true }, { action: "actor_read_memory", field: "longTerm", actorId: "rem", workspaceId: "threadex" },
      { action: "actor_create_root", name: "ABC", model: "gpt-6-luna", memory, workspaceId: "threadex" }]) {
      const denied = await call(body);
      assert.equal(denied.status, 400); assert.match(denied.body.error, /user's own messages in this task/);
    }

    // The user's own message names the actor: its memory is readable, but creating there needs the workspace itself named.
    turn = { ...turn, requestMetadata: { message: "係 default 建 ABC use case 負責人，clone 雷姆 嘅 mem", clientLayout: "desktop" } };
    assert.deepEqual((await call({ action: "actor_list", allWorkspaces: true })).body.actors.map((entry: { id: string }) => entry.id), ["rem"]);
    const read = await call({ action: "actor_read_memory", field: "longTerm", actorId: "rem", workspaceId: "threadex" });
    assert.equal(read.status, 200);
    assert.deepEqual({ actorId: read.body.actorId, workspaceId: read.body.workspaceId, version: read.body.version, text: read.body.text },
      { actorId: "rem", workspaceId: "threadex", version: 3, text: "雷姆 · BDD fairshot-hub use cases" });
    assert.equal((await call({ action: "actor_read_memory", field: "longTerm", actorId: "other", workspaceId: "threadex" })).status, 400);
    assert.equal((await call({ action: "actor_create_root", name: "ABC", model: "gpt-6-luna", memory, workspaceId: "threadex" })).status, 400);
    assert.equal((await call({ action: "actor_create_root", name: "ABC", model: "gpt-6-luna", memory })).status, 200);
    assert.deepEqual(created, [{ workspaceId: "default", name: "ABC", model: "gpt-6-luna", parentActorId: null, memory, allowedModelTiers: null }]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("an actor task reads another workspace's memory and creates a root there only when the user names it", async () => {
  const auth = new DomainActorAuth(capabilityStore());
  const token = await auth.issue("threadex", "task", "turn");
  const actor = (id: string, name: string) => ({ id, name, rootActorId: id, parentActorId: null, allowedModels: ["gpt-6-luna", "gpt-6-astra"],
    memory: { version: 1, rolePrompt: "", roleSummary: "", longTerm: `${name} memory`, rolling: "" } });
  const rooms: Record<string, any> = {
    threadex: { workspaceId: "threadex", rounds: [{ id: "round", userPrompt: "Original request" }], taskUpdates: [], actors: [actor("src", "初音未來 · Actors協作")],
      workItems: [{ id: "work", roundId: "round", executorActorId: "src", taskSessionId: "task", taskTurnId: "initial-turn", model: "gpt-6-astra", executionHistory: [] }] },
    default: { workspaceId: "default", actors: [actor("hub", "Hub owner")] }
  };
  let turn: any = { id: "turn", requestMetadata: { message: "copy memory", clientLayout: "desktop" } };
  const created: any[] = [];
  const service = { getRoom: async (id: string) => rooms[id],
    createActor: async (workspaceId: string, input: any) => { created.push({ workspaceId, ...input }); return { id: "new" }; } } as unknown as DomainActorService;
  const workspaces = [{ id: "threadex", name: "Threadex" }, { id: "default", name: "Default" }];
  const sessions = {
    getSession: async (id: string) => ({ id, workspaceId: "threadex" }),
    getSessionTurn: async (id: string) => ({ sessionId: "task", status: "running", created: "2026-11-04 14:00:00+00", ...turn, id }),
    listSessionTurns: async () => [], listSessionApprovalLiveItems: async () => ({}), listSessionSteerMessages: async () => ({}),
    listWorkspaces: async () => workspaces, getWorkspace: async (id: string) => workspaces.find(workspace => workspace.id === id) ?? null
  } as unknown as SessionStore;
  const app = express(); app.use(express.json());
  app.use(createDomainActorRouter(service, { getRoom: async (id: string) => rooms[id] } as unknown as DomainActorStore, sessions, {} as CollaborationService, auth));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const call = async (body: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/sessions/task/action`, { method: "POST",
      headers: { "Content-Type": "application/json", "x-threadex-actor-capability": token }, body: JSON.stringify({ sourceTurnId: "turn", ...body }) });
    return { status: response.status, body: await response.json() };
  };
  const memory = { rolePrompt: "role", roleSummary: "summary", longTerm: "", rolling: "" };
  const create = { action: "actor_create_root", name: "ABC", model: "gpt-6-luna", memory, workspaceId: "default" };
  try {
    assert.equal((await call({ action: "actor_read_memory", field: "longTerm" })).body.text, "初音未來 · Actors協作 memory");
    assert.equal((await call({ action: "actor_read_memory", field: "longTerm", actorId: "hub", workspaceId: "default" })).status, 400);
    assert.equal((await call(create)).status, 400);
    assert.equal(created.length, 0);
    turn = { ...turn, requestMetadata: { message: "喺 Default workspace 建 ABC", clientLayout: "desktop" } };
    assert.equal((await call({ action: "actor_read_memory", field: "longTerm", actorId: "hub", workspaceId: "default" })).body.text, "Hub owner memory");
    assert.equal((await call(create)).status, 200);
    assert.deepEqual(created, [{ workspaceId: "default", name: "ABC", model: "gpt-6-luna", parentActorId: null, memory, allowedModelTiers: ["codex-luna", "codex-astra"] }]);
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
