import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { SessionStore } from "./sessionStore";
import { DomainActorStore } from "./domainActorStore";
import { MODEL_CATALOG } from "../modelCatalog";
import type { ActorWorkItem } from "../domainActors";
import type { SessionDbConnection, SessionDbValue } from "./sessionDb";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function observeLockQuery(connection: SessionDbConnection, attempted: ReturnType<typeof deferred>) {
  return Object.assign(Object.create(connection) as SessionDbConnection, {
    run: (sql: string, params?: Record<string, SessionDbValue>) => {
      const query = connection.run(sql, params);
      if (sql.includes("FROM actor_room") && sql.includes("FOR UPDATE")) attempted.resolve();
      return query;
    }
  });
}
async function fixture() {
  if (process.env.SESSION_PG_SCHEMA) throw new Error("Requires an isolated generated schema.");
  const path = `/private/tmp/actor-lifecycle-${randomUUID()}`;
  const first = new SessionStore(path), second = new SessionStore(path);
  await Promise.all([first.ready(), second.ready()]);
  const actors = new DomainActorStore(first), otherActors = new DomainActorStore(second);
  for (const id of ["owner", "executor", "historical"]) await actors.create("default", {
    id, name: id, model: MODEL_CATALOG.luna.id,
    memory: { rolePrompt: "Fixture", roleSummary: "Fixture", longTerm: "", rolling: "" }
  });
  for (const id of ["current-session", "history-session", "ordinary-session"]) await first.upsertSession({
    id, workspaceId: "default", cwd: "/private/tmp", title: id
  });
  const work: ActorWorkItem = { id: "work", roundId: "historical-round", ownerActorId: "owner", executorActorId: "executor", model: MODEL_CATALOG.luna.id,
    dispatchKey: "dispatch", taskSessionId: "current-session", taskTurnId: "original-turn", status: "completed", dispatchError: null,
    created: "2020-01-01T00:00:00Z", updated: "2020-01-01T00:00:00Z", dispatched: true, dispatchLease: null, executionRevision: 1,
    executionHistory: [{ executorActorId: "historical", model: MODEL_CATALOG.luna.id, taskSessionId: "history-session", taskTurnId: "old-turn", dispatchKey: "old", dispatched: true, status: "completed" }], assignmentRequests: [] };
  await first.changeDomainActorRoom("default", room => { room.workItems.push(work); });
  const turn = (id: string, sessionId = "current-session") => ({ id, sessionId, userInput: "Fixture", agentResponse: "", tokenIn: 0, tokenOut: 0, status: "running" as const });
  return { path, first, second, actors, otherActors, turn, close: () => Promise.all([first.close(), second.close()]) };
}

test("actor admission holding the lifecycle row lock commits before deletion rechecks live sessions", async () => {
  const h = await fixture(); const locked = deferred(), release = deferred(), deletionAttempted = deferred();
  const internal = h.first as any;
  const original = internal.lockActorTurnAdmission.bind(h.first);
  internal.lockActorTurnAdmission = async (...args: unknown[]) => { await original(...args); locked.resolve(); await release.promise; };
  const deleting = h.second as any;
  const originalTransaction = deleting.actorLifecycleTransaction.bind(h.second);
  deleting.actorLifecycleTransaction = (sessionId: string | null, operation: (connection: SessionDbConnection) => Promise<unknown>, turnId?: string) =>
    originalTransaction(sessionId, (connection: SessionDbConnection) => operation(observeLockQuery(connection, deletionAttempted)), turnId);
  try {
    const admission = h.first.recordSessionTurn(h.turn("live")); await locked.promise;
    const deletion = h.otherActors.delete("default", "owner");
    const rejected = assert.rejects(deletion, /running task or follow-up/);
    await deletionAttempted.promise;
    release.resolve(); await admission; await rejected;
    assert.ok((await h.first.getDomainActorRoom("default")).actors.some(actor => actor.id === "owner"));
  } finally { release.resolve(); await h.close(); }
});

test("deletion holding the lifecycle row lock prevents follow-up admission across stores and rolls back failures", async () => {
  const h = await fixture(); const locked = deferred(), release = deferred(), admissionAttempted = deferred();
  const ordinaryStore = new SessionStore(h.path); await ordinaryStore.ready();
  const internal = h.first as any;
  const original = internal.actorRunningSessionsWithConnection.bind(h.first);
  internal.actorRunningSessionsWithConnection = async (...args: unknown[]) => { const result = await original(...args); locked.resolve(); await release.promise; return result; };
  const admitting = h.second as any;
  const originalAdmission = admitting.lockActorTurnAdmission.bind(h.second);
  admitting.lockActorTurnAdmission = (connection: SessionDbConnection, ...args: unknown[]) => originalAdmission(observeLockQuery(connection, admissionAttempted), ...args);
  try {
    const before = (await h.first.getDomainActorRoom("default")).workItems;
    const deletion = h.actors.delete("default", "owner"); await locked.promise;
    let settled = false;
    const admission = h.second.recordSessionTurn(h.turn("refused")).then(
      () => { settled = true; return null; }, error => { settled = true; return error as Error; });
    await admissionAttempted.promise;
    // An unrelated session must commit while deletion still holds this workspace's room lock.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ordinary = ordinaryStore.recordSessionTurn(h.turn("ordinary", "ordinary-session"));
      assert.equal(await Promise.race([ordinary.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2000); })]), true,
        "unbound admission waited for the actor deletion lock");
    } finally { if (timer) clearTimeout(timer); }
    assert.equal(settled, false, "bound admission must wait while the lifecycle row is locked");
    release.resolve(); await deletion; assert.match((await admission)?.message ?? "", /deleted worker/);
    assert.equal(await h.first.getSessionTurn("refused"), null);
    await assert.rejects(h.second.claimSessionTurn(h.turn("claim-refused")), /deleted worker/);
    assert.deepEqual((await h.first.getDomainActorRoom("default")).workItems, before);
    assert.ok(await h.first.getSession("current-session"));
    assert.equal((await h.first.getSessionTurn("ordinary"))?.status, "running");
  } finally { release.resolve(); await Promise.all([h.close(), ordinaryStore.close()]); }
});

test("deleted historical executors cannot queue, retry, reopen or stage work in their saved session", async () => {
  const h = await fixture();
  try {
    await h.first.recordSessionTurn({ ...h.turn("stopped", "history-session"), status: "todo", pendingReason: "stopped" });
    await h.actors.delete("default", "historical");
    await assert.rejects(h.second.recordSessionTurn({ ...h.turn("queued", "history-session"), status: "todo", pendingReason: "queued" }), /deleted worker/);
    await assert.rejects(h.second.claimPendingSessionTurn("stopped", "history-session"), /deleted worker/);
    await assert.rejects(h.second.updateSessionTurn({ id: "stopped", agentResponse: "retry", tokenIn: 0, tokenOut: 0, status: "running" }), /deleted worker/);
    await assert.rejects(h.second.updateSessionTurn({ id: "stopped", agentResponse: "retry", tokenIn: 0, tokenOut: 0, status: "todo", pendingReason: "queued" }), /deleted worker/);
    await assert.rejects(h.second.reserveWorkspaceManagerQueuedPromptFork({ turnId: "stage", sessionId: "history-session", workspaceId: "default", managerSessionId: "history-session", requestId: "stage", staged: { message: "work", attachmentKey: "fixture", requestMetadata: {} } }), /deleted worker/);
    assert.equal((await h.first.getSessionTurn("stopped"))?.pendingReason, "stopped");
    assert.equal(await h.first.getSessionTurn("stage"), null);
    // Terminal writes and stored history remain usable after deletion.
    await h.second.updateSessionTurn({ id: "stopped", agentResponse: "history", tokenIn: 0, tokenOut: 0, status: "done" });
    assert.equal((await h.first.getSessionTurn("stopped"))?.agentResponse, "history");
    await h.second.recordSessionTurn({ ...h.turn("historical-copy", "history-session"), status: "done" });
  } finally { await h.close(); }
});

test("pending loop continuation blocks deletion until explicitly ended; failed deletion preserves registry", async () => {
  const h = await fixture();
  try {
    await h.first.recordSessionTurn(h.turn("loop-root")); await h.first.enableTurnLoopMode("loop-root");
    await h.first.updateSessionTurn({ id: "loop-root", agentResponse: "result", tokenIn: 0, tokenOut: 0, status: "done", runnerExitCode: 0 });
    assert.ok(await h.first.getLoopContinuation("loop-root"));
    await assert.rejects(h.otherActors.delete("default", "executor"), /running task or follow-up/);
    assert.ok((await h.first.getDomainActorRoom("default")).actors.some(actor => actor.id === "executor"));
    await h.first.finishLoopContinuation("loop-root"); await h.otherActors.delete("default", "executor");
    await assert.rejects(h.first.claimSessionTurn(h.turn("late-loop")), /deleted worker/);
  } finally { await h.close(); }
});

test("ordinary sessions keep one writer and a busy pending claim remains recoverable", async () => {
  const h = await fixture();
  try {
    const claims = await Promise.all([h.first.claimSessionTurn(h.turn("one", "ordinary-session")), h.second.claimSessionTurn({ ...h.turn("two", "ordinary-session"), userInput: "Different" })]);
    assert.equal(claims.filter(claim => claim.disposition === "started").length, 1);
    const queued = claims.find(claim => claim.disposition === "queued")!; assert.ok(queued);
    assert.equal((await h.second.claimPendingSessionTurn(queued.turn.id, "ordinary-session")).disposition, "blocked");
    assert.ok(await h.second.getSessionTurn(queued.turn.id));
  } finally { await h.close(); }
});
