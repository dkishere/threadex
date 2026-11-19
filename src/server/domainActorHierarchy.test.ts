import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { emptyActorRoom, type ActorRoom, type ActorRound, type ActorRunningSession, type ActorWorkItem } from "../domainActors";
import { MODEL_CATALOG } from "../modelCatalog";
import { ActorHierarchyConflict, DomainActorStore, type ActorPersistence } from "./domainActorStore";
import { SessionStore } from "./sessionStore";

const memory = { rolePrompt: "Role", roleSummary: "Summary", longTerm: "Knowledge", rolling: "Recent" };
const move = (parentActorId: string | null, expectedParentActorId: string | null = "root", expectedRootActorId = "root") =>
  ({ parentActorId, expectedParentActorId, expectedRootActorId });
function work(extra: Partial<ActorWorkItem> = {}): ActorWorkItem {
  return { id: "work", roundId: "round", ownerActorId: "other", executorActorId: "other", model: MODEL_CATALOG.luna.id,
    dispatchKey: "dispatch", taskSessionId: "session", taskTurnId: "turn", status: "completed", dispatchError: null,
    created: "2020-01-01T00:00:00Z", updated: "2020-01-01T00:00:00Z", dispatched: true, dispatchLease: null,
    executionRevision: 1, executionHistory: [], assignmentRequests: [], ...extra };
}
function pickupRound(room: ActorRoom, extra: Partial<ActorRound> = {}): ActorRound {
  return { id: "round", status: "awaiting_pickup", actorSnapshots: structuredClone(room.actors),
    candidateSnapshots: [{ actorId: "root", actor: structuredClone(room.actors[0]), memoryVersion: 0 }],
    namedActorIds: [], stakeholderIds: [], replies: [], ownerActorId: null,
    workItemId: "work", workItemIds: ["work", "second"], lease: null, ...extra } as ActorRound;
}
async function fixture() {
  let saved = emptyActorRoom("ws");
  let running: ActorRunningSession[] = [];
  const persistence: ActorPersistence = {
    getWorkspace: async id => id === "ws" ? { id } as NonNullable<Awaited<ReturnType<ActorPersistence["getWorkspace"]>>> : null,
    getDomainActorRoom: async () => structuredClone(saved),
    changeDomainActorRoom: async (_id, mutate, options) => {
      const room = structuredClone(saved);
      const result = mutate(room, options?.actorLifecycleLock ? running : undefined);
      saved = room;
      return result;
    },
    getDomainActorRunningSessions: async () => running,
    getSessionTurn: async () => null,
    captureActorCostBaseline: async () => ({ capturedAt: "2020-01-01", usage: [] })
  };
  const store = new DomainActorStore(persistence);
  for (const [id, parentActorId] of [["root", undefined], ["child", "root"], ["sibling", "root"], ["dest", undefined], ["dest-child", "dest"], ["other", undefined]] as const) {
    await store.create("ws", { id, name: id, parentActorId, model: MODEL_CATALOG.luna.id, memory });
  }
  const seed = (mutate: (room: ActorRoom) => void) => { mutate(saved); };
  return { store, seed, read: () => structuredClone(saved), running: (sessions: ActorRunningSession[]) => { running = sessions; } };
}

test("promotion preserves identity, configuration, memory and history, and copies effective projects", async () => {
  const h = await fixture();
  h.seed(room => {
    room.actors[0].projectIds = ["p", "q", "p"];
    const child = room.actors[1]; child.avatar = "data:image/png;base64,YQ==";
    child.updated = "2020-01-01"; child.memory.version = 7; child.memory.sourceEventIds = ["event"];
    room.workItems.push(work({ ownerActorId: "root", executorActorId: "child" }));
  });
  const before = h.read();
  const promoted = await h.store.reparent("ws", "child", move(null), "root");
  assert.deepEqual(promoted, { ...before.actors[1], parentActorId: null, rootActorId: "child", projectIds: ["p", "q"], updated: promoted.updated });
  assert.notEqual(promoted.updated, before.actors[1].updated);
  assert.deepEqual(h.read().workItems, before.workItems);
  assert.deepEqual(h.read().actors.filter(a => a.id !== "child"), before.actors.filter(a => a.id !== "child"));
  const sibling = await h.store.reparent("ws", "sibling", move(null));
  assert.deepEqual(sibling.projectIds, ["p", "q"]);
});

test("root no-op keeps its children consistent; demotion with children is refused", async () => {
  const h = await fixture(), before = h.read();
  await h.store.reparent("ws", "root", move(null, null), "root");
  assert.deepEqual(h.read(), before);
  await assert.rejects(h.store.reparent("ws", "root", move("dest", null)), ActorHierarchyConflict);
  assert.deepEqual(h.read(), before);
});

test("reparent preserves projects and model permissions and removes child-local project fields", async () => {
  const h = await fixture();
  h.seed(room => { room.actors[0].projectIds = ["p", "q"]; room.actors[3].projectIds = ["q", "p"]; room.actors[1].projectIds = ["legacy"]; });
  const child = await h.store.reparent("ws", "child", move("dest"), "root");
  assert.equal(child.parentActorId, "dest"); assert.equal(child.rootActorId, "dest"); assert.equal(child.projectIds, undefined);
  await assert.rejects(h.store.reparent("ws", "child", move("other", "dest", "dest")), /same projects/);
  h.seed(room => { room.actors[3].allowedModelTiers = ["codex-luna"]; });
  await assert.rejects(h.store.reparent("ws", "sibling", move("dest")), /does not allow/);
});

test("an empty root can become a child; unassigned promotion does not add projectIds", async () => {
  const h = await fixture();
  const result = await h.store.reparent("ws", "other", move("dest", null, "other"), "other");
  assert.equal(result.rootActorId, "dest"); assert.equal(result.parentActorId, "dest");
  const child = await h.store.reparent("ws", "child", move(null));
  assert.equal(Object.hasOwn(child, "projectIds"), false);
});

test("missing actors, invalid fields, self, cycles and nested destinations never mutate room", async () => {
  const h = await fixture(), before = h.read();
  for (const [id, input] of [
    ["missing", move(null)], ["child", move("missing")], ["child", move("child")],
    ["root", move("child", null)], ["child", move("dest-child")],
    ["child", { ...move(null), expectedRootActorId: 1 }], ["child", { ...move(null), parentActorId: false }],
    ["child", { ...move(null), expectedParentActorId: undefined }]
  ] as const) {
    await assert.rejects(h.store.reparent("ws", id, input as ReturnType<typeof move>));
    assert.deepEqual(h.read(), before);
  }
  await assert.rejects(h.store.reparent("missing", "child", move(null)), /workspace not found/);
});

test("caller authorization and expected hierarchy are checked even for no-op", async () => {
  const h = await fixture(), before = h.read();
  for (const caller of ["child", "dest", "missing"]) await assert.rejects(h.store.reparent("ws", "child", move("root"), caller));
  for (const input of [move("root", null), move("root", "root", "dest")])
    await assert.rejects(h.store.reparent("ws", "child", input, "root"), ActorHierarchyConflict);
  assert.deepEqual(h.read(), before);
  await h.store.reparent("ws", "child", move("root"), "root");
  assert.deepEqual(h.read(), before);
});

test("activity anywhere in source or destination tree rejects atomically", async t => {
  const cases: Array<[string, (h: Awaited<ReturnType<typeof fixture>>) => void]> = [];
  for (const actorId of ["root", "child", "sibling", "dest", "dest-child"]) {
    for (const status of ["running", "todo", "loop", "done"]) cases.push([`${actorId} ${status} session`, h => {
      h.running([{ actorId, status, workItemId: "unknown", sessionId: "session", turnId: "turn" }]);
    }]);
    cases.push([`${actorId} unfinished`, h => h.seed(room => room.workItems.push(work({ ownerActorId: actorId, status: "failed" })))]);
  }
  cases.push(["related work session", h => { h.seed(room => room.workItems.push(work({ ownerActorId: "sibling" }))); h.running([{ actorId: "other", status: "running", workItemId: "work", sessionId: "session", turnId: "turn" }]); }]);
  for (const [name, arrange] of cases) await t.test(name, async () => {
    const h = await fixture(); arrange(h); const before = h.read();
    await assert.rejects(h.store.reparent("ws", "child", move("dest")), ActorHierarchyConflict);
    assert.deepEqual(h.read(), before);
  });
});

test("pending operations and all active round phases reject without changing saved state", async t => {
  const pending: Array<[string, (room: ActorRoom) => void]> = [
    ["dispatch", room => room.workItems.push(work({ executorActorId: "dest-child", dispatchLease: { owner: "x", until: 1 } }))],
    ["recovery", room => room.workItems.push(work({ executorActorId: "sibling", nativeAgent: { name: "child", provider: "codex", recovery: { requestId: "r", userPrompt: "p", status: "pending", turnId: "t" } } }))],
    ["assignment", room => room.workItems.push(work({ assignmentRequests: [{ requestId: "r", executorActorId: "dest-child", model: MODEL_CATALOG.luna.id, status: "pending" }] }))],
    ["parallel source", room => room.workItems.push(work({ parallelRequests: [{ requestId: "r", sourceActorId: "sibling", sourceSessionId: "s", tasks: [], sourceSnapshot: room.actors[2], executorSnapshots: [], userMessages: [], status: "pending", workItemIds: [], lease: null }] }))],
    ["parallel executor", room => room.workItems.push(work({ parallelRequests: [{ requestId: "r", sourceActorId: "other", sourceSessionId: "s", tasks: [{ executorActorId: "dest-child", task: "p" }], sourceSnapshot: room.actors[5], executorSnapshots: [], userMessages: [], status: "pending", workItemIds: [], lease: null }] }))],
    ["review", room => room.workItems.push(work({ completionReviews: [{ id: "review", workItemId: "work", actorId: "dest-child", ownerActorId: "other", roundId: "r", taskSessionId: "s", taskTurnId: "t", executionRevision: 1, status: "pending", issues: [], created: "2020" }] }))],
    ["task update", room => { room.taskUpdates = [{ requestId: "r", workItemId: "work", workItem: work(), userPrompt: "p", namedActorIds: ["sibling"], status: "pending", lease: null }]; }]
  ];
  for (const status of ["queued", "responding", "awaiting_pickup"] as const) {
    for (const field of ["actorSnapshots", "candidateSnapshots", "namedActorIds", "stakeholderIds", "ownerActorId", "replies", "allocation"] as const) {
      pending.push([`${status} round ${field}`, room => {
        const round = { id: "round", status, actorSnapshots: [], candidateSnapshots: [], namedActorIds: [], stakeholderIds: [], replies: [], ownerActorId: null } as unknown as ActorRound;
        if (field === "actorSnapshots") round.actorSnapshots = [room.actors[4]];
        if (field === "candidateSnapshots") round.candidateSnapshots = [{ actorId: "dest-child", actor: room.actors[4], memoryVersion: 0 }];
        if (field === "namedActorIds" || field === "stakeholderIds") round[field] = ["sibling"];
        if (field === "ownerActorId") round.ownerActorId = "root";
        if (field === "replies") round.replies = [{ actorId: "other", executorActorId: "sibling", status: "claimed", text: "p" }];
        if (field === "allocation") round.allocation = { requirements: [], assignments: [{ id: "a", actorId: "dest-child", requirementIds: [], brief: "p", dependsOn: [] }], review: { overlaps: [], conflicts: [], uncovered: [] } };
        room.rounds.push(round);
      }]);
    }
  }
  for (const [name, arrange] of pending) await t.test(name, async () => {
    const h = await fixture(); h.seed(arrange); const before = h.read();
    await assert.rejects(h.store.reparent("ws", "child", move("dest")), ActorHierarchyConflict);
    assert.deepEqual(h.read(), before);
  });
});

test("terminal pickup snapshots allow promotion without changing round, work or actor identity", async t => {
  for (const variant of ["completed", "mixed", "cancelled", "associated only", "singular reference", "plural references"] as const) {
    await t.test(variant, async () => {
      const h = await fixture();
      h.seed(room => {
        room.actors[0].projectIds = ["project"];
        room.workItems.push(work(variant === "cancelled" ? { status: "started", cancelledAt: "2020-01-02" } : {}),
          work({ id: "second", ...(variant === "mixed" || variant === "cancelled" ? { status: "failed", cancelledAt: "2020-01-02" } : {}) }));
        const round = pickupRound(room);
        if (variant === "associated only") { round.workItemId = null; round.workItemIds = []; }
        if (variant === "singular reference") {
          round.workItemIds = [];
          room.workItems = [work({ roundId: "another-round" })];
        }
        if (variant === "plural references") {
          round.workItemId = null;
          for (const item of room.workItems) item.roundId = "another-round";
        }
        room.rounds.push(round);
      });
      const before = h.read();
      const promoted = await h.store.reparent("ws", "child", move(null), "root");
      assert.deepEqual(promoted, { ...before.actors[1], parentActorId: null, rootActorId: "child", projectIds: ["project"], updated: promoted.updated });
      assert.deepEqual(h.read(), { ...before, actors: before.actors.map(actor => actor.id === "child" ? promoted : actor) });
    });
  }
});

test("pickup must have complete terminal evidence and no active lease before snapshots stop blocking", async t => {
  const cases: Array<[string, (room: ActorRoom, round: ActorRound) => void]> = [
    ["no related work", (room, round) => { room.workItems = []; round.workItemId = null; round.workItemIds = []; }],
    ["missing all work", room => { room.workItems = []; }],
    ["missing singular reference", (_room, round) => { round.workItemId = "missing"; }],
    ["missing plural reference", (_room, round) => { round.workItemIds!.push("missing"); }],
    ["unreferenced associated work", room => { room.workItems.push(work({ id: "extra", status: "assigned" })); }],
    ["referenced work from another round", room => { room.workItems[1].roundId = "another-round"; room.workItems[1].status = "started"; }],
    ["unknown work status", room => { room.workItems[1].status = "unknown" as ActorWorkItem["status"]; }],
    ["round lease", (_room, round) => { round.lease = { owner: "runner", until: Date.now() + 60_000 }; }],
    ["expired round lease", (_room, round) => { round.lease = { owner: "runner", until: 1 }; }]
  ];
  for (const status of ["claimed", "assigned", "started", "failed", "needs_user"] as const)
    cases.push([`${status} work`, room => { room.workItems[1].status = status; }]);
  for (const status of ["queued", "responding"] as const)
    cases.push([`${status} with terminal work`, (_room, round) => { round.status = status; }]);
  for (const [name, arrange] of cases) await t.test(name, async () => {
    const h = await fixture();
    h.seed(room => {
      room.workItems.push(work(), work({ id: "second" }));
      const round = pickupRound(room); room.rounds.push(round); arrange(room, round);
    });
    const before = h.read();
    await assert.rejects(h.store.reparent("ws", "child", move(null), "root"), /active discussion or task pickup/);
    assert.deepEqual(h.read(), before);
  });
});

test("terminal pickup does not bypass affected tree live sessions or pending work operations", async t => {
  for (const guard of ["running", "todo", "loop", "dispatch", "assignment", "review", "task update"] as const) {
    await t.test(guard, async () => {
      const h = await fixture();
      h.seed(room => {
        const item = work({ ownerActorId: "root" });
        room.workItems.push(item, work({ id: "second" })); room.rounds.push(pickupRound(room));
        if (guard === "dispatch") item.dispatchLease = { owner: "runner", until: 1 };
        if (guard === "assignment") item.assignmentRequests = [{ requestId: "r", executorActorId: "other", model: MODEL_CATALOG.luna.id, status: "pending" }];
        if (guard === "review") item.completionReviews = [{ id: "review", workItemId: "work", actorId: "root", ownerActorId: "root", roundId: "round", taskSessionId: "s", taskTurnId: "t", executionRevision: 1, status: "pending", issues: [], created: "2020" }];
        if (guard === "task update") room.taskUpdates = [{ requestId: "r", workItemId: "work", workItem: structuredClone(item), userPrompt: "p", namedActorIds: [], status: "pending", lease: null }];
      });
      if (guard === "running" || guard === "todo" || guard === "loop")
        h.running([{ actorId: "root", workItemId: "work", sessionId: "s", turnId: "t", status: guard }]);
      const before = h.read();
      await assert.rejects(h.store.reparent("ws", "child", move(null), "root"), ActorHierarchyConflict);
      assert.deepEqual(h.read(), before);
    });
  }
});

test("unrelated active work and actor blockers do not lock hierarchy", async () => {
  const h = await fixture();
  h.seed(room => room.workItems.push(work({ status: "started" })));
  h.running([{ actorId: "other", workItemId: "work", sessionId: "s", turnId: "t", status: "running" }]);
  // An unresolved blocker has no hierarchy admission effect, even when owned by the moving actor.
  h.seed(room => { room.blockers = [{ id: "blocker", ownerActorId: "child", executorActorId: "root", status: "open", proposals: [] }] as unknown as ActorRoom["blockers"]; });
  const before = h.read();
  await h.store.reparent("ws", "child", move("dest"));
  assert.deepEqual(h.read().blockers, before.blockers); assert.deepEqual(h.read().workItems, before.workItems);
});

test("authenticated root management work can promote its child while preserving the running task", async () => {
  const h = await fixture();
  h.seed(room => {
    room.workItems.push(work({ id: "management", roundId: "management-round", ownerActorId: "root", executorActorId: "root", status: "started" }),
      work(), work({ id: "second" }));
    room.rounds.push(pickupRound(room));
  });
  h.running([{ actorId: "root", workItemId: "management", sessionId: "session", turnId: "turn", status: "running" }]);
  const before = h.read();
  const promoted = await h.store.reparent("ws", "child", move(null), "root", "management");
  assert.equal(promoted.parentActorId, null); assert.equal(promoted.rootActorId, "child");
  assert.deepEqual(h.read().workItems, before.workItems);
});

test("management exemption requires exact trusted work and never covers other actors or work", async t => {
  const cases: Array<[string, (h: Awaited<ReturnType<typeof fixture>>) => void, string | undefined, string]> = [
    ["no management binding", () => {}, "root", ""],
    ["forged management id", () => {}, "root", "forged"],
    ["no caller binding", () => {}, undefined, "management"],
    ["different owner", h => h.seed(room => { room.workItems[0].ownerActorId = "sibling"; }), "root", "management"],
    ["different executor", h => h.seed(room => { room.workItems[0].executorActorId = "sibling"; }), "root", "management"],
    ["cross actor execution history", h => h.seed(room => { room.workItems[0].executionHistory.push({ executorActorId: "child", model: MODEL_CATALOG.luna.id, taskSessionId: "old", taskTurnId: "old", dispatchKey: "old", dispatched: true, status: "completed" }); }), "root", "management"],
    ["child session under management work", h => h.running([{ actorId: "child", workItemId: "management", sessionId: "child-session", turnId: "turn", status: "running" }]), "root", "management"],
    ["other source session", h => h.running([{ actorId: "sibling", workItemId: "other-work", sessionId: "s", turnId: "t", status: "running" }]), "root", "management"],
    ["destination session", h => h.running([{ actorId: "dest-child", workItemId: "other-work", sessionId: "s", turnId: "t", status: "running" }]), "root", "management"],
    ["same caller other session work", h => h.running([{ actorId: "root", workItemId: "other-work", sessionId: "s", turnId: "t", status: "running" }]), "root", "management"],
    ["other unfinished work", h => h.seed(room => room.workItems.push(work({ id: "other-work", executorActorId: "root", status: "started" }))), "root", "management"],
    ["moved actor unfinished work", h => h.seed(room => room.workItems.push(work({ id: "other-work", executorActorId: "child", status: "started" }))), "root", "management"],
    ["destination unfinished work", h => h.seed(room => room.workItems.push(work({ id: "other-work", executorActorId: "dest-child", status: "started" }))), "root", "management"]
  ];
  for (const [name, arrange, caller, managementId] of cases) await t.test(name, async () => {
    const h = await fixture();
    h.seed(room => room.workItems.push(work({ id: "management", ownerActorId: "root", executorActorId: "root", status: "started" })));
    h.running([{ actorId: "root", workItemId: "management", sessionId: "session", turnId: "turn", status: "running" }]);
    arrange(h); const before = h.read();
    await assert.rejects(h.store.reparent("ws", "child", move("dest"), caller, managementId), ActorHierarchyConflict);
    assert.deepEqual(h.read(), before);
  });
});

test("management exemption never covers pending operations or active rounds", async t => {
  const cases: Array<[string, (room: ActorRoom, management: ActorWorkItem) => void]> = [
    ["dispatch", (_room, management) => { management.dispatchLease = { owner: "x", until: 1 }; }],
    ["recovery", (_room, management) => { management.nativeAgent = { name: "root", provider: "codex", recovery: { requestId: "r", userPrompt: "p", status: "pending", turnId: "t" } }; }],
    ["assignment", (_room, management) => { management.assignmentRequests = [{ requestId: "r", executorActorId: "other", model: MODEL_CATALOG.luna.id, status: "pending" }]; }],
    ["parallel", (room, management) => { management.parallelRequests = [{ requestId: "r", sourceActorId: "root", sourceSessionId: "s", tasks: [], sourceSnapshot: room.actors[0], executorSnapshots: [], userMessages: [], status: "pending", workItemIds: [], lease: null }]; }],
    ["review", (_room, management) => { management.completionReviews = [{ id: "review", workItemId: "management", actorId: "root", ownerActorId: "root", roundId: "r", taskSessionId: "s", taskTurnId: "t", executionRevision: 1, status: "pending", issues: [], created: "2020" }]; }],
    ["task update", (room, management) => { room.taskUpdates = [{ requestId: "r", workItemId: "management", workItem: structuredClone(management), userPrompt: "p", namedActorIds: [], status: "pending", lease: null }]; }],
    ["active round", room => { room.rounds.push({ id: "round", status: "awaiting_pickup", actorSnapshots: [], candidateSnapshots: [], namedActorIds: ["root"], stakeholderIds: [], replies: [], ownerActorId: null } as unknown as ActorRound); }]
  ];
  for (const [name, arrange] of cases) await t.test(name, async () => {
    const h = await fixture();
    h.seed(room => { const management = work({ id: "management", ownerActorId: "root", executorActorId: "root", status: "started" }); room.workItems.push(management); arrange(room, management); });
    h.running([{ actorId: "root", workItemId: "management", sessionId: "s", turnId: "t", status: "running" }]);
    const before = h.read();
    await assert.rejects(h.store.reparent("ws", "child", move(null), "root", "management"), ActorHierarchyConflict);
    assert.deepEqual(h.read(), before);
  });
});

test("a root cannot use its management work exemption to demote itself", async () => {
  const h = await fixture();
  h.seed(room => room.workItems.push(work({ id: "management", ownerActorId: "other", executorActorId: "other", status: "started" })));
  h.running([{ actorId: "other", workItemId: "management", sessionId: "s", turnId: "t", status: "running" }]);
  const before = h.read();
  await assert.rejects(h.store.reparent("ws", "other", move("dest", null, "other"), "other", "management"), ActorHierarchyConflict);
  assert.deepEqual(h.read(), before);
});

test("concurrent hierarchy updates across real stores have exactly one winner", async () => {
  if (process.env.SESSION_PG_SCHEMA) throw new Error("Requires an isolated generated schema; unset SESSION_PG_SCHEMA.");
  const path = `/private/tmp/actor-hierarchy-${randomUUID()}`;
  const first = new SessionStore(path), second = new SessionStore(path);
  try {
    await Promise.all([first.ready(), second.ready()]);
    const store = new DomainActorStore(first), other = new DomainActorStore(second);
    for (const [id, parentActorId] of [["root", undefined], ["child", "root"], ["dest", undefined]] as const)
      await store.create("default", { id, name: id, parentActorId, model: MODEL_CATALOG.luna.id, memory });
    const results = await Promise.allSettled([store.reparent("default", "child", move(null)), other.reparent("default", "child", move("dest"))]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof ActorHierarchyConflict);
    const room = await other.getRoom("default"), child = room.actors.find(actor => actor.id === "child")!;
    assert.ok(child.rootActorId === "child" || child.rootActorId === "dest");
    assert.equal(child.parentActorId, child.rootActorId === "child" ? null : "dest");
  } finally { await Promise.all([first.close(), second.close()]); }
});
