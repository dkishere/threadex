import { createHash } from "node:crypto";

export const schemaVersion = 1;
export const ratedDimensions = ["implementation", "coverage", "conventions", "simplicity", "spec"];
export const riskLevels = ["low", "medium", "high", "critical"];
export const complexityLevels = ["low", "medium", "high"];
export const riskFactors = [
  "none", "persistent-state", "runner-lifecycle", "concurrency", "security-boundary",
  "external-contract", "data-loss", "user-visible"
];
export const areas = ["client", "server", "shared", "script", "skill", "docs", "config", "test", "other"];
export const severities = ["blocker", "major", "minor", "nit"];
export const confidences = ["verified", "plausible"];
// A finding caps its dimension's score, so severity and rating cannot disagree.
const maxScoreForSeverity = { blocker: 0, major: 1, minor: 2, nit: 3 };

export function isTestPath(path) {
  return /(^|\/)(test|tests|__tests__|e2e)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function unquotePath(value) {
  const path = value.replace(/\t.*$/, "");
  if (!path.startsWith('"')) return path;
  const bytes = [];
  for (let index = 1; index < path.length - 1; index += 1) {
    const char = path[index];
    if (char !== "\\") { bytes.push(...Buffer.from(char, "utf8")); continue; }
    const next = path[index + 1];
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(path.slice(index + 1, index + 4), 8));
      index += 3;
    } else {
      bytes.push(({ n: 10, t: 9, r: 13, '"': 34, "\\": 92 })[next] ?? next.charCodeAt(0));
      index += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

const stripPrefix = (path) => path.replace(/^[ab]\//, "");

/** Parse `git diff` output into files and hunks with content-derived IDs; hunk text is not retained. */
export function parseUnifiedDiff(patch) {
  const files = [];
  let file = null;
  let hunk = null;
  const finishHunk = () => {
    if (hunk && file) file.hunks.push(hunk);
    hunk = null;
  };
  const finishFile = () => {
    finishHunk();
    if (!file) return;
    if (!file.hunks.length) {
      // Binary, rename-only and mode-only changes still need an assignable hunk.
      file.hunks.push({ header: `(${file.binary ? "binary" : file.status})`, oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, additions: 0, deletions: 0, body: [] });
    }
    const hunks = file.hunks.map((item) => ({
      id: `h${createHash("sha1").update([file.path, item.oldStart, item.newStart, item.header, ...item.body].join("\0")).digest("hex").slice(0, 10)}`,
      header: item.header, oldStart: item.oldStart, oldLines: item.oldLines, newStart: item.newStart, newLines: item.newLines,
      additions: item.additions, deletions: item.deletions
    }));
    files.push({
      path: file.path, ...(file.oldPath !== file.path ? { oldPath: file.oldPath } : {}), status: file.status,
      binary: file.binary, test: isTestPath(file.path),
      additions: hunks.reduce((total, item) => total + item.additions, 0),
      deletions: hunks.reduce((total, item) => total + item.deletions, 0),
      hunks
    });
    file = null;
  };

  for (const line of String(patch ?? "").replace(/\r\n/g, "\n").split("\n")) {
    if (hunk && (hunk.remainingOld > 0 || hunk.remainingNew > 0)) {
      const marker = line[0];
      if (marker === "+") { hunk.additions += 1; hunk.remainingNew -= 1; }
      else if (marker === "-") { hunk.deletions += 1; hunk.remainingOld -= 1; }
      else if (marker === " " || line === "") { hunk.remainingOld -= 1; hunk.remainingNew -= 1; }
      else if (marker !== "\\") { finishHunk(); }
      if (hunk) { hunk.body.push(line); continue; }
    }
    if (line.startsWith("diff --git ")) {
      finishFile();
      const match = /^diff --git (.+?) (b\/.+|"b\/.+")$/.exec(line);
      const oldPath = stripPrefix(unquotePath(match?.[1] ?? ""));
      file = { path: stripPrefix(unquotePath(match?.[2] ?? "")), oldPath, status: "modified", binary: false, hunks: [] };
      continue;
    }
    if (!file) continue;
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (header) {
      finishHunk();
      const oldLines = header[2] === undefined ? 1 : Number(header[2]);
      const newLines = header[4] === undefined ? 1 : Number(header[4]);
      hunk = {
        header: header[5].trim(), oldStart: Number(header[1]), oldLines, newStart: Number(header[3]), newLines,
        additions: 0, deletions: 0, remainingOld: oldLines, remainingNew: newLines, body: []
      };
    } else if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) { file.oldPath = unquotePath(line.slice(12)); file.status = "renamed"; }
    else if (line.startsWith("rename to ")) file.path = unquotePath(line.slice(10));
    else if (line.startsWith("Binary files ")) file.binary = true;
    else if (line.startsWith("--- ")) { if (line !== "--- /dev/null") file.oldPath = stripPrefix(unquotePath(line.slice(4))); }
    else if (line.startsWith("+++ ")) { if (line !== "+++ /dev/null") file.path = stripPrefix(unquotePath(line.slice(4))); }
  }
  finishFile();
  for (const item of files) {
    if (item.status === "deleted") item.path = item.oldPath ?? item.path;
  }
  return files;
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const isStringList = (value) => Array.isArray(value) && value.every(nonEmpty);
const locationPattern = /^(\S(?:.*\S)?):(\d+)(?:-(\d+))?$/;

function parseLocation(value) {
  const match = typeof value === "string" ? locationPattern.exec(value) : null;
  if (!match) return null;
  const start = Number(match[2]);
  const end = match[3] === undefined ? start : Number(match[3]);
  return start >= 1 && end >= start ? { path: match[1], start, end } : null;
}

const contextHunks = (context) => new Map(context.files.flatMap((file) => file.hunks.map((hunk) => [hunk.id, { ...hunk, path: file.path, test: file.test }])));

/** A finding is in the diff when its lines overlap a hunk's new-side range; pure deletions anchor at their position. */
export function findingAnchor(context, location) {
  const parsed = parseLocation(location);
  const file = parsed && context.files.find((item) => item.path === parsed.path);
  const overlaps = file?.hunks.some((hunk) => hunk.newStart <= parsed.end && parsed.start <= hunk.newStart + Math.max(hunk.newLines, 1) - 1);
  return overlaps ? "in_diff" : "off_diff";
}

/**
 * Check a review against its context; every hunk must be assigned once and every deduction must cite a finding.
 * `lineCount(path)` returns the file's line count at the reviewed head, or null when it does not exist there.
 */
export function validateReview(context, review, { lineCount } = {}) {
  const errors = [];
  const warnings = [];
  const fail = (path, message) => errors.push(`${path}: ${message}`);
  const checkLocation = (value, path) => {
    const parsed = parseLocation(value);
    if (!parsed) { fail(path, "expected \"path:line\" or \"path:start-end\""); return; }
    if (!lineCount) return;
    const lines = lineCount(parsed.path);
    if (lines === null) fail(path, `${parsed.path} does not exist at the reviewed head`);
    else if (parsed.end > lines) fail(path, `line ${parsed.end} is past the end of ${parsed.path} (${lines} lines)`);
  };
  if (!lineCount) warnings.push("evidence locations were not checked against the reviewed files");
  if (!isObject(review)) return { errors: ["review: expected an object"], warnings };
  if (review.schemaVersion !== schemaVersion) fail("schemaVersion", `expected ${schemaVersion}`);
  if (!isObject(review.source) || review.source.head !== context.source.head || (review.source.mergeBase ?? null) !== (context.source.mergeBase ?? null)) {
    fail("source", "must match the context's head and mergeBase; copy context.source unchanged");
  }
  if (!isObject(review.spec) || typeof review.spec.summary !== "string" || !Array.isArray(review.spec.sources) || !review.spec.sources.every(nonEmpty)) {
    fail("spec", "expected { summary: string, sources: string[] }");
  }
  const hasSpec = nonEmpty(review.spec?.summary);

  const hunks = contextHunks(context);
  const owners = new Map();
  const claim = (id, owner, path) => {
    if (!hunks.has(id)) fail(path, `unknown hunk ${id}`);
    else if (owners.has(id)) fail(path, `hunk ${id} is already assigned to ${owners.get(id)}`);
    else owners.set(id, owner);
  };
  const checkHunkKind = (id, test, path) => {
    const hunk = hunks.get(id);
    if (hunk && hunk.test !== test) warnings.push(`${path}: ${id} (${hunk.path}) is ${hunk.test ? "a test file; move it to testHunks" : "not a test file; move it to hunks unless it is a test fixture"}`);
  };

  if (!Array.isArray(review.excluded ?? [])) fail("excluded", "expected an array");
  else (review.excluded ?? []).forEach((item, index) => {
    if (!isObject(item) || typeof item.hunk !== "string" || !nonEmpty(item.reason)) fail(`excluded[${index}]`, "expected { hunk, reason }");
    else claim(item.hunk, "excluded", `excluded[${index}]`);
  });

  if (!Array.isArray(review.units)) {
    fail("units", "expected an array");
    return { errors, warnings };
  }
  const unitIds = new Set();
  review.units.forEach((unit, index) => {
    const at = `units[${index}]`;
    if (!isObject(unit)) { fail(at, "expected an object"); return; }
    if (typeof unit.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(unit.id) || unitIds.has(unit.id)) fail(`${at}.id`, "expected a unique lowercase id");
    unitIds.add(unit.id);
    if (!nonEmpty(unit.title)) fail(`${at}.title`, "required");
    if (!nonEmpty(unit.summary)) fail(`${at}.summary`, "required");
    if (!areas.includes(unit.area)) fail(`${at}.area`, `expected one of ${areas.join(", ")}`);
    // A test-only unit has no production hunks; it still needs at least one hunk overall.
    for (const field of ["hunks", "testHunks"]) {
      if (unit[field] !== undefined && !Array.isArray(unit[field])) fail(`${at}.${field}`, "expected an array");
    }
    const production = Array.isArray(unit.hunks) ? unit.hunks : [];
    const tests = Array.isArray(unit.testHunks) ? unit.testHunks : [];
    if (!production.length && !tests.length) fail(at, "expected at least one hunk in hunks or testHunks");
    production.forEach((id) => { claim(id, unit.id, `${at}.hunks`); checkHunkKind(id, false, `${at}.hunks`); });
    tests.forEach((id) => { claim(id, unit.id, `${at}.testHunks`); checkHunkKind(id, true, `${at}.testHunks`); });
    for (const field of ["setAside", "humanDecisions"]) {
      if (unit[field] !== undefined && !isStringList(unit[field])) fail(`${at}.${field}`, "expected a list of non-empty strings");
    }
    validateScores(unit, at, { context, hunks, hasSpec, fail, warnings, checkLocation });
  });

  const unassigned = [...hunks.values()].filter((hunk) => !owners.has(hunk.id));
  if (unassigned.length) {
    const listed = unassigned.slice(0, 20).map((hunk) => `${hunk.id} (${hunk.path}:${hunk.newStart})`).join(", ");
    fail("units", `${unassigned.length} hunk(s) are neither assigned to a unit nor excluded: ${listed}${unassigned.length > 20 ? ", …" : ""}`);
  }
  return { errors, warnings };
}

function validateScores(unit, at, { context, hunks, hasSpec, fail, warnings, checkLocation }) {
  const scores = unit.scores;
  if (!isObject(scores)) { fail(`${at}.scores`, "required"); return; }
  const risk = scores.risk;
  if (!isObject(risk) || !riskLevels.includes(risk.level) || !nonEmpty(risk.rationale)
    || !Array.isArray(risk.factors) || !risk.factors.length || !risk.factors.every((factor) => riskFactors.includes(factor))) {
    fail(`${at}.scores.risk`, `expected { level: ${riskLevels.join("|")}, factors: [${riskFactors.join("|")}], rationale }`);
  } else if (risk.factors.includes("none") && (risk.factors.length > 1 || risk.level !== "low")) {
    fail(`${at}.scores.risk.factors`, "\"none\" stands alone and only with level low");
  }
  const complexity = scores.complexity;
  if (!isObject(complexity) || !complexityLevels.includes(complexity.level) || !nonEmpty(complexity.rationale)) {
    fail(`${at}.scores.complexity`, `expected { level: ${complexityLevels.join("|")}, rationale }`);
  }
  for (const dimension of ratedDimensions) {
    const path = `${at}.scores.${dimension}`;
    const entry = scores[dimension];
    if (!isObject(entry) || !(entry.score === null || [0, 1, 2, 3].includes(entry.score)) || !nonEmpty(entry.rationale) || !Array.isArray(entry.evidence)) {
      fail(path, "expected { score: 0-3 or null, rationale, evidence: [\"path:line\"] }");
      continue;
    }
    entry.evidence.forEach((item, index) => checkLocation(item, `${path}.evidence[${index}]`));
    if (entry.score === 3 && !entry.evidence.length) fail(path, "a full score needs evidence");
    if (dimension === "coverage" && entry.score !== null && entry.score > 0 && !entry.evidence.length) fail(path, "cite the tests that cover this unit");
    if (dimension === "spec" && !hasSpec && entry.score !== null) fail(path, "must be null when spec.summary is empty");
  }

  if (!Array.isArray(unit.findings ?? [])) { fail(`${at}.findings`, "expected an array"); return; }
  const findings = unit.findings ?? [];
  findings.forEach((finding, index) => {
    const path = `${at}.findings[${index}]`;
    if (!isObject(finding) || !ratedDimensions.includes(finding.dimension) || !severities.includes(finding.severity)
      || !confidences.includes(finding.confidence) || !parseLocation(finding.location) || !nonEmpty(finding.summary)) {
      fail(path, `expected { dimension, severity: ${severities.join("|")}, confidence: ${confidences.join("|")}, location: "path:line", summary, failureScenario }`);
      return;
    }
    checkLocation(finding.location, `${path}.location`);
    // Off-diff findings must name the changed hunk that makes them reachable, or they are pre-existing.
    if (findingAnchor(context, finding.location) === "off_diff" && !hunks.has(finding.enabledBy)) {
      fail(`${path}.enabledBy`, "the location is outside the changed lines; set enabledBy to the hunk ID that makes it reachable, or drop it as pre-existing");
    }
    if ((finding.severity === "blocker" || finding.severity === "major") && !nonEmpty(finding.failureScenario)) {
      fail(`${path}.failureScenario`, "blocker and major findings need a concrete failure scenario");
    }
    if (finding.severity === "blocker" && finding.confidence !== "verified") warnings.push(`${path}: blocker is only plausible; verify it or lower its severity`);
    const score = scores[finding.dimension]?.score;
    if (score === null) fail(path, `${finding.dimension} is N/A, so it cannot carry findings`);
    else if (typeof score === "number" && score > maxScoreForSeverity[finding.severity]) {
      fail(path, `a ${finding.severity} finding caps ${finding.dimension} at ${maxScoreForSeverity[finding.severity]}, but it scored ${score}`);
    }
  });
  for (const dimension of ratedDimensions) {
    const score = scores[dimension]?.score;
    if (typeof score === "number" && score < 3 && !findings.some((finding) => finding.dimension === dimension)) {
      fail(`${at}.scores.${dimension}`, `scored ${score} without a finding that explains the deduction`);
    }
  }
}

const formatScore = (score) => score === null ? "N/A" : String(score);

/** Flags come from fixed rules, never from the reviewer, so the same scores always produce the same status. */
export function deriveUnit(unit, hunksById) {
  const flags = [];
  const flag = (level, code, message) => flags.push({ level, code, message });
  const { risk, complexity, coverage } = unit.scores;
  const lowCoverage = coverage.score === null || coverage.score <= 1;
  const noCoverage = coverage.score === null || coverage.score === 0;
  if (complexity.level === "high" && lowCoverage) flag("red", "complexity-coverage-gap", `High complexity with coverage ${formatScore(coverage.score)}`);
  else if (complexity.level === "medium" && noCoverage) flag("amber", "complexity-coverage-gap", `Medium complexity with coverage ${formatScore(coverage.score)}`);
  if ((risk.level === "high" || risk.level === "critical") && lowCoverage) flag("red", "risk-coverage-gap", `${risk.level} risk with coverage ${formatScore(coverage.score)}`);
  else if (risk.level === "medium" && noCoverage) flag("amber", "risk-coverage-gap", `Medium risk with coverage ${formatScore(coverage.score)}`);
  for (const dimension of ratedDimensions) {
    const score = unit.scores[dimension].score;
    if (score === 0) flag("red", `zero-${dimension}`, `${dimension} scored 0`);
    else if (score === 1) flag("amber", `low-${dimension}`, `${dimension} scored 1`);
  }
  if (risk.level === "critical") flag("amber", "critical-risk", "Critical risk needs a human reviewer regardless of scores");
  if (unit.humanDecisions?.length) flag("amber", "needs-decision", `${unit.humanDecisions.length} decision(s) only a person can make`);
  flags.sort((left, right) => (left.level === right.level ? 0 : left.level === "red" ? -1 : 1));

  const owned = [...(unit.hunks ?? []), ...(unit.testHunks ?? [])].map((id) => hunksById.get(id));
  const sumLines = (items, key) => items.reduce((total, item) => total + item[key], 0);
  const code = (unit.hunks ?? []).map((id) => hunksById.get(id));
  const tests = (unit.testHunks ?? []).map((id) => hunksById.get(id));
  return {
    status: flags.some((item) => item.level === "red") ? "red" : flags.length ? "amber" : "green",
    flags,
    metrics: {
      files: new Set(owned.map((item) => item.path)).size,
      additions: sumLines(code, "additions"), deletions: sumLines(code, "deletions"),
      testAdditions: sumLines(tests, "additions"), testDeletions: sumLines(tests, "deletions")
    }
  };
}

/** Validate, then attach derived status, flags and metrics to each unit plus a PR-level summary. */
export function finalizeReview(context, review, options = {}) {
  const { errors, warnings } = validateReview(context, review, options);
  if (errors.length) return { ok: false, errors, warnings };
  const hunksById = contextHunks(context);
  const units = review.units.map((unit) => ({
    ...unit,
    findings: (unit.findings ?? []).map((finding) => ({ ...finding, anchor: findingAnchor(context, finding.location) })),
    derived: deriveUnit(unit, hunksById)
  }));
  const count = (status) => units.filter((unit) => unit.derived.status === status).length;
  const status = count("red") ? "red" : count("amber") ? "amber" : "green";
  return {
    ok: true,
    warnings,
    result: {
      ...review,
      units,
      summary: {
        status, units: units.length, red: count("red"), amber: count("amber"), green: count("green"),
        excludedHunks: (review.excluded ?? []).length,
        redFlags: units.flatMap((unit) => unit.derived.flags.filter((item) => item.level === "red").map((item) => ({ unit: unit.id, ...item })))
      }
    }
  };
}
