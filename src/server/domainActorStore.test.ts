import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { SessionStore } from "./sessionStore";
import { DomainActorStore } from "./domainActorStore";
import { MODEL_CATALOG } from "../modelCatalog";
import { actorConclusionFlow } from "./testFixtures/actorConclusionFlow";
import { actorSummary } from "./domainActorSummary";

test("published conclusions and exact Ack survive database reopen and concurrent consumers", async () => {
  if (process.env.SESSION_PG_SCHEMA) throw new Error("Requires an isolated generated schema; unset SESSION_PG_SCHEMA.");
  const id = `/private/tmp/actor-conclusions-${randomUUID()}`;
  const first = new SessionStore(id), second = new SessionStore(id);
  let conclusionId = "";
  try {
    await Promise.all([first.ready(), second.ready()]);
    const flow = actorConclusionFlow("default"); await flow.complete(); await flow.finish();
    const seed = await flow.store.getRoom("default");
    // Existing producer-only rooms have approved reviews but no consumed dialog history.
    delete seed.conclusions;
    await first.changeDomainActorRoom("default", room => Object.assign(room, seed));
    const consumers = [new DomainActorStore(first), new DomainActorStore(second)];
    await Promise.all(consumers.map(consumer => consumer.getRoom("default")));
    const published = await consumers[0].getRoom("default");
    assert.equal(published.conclusions!.length, 1);
    conclusionId = published.conclusions![0].id;
    await Promise.all(consumers.map(consumer => consumer.acknowledgeConclusion("default", "sub-1", conclusionId)));
    await consumers[0].change("default", room => { room.workItems[0].status = "started"; room.workItems[0].activeTurnId = "next-turn"; });
  } finally { await Promise.all([first.close(), second.close()]); }
  const reopened = new SessionStore(id);
  try {
    await reopened.ready();
    const room = await new DomainActorStore(reopened).getRoom("default");
    assert.equal(room.conclusions!.length, 1);
    assert.equal(room.conclusions![0].id, conclusionId);
    assert.ok(room.conclusions![0].acknowledgedAt);
    assert.equal(room.conclusions![0].text, "Verified conclusion for turn");
    assert.equal(actorSummary(room, []).actors.find(actor => actor.id === "sub-1")!.unreadConclusions, 0);
  } finally { await reopened.close(); }
});

test("actor room CAS, baseline and memory event dedupe survive database reopen across connections", async () => {
  if (process.env.SESSION_PG_SCHEMA) throw new Error("Requires an isolated generated schema; unset SESSION_PG_SCHEMA.");
  const id = `/private/tmp/actor-room-${randomUUID()}`;
  const first = new SessionStore(id);
  const second = new SessionStore(id);
  const memory = { rolePrompt: "Role", roleSummary: "Summary", longTerm: "Knowledge", rolling: "Recent" };
  try {
    await Promise.all([first.ready(), second.ready()]);
    const actors = new DomainActorStore(first);
    await first.recordTokenUsage([{ id: "baseline", usageType: "agent", source: "test", workspaceId: "default", model: MODEL_CATALOG.luna.id,
      inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, reasoningOutputTokens: 1, totalTokens: 15, modelContextWindow: 100_000 }]);
    await first.upsertSession({ id: "legacy-usage", workspaceId: "default", cwd: "/private/tmp", title: "Legacy final usage fixture" });
    await first.recordSessionTurn({ id: "legacy-turn", sessionId: "legacy-usage", userInput: "Fixture", agentResponse: "", tokenIn: 0, tokenOut: 0 });
    await first.updateSessionTurn({ id: "legacy-turn", agentResponse: "Completed", tokenIn: 7, tokenOut: 3, status: "done" });
    await first.recordTokenUsage([{ id: "orphan", usageType: "agent", source: "test", inputTokens: 999, totalTokens: 999 },
      { id: "foreign", usageType: "agent", source: "test", workspaceId: "foreign", inputTokens: 555, totalTokens: 555 }]);
    await actors.captureCostBaseline("default");
    await actors.create("default", { id: "root", name: "Root", model: MODEL_CATALOG.luna.id, memory });
    const results = await Promise.allSettled([first, second].map((store, index) => new DomainActorStore(store).updateMemory({
      workspaceId: "default", actorId: "root", sourceEventId: `source-${index}`, baseVersion: 0, memory: { ...memory, rolling: `Update ${index}` } })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second).changeDomainActorRoom("default", room => {
      room.memoryErrors.push({ actorId: "root", eventId: `append-${index}`, error: "Recorded", created: "2026-10-22T00:00:00Z" });
    })));
    await actors.create("default", { id: "sub", parentActorId: "root", name: "Sub", model: MODEL_CATALOG.luna.id, memory });
    for (const sessionId of ["root-session", "sub-session"]) {
      await first.upsertSession({ id: sessionId, workspaceId: "default", cwd: "/private/tmp", title: "Live binding fixture" });
      await first.recordSessionTurn({ id: `${sessionId}-turn`, sessionId, userInput: "Fixture", agentResponse: "", tokenIn: 0, tokenOut: 0, status: "running" });
    }
    await first.changeDomainActorRoom("default", room => {
      room.workItems.push({ id: "work", roundId: "round", ownerActorId: "root", executorActorId: "sub", model: MODEL_CATALOG.luna.id,
        dispatchKey: "work:execution:1", taskSessionId: "sub-session", taskTurnId: "sub-session-turn", status: "assigned",
        dispatchError: null, dispatched: true, dispatchLease: null, executionRevision: 1, assignmentRequests: [],
        executionHistory: [{ executorActorId: "root", model: MODEL_CATALOG.luna.id, taskSessionId: "root-session", taskTurnId: "root-session-turn", dispatchKey: "work", dispatched: true, status: "started" }],
        created: "2026-10-22T00:00:00Z", updated: "2026-10-22T00:00:00Z" });
    });
    assert.deepEqual((await actors.runningSessions("default")).map(item => [item.actorId, item.sessionId]).sort(), [["root", "root-session"], ["sub", "sub-session"]]);
    // A manual follow-up queued in an idle actor session counts once, whether it is queued or stopped.
    await first.upsertSession({ id: "queued-session", workspaceId: "default", cwd: "/private/tmp", title: "Queued follow-up fixture" });
    await first.recordSessionTurn({ id: "queued-turn", sessionId: "queued-session", userInput: "Follow up", agentResponse: "", tokenIn: 0, tokenOut: 0, status: "todo", pendingReason: "queued" });
    await first.recordSessionTurn({ id: "queued-turn-2", sessionId: "queued-session", userInput: "Follow up 2", agentResponse: "", tokenIn: 0, tokenOut: 0, status: "todo", pendingReason: "queued" });
    await first.upsertSession({ id: "stopped-session", workspaceId: "default", cwd: "/private/tmp", title: "Stopped follow-up fixture" });
    await first.recordSessionTurn({ id: "stopped-turn", sessionId: "stopped-session", userInput: "Follow up", agentResponse: "", tokenIn: 0, tokenOut: 0, status: "todo", pendingReason: "stopped" });
    await first.changeDomainActorRoom("default", room => {
      const base = room.workItems[0];
      room.workItems.push({ ...base, id: "work-queued", taskSessionId: "queued-session", taskTurnId: "queued-turn", executionHistory: [] },
        { ...base, id: "work-stopped", taskSessionId: "stopped-session", taskTurnId: "stopped-turn", executionHistory: [] });
    });
    assert.deepEqual((await actors.runningSessions("default")).map(item => [item.actorId, item.sessionId]).sort(),
      [["root", "root-session"], ["sub", "queued-session"], ["sub", "sub-session"]]);
    await actors.update("default", "root", { name: "Configured worker", model: MODEL_CATALOG.sol.id, effort: "max", allowedModels: [MODEL_CATALOG.sol.id], avatar: "data:image/png;base64,YQ==" });
  } finally { await Promise.all([first.close(), second.close()]); }
  const reopened = new SessionStore(id);
  try {
    await reopened.ready();
    const store = new DomainActorStore(reopened);
    const room = await store.getRoom("default");
    assert.equal(room.actors[0].name, "Configured worker");
    assert.equal(room.actors[0].model, MODEL_CATALOG.sol.id);
    assert.equal(room.actors[0].effort, "max");
    assert.deepEqual(room.actors[0].allowedModels, [MODEL_CATALOG.sol.id]);
    assert.equal(room.actors[0].avatar, "data:image/png;base64,YQ==");
    assert.equal(room.actors[0].memory.version, 1); assert.equal(room.memoryErrors.length, 8);
    const luna = room.costBaseline?.usage.find(row => row.model === MODEL_CATALOG.luna.id);
    assert.equal(luna?.input_tokens, 10); assert.equal(luna?.model_context_window, 100_000);
    assert.equal(await reopened.getModelContextWindow(MODEL_CATALOG.luna.id), 100_000);
    assert.equal(await reopened.getModelContextWindow(MODEL_CATALOG.claudeOpus.id), null);
    assert.equal(room.costBaseline?.usage.find(row => row.model === null)?.input_tokens, 7);
    assert.equal(room.costBaseline?.usage.reduce((sum, row) => sum + Number(row.input_tokens), 0), 17);
    const eventId = room.actors[0].memory.sourceEventIds[0];
    const deduped = await store.updateMemory({ workspaceId: "default", actorId: "root", sourceEventId: eventId, baseVersion: 0, memory });
    assert.equal(deduped.memory.version, 1);
    assert.equal((await store.runningSessions("default")).length, 3);
    await store.update("default", "root", { effort: "max" });
    assert.equal((await store.getRoom("default")).actors[0].avatar, "data:image/png;base64,YQ==");
    await store.update("default", "root", { avatar: null });
    assert.equal((await store.getRoom("default")).actors[0].avatar, undefined);
  } finally { await reopened.close(); }
});
