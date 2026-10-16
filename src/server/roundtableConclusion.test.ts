import assert from "node:assert/strict";
import test from "node:test";
import { parseRoundtableConclusion, roundtableSynthesisMarkdown } from "../roundtable";

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

test("a review with no findings can state its limits without fabricated sections", () => {
  const empty = { taskType: "code_review", template: "summary", overview: "No findings were reported; runtime behaviour was not tested.", sections: [] };
  const parsed = parseRoundtableConclusion(JSON.stringify(empty), names)!;
  assert.deepEqual(parsed, empty);
  assert.equal(roundtableSynthesisMarkdown(parsed, 2), empty.overview);
});
