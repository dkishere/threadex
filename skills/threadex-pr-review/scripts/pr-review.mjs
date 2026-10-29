#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { finalizeReview, parseUnifiedDiff, schemaVersion } from "./review-core.mjs";

const usage = `Usage:
  pr-review.mjs context [--base <ref>] [--worktree] [--pr <number>] [--out <file|->]
  pr-review.mjs finalize --review <file> [--context <file>] [--out <file|->]

context   Resolve the change range and list its files and hunks as JSON.
          Default: merge-base(<base>, HEAD)..HEAD; --worktree also includes
          uncommitted and untracked files; --pr reads the GitHub PR via gh.
          Writes <git-common-dir>/threadex-pr-review/<head12>/context.json
          unless --out is given, and prints the absolute paths.
finalize  Validate a review against its context and the files at its head,
          then add derived flags. Defaults to context.json and result.json
          next to the review.`;

const maxBuffer = 512 * 1024 * 1024;
const git = (args, options = {}) => execFileSync("git", args, { encoding: "utf8", maxBuffer, stdio: ["ignore", "pipe", "pipe"], ...options }).trimEnd();
const gitOk = (args) => spawnSync("git", args, { stdio: "ignore" }).status === 0;
const gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer, stdio: ["ignore", "pipe", "pipe"] });

function defaultBase() {
  const remoteHead = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { encoding: "utf8" });
  if (remoteHead.status === 0 && remoteHead.stdout.trim()) return remoteHead.stdout.trim();
  for (const candidate of ["main", "master"]) if (gitOk(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`])) return candidate;
  throw new Error("Cannot determine the base branch; pass --base <ref>.");
}

function commitSubjects(range) {
  const output = git(["log", "--format=%h %s", "--max-count=200", range]);
  return output ? output.split("\n") : [];
}

function untrackedPatch() {
  const files = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  // `git diff --no-index` exits 1 when files differ, which is the expected case here.
  return files.map((file) => {
    const result = spawnSync("git", ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", file], { encoding: "utf8", maxBuffer });
    if (result.status !== 0 && result.status !== 1) throw new Error(`git diff failed for untracked ${file}: ${result.stderr}`);
    return result.stdout;
  }).join("");
}

function localContext(base, worktree) {
  const head = git(["rev-parse", "HEAD"]);
  const mergeBase = git(["merge-base", base, "HEAD"]);
  const diffArgs = ["diff", "--no-color", "--no-ext-diff", "-M", mergeBase, ...(worktree ? [] : ["HEAD"])];
  const patch = git(diffArgs) + "\n" + (worktree ? untrackedPatch() : "");
  return {
    source: { kind: "local", base, mergeBase, head, includesWorktree: worktree, diffCommand: `git ${diffArgs.join(" ")}${worktree ? " (+ untracked files)" : ""}` },
    commits: commitSubjects(`${mergeBase}..HEAD`),
    patch
  };
}

function githubContext(number) {
  const pr = JSON.parse(gh(["pr", "view", String(number), "--json", "number,url,title,body,baseRefName,headRefName,headRefOid"]));
  const localHead = git(["rev-parse", "HEAD"]);
  const base = [`origin/${pr.baseRefName}`, pr.baseRefName].find((ref) => gitOk(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]));
  const pullRequest = { number: pr.number, url: pr.url, title: pr.title, body: pr.body, baseRefName: pr.baseRefName, headRefName: pr.headRefName };
  // Prefer local git so the reviewer can read files at the PR head; otherwise fall back to GitHub's patch.
  if (base && gitOk(["cat-file", "-e", `${pr.headRefOid}^{commit}`])) {
    const mergeBase = git(["merge-base", base, pr.headRefOid]);
    const diffArgs = ["diff", "--no-color", "--no-ext-diff", "-M", mergeBase, pr.headRefOid];
    return {
      source: { kind: "github", base, mergeBase, head: pr.headRefOid, localHeadMatches: localHead === pr.headRefOid, diffCommand: `git ${diffArgs.join(" ")}`, pullRequest },
      commits: commitSubjects(`${mergeBase}..${pr.headRefOid}`),
      patch: git(diffArgs)
    };
  }
  return {
    source: { kind: "github", base: pr.baseRefName, mergeBase: null, head: pr.headRefOid, localHeadMatches: localHead === pr.headRefOid, diffCommand: `gh pr diff ${pr.number}`, pullRequest },
    commits: [],
    patch: gh(["pr", "diff", String(pr.number)])
  };
}

/** Writes JSON to a file and returns its absolute path, or to stdout for "-". */
function write(out, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (out === "-") { process.stdout.write(text); return null; }
  const path = resolve(out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// The repository's own git directory is the same path inside and outside a sandbox, unlike $TMPDIR.
function defaultContextPath(head) {
  const gitDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return join(gitDir, "threadex-pr-review", head.slice(0, 12), "context.json");
}

const countLines = (text) => text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

/** Line counts at the reviewed head, or null when that head cannot be read locally. */
function headLineCounter(context) {
  const { source } = context;
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) return null;
  const root = top.stdout.trim();
  if (!source.includesWorktree && !gitOk(["cat-file", "-e", `${source.head}^{commit}`])) return null;
  // Deleted files have no head version; findings about them cite their old lines.
  const deleted = new Set(context.files.filter((file) => file.status === "deleted").map((file) => file.path));
  const cache = new Map();
  return (path) => {
    if (deleted.has(path)) return Number.POSITIVE_INFINITY;
    if (!cache.has(path)) {
      let lines = null;
      if (source.includesWorktree) {
        try {
          lines = countLines(readFileSync(resolve(root, path), "utf8"));
        } catch (error) {
          if (!["ENOENT", "EISDIR", "ENOTDIR"].includes(error?.code)) throw error;
        }
      } else {
        const shown = spawnSync("git", ["show", `${source.head}:${path}`], { cwd: root, encoding: "utf8", maxBuffer });
        if (shown.status === 0) lines = countLines(shown.stdout);
      }
      cache.set(path, lines);
    }
    return cache.get(path);
  };
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === "context") {
    const { values } = parseArgs({ args: rest, options: { base: { type: "string" }, worktree: { type: "boolean", default: false }, pr: { type: "string" }, out: { type: "string" } } });
    if (values.pr !== undefined && (values.base !== undefined || values.worktree)) throw new Error("--pr cannot be combined with --base or --worktree.");
    if (values.pr !== undefined && !/^\d+$/.test(values.pr)) throw new Error("--pr expects a pull request number.");
    const { source, commits, patch } = values.pr !== undefined ? githubContext(values.pr) : localContext(values.base ?? defaultBase(), values.worktree);
    const files = parseUnifiedDiff(patch);
    const totals = { files: files.length, hunks: files.reduce((total, file) => total + file.hunks.length, 0), additions: files.reduce((total, file) => total + file.additions, 0), deletions: files.reduce((total, file) => total + file.deletions, 0) };
    const path = write(values.out ?? defaultContextPath(source.head), { schemaVersion, source, commits, files, totals });
    if (path) {
      process.stdout.write(`${JSON.stringify({ ok: true, dir: dirname(path), context: path, review: join(dirname(path), "review.json"), diffCommand: source.diffCommand, totals }, null, 2)}\n`);
    }
    return 0;
  }
  if (command === "finalize") {
    const { values } = parseArgs({ args: rest, options: { context: { type: "string" }, review: { type: "string" }, out: { type: "string" } } });
    if (!values.review) throw new Error("finalize needs --review.");
    const dir = dirname(resolve(values.review));
    const context = readJson(values.context ?? join(dir, "context.json"));
    const lineCount = headLineCounter(context) ?? undefined;
    const outcome = finalizeReview(context, readJson(values.review), { lineCount });
    if (!outcome.ok) {
      process.stderr.write(`${JSON.stringify({ ok: false, errors: outcome.errors, warnings: outcome.warnings }, null, 2)}\n`);
      return 1;
    }
    const path = write(values.out ?? join(dir, "result.json"), { ...outcome.result, generatedAt: new Date().toISOString() });
    const report = { ok: true, ...(path ? { result: path } : {}), warnings: outcome.warnings, summary: outcome.result.summary };
    (path ? process.stdout : process.stderr).write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  process.stderr.write(`${usage}\n`);
  return command === undefined || command === "help" || command === "--help" ? 0 : 2;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
