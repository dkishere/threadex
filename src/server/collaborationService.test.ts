import assert from "node:assert/strict";
import test from "node:test";
import type { CollaborationGroup } from "../collaboration";
import { CollaborationService } from "./collaborationService";
import type { SessionStore, SessionTurnRecord } from "./sessionStore";

test("actor messages select the specified member group when a session belongs to several groups", async () => {
  const groups = ["tree", "parallel"].map(id => ({ id, workspaceId: "ws", mainSessionId: "source", messages: [], results: [],
    members: [{ localId: "main", sessionId: "source", stopped: false }, { localId: "target", sessionId: `${id}-target`, stopped: false }] })) as unknown as CollaborationGroup[];
  const store = { listCollaborationGroups: async () => groups,
    listSessionTurns: async () => [{ id: "turn", status: "running" }], listSessionTurnLiveItems: async () => [],
    getSessionTurn: async () => ({ id: "turn", sessionId: "source", status: "running" }),
    changeCollaboration: async (id: string, _initial: unknown, mutate: (group: CollaborationGroup) => unknown) => mutate(groups.find(group => group.id === id)!)
  } as unknown as SessionStore;
  const service = new CollaborationService(store, "http://unused", () => []);
  await service.send("source", { to: "target", requestId: "request", message: "Coordinate", reason: "Parallel work", turnId: "turn" }, "parallel");
  assert.equal(groups[0].messages.length, 0);
  assert.equal(groups[1].messages.length, 1);
  await assert.rejects(service.send("source", { to: "target" }, "not-a-member"), /not enabled/);
});

test("delivery refreshes the leased group rather than the first group sharing its main session", async () => {
  const groups = ["tree", "parallel"].map(id => ({ id, mainSessionId: "source", lease: null, results: [],
    members: [{ localId: "target", sessionId: `${id}-target`, stopped: false }],
    messages: [{ id: `${id}-message`, state: "pending", to: "target" }] })) as unknown as CollaborationGroup[];
  const store = { listCollaborationGroups: async () => groups,
    changeCollaboration: async (id: string, _initial: unknown, mutate: (group: CollaborationGroup) => unknown) => mutate(groups.find(group => group.id === id)!)
  } as unknown as SessionStore;
  const service = new CollaborationService(store, "http://unused", () => []);
  const internal = service as unknown as { collect: (group: CollaborationGroup) => Promise<void>; deliver: (group: CollaborationGroup, message: CollaborationGroup["messages"][number]) => Promise<void> };
  const deliveries: string[] = [];
  internal.collect = async () => {};
  internal.deliver = async (group, message) => { deliveries.push(group.id); message.state = "delivered"; };
  await service.pulse();
  assert.deepEqual(deliveries, ["tree", "parallel"]);
});

function forkStore(input: { threadId: string; turns: Array<Partial<SessionTurnRecord>>; nativeLink?: boolean }) {
  let group: CollaborationGroup | null = null;
  const sessions = new Map<string, Record<string, unknown>>([["main", { id: "main", workspaceId: "ws", cwd: "/repo",
    accountId: null, title: "Main", threadId: input.threadId, parentSessionId: null, forkedFromTurnId: null, description: "" }]]);
  const turns = new Map<string, Array<Partial<SessionTurnRecord>>>([["main", input.turns]]);
  const nativeLookups: string[] = [];
  const store = {
    listCollaborationGroups: async () => group ? [group] : [],
    getSession: async (id: string) => sessions.get(id) ?? null,
    upsertSession: async (session: Record<string, unknown>) => { sessions.set(String(session.id), session); },
    getSessionModelPreferences: async () => ({ selectedModel: "gpt-6-sol", selectedEffort: "high", gearProfiles: [], activeGearIndex: 0 }),
    setSessionModelPreferences: async () => {},
    resolveApprovalPolicy: async () => "on-request",
    resolveSessionWorkspaceManager: async () => null,
    listSessionTurns: async (id: string) => turns.get(id) ?? [],
    listSessionSteerMessages: async () => ({}),
    listSessionTurnLiveItems: async () => [],
    collaborationNativeTurn: async (_session: string, turnId: string, threadId: string) => {
      nativeLookups.push(turnId);
      return input.nativeLink ? { threadId, lastTurnId: `native-${turnId}` } : null;
    },
    changeCollaboration: async (_id: string, initial: CollaborationGroup | null, change: (value: CollaborationGroup) => unknown) => {
      group ??= initial;
      return change(group!);
    }
  } as unknown as SessionStore;
  return { store, turns, nativeLookups, group: () => group! };
}

const sourceTurns: Array<Partial<SessionTurnRecord>> = [
  { id: "t1", status: "done", userInput: "First request", agentResponse: "First result", runnerExitCode: 0, created: "2026-10-26T09:00:00Z" },
  { id: "t2", status: "done", userInput: "Boundary request", agentResponse: "Boundary result", runnerExitCode: 0, created: "2026-10-26T09:01:00Z" },
  { id: "t3", status: "running", userInput: "Still running request", agentResponse: "", runnerExitCode: null, created: "2026-10-26T09:02:00Z" }
];

test("Claude source forks from a completed turn while a later turn is still running", async () => {
  const fixture = forkStore({ threadId: "claude:source-thread", turns: sourceTurns });
  const service = new CollaborationService(fixture.store, "http://unused", () => []);
  const member = await service.fork("main", { requestId: "r1", task: "Check in parallel", model: "gpt-6-sol" });
  assert.equal(member.sourceTurnId, "t2", "defaults to the latest completed turn, not the running one");
  assert.equal(member.fork, null, "Claude threads have no Codex native fork");
  assert.deepEqual(fixture.nativeLookups, []);
  const context = await service.runnerContext(member.sessionId, "worker-turn");
  assert.ok(context?.recovery, "worker is seeded from the source transcript");
  assert.match(context.recovery.handoff, /Boundary result/);
  assert.doesNotMatch(context.recovery.handoff, /Still running request/, "turns after the boundary are excluded");
  assert.equal(context.priorContext, "");
});

test("Claude workers from a Codex source use the transcript instead of a Codex native fork", async () => {
  const fixture = forkStore({ threadId: "codex-thread", turns: sourceTurns, nativeLink: true });
  const service = new CollaborationService(fixture.store, "http://unused", () => []);
  const member = await service.fork("main", { requestId: "r2", task: "Review", model: "claude-opus-5-5", turnId: "t1" });
  assert.equal(member.fork, null);
  const context = await service.runnerContext(member.sessionId, "worker-turn");
  assert.match(context!.recovery!.handoff, /First result/);
  assert.doesNotMatch(context!.recovery!.handoff, /Boundary request/);
});

test("Codex workers keep the native fork and fall back to the transcript without a native link", async () => {
  const linked = forkStore({ threadId: "codex-thread", turns: sourceTurns, nativeLink: true });
  const native = await new CollaborationService(linked.store, "http://unused", () => []).fork("main", { requestId: "r3", task: "Go", model: "gpt-6-sol" });
  assert.deepEqual(native.fork, { threadId: "codex-thread", lastTurnId: "native-t2" });
  assert.equal(await new CollaborationService(linked.store, "http://unused", () => []).runnerContext(native.sessionId, "w").then(c => c?.recovery), null);
  const unlinked = forkStore({ threadId: "codex-thread", turns: sourceTurns });
  const fallback = await new CollaborationService(unlinked.store, "http://unused", () => []).fork("main", { requestId: "r4", task: "Go", model: "gpt-6-sol" });
  assert.equal(fallback.fork, null);
});

test("a running or foreign source turn is rejected with a clear reason", async () => {
  const fixture = forkStore({ threadId: "claude:source-thread", turns: sourceTurns });
  const service = new CollaborationService(fixture.store, "http://unused", () => []);
  await assert.rejects(service.fork("main", { requestId: "r5", task: "Go", turnId: "t3" }), /completed source turn.*running turn/);
  await assert.rejects(service.fork("main", { requestId: "r6", task: "Go", turnId: "elsewhere" }), /does not belong/);
  assert.equal(fixture.group().members.length, 1, "rejections create no worker");
});

for (const resolution of ["completed", "cancelled"] as const) {
  test(`collect revisits a waiting checkpoint after its dependency is ${resolution}`, async () => {
    const group = {
      id: "group", mainSessionId: "main", results: [],
      members: ["main", "c1", "c2"].map(localId => ({ localId, sessionId: localId, observed: {}, stopped: false })),
      messages: [
        { id: "dependency", from: "c1", to: "main", sourceTurnId: "c1-turn", wait: true, completed: false, state: "delivered" },
        { id: "baseline", from: "c2", to: "c1", targetTurnId: "c1-turn", wait: true, completed: false, state: "delivered", depth: 0 }
      ]
    } as unknown as CollaborationGroup;
    const store = {
      listSessionTurns: async (id: string) => id === "c1" ? [
        { id: "c1-turn", status: "done", agentResponse: "Baseline finished", runnerExitCode: 0 }
      ] as SessionTurnRecord[] : [],
      changeCollaboration: async (_id: string, _revision: unknown, change: (value: CollaborationGroup) => unknown) => change(group),
      inspectSession: async () => ({ fileChanges: [] }),
    } as unknown as SessionStore;
    const service = new CollaborationService(store, "http://unused", () => []);
    const collect = () => (service as unknown as { collect(group: CollaborationGroup): Promise<void> }).collect(structuredClone(group));
    await collect();
    assert.equal(group.results.length, 0);
    assert.ok(group.members[1].observed["c1-turn"], "checkpoint was already fingerprinted");
    assert.equal(group.messages[1].completed, false);
    if (resolution === "completed") group.messages[0].completed = true;
    else group.messages[0].state = "cancelled";
    await collect();
    assert.equal(group.results.length, 1);
    assert.equal(group.results[0].summary, "Baseline finished");
    assert.equal(group.messages[1].completed, true, "C2 no longer waits on C1");
    assert.ok(group.messages.some(m => m.kind === "result" && m.to === "c2"));
    const count = group.messages.length;
    await collect();
    assert.equal(group.results.length, 1);
    assert.equal(group.messages.length, count, "repeated collection does not resend results");
  });
}
