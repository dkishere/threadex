import assert from "node:assert/strict";
import test from "node:test";
import type { ActorRoom, ActorWorkItem, DomainActor } from "../domainActors";
import { actorChildMessage, actorClaudeAgentModel, actorNativeAgentName, actorNativeSignals, actorSessionWork, actorSplitHostContext, projectActorNativeSignals } from "./actorNativeAgents";
import { RunnerUpdateQueue } from "./runnerUpdateQueue";

test("a failed native projection fails the runner callback, so the update stays unapplied and its replay is projected", async () => {
  const queue = new RunnerUpdateQueue();
  const observed: string[] = [];
  let fail = true;
  const update = { sessionId: "s-host", turnId: "t-host", ts: "2026-10-22T22:02:00Z",
    data: { id: "toolu_1", eventType: "item.completed", itemType: "subagent", tool: "spawn_agent", status: "completed",
      agents: [{ id: "toolu_1", name: "actor_ui_123456", status: "completed", message: "UI done" }] } };
  const apply = () => queue.run("update-1", () => projectActorNativeSignals({ update, getSession: async id => ({ id, workspaceId: "w" }),
    observe: async input => { if (fail) throw new Error("store write failed"); observed.push(`${input.signal.phase}:${input.signal.result}:${input.timestamp}`); } }));
  await assert.rejects(apply(), /store write failed/);
  fail = false;
  await apply();
  await apply();
  assert.deepEqual(observed, ["completed:UI done:2026-10-22T22:02:00Z"], "the replay is projected once, with the runner's original timestamp");
});

test("native agent names are provider-safe and unique per assignment", () => {
  assert.equal(actorNativeAgentName("UI / Forms", "actor_work_ab12cd34"), "actor_ui_forms_12cd34");
  assert.match(actorNativeAgentName("!!!", "actor_work_x"), /^actor_work_[a-z0-9]*$/);
});

test("Claude Agent cards and Codex child items become child lifecycle signals", () => {
  const claude = (eventType: string, status: string, message?: string) => ({ id: "toolu_1", eventType, itemType: "subagent", tool: "spawn_agent", status,
    model: "claude-sonnet-5-5", agents: [{ id: "toolu_1", name: "actor_ui_123456", status, ...(message ? { message } : {}) }] });
  assert.deepEqual(actorNativeSignals(claude("item.started", "inProgress")), [{ name: "actor_ui_123456", agentId: "toolu_1", phase: "started", result: undefined, model: "claude-sonnet-5-5" }]);
  assert.deepEqual(actorNativeSignals(claude("item.completed", "completed", "Form done")).map(signal => [signal.phase, signal.result]), [["completed", "Form done"]]);
  assert.equal(actorNativeSignals({ ...claude("item.started", "inProgress"), model: undefined, actualModel: "claude-opus-5-5" })[0].model, "claude-opus-5-5",
    "the system-fixed model is recorded when the host passes none");
  assert.equal(actorNativeSignals(claude("item.completed", "failed"))[0].phase, "failed");
  assert.equal(actorNativeSignals(claude("item.completed", "declined"))[0].phase, "failed");
  // A child handed off in place runs as a general-purpose agent named by its brief's marker, with an Agent model alias.
  const inPlace = (eventType: string, status: string, message?: string) => ({ ...claude(eventType, status, message), model: "opus",
    prompt: `${actorChildMessage("actor_handoff_abc123", "You are domain actor Docs")}\n\nCoordination notes`,
    agents: [{ id: "toolu_1", name: "general-purpose", status, ...(message ? { message } : {}) }] });
  assert.deepEqual(actorNativeSignals(inPlace("item.started", "inProgress")), [{ name: "actor_handoff_abc123", agentId: "toolu_1", phase: "started", result: undefined, model: "claude-opus-5-5" }]);
  assert.deepEqual(actorNativeSignals(inPlace("item.completed", "completed", "Docs done")).map(signal => [signal.name, signal.phase, signal.result]), [["actor_handoff_abc123", "completed", "Docs done"]]);
  assert.equal(actorNativeSignals({ ...inPlace("item.started", "inProgress"), prompt: "Notes first [threadex-actor-assignment:actor_handoff_abc123]" })[0].name, "general-purpose",
    "only a prompt that begins with the marker names a child");

  const activity = { id: "a1", eventType: "item.started", itemType: "subagent", tool: "activity", status: "started", label: "/root/actor_api_654321", receiverThreadIds: ["thread-api"] };
  assert.deepEqual(actorNativeSignals(activity), [{ name: "actor_api_654321", agentId: "thread-api", phase: "started" }]);
  assert.deepEqual(actorNativeSignals({ ...activity, status: "interacted" }), [], "a host call on a finished child must not open a phantom run");
  const waited = { id: "w1", eventType: "item.completed", itemType: "subagent", tool: "wait", status: "completed", receiverThreadIds: ["thread-api", "thread-x"],
    agents: [{ id: "thread-api", status: "completed", message: "API ready" }, { id: "thread-x", status: "errored" }, { id: "thread-y", status: "shutdown" }] };
  assert.deepEqual(actorNativeSignals(waited), [{ agentId: "thread-api", phase: "completed", result: "API ready" }, { agentId: "thread-x", phase: "failed", result: undefined }]);
  const spawned = { id: "s1", eventType: "item.completed", itemType: "subagent", tool: "spawnAgent", status: "completed", receiverThreadIds: ["thread-api"],
    prompt: actorChildMessage("actor_api_654321", "brief"), agents: [{ id: "thread-api", status: "running" }] };
  assert.deepEqual(actorNativeSignals(spawned), [{ name: "actor_api_654321", agentId: "thread-api", phase: "started" }], "the brief marker names the child");
  assert.deepEqual(actorNativeSignals({ itemType: "command_execution" }), []);
});

const actor = (id: string): DomainActor => ({ type: "worker", id, workspaceId: "w", rootActorId: id, parentActorId: null, name: id.toUpperCase(), model: "claude-sonnet-5-5",
  effort: "medium", allowedModels: ["claude-sonnet-5-5", "claude-opus-5-5"], memory: { version: 1, sourceEventIds: [], rolePrompt: `${id} role`, roleSummary: id, longTerm: `${id} decisions`, rolling: "" },
  created: "", updated: "" });
const work = (id: string, executor: string, extra: Partial<ActorWorkItem> = {}): ActorWorkItem => ({ id, roundId: "r", ownerActorId: executor, executorActorId: executor,
  model: "claude-opus-5-5", allocationId: `a-${id}`, delegatedTask: `${id} portion`, dispatchKey: id, taskSessionId: "s-host", taskTurnId: "t-host", status: "assigned",
  dispatchError: null, created: "", updated: "", dispatched: true, dispatchLease: null, executionRevision: 0, executionHistory: [], assignmentRequests: [], ...extra });

function splitRoom(childModel: string): ActorRoom {
  return { workspaceId: "w", revision: 1, actors: [actor("api"), actor("ui"), actor("ops")], events: [], memoryErrors: [],
    rounds: [{ id: "r", requestId: "q", userPrompt: "Build orders", namedActorIds: [], candidateSnapshots: [], stakeholderIds: [], replies: [], actorSnapshots: [actor("api"), actor("ui"), actor("ops")],
      routingDecisions: {}, policies: {} as never, ownerActorId: null, workItemId: "host", workItemIds: ["ui-child", "host", "ops-external"], status: "assigned", error: null, created: "", deadline: "", lease: null,
      allocation: { requirements: [], review: { overlaps: [], conflicts: [], uncovered: [] }, integrationAssignmentId: "a-host",
        assignments: [{ id: "a-host", actorId: "api", requirementIds: [], brief: "", dependsOn: ["a-ui-child"] }, { id: "a-ui-child", actorId: "ui", requirementIds: [], brief: "", dependsOn: [] },
          { id: "a-ops-external", actorId: "ops", requirementIds: [], brief: "", dependsOn: [] }] } }],
    workItems: [work("ui-child", "ui", { model: childModel, hostWorkItemId: "host", nativeAgent: { name: "actor_ui_123456", provider: "claude" } }),
      work("host", "api"), work("ops-external", "ops", { model: "gpt-6-luna", taskSessionId: "s-ops", taskTurnId: "t-ops", status: "started" })] };
}

test("session binding resolves the host, never a native child sharing its session", () => {
  assert.equal(actorSessionWork(splitRoom("claude-sonnet-5-5"), "s-host")?.id, "host");
  assert.equal(actorSessionWork(splitRoom("claude-sonnet-5-5"), "s-ops")?.id, "ops-external");
});

test("a split host turn defines each native child as its own actor with a per-turn credential", async () => {
  const issued: string[] = [];
  const room = splitRoom("claude-sonnet-5-5");
  const context = await actorSplitHostContext({ room, host: room.workItems[1], hostActor: actor("api"), turnId: "t-host", runningSessions: [],
    contextWindow: async () => 200_000, issue: async id => { issued.push(id); return "c".repeat(64); } });
  assert.ok(context);
  assert.equal(context.provider, "claude");
  assert.deepEqual(issued, ["ui-child"]);
  assert.deepEqual(context.capabilities, { actor_ui_123456: "c".repeat(64) });
  assert.equal(context.children.length, 1);
  const [child] = context.children;
  assert.equal(child.model, "claude-sonnet-5-5"); assert.equal(child.effort, "medium");
  assert.match(child.prompt, /You are domain actor UI \(ui\)/);
  assert.match(child.prompt, /ui-child portion/); assert.match(child.prompt, /ui decisions/, "the child's own memory, not the host's");
  assert.doesNotMatch(child.prompt, /api decisions/);
  assert.match(context.instructions, /subagent_type exactly its name/);
  assert.match(context.instructions, /"name":"actor_ui_123456"/);
  assert.equal(await actorSplitHostContext({ room, host: room.workItems[2], hostActor: actor("ops"), turnId: "t-ops", runningSessions: [],
    contextWindow: async () => null, issue: async () => "x" }), undefined, "only the integration owner hosts the split");
});

test("a child whose model permission is revoked or unpicked gets no definition and no credential", async () => {
  for (const mutate of [(room: ActorRoom) => { room.actors[1].allowedModels = ["claude-haiku-5-5"]; },
    (room: ActorRoom) => { room.workItems[0].status = "failed"; room.workItems[0].dispatched = false; }]) {
    const room = splitRoom("claude-sonnet-5-5");
    mutate(room);
    const issued: string[] = [];
    const context = await actorSplitHostContext({ room, host: room.workItems[1], hostActor: actor("api"), turnId: "t-host", runningSessions: [],
      contextWindow: async () => null, issue: async id => { issued.push(id); return "c".repeat(64); } });
    assert.ok(context);
    assert.deepEqual(context.children, []); assert.deepEqual(context.capabilities, {}); assert.deepEqual(issued, []);
    assert.match(context.instructions, /"unavailable":"Model permission is missing/);
    assert.match(context.instructions, /Children marked unavailable are not defined in this turn/);
  }
});

test("a child awaiting recovery is defined only in its own recovery turn", async () => {
  const room = splitRoom("claude-sonnet-5-5");
  room.workItems[0].nativeAgent!.recovery = { requestId: "native-recover:r", userPrompt: "Recover", status: "queued", turnId: "recovery-turn" };
  const context = (turnId: string) => actorSplitHostContext({ room, host: room.workItems[1], hostActor: actor("api"), turnId, runningSessions: [],
    contextWindow: async () => null, issue: async () => "c".repeat(64) });
  const earlier = await context("ordinary-turn");
  assert.deepEqual(earlier!.children, []); assert.match(earlier!.instructions, /Queued for its own recovery turn/);
  const own = await context("recovery-turn");
  assert.deepEqual(own!.children.map(child => child.name), ["actor_ui_123456"]);
});

test("a cancelled child receives no launch definition or capability in later host turns", async () => {
  const room = splitRoom("claude-sonnet-5-5");
  room.workItems[0].cancelledAt = "2026-10-31T00:00:00Z";
  const context = await actorSplitHostContext({ room, host: room.workItems[1], hostActor: actor("api"), turnId: "later-turn", runningSessions: [],
    contextWindow: async () => null, issue: async () => { throw new Error("Cancelled child must not receive a capability"); } });
  assert.ok(context);
  assert.deepEqual(context.children, []); assert.deepEqual(context.capabilities, {});
  assert.match(context.instructions, /Task cancelled/);
});

test("an ordinary task hosting a handoff defines its hosted child with a credential and no-delegation rules", async () => {
  const room = splitRoom("claude-sonnet-5-5");
  delete room.rounds[0].allocation;
  // Without a split, only a hosted handoff child makes the task a host.
  assert.equal(await actorSplitHostContext({ room, host: room.workItems[1], hostActor: actor("api"), turnId: "t-follow", runningSessions: [],
    contextWindow: async () => null, issue: async () => "x" }), undefined);
  room.workItems[0] = { ...room.workItems[0], allocationId: "handoff", parentWorkItemId: "host", handoff: { sourceActorId: "api", sourceSessionId: "s-host" },
    nativeAgent: { name: "actor_handoff_123456", provider: "claude" } };
  const issued: string[] = [];
  const context = await actorSplitHostContext({ room, host: room.workItems[1], hostActor: actor("api"), turnId: "t-follow", runningSessions: [],
    contextWindow: async () => null, issue: async id => { issued.push(id); return "c".repeat(64); } });
  assert.ok(context);
  assert.deepEqual(issued, ["ui-child"]); assert.deepEqual(Object.keys(context.capabilities), ["actor_handoff_123456"]);
  const [child] = context.children;
  assert.equal(child.name, "actor_handoff_123456"); assert.match(child.description, /follow-up handed off by this session/);
  assert.match(child.prompt, /follow-up work that API handed off to you/);
  assert.match(child.prompt, /Never call actor_handoff or actor_assign_many.*the host decides/);
  assert.match(context.instructions, /^Hosted handoff host/); assert.doesNotMatch(context.instructions, /Partial-claim integration owner/);
  assert.match(context.instructions, /Children cannot delegate/);
  assert.equal(await actorSplitHostContext({ room, host: room.workItems[2], hostActor: actor("ops"), turnId: "t-ops", runningSessions: [],
    contextWindow: async () => null, issue: async () => "x" }), undefined, "other tasks host nothing");
});

test("a Claude child handed off in place gets a verbatim brief, no definition and no credential", async () => {
  const room = splitRoom("claude-sonnet-5-5");
  delete room.rounds[0].allocation;
  room.workItems[0] = { ...room.workItems[0], allocationId: "handoff", parentWorkItemId: "host", handoff: { sourceActorId: "api", sourceSessionId: "s-host" },
    nativeAgent: { name: "actor_handoff_123456", provider: "claude" } };
  const context = await actorSplitHostContext({ room, host: room.workItems[1], hostActor: actor("api"), turnId: "t-host", runningSessions: [], contextWindow: async () => null });
  assert.ok(context);
  assert.deepEqual(context.children, []); assert.deepEqual(context.capabilities, {});
  const [brief] = context.briefs;
  assert.deepEqual([brief.name, brief.model, brief.effort], ["actor_handoff_123456", "claude-sonnet-5-5", "medium"]);
  assert.match(brief.brief!, /^\[threadex-actor-assignment:actor_handoff_123456\]\nYou are domain actor UI \(ui\)/);
  assert.match(brief.brief!, /ui decisions/); assert.match(brief.brief!, /Do not call actor tools/);
  assert.doesNotMatch(brief.brief!, /bound to your own actor/);
});

test("Claude in-place children use the Agent model alias that runs exactly their model", () => {
  assert.deepEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2", "claude-fable-5-1", "gpt-6-luna"].map(actorClaudeAgentModel),
    ["opus", "sonnet", "haiku", "fable", undefined, undefined]);
});

test("a Codex host passes each child brief verbatim and issues no unusable credentials", async () => {
  const room = splitRoom("gpt-6-luna");
  room.workItems[1].model = "gpt-6-sol";
  for (const actor of room.actors) actor.allowedModels.push("gpt-6-luna", "gpt-6-sol");
  room.workItems[0].nativeAgent!.provider = "codex";
  const context = await actorSplitHostContext({ room, host: room.workItems[1], hostActor: actor("api"), turnId: "t-host", runningSessions: [],
    contextWindow: async () => null, issue: async () => { throw new Error("Codex children have no credential channel"); } });
  assert.ok(context);
  assert.equal(context.provider, "codex");
  assert.deepEqual(context.children, []); assert.deepEqual(context.capabilities, {});
  assert.match(context.instructions, /spawn_agent: task_name exactly its name/);
  assert.match(context.instructions, /reasoning_effort set to its listed effort/, "Codex children run with, and report, their actor's effort");
  assert.match(context.instructions, /"effort":"medium"/);
  assert.match(context.instructions, /threadex-actor-assignment:actor_ui_123456/);
  assert.match(context.instructions, /ui decisions/, "the verbatim brief carries the child's own memory");
  assert.match(context.instructions, /must not call actor tools/);
});
