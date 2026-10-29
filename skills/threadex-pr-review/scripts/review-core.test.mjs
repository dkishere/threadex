import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deriveUnit, finalizeReview, parseUnifiedDiff, validateReview } from "./review-core.mjs";

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@ export function a() {",
  " const x = 1;",
  "-const y = 2;",
  "+const y = 3;",
  "+const z = 4;",
  " return x;",
  "@@ -10 +11 @@",
  "--- removed line that looks like a header",
  "+++ added line that looks like a header",
  "diff --git a/src/a.test.ts b/src/a.test.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/a.test.ts",
  "@@ -0,0 +1,2 @@",
  "+test(\"a\", () => {});",
  "+// done",
  "\\ No newline at end of file",
  "diff --git a/old.txt b/new.txt",
  "similarity index 100%",
  "rename from old.txt",
  "rename to new.txt",
  "diff --git a/gone.md b/gone.md",
  "deleted file mode 100644",
  "--- a/gone.md",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/logo.png b/logo.png",
  "Binary files a/logo.png and b/logo.png differ",
  ""
].join("\n");

test("parses files, hunks and line counts from git diff output", () => {
  const files = parseUnifiedDiff(patch);
  assert.deepEqual(files.map((file) => [file.path, file.status, file.test, file.additions, file.deletions, file.hunks.length]), [
    ["src/a.ts", "modified", false, 3, 2, 2],
    ["src/a.test.ts", "added", true, 2, 0, 1],
    ["new.txt", "renamed", false, 0, 0, 1],
    ["gone.md", "deleted", false, 0, 1, 1],
    ["logo.png", "modified", false, 0, 0, 1]
  ]);
  assert.equal(files[0].hunks[0].header, "export function a() {");
  assert.deepEqual([files[0].hunks[1].oldStart, files[0].hunks[1].oldLines, files[0].hunks[1].newStart, files[0].hunks[1].newLines], [10, 1, 11, 1]);
  assert.equal(files[2].oldPath, "old.txt");
  assert.equal(files[2].hunks[0].header, "(renamed)");
  assert.equal(files[4].binary, true);
  assert.equal(new Set(files.flatMap((file) => file.hunks.map((hunk) => hunk.id))).size, 6);
  assert.deepEqual(parseUnifiedDiff(patch).map((file) => file.hunks.map((hunk) => hunk.id)), files.map((file) => file.hunks.map((hunk) => hunk.id)));
});

test("unquotes git-escaped paths", () => {
  const [file] = parseUnifiedDiff([
    "diff --git \"a/caf\\303\\251 x.txt\" \"b/caf\\303\\251 x.txt\"",
    "--- \"a/caf\\303\\251 x.txt\"",
    "+++ \"b/caf\\303\\251 x.txt\"",
    "@@ -1 +1 @@",
    "-a",
    "+b"
  ].join("\n"));
  assert.equal(file.path, "café x.txt");
});

const context = () => {
  const files = parseUnifiedDiff(patch);
  return { schemaVersion: 1, source: { kind: "local", base: "main", mergeBase: "base", head: "head" }, commits: [], files };
};

const rated = (score, evidence = ["src/a.ts:1"]) => ({ score, rationale: "Checked.", evidence: score === null ? [] : evidence });

function review(overrides = {}) {
  const files = context().files;
  const [code, test, rename, deleted, binary] = files.map((file) => file.hunks.map((hunk) => hunk.id));
  return {
    schemaVersion: 1,
    source: { kind: "local", base: "main", mergeBase: "base", head: "head" },
    spec: { summary: "Change a.", sources: ["user request"] },
    excluded: [{ hunk: binary[0], reason: "binary asset" }],
    units: [{
      id: "core",
      title: "Change a",
      summary: "Updates a.",
      area: "server",
      hunks: [...code, ...rename, ...deleted],
      testHunks: test,
      scores: {
        risk: { level: "low", factors: ["none"], rationale: "Local." },
        complexity: { level: "low", rationale: "Straight-line." },
        implementation: rated(3), coverage: rated(3, ["src/a.test.ts:1"]), conventions: rated(3), simplicity: rated(3), spec: rated(3)
      },
      findings: [],
      ...overrides
    }]
  };
}

test("accepts a complete review and derives a green unit", () => {
  const outcome = finalizeReview(context(), review());
  assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));
  const [unit] = outcome.result.units;
  assert.equal(unit.derived.status, "green");
  assert.deepEqual(unit.derived.metrics, { files: 4, additions: 3, deletions: 3, testAdditions: 2, testDeletions: 0 });
  assert.deepEqual(outcome.result.summary, { status: "green", units: 1, red: 0, amber: 0, green: 1, excludedHunks: 1, redFlags: [] });
});

test("rejects unassigned, duplicated and unknown hunks", () => {
  const value = review();
  const [first] = value.units[0].hunks;
  value.units[0].hunks = [first, first, "hdeadbeef00"];
  const { errors } = validateReview(context(), value);
  assert.ok(errors.some((error) => error.includes(`hunk ${first} is already assigned to core`)));
  assert.ok(errors.some((error) => error.includes("unknown hunk hdeadbeef00")));
  assert.ok(errors.some((error) => /3 hunk\(s\) are neither assigned/.test(error)));
});

test("rejects reviews written for another range", () => {
  const value = review();
  value.source = { ...value.source, head: "other" };
  assert.ok(validateReview(context(), value).errors.some((error) => error.startsWith("source:")));
});

test("requires a finding for every deduction and keeps severity consistent with the score", () => {
  const deducted = review();
  deducted.units[0].scores.implementation = rated(2);
  assert.ok(validateReview(context(), deducted).errors.some((error) => error.includes("scores.implementation: scored 2 without a finding")));

  const inconsistent = review({ findings: [{ dimension: "implementation", severity: "major", confidence: "verified", location: "src/a.ts:2", summary: "Wrong value.", failureScenario: "y=3 breaks callers." }] });
  inconsistent.units[0].scores.implementation = rated(2);
  assert.ok(validateReview(context(), inconsistent).errors.some((error) => error.includes("a major finding caps implementation at 1, but it scored 2")));

  const missingScenario = review({ findings: [{ dimension: "implementation", severity: "major", confidence: "verified", location: "src/a.ts:2", summary: "Wrong value." }] });
  missingScenario.units[0].scores.implementation = rated(1);
  assert.ok(validateReview(context(), missingScenario).errors.some((error) => error.endsWith("blocker and major findings need a concrete failure scenario")));
});

test("requires evidence and an N/A spec when no intent is stated", () => {
  const value = review();
  value.spec.summary = "";
  value.units[0].scores.conventions = { score: 3, rationale: "Fine.", evidence: [] };
  value.units[0].scores.implementation.evidence = ["src/a.ts"];
  const { errors } = validateReview(context(), value);
  assert.ok(errors.some((error) => error.includes("scores.spec: must be null when spec.summary is empty")));
  assert.ok(errors.some((error) => error.includes("scores.conventions: a full score needs evidence")));
  assert.ok(errors.some((error) => error.includes("implementation.evidence[0]: expected \"path:line\"")));
});

test("rejects findings on N/A dimensions and misuse of the none risk factor", () => {
  const value = review({ findings: [{ dimension: "spec", severity: "nit", confidence: "verified", location: "src/a.ts:1", summary: "Extra." }] });
  value.units[0].scores.spec = rated(null);
  value.units[0].scores.risk = { level: "high", factors: ["none"], rationale: "Hm." };
  const { errors } = validateReview(context(), value);
  assert.ok(errors.some((error) => error.includes("spec is N/A, so it cannot carry findings")));
  assert.ok(errors.some((error) => error.includes("\"none\" stands alone and only with level low")));
});

test("accepts a test-only unit and counts its lines as test lines", () => {
  const value = review();
  const testHunks = value.units[0].testHunks;
  value.units[0].testHunks = [];
  value.units.push({
    ...structuredClone(value.units[0]), id: "tests-only", area: "test", hunks: undefined, testHunks,
    scores: { ...value.units[0].scores, coverage: { score: null, rationale: "The unit is a test.", evidence: [] } }
  });
  const outcome = finalizeReview(context(), value);
  assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));
  assert.deepEqual(outcome.result.units[1].derived.metrics, { files: 1, additions: 0, deletions: 0, testAdditions: 2, testDeletions: 0 });

  const empty = review();
  empty.units[0].hunks = [];
  empty.units[0].testHunks = [];
  assert.ok(validateReview(context(), empty).errors.some((error) => error === "units[0]: expected at least one hunk in hunks or testHunks"));
});

test("warns when test and production hunks are listed on the wrong side", () => {
  const value = review();
  const [unit] = value.units;
  [unit.hunks, unit.testHunks] = [[...unit.testHunks, ...unit.hunks.slice(1)], [unit.hunks[0]]];
  const { warnings } = validateReview(context(), value);
  assert.ok(warnings.some((warning) => warning.includes("(src/a.test.ts) is a test file; move it to testHunks")));
  assert.ok(warnings.some((warning) => warning.includes("(src/a.ts) is not a test file")));
});

test("checks evidence and finding locations against the reviewed files", () => {
  const value = review({ findings: [{ dimension: "simplicity", severity: "nit", confidence: "verified", location: "src/missing.ts:1", summary: "Elsewhere." }] });
  value.units[0].scores.implementation.evidence = ["src/a.ts:99"];
  const lineCount = (path) => ({ "src/a.ts": 20, "src/a.test.ts": 2 })[path] ?? null;
  const { errors, warnings } = validateReview(context(), value, { lineCount });
  assert.ok(errors.some((error) => error.endsWith("line 99 is past the end of src/a.ts (20 lines)")));
  assert.ok(errors.some((error) => error.endsWith("src/missing.ts does not exist at the reviewed head")));
  assert.ok(!warnings.some((warning) => warning.startsWith("evidence locations were not checked")));
  assert.ok(validateReview(context(), review()).warnings.includes("evidence locations were not checked against the reviewed files"));
});

test("requires off-diff findings to name the hunk that enables them", () => {
  const ctx = context();
  const finding = { dimension: "implementation", severity: "minor", confidence: "verified", location: "src/a.ts:30", summary: "Caller now reachable.", failureScenario: "x" };
  const value = review({ findings: [finding] });
  value.units[0].scores.implementation = rated(2);
  assert.ok(validateReview(ctx, value).errors.some((error) => error.includes("findings[0].enabledBy: the location is outside the changed lines")));

  finding.enabledBy = ctx.files[0].hunks[0].id;
  const outcome = finalizeReview(ctx, value);
  assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));
  assert.equal(outcome.result.units[0].findings[0].anchor, "off_diff");

  finding.location = "src/a.ts:2";
  delete finding.enabledBy;
  assert.equal(finalizeReview(ctx, value).result.units[0].findings[0].anchor, "in_diff");
});

test("flags high complexity or high risk with low coverage as red", () => {
  const hunks = new Map(context().files.flatMap((file) => file.hunks.map((hunk) => [hunk.id, { ...hunk, path: file.path }])));
  const unit = review().units[0];
  const withScores = (scores) => ({ ...unit, scores: { ...unit.scores, ...scores } });

  const complex = deriveUnit(withScores({ complexity: { level: "high", rationale: "Parser." }, coverage: rated(1) }), hunks);
  assert.equal(complex.status, "red");
  assert.deepEqual(complex.flags.map((flag) => [flag.level, flag.code]), [["red", "complexity-coverage-gap"], ["amber", "low-coverage"]]);

  const risky = deriveUnit(withScores({ risk: { level: "critical", factors: ["data-loss"], rationale: "Deletes." }, coverage: rated(null) }), hunks);
  assert.deepEqual(risky.flags.map((flag) => [flag.level, flag.code]), [["red", "risk-coverage-gap"], ["amber", "critical-risk"]]);

  const medium = deriveUnit(withScores({ complexity: { level: "medium", rationale: "Branches." }, coverage: rated(2) }), hunks);
  assert.equal(medium.status, "green");

  const untested = deriveUnit(withScores({ complexity: { level: "medium", rationale: "Branches." }, coverage: rated(0) }), hunks);
  assert.deepEqual(untested.flags.map((flag) => [flag.level, flag.code]), [["red", "zero-coverage"], ["amber", "complexity-coverage-gap"]]);

  const decision = deriveUnit({ ...unit, humanDecisions: ["Keep the old format?"] }, hunks);
  assert.deepEqual([decision.status, decision.flags[0].code], ["amber", "needs-decision"]);
});

test("context and finalize round-trip on a local branch", () => {
  const repo = mkdtempSync(join(tmpdir(), "pr-review-cli-"));
  const run = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  run("init", "--quiet", "--initial-branch=main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  writeFileSync(join(repo, "a.js"), "export const a = 1;\n");
  run("add", "a.js");
  run("commit", "--quiet", "-m", "base");
  run("switch", "--quiet", "-c", "feature");
  writeFileSync(join(repo, "a.js"), "export const a = 2;\n");
  run("commit", "--quiet", "-am", "Change a");
  writeFileSync(join(repo, "new.js"), "export const b = 1;\n");

  const cli = fileURLToPath(new URL("./pr-review.mjs", import.meta.url));
  const node = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: "utf8" });
  const head = run("rev-parse", "HEAD").trim();
  const report = JSON.parse(node("context").stdout);
  assert.equal(report.dir, join(realpathSync(repo), ".git", "threadex-pr-review", head.slice(0, 12)));
  assert.equal(report.review, join(report.dir, "review.json"));
  const committed = JSON.parse(readFileSync(report.context, "utf8"));
  assert.equal(committed.source.base, "main");
  assert.deepEqual(committed.commits.map((line) => line.replace(/^\w+ /, "")), ["Change a"]);
  assert.deepEqual(committed.files.map((file) => file.path), ["a.js"]);

  const withWorktree = JSON.parse(node("context", "--worktree", "--out", "-").stdout);
  assert.deepEqual(withWorktree.files.map((file) => [file.path, file.status]), [["a.js", "modified"], ["new.js", "added"]]);

  const value = review();
  value.source = committed.source;
  value.excluded = [];
  value.units[0].hunks = committed.files[0].hunks.map((hunk) => hunk.id);
  value.units[0].testHunks = [];
  for (const dimension of ["implementation", "coverage", "conventions", "simplicity", "spec"]) value.units[0].scores[dimension].evidence = ["a.js:1"];
  writeFileSync(report.review, JSON.stringify(value));
  const finalized = node("finalize", "--review", report.review);
  assert.equal(finalized.status, 0, finalized.stderr);
  const outcome = JSON.parse(finalized.stdout);
  assert.equal(outcome.result, join(report.dir, "result.json"));
  assert.deepEqual([outcome.summary.status, outcome.warnings], ["green", []]);
  assert.equal(JSON.parse(readFileSync(outcome.result, "utf8")).units[0].derived.status, "green");

  value.units[0].scores.implementation.evidence = ["a.js:2"];
  writeFileSync(report.review, JSON.stringify(value));
  const pastEnd = node("finalize", "--review", report.review);
  assert.equal(pastEnd.status, 1);
  assert.deepEqual(JSON.parse(pastEnd.stderr).errors, ["units[0].scores.implementation.evidence[0]: line 2 is past the end of a.js (1 lines)"]);
});
