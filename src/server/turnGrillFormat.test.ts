import assert from "node:assert/strict";
import test from "node:test";
import { grillHandoff, parseGrillIssues, mergeGrillEdits, type GrillRound } from "../turnGrill";

test("three-way edit merge keeps remote answers and new issues, and reports same-field conflicts", () => {
  const base = parseGrillIssues([{ id: "q1", md: "Original", responseMd: "", status: "open" }]);
  const local = [{ ...base[0], md: "Local" }];
  const remote = [{ ...base[0], selected: false, responseMd: "Answer", status: "resolved" as const }, { ...base[0], id: "q2" }];
  const result = mergeGrillEdits(base, local, remote);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.issues[0].md, "Local");
  assert.equal(result.issues[0].selected, false);
  assert.equal(result.issues[0].responseMd, "Answer");
  assert.equal(result.issues[0].status, "open");
  assert.equal(result.issues[1].id, "q2");
  assert.deepEqual(mergeGrillEdits(base, local, [{ ...remote[0], md: "Remote" }]).conflicts, ["q1.md"]);
  assert.deepEqual(mergeGrillEdits(base, local, [{ ...remote[0], md: "Local" }]).conflicts, []);
});

test("Grill rejects malformed, duplicate and oversized issues", () => {
  const issue = { id: "q1", md: "**Question**", responseMd: "Answer", status: "open" };
  assert.throws(() => parseGrillIssues("plain text"));
  assert.throws(() => parseGrillIssues([issue, issue]));
  assert.throws(() => parseGrillIssues([{ ...issue, md: " " }]));
  assert.throws(() => parseGrillIssues([{ ...issue, status: "invented" }]));
  assert.throws(() => parseGrillIssues([{ ...issue, dropped: "yes" }]));
  assert.throws(() => parseGrillIssues([{ ...issue, impact: "minor" }]));
  assert.throws(() => parseGrillIssues([{ ...issue, responseMd: "a".repeat(32001) }]));
  assert.equal(parseGrillIssues([{ ...issue, impact: "non_blocking" }])[0].impact, "non_blocking");
  assert.deepEqual(parseGrillIssues([]), []);
});

test("main handoff includes selected questions, answers and optional instructions only", () => {
  const issues = parseGrillIssues([
    { id: "q1", md: "Chosen", responseMd: "Plan", status: "resolved" },
    { id: "q2", md: "Excluded", responseMd: "Other", status: "open", selected: false },
    { id: "q3", md: "Irrelevant", responseMd: "Dropped response", status: "open", selected: true, dropped: true }
  ]);
  const prompt = grillHandoff(issues, "Keep the API compatible");
  assert.match(prompt, /\*\*User \(Start work instructions\):\*\*\nKeep the API compatible/);
  assert.match(prompt, /Chosen/); assert.match(prompt, /Plan/); assert.match(prompt, /Keep the API compatible/);
  assert.doesNotMatch(prompt, /Excluded|Other|Irrelevant|Dropped response/);
  assert.throws(() => grillHandoff([{ ...issues[2], selected: true }], ""));
  assert.throws(() => grillHandoff([], ""));
});

test("handoff preserves thread answers overwritten by re-grill and filters inactive history", () => {
  const issue = { id: "q1", md: "Current question", responseMd: "Reviewer follow-up", status: "open" as const, selected: true };
  const rounds: GrillRound[] = [
    { id: "r1", created: "", action: "respond", prompt: "Consider compatibility", issues: [
      { ...issue, md: "Original question", responseMd: "Thread action plan" },
      { ...issue, id: "q2", responseMd: "Excluded answer" }
    ] },
    { id: "r2", created: "", action: "followup", prompt: "", issues: [issue] },
    { id: "r3", created: "", action: "save", prompt: "", issues: [{ ...issue, responseMd: "Saved snapshot" }] },
    { id: "r4", created: "", action: "respond", prompt: "", issues: [{ ...issue, selected: false, responseMd: "Inactive snapshot" }] }
  ];
  const prompt = grillHandoff([issue], "Proceed", rounds);
  assert.equal(prompt.split("Current question").length - 1, 1);
  assert.doesNotMatch(prompt, /Original question|Question at this round/);
  assert.match(prompt, /Round 1\n\*\*User:\*\*\nConsider compatibility[\s\S]*\*\*Agent:\*\*\nThread action plan/);
  assert.match(prompt, /Round 2[\s\S]*\*\*Griller:\*\*\nReviewer follow-up/);
  assert.doesNotMatch(prompt, /Excluded answer|Saved snapshot|Inactive snapshot/);
  assert.ok(prompt.endsWith("Proceed"));
});
