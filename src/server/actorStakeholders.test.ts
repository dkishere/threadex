import assert from "node:assert/strict";
import test from "node:test";
import { pickStakeholders } from "./decision/actors";
import { fakeBackend } from "./decision/fake";
import { createDecisionPolicy, type DecisionAudit } from "./decision/policy";
import { durableDecision } from "./decision/service";
import type { BackendId, Decision, DecisionBackend, DecisionRequest, PurposePolicy } from "./decision/types";

const audit = { workspaceId: "workspace", roundId: "round" };
const actors = ["a", "b", "c"].map(id => ({ id, systemHeader: "Developer", roleSummary: `Domain ${id}` }));
const policy: PurposePolicy = { order: ["fake"], threshold: { fake: 0.5, jev: 0.5, llm: 0.7 } };
function backend(scores: Record<string, number>, id: BackendId = "fake", inspect?: (req: DecisionRequest) => void): DecisionBackend {
  return { ...fakeBackend(req => {
    inspect?.(req);
    return { ok: true, backend: id, model: "fake", calibrated: false, latencyMs: 0,
      answers: Object.fromEntries(Object.entries(scores).map(([key, probability]) => [key, { kind: "predicate", probability }])) };
  }), id };
}
function decide(scores: Record<string, number>, id: BackendId = "fake", inspect?: (req: DecisionRequest) => void): Decision {
  return createDecisionPolicy({ backends: [backend(scores, id, inspect)], policy: () => ({ ...policy, order: [id] }) });
}
const context = { userPrompt: "Review this feature", actors, audit, policy };

test("one batched Decision selects all qualifying SH and preserves a frozen audit snapshot", async () => {
  let calls = 0;
  const result = await pickStakeholders({ ...context, decide: decide({ a: 0.8, b: 0.5, c: 0.3 }, "fake", req => {
    calls++;
    assert.equal(req.purpose, "sh_pick");
    assert.deepEqual(req.audit, audit);
    assert.deepEqual(req.questions.map(q => [q.id, q.kind]), actors.map(actor => [actor.id, "predicate"]));
    assert.deepEqual(JSON.parse(req.state), { userPrompt: context.userPrompt, actors });
  }) });
  assert.equal(calls, 1);
  assert.ok(result.ok);
  assert.deepEqual(result.selection.actorIds, ["a", "b"]);
  assert.deepEqual(result.selection.audit, audit);
  assert.deepEqual(result.selection.probabilities, { a: 0.8, b: 0.5, c: 0.3 });
  assert.ok(Object.isFrozen(result.selection) && Object.isFrozen(result.selection.actorIds)
    && Object.isFrozen(result.selection.audit) && Object.isFrozen(result.selection.probabilities));
});

test("below-threshold fallback selects exactly the highest candidate", async () => {
  const result = await pickStakeholders({ ...context, decide: decide({ a: 0.1, b: 0.3, c: 0.2 }) });
  assert.ok(result.ok);
  assert.deepEqual(result.selection.actorIds, ["b"]);
});

test("ties prefer previous owner then stable input order without overriding higher scores", async () => {
  for (const [scores, previousOwnerId, expected] of [
    [{ a: 0.2, b: 0.2, c: 0.2 }, "b", ["b"]],
    [{ a: 0.2, b: 0.2, c: 0.2 }, "absent", ["a"]],
    [{ a: 0.7, b: 0.7, c: 0.7 }, "c", ["c", "a", "b"]],
    [{ a: 0.9, b: 0.7, c: 0.7 }, "c", ["a", "c", "b"]]
  ] as const) {
    const result = await pickStakeholders({ ...context, previousOwnerId, decide: decide(scores) });
    assert.ok(result.ok);
    assert.deepEqual(result.selection.actorIds, expected);
  }
});

test("SH cap is eight after score ranking and previous-owner tie preference", async () => {
  const candidates = Array.from({ length: 11 }, (_, index) => ({ ...actors[0], id: `actor-${index}` }));
  const result = await pickStakeholders({ ...context, actors: candidates, previousOwnerId: "actor-10",
    decide: decide(Object.fromEntries(candidates.map(actor => [actor.id, 0.8]))) });
  assert.ok(result.ok);
  assert.deepEqual(result.selection.actorIds, ["actor-10", ...candidates.slice(0, 7).map(actor => actor.id)]);
  assert.equal(Object.keys(result.selection.probabilities).length, 11);
});

test("threshold comes from the successful backend, including fallback backend", async () => {
  const scores = { a: 0.8, b: 0.6, c: 0.4 };
  const jev = await pickStakeholders({ ...context, decide: decide(scores, "jev") });
  const llm = await pickStakeholders({ ...context, decide: createDecisionPolicy({ backends: [backend(scores, "llm")],
    policy: () => ({ ...policy, order: ["jev", "llm"] }) }) });
  assert.ok(jev.ok && llm.ok);
  assert.deepEqual(jev.selection.actorIds, ["a", "b"]);
  assert.deepEqual(llm.selection.actorIds, ["a"]);
  assert.equal(llm.selection.threshold, 0.7);
});

test("no candidates skips inference; failed or malformed Decisions do not select SH", async () => {
  assert.deepEqual(await pickStakeholders({ ...context, actors: [], decide: async () => { throw new Error("must not call"); } }),
    { ok: false, reason: "routing_failed" });
  for (const decision of [
    createDecisionPolicy({ backends: [], policy: () => policy }),
    decide({ a: NaN, b: 0.5, c: 0.5 })
  ]) {
    const result = await pickStakeholders({ ...context, decide: decision });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "routing_failed");
  }
});

test("round replay reuses durable Decision and leaves the same selected SH", async () => {
  const saved = new Map<string, DecisionAudit>();
  let calls = 0;
  const factory = () => durableDecision(record => createDecisionPolicy({
    backends: [backend({ a: 0.8, b: 0.6, c: 0.3 }, "fake", () => { calls++; })],
    policy: () => policy, audit: record
  }), { load: async key => saved.get(key) ?? null,
    save: async (key, entry) => { saved.set(key, saved.get(key) ?? entry); return saved.get(key)!; }, usage: async () => {} });
  const first = await pickStakeholders({ ...context, decide: factory() });
  const replay = await pickStakeholders({ ...context, decide: factory() });
  assert.deepEqual(first, replay);
  assert.equal(calls, 1);
});

test("configuration errors are explicit and caller mutation cannot change an in-flight snapshot", async () => {
  await assert.rejects(pickStakeholders({ ...context, actors: [actors[0], actors[0]], decide: decide({ a: 0.8 }) }), /unique/);
  await assert.rejects(pickStakeholders({ ...context, policy: { ...policy, threshold: {} }, decide: decide({ a: 0.8, b: 0.6, c: 0.3 }) }), /threshold/);
  const mutable = { ...context, actors: actors.map(actor => ({ ...actor })), audit: { ...audit }, policy: { ...policy, threshold: { ...policy.threshold } } };
  const result = await pickStakeholders({ ...mutable, previousOwnerId: "b", decide: async req => {
    mutable.actors[0].id = "changed";
    mutable.audit.roundId = "changed";
    mutable.policy.threshold.fake = 1;
    return decide({ a: 0.8, b: 0.8, c: 0.3 })(req);
  } });
  assert.ok(result.ok);
  assert.deepEqual(result.selection.actorIds, ["b", "a"]);
  assert.equal(result.selection.audit.roundId, "round");
  assert.equal(result.selection.threshold, 0.5);
});

test("continuations of the preceding request go back to its claimants despite literal keyword scores", async () => {
  const continuation = "context:continuesLastRequest";
  const recentRequests = [{ userPrompt: "Older work", claimantIds: ["c"] }, { userPrompt: "Fix waiting for limit reset", claimantIds: ["a"] }];
  const single = await pickStakeholders({ ...context, userPrompt: "If the account is switched, clear it too", recentRequests,
    decide: decide({ a: 0.01, b: 0.98, c: 0.01, [continuation]: 0.95 }, "fake", req => {
      assert.deepEqual(JSON.parse(req.state), { userPrompt: "If the account is switched, clear it too", recentRequests, actors });
      assert.equal(req.questions.at(-1)!.id, continuation);
      assert.match(req.questions[0].instructions, /recentRequests/);
    }) });
  assert.ok(single.ok);
  assert.deepEqual(single.selection.actorIds, ["a", "b"], "the earlier claimant leads; keyword matches still join");
  assert.deepEqual(single.selection.continuation, { probability: 0.95, actorIds: ["a"] });
  assert.ok(Object.isFrozen(single.selection.continuation));

  // Several earlier claimants all return; their replies and claim arbitration pick the owner.
  const several = await pickStakeholders({ ...context, recentRequests: [{ userPrompt: "Fix it", claimantIds: ["a", "c", "removed"] }],
    decide: decide({ a: 0.01, b: 0.2, c: 0.01, [continuation]: 0.9 }) });
  assert.ok(several.ok);
  assert.deepEqual(several.selection.actorIds, ["a", "c"], "claimants no longer eligible are skipped; no unrelated fallback is added");

  // Unrelated work and routing questions keep normal picking.
  const unrelated = await pickStakeholders({ ...context, recentRequests,
    decide: decide({ a: 0.01, b: 0.98, c: 0.01, [continuation]: 0.05 }) });
  assert.ok(unrelated.ok);
  assert.deepEqual(unrelated.selection.actorIds, ["b"]);
  assert.equal(unrelated.selection.continuation, undefined);
});

test("without a direct preceding request picking asks no continuation question", async () => {
  const result = await pickStakeholders({ ...context, recentRequests: [], decide: decide({ a: 0.8, b: 0.6, c: 0.3 }, "fake", req => {
    assert.deepEqual(req.questions.map(q => q.id), ["a", "b", "c"]);
    assert.doesNotMatch(req.questions[0].instructions, /recentRequests/);
  }) });
  assert.ok(result.ok);
  assert.deepEqual(result.selection.actorIds, ["a", "b"]);
});
