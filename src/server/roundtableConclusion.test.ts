import assert from "node:assert/strict";
import test from "node:test";
import { parseRoundtableConclusion, roundtableIssueKind, roundtableSynthesisMarkdown } from "../roundtable";

const names = ["Robin", "Willow"];
const findings = {
  taskType: "code_review", template: "summary", overview: "One bug and a test gap were reported.",
  sections: [{ title: "Findings", items: [
    { text: "**P1:** Retry can duplicate writes. See [write.ts:42](/src/write.ts:42).", actors: names },
    { text: "No test covers a reconnect after a partial write.", actors: ["Robin"] }
  ] }, { title: "Open questions", items: [{ text: "The server's retry guarantee was not verified.", actors: ["Willow"] }] }]
};
const issues = [{ topic: "Retry policy", positions: [{ view: "Use idempotency keys", actors: names }] }];

test("task classification selects a validated template and keeps legacy decisions readable", () => {
  const legacy = parseRoundtableConclusion(JSON.stringify({ issues }), names)!;
  assert.deepEqual(legacy, { issues });
  assert.match(roundtableSynthesisMarkdown(legacy, 2), /Consensus/);
  assert.deepEqual(parseRoundtableConclusion(JSON.stringify({ taskType: "decision", template: "decision", issues }), names),
    { taskType: "decision", template: "decision", issues });
  for (const taskType of ["code_review", "research", "summary"]) {
    const parsed = parseRoundtableConclusion("```json\n" + JSON.stringify({ ...findings, taskType }) + "\n```", names)!;
    assert.deepEqual(parsed, { ...findings, taskType });
    const markdown = roundtableSynthesisMarkdown(parsed, 2);
    assert.match(markdown, /One bug and a test gap/);
    assert.match(markdown, /\[write.ts:42\]\(\/src\/write.ts:42\)/);
    assert.match(markdown, /not verified/);
    assert.match(markdown, /Robin, Willow/);
    assert.doesNotMatch(markdown, /Consensus|Disagreements|No position recorded/);
  }
});

test("mismatched classification, mixed schemas and unsupported attribution keep the raw output", () => {
  for (const invalid of [
    { ...findings, taskType: "decision" }, { ...findings, taskType: "unknown" },
    { ...findings, taskType: undefined }, { ...findings, template: undefined },
    { ...findings, template: "unknown" }, { ...findings, issues },
    { taskType: "research", template: "decision", issues }, { template: "decision", issues },
    { ...findings, overview: " " }, { ...findings, sections: {} },
    { ...findings, sections: [null] }, { ...findings, sections: [{ title: "Findings", items: [] }] },
    ...[[], ["Ghost"], ["Robin", 1]].map(actors => ({ ...findings, sections: [{ title: "Findings", items: [{ text: "Bug", actors }] }] })),
    null, [], "Unstructured response"
  ]) assert.equal(parseRoundtableConclusion(JSON.stringify(invalid), names), null, JSON.stringify(invalid));
  assert.equal(parseRoundtableConclusion(JSON.stringify(findings), []), null);
  assert.equal(parseRoundtableConclusion(JSON.stringify(findings), ["Robin", "Robin"]), null);
});

test("a host's mismatched closing bracket is repaired, but truncated or ambiguous output stays raw", () => {
  const decision = { taskType: "decision", template: "decision", issues: [{ topic: "Retry policy", positions: [{ view: "Use keys",
    actors: names, details: [{ actors: ["Robin"], detail: "Keys {stay} [stable]." }, { actors: ["Willow"], detail: "Add a test." }] }] }] };
  const valid = JSON.stringify(decision);
  const swapped = valid.replace('{"actors":["Willow"]', '{"actors":["Willow"}');
  assert.notEqual(swapped, valid);
  assert.deepEqual(parseRoundtableConclusion("```json\n" + swapped + "\n```", names), decision);
  for (const text of [valid.slice(0, -2), valid + "}", swapped.replace('"Add a test."', '"Add a test.')])
    assert.equal(parseRoundtableConclusion(text, names), null, text);
});

test("scope notes stay out of positions, close the decision markdown and never join a summary", () => {
  const scope = [{ actors: ["Willow"], text: "Read-only inspection; deployed state was not verified." }];
  const decision = parseRoundtableConclusion(JSON.stringify({ taskType: "decision", template: "decision", issues, scope }), names)!;
  assert.deepEqual(decision, { taskType: "decision", template: "decision", issues, scope });
  assert.match(roundtableSynthesisMarkdown(decision, 2), /\*\*Consensus\*\*[\s\S]*\*\*Verification scope\*\*\n\n- Willow: Read-only inspection; deployed state was not verified\.$/);
  assert.deepEqual(parseRoundtableConclusion(JSON.stringify({ issues, scope: [] }), names), { issues }, "an empty scope array is omitted");
  assert.deepEqual(parseRoundtableConclusion(JSON.stringify({ issues, scope: [{ actors: ["Robin"], text: " Same note " }, { actors: ["Willow", "Willow"], text: "Same note" }] }), names),
    { issues, scope: [{ actors: ["Robin", "Willow"], text: "Same note" }] }, "identical notes merge their actors");
  for (const invalid of [
    { issues, scope: {} }, { issues, scope: [null] }, { issues, scope: [{ actors: [], text: "No actor" }] },
    { issues, scope: [{ actors: ["Ghost"], text: "Unknown actor" }] }, { issues, scope: [{ actors: ["Robin"], text: " " }] },
    { ...findings, scope }
  ]) assert.equal(parseRoundtableConclusion(JSON.stringify(invalid), names), null, JSON.stringify(invalid));
});

test("a review with no findings can state its limits without fabricated sections", () => {
  const empty = { taskType: "code_review", template: "summary", overview: "No findings were reported; runtime behaviour was not tested.", sections: [] };
  const parsed = parseRoundtableConclusion(JSON.stringify(empty), names)!;
  assert.deepEqual(parsed, empty);
  assert.equal(roundtableSynthesisMarkdown(parsed, 2), empty.overview);
});

test("a rollout proposal and verification caveat do not invent opposition or another supporter", () => {
  const output = { taskType: "decision", template: "decision", issues: [{ topic: "Rollout sequence", positions: [{
    view: "Validate both local targets before changing Gateway integrations.", actors: ["Willow"],
    details: [{ actors: ["Willow"], detail: "Keep worker versions fixed during comparison." }]
  }] }], scope: [{ actors: ["Robin"], text: "No changes or tests were run; deployed AWS state was not verified." }],
  openQuestions: [{ actors: names, text: "Is the ingestion worker deployed elsewhere?" }] };
  const parsed = parseRoundtableConclusion(JSON.stringify(output), names)!;
  assert.ok(parsed.template !== "summary");
  assert.equal(roundtableIssueKind(parsed.issues[0], 2), "partial", "scope and questions are not votes");
  const markdown = roundtableSynthesisMarkdown(parsed, 2);
  assert.match(markdown, /Validate both local targets[\s\S]*Keep worker versions fixed/);
  assert.match(markdown, /\*\*Open questions\*\*[\s\S]*\*\*Verification scope\*\*/);
  assert.doesNotMatch(markdown, /Consensus|Disagreements/);
});

test("compatible details remain consensus while now-versus-wait remains a disagreement", () => {
  const parsed = parseRoundtableConclusion(JSON.stringify({ issues: [
    { topic: "Boundary", positions: [{ view: "Keep workers separate", actors: names,
      details: [{ actors: ["Robin"], detail: "Pin worker versions independently." }, { actors: ["Willow"], detail: "Preserve worker triggers." }] }] },
    { topic: "Timing", positions: [{ view: "Migrate now", actors: ["Robin"] }, { view: "Defer migration", actors: ["Willow"] }] }
  ] }), names)!;
  assert.ok(parsed.template !== "summary");
  assert.deepEqual(parsed.issues.map(issue => roundtableIssueKind(issue, 2)), ["consensus", "disagreement"]);
  assert.match(roundtableSynthesisMarkdown(parsed, 2), /\*\*Disagreements\*\*[\s\S]*Migrate now[\s\S]*Defer migration/);
});

test("decisions can contain only questions or scope without fabricated positions", () => {
  for (const field of ["scope", "openQuestions"] as const) {
    const output = { taskType: "decision", template: "decision", issues: [],
      [field]: [{ actors: names, text: "Deployment state remains unverified." }] };
    const parsed = parseRoundtableConclusion(JSON.stringify(output), names)!;
    assert.deepEqual(parsed, output);
    assert.doesNotMatch(roundtableSynthesisMarkdown(parsed, 2), /Consensus|Disagreements|Other points/);
    for (const invalid of [null, {}, [null], [{ actors: ["Ghost"], text: "Question" }],
      [{ actors: [], text: "Question" }], [{ actors: names, text: " " }]]) {
      assert.equal(parseRoundtableConclusion(JSON.stringify({ ...output, [field]: invalid }), names), null);
    }
    assert.equal(parseRoundtableConclusion(JSON.stringify({ ...findings, [field]: [] }), names), null);
  }
  assert.equal(parseRoundtableConclusion(JSON.stringify({ issues: [], scope: [], openQuestions: [] }), names), null);
});
