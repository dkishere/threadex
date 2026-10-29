import assert from "node:assert/strict";
import test from "node:test";
import { ActorAllocationValidationError, validateActorAllocation } from "./domainActorAllocation";

function quotedPlan() {
  return { error: null, requirements: [
    { id: "review", messageIndex: 0, source: "做 review ✅，", description: "Review first" },
    { id: "ui", messageIndex: 0, source: "然後顯示 👩‍💻 conclusion。", description: "Display the reviewed conclusion" }
  ], assignments: [
    { id: "backend", actorId: "a", requirementIds: ["review"], brief: "Run review", dependsOn: [] as string[] },
    { id: "frontend", actorId: "b", requirementIds: ["ui"], brief: "Display after passing review", dependsOn: ["backend"] }
  ], review: { overlaps: [], conflicts: [], uncovered: [] } };
}
const messages = ["做 review ✅，然後顯示 👩‍💻 conclusion。"];

test("exact source quotes produce correct UTF-16 spans without model character counting", () => {
  const input = quotedPlan();
  const plan = validateActorAllocation(input, messages, ["a", "b"]);
  assert.equal(plan.requirements[0].start, 0);
  assert.equal(plan.requirements[0].end, input.requirements[0].source.length);
  assert.equal(plan.requirements[1].start, input.requirements[0].source.length);
  assert.equal(plan.requirements[1].end, messages[0].length);
  assert.ok(plan.requirements.every(req => !("source" in req)));
  assert.ok(input.requirements.every(req => "source" in req && !("start" in req)), "validation does not mutate the model response");
  assert.deepEqual(validateActorAllocation(plan, messages, ["a", "b"]), plan, "saved numeric plans remain valid");
});

test("allocation diagnostics identify exact coverage, ownership and dependency failures", () => {
  const cases: Array<[string, (plan: ReturnType<typeof quotedPlan>) => void]> = [
    ["source_quote", p => { p.requirements[0].source = "different text"; }],
    ["source_gap", p => { p.requirements[0].source = "做 review ✅"; }],
    ["source_overlap", p => { p.requirements[0].source = messages[0]; }],
    ["duplicate_owner", p => { p.assignments[1].requirementIds.push("review"); }],
    ["unassigned_requirement", p => { p.requirements.push({ id: "extra", messageIndex: 1, source: "Extra", description: "Extra requirement" }); }],
    ["unknown_dependency", p => { p.assignments[1].dependsOn = ["a"]; }],
    ["dependency_cycle", p => { p.assignments[0].dependsOn = ["frontend"]; }],
    ["review", p => { (p.review as unknown as { conflicts: unknown }).conflicts = {}; }]
  ];
  for (const [code, mutate] of cases) {
    const plan = quotedPlan(); mutate(plan);
    assert.throws(() => validateActorAllocation(plan, code === "unassigned_requirement" ? [...messages, "Extra"] : messages, ["a", "b"]),
      (error: unknown) => error instanceof ActorAllocationValidationError && error.code === code, code);
  }
});

test("every validated split names an existing integration assignment", () => {
  assert.equal(validateActorAllocation(quotedPlan(), messages, ["a", "b"]).integrationAssignmentId, "frontend",
    "without an explicit owner the assignment integrating the most others hosts the split");
  assert.equal(validateActorAllocation({ ...quotedPlan(), integrationAssignmentId: "backend" }, messages, ["a", "b"]).integrationAssignmentId, "backend");
  assert.throws(() => validateActorAllocation({ ...quotedPlan(), integrationAssignmentId: "a" }, messages, ["a", "b"]),
    (error: unknown) => error instanceof ActorAllocationValidationError && error.code === "unknown_integration");
});

test("ambiguous quotes and invalid shapes fail explicitly without guessing ownership", () => {
  const plan = quotedPlan();
  plan.requirements[0].source = "review";
  assert.throws(() => validateActorAllocation(plan, ["review review"], ["a", "b"]), /ambiguous_source/);
  for (const value of [null, {}, { requirements: [null], assignments: [{}, {}], review: { overlaps: [], conflicts: [], uncovered: [] } }]) {
    assert.throws(() => validateActorAllocation(value, messages, ["a", "b"]), ActorAllocationValidationError);
  }
});
