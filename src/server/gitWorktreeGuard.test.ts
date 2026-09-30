import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installGitWorktreeReviewHooks, inspectOtherWorktrees } from "./gitWorktreeGuard";
import { installGitProvenanceHooks } from "./gitProvenance";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(resolve(tmpdir(), "threadex-worktree-review-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = resolve(dir, "main");
  const other = resolve(dir, "other ' worktree\nname");
  const remote = resolve(dir, "remote.git");
  mkdirSync(main);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.name", "Test");
  git(main, "config", "user.email", "test@example.invalid");
  git(main, "config", "commit.gpgsign", "false");
  git(main, "config", "core.hooksPath", resolve(main, ".git/hooks"));
  writeFileSync(resolve(main, "tracked.txt"), "baseline\n");
  git(main, "add", "tracked.txt"); git(main, "commit", "-qm", "Baseline");
  git(main, "init", "--bare", "-q", remote);
  git(main, "remote", "add", "origin", remote);
  git(main, "push", "-qu", "origin", "main");
  const addOther = () => {
    git(main, "worktree", "add", "-qb", "other", other);
    git(other, "push", "-qu", "origin", "other");
  };
  const run = (cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync("git", args, { cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 10_000 });
  return { dir, main, other, remote, git, addOther, run };
}

test("single worktree commits work; sibling changes block a real commit and a reviewed retry preserves them", t => {
  const f = fixture(t);
  installGitWorktreeReviewHooks(f.main);
  assert.equal(f.run(f.main, ["commit", "--allow-empty", "-qm", "Single tree"]).status, 0);
  f.git(f.main, "push", "-q", "origin", "main");
  f.addOther();
  writeFileSync(resolve(f.other, "untracked.txt"), "leave this alone\n");
  const before = f.git(f.main, "rev-parse", "HEAD");
  const blocked = f.run(f.main, ["commit", "--allow-empty", "-qm", "Blocked"]);
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.match(blocked.stderr, /Uncommitted changes/);
  assert.equal(f.git(f.main, "rev-parse", "HEAD"), before);
  const token = /THREADEX_WORKTREE_REVIEW=([a-f0-9]+)/.exec(blocked.stderr)![1];
  assert.equal(f.run(f.main, ["commit", "--allow-empty", "-qm", "No reason"], { THREADEX_WORKTREE_REVIEW: token }).status, 1);
  const approved = f.run(f.main, ["commit", "--allow-empty", "-qm", "Reviewed"], { THREADEX_WORKTREE_REVIEW: token, THREADEX_WORKTREE_REASON: "Other task is still in progress" });
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal(readFileSync(resolve(f.other, "untracked.txt"), "utf8"), "leave this alone\n");
  assert.match(f.git(f.other, "status", "--porcelain"), /untracked.txt/);
});

test("review tokens change with tracked, staged and untracked sibling changes and do not authorize another hook", t => {
  const f = fixture(t); f.addOther();
  writeFileSync(resolve(f.other, "tracked.txt"), "first\n");
  const first = inspectOtherWorktrees(f.main, "pre-commit");
  writeFileSync(resolve(f.other, "tracked.txt"), "second\n");
  const second = inspectOtherWorktrees(f.main, "pre-commit");
  assert.notEqual(first.token, second.token);
  f.git(f.other, "add", "tracked.txt");
  assert.notEqual(second.token, inspectOtherWorktrees(f.main, "pre-commit").token);
  assert.notEqual(second.token, inspectOtherWorktrees(f.main, "pre-push").token);
  writeFileSync(resolve(f.other, "new.txt"), "new\n");
  assert.match(JSON.stringify(inspectOtherWorktrees(f.main, "pre-commit").concerns), /Uncommitted/);
});

test("ahead branches block real pushes; branches already included in that push are allowed", t => {
  const f = fixture(t); f.addOther();
  f.git(f.other, "commit", "--allow-empty", "-qm", "Other pending commit");
  f.git(f.main, "commit", "--allow-empty", "-qm", "Main pending commit");
  installGitWorktreeReviewHooks(f.main);
  const before = f.git(f.remote, "rev-parse", "refs/heads/main");
  const blocked = f.run(f.main, ["push", "origin", "main"]);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /1 unpushed commit/);
  assert.equal(f.git(f.remote, "rev-parse", "refs/heads/main"), before);
  const together = f.run(f.main, ["push", "origin", "main", "other"]);
  assert.equal(together.status, 0, together.stderr);
  assert.equal(f.git(f.remote, "rev-parse", "refs/heads/other"), f.git(f.other, "rev-parse", "HEAD"));
  assert.deepEqual(inspectOtherWorktrees(f.main, "pre-push").concerns, []);
});

test("missing upstream, deleted tracking ref, detached commits and unavailable worktrees require review", t => {
  const f = fixture(t); f.addOther();
  f.git(f.other, "branch", "--unset-upstream");
  assert.match(JSON.stringify(inspectOtherWorktrees(f.main, "pre-commit").concerns), /No upstream/);
  f.git(f.other, "branch", "--set-upstream-to=origin/other");
  f.git(f.main, "update-ref", "-d", "refs/remotes/origin/other");
  assert.match(JSON.stringify(inspectOtherWorktrees(f.main, "pre-commit").concerns), /unavailable/);
  f.git(f.other, "checkout", "--detach", "-q");
  f.git(f.other, "commit", "--allow-empty", "-qm", "Detached unpublished commit");
  assert.match(JSON.stringify(inspectOtherWorktrees(f.main, "pre-commit").concerns), /Detached HEAD has 1/);
  rmSync(f.other, { recursive: true });
  assert.match(JSON.stringify(inspectOtherWorktrees(f.main, "pre-commit").concerns), /Worktree is unavailable/);
});

test("existing custom hooks keep arguments, stdin and exit status; installation is idempotent", t => {
  const f = fixture(t); f.addOther();
  const hooks = resolve(f.dir, "custom hooks");
  mkdirSync(hooks);
  f.git(f.main, "config", "core.hooksPath", hooks);
  const original = "#!/bin/sh\ncat > hook-input.txt\nprintf '%s\\n' \"$@\" > hook-args.txt\nexit 7\n";
  writeFileSync(resolve(hooks, "pre-push"), original, { mode: 0o755 });
  installGitWorktreeReviewHooks(f.main);
  installGitWorktreeReviewHooks(f.other);
  assert.equal(readFileSync(resolve(hooks, "pre-push"), "utf8"), original);
  assert.notEqual(f.git(f.main, "config", "core.hooksPath"), hooks);
  f.git(f.main, "commit", "--allow-empty", "-qm", "Push me");
  const result = f.run(f.main, ["push", "origin", "main"]);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(resolve(f.main, "hook-args.txt"), "utf8"), `origin\n${f.remote}\n`);
  assert.match(readFileSync(resolve(f.main, "hook-input.txt"), "utf8"), /^refs\/heads\/main [a-f0-9]+ refs\/heads\/main [a-f0-9]+\n$/);
});

function legacyInlineHooks(main: string) {
  const cli = fileURLToPath(new URL("../../scripts/git-worktree-review.ts", import.meta.url));
  const hooks = resolve(main, ".git/hooks");
  for (const hook of ["pre-commit", "pre-push"]) {
    const path = resolve(hooks, hook);
    const command = "exec '" + process.execPath + "' --import '" + import.meta.resolve("tsx") + "' '" + cli
      + "' " + hook + " '" + path + ".threadex-original' \"$@\"\n";
    writeFileSync(path, "#!/bin/sh\n# Threadex worktree review hook v1\n" + command, { mode: 0o755 });
  }
  return hooks;
}

test("legacy inline hooks without backups do not recurse and still review unfinished sibling work", t => {
  const f = fixture(t);
  legacyInlineHooks(f.main);
  installGitWorktreeReviewHooks(f.main);
  const committed = f.run(f.main, ["commit", "--allow-empty", "-qm", "Migrated legacy hooks"]);
  assert.equal(committed.status, 0, committed.stderr);
  const pushed = f.run(f.main, ["push", "origin", "main"]);
  assert.equal(pushed.status, 0, pushed.stderr);
  f.addOther();
  f.git(f.main, "commit", "--allow-empty", "-qm", "Pending push");
  writeFileSync(resolve(f.other, "pending.txt"), "unfinished");
  const commit = f.run(f.main, ["commit", "--allow-empty", "-qm", "Must review"]);
  assert.equal(commit.status, 1, commit.stderr);
  assert.match(commit.stderr, /Threadex paused commit/);
  const push = f.run(f.main, ["push", "origin", "main"]);
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /Threadex paused push/);
});

test("legacy hook backups retain their path, push arguments, stdin and exit status", t => {
  const f = fixture(t);
  const hooks = legacyInlineHooks(f.main);
  const originalCommit = resolve(hooks, "pre-commit.threadex-original");
  const commitSource = '#!/bin/sh\nprintf "%s" "$0" > original-path.txt\n';
  writeFileSync(originalCommit, commitSource, { mode: 0o755 });
  const originalPush = resolve(hooks, "pre-push.threadex-original");
  const pushSource = '#!/bin/sh\ncat > hook-input.txt\nprintf "%s\\n" "$@" > hook-args.txt\nexit 7\n';
  writeFileSync(originalPush, pushSource, { mode: 0o755 });
  installGitWorktreeReviewHooks(f.main);
  const committed = f.run(f.main, ["commit", "--allow-empty", "-qm", "Preserved legacy backup"]);
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(readFileSync(resolve(f.main, "original-path.txt"), "utf8"), originalCommit);
  const pushed = f.run(f.main, ["push", "origin", "main"]);
  assert.notEqual(pushed.status, 0);
  assert.equal(readFileSync(resolve(f.main, "hook-args.txt"), "utf8"), "origin\n" + f.remote + "\n");
  assert.match(readFileSync(resolve(f.main, "hook-input.txt"), "utf8"), /^refs\/heads\/main [a-f0-9]+ refs\/heads\/main [a-f0-9]+\n$/);
  assert.equal(readFileSync(originalCommit, "utf8"), commitSource);
  assert.equal(readFileSync(originalPush, "utf8"), pushSource);
});

test("relative hooksPath and symlink hooks are preserved for each worktree", t => {
  const f = fixture(t); f.addOther();
  f.git(f.main, "config", "core.hooksPath", ".custom-hooks");
  for (const cwd of [f.main, f.other]) {
    mkdirSync(resolve(cwd, ".custom-hooks"));
    writeFileSync(resolve(cwd, ".custom-hooks/original"), "#!/bin/sh\necho original-hook >&2\nexit 3\n", { mode: 0o755 });
    symlinkSync("original", resolve(cwd, ".custom-hooks/pre-commit"));
    // Don't make the hook fixtures themselves unfinished work.
  }
  writeFileSync(resolve(f.main, ".git/info/exclude"), ".custom-hooks/\n");
  installGitWorktreeReviewHooks(f.main);
  for (const cwd of [f.main, f.other]) {
    const result = f.run(cwd, ["commit", "--allow-empty", "-qm", "Must be rejected"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /original-hook/);
  }
});

test("nonexecutable original hooks remain inactive; dispatcher conflicts preserve user hooks", t => {
  const f = fixture(t);
  const path = resolve(f.main, ".git/hooks/pre-commit");
  writeFileSync(path, "#!/bin/sh\nexit 9\n", { mode: 0o644 });
  chmodSync(path, 0o644);
  installGitWorktreeReviewHooks(f.main);
  assert.equal(f.run(f.main, ["commit", "--allow-empty", "-qm", "Allowed"]).status, 0);
  const dispatcher = resolve(f.git(f.main, "config", "core.hooksPath"), "pre-commit");
  writeFileSync(dispatcher, "#!/bin/sh\necho newly installed user hook\n");
  assert.throws(() => installGitWorktreeReviewHooks(f.main), /Existing hook preserved/);
  assert.match(readFileSync(dispatcher, "utf8"), /newly installed user hook/);
  assert.equal(readFileSync(path, "utf8"), "#!/bin/sh\nexit 9\n");
});

test("non-repositories are ignored without creating hooks", t => {
  const f = fixture(t);
  assert.equal(installGitWorktreeReviewHooks(f.dir), false);
  assert.equal(existsSync(resolve(f.dir, ".git")), false);
});

test("original hook path and unrelated hooks are preserved, including provenance installed afterwards", t => {
  const f = fixture(t);
  const hooks = resolve(f.main, ".git/hooks");
  const original = resolve(hooks, "pre-commit");
  writeFileSync(original, '#!/bin/sh\nprintf "%s" "$0" > original-path.txt\n', { mode: 0o755 });
  installGitWorktreeReviewHooks(f.main);
  installGitProvenanceHooks(f.main, fileURLToPath(new URL("../../scripts/git-provenance.ts", import.meta.url)), import.meta.resolve("tsx"));
  const committed = f.run(f.main, ["commit", "--allow-empty", "-qm", "Both hooks"]);
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(readFileSync(resolve(f.main, "original-path.txt"), "utf8"), original);
  assert.match(readFileSync(resolve(hooks, "prepare-commit-msg"), "utf8"), /git-provenance/);
  const postRewrite = resolve(hooks, "post-rewrite");
  writeFileSync(postRewrite, '#!/bin/sh\ncat > rewrite-input.txt\nprintf "%s" "$1" > rewrite-arg.txt\nexit 6\n', { mode: 0o755 });
  const dispatch = resolve(f.git(f.main, "config", "core.hooksPath"), "post-rewrite");
  const input = Buffer.from([0x61, 0, 0xff, 10]);
  const result = spawnSync(dispatch, ["amend"], { cwd: f.main, input, timeout: 10_000 });
  assert.equal(result.status, 6);
  assert.deepEqual(readFileSync(resolve(f.main, "rewrite-input.txt")), input);
  assert.equal(readFileSync(resolve(f.main, "rewrite-arg.txt"), "utf8"), "amend");
});

test("per-worktree hook overrides survive enrollment and a future linked worktree inherits review", t => {
  const f = fixture(t); f.addOther();
  f.git(f.main, "config", "extensions.worktreeConfig", "true");
  const hooks = resolve(f.dir, "other-hooks");
  mkdirSync(hooks);
  writeFileSync(resolve(hooks, "pre-commit"), "#!/bin/sh\necho per-worktree-original >&2\nexit 2\n", { mode: 0o755 });
  f.git(f.other, "config", "--worktree", "core.hooksPath", hooks);
  installGitWorktreeReviewHooks(f.main);
  installGitWorktreeReviewHooks(f.other);
  assert.match(f.run(f.other, ["commit", "--allow-empty", "-qm", "Fail original"]).stderr, /per-worktree-original/);
  const newer = resolve(f.dir, "newer");
  f.git(f.main, "worktree", "add", "-qb", "newer", newer);
  writeFileSync(resolve(f.other, "pending.txt"), "unfinished");
  const result = f.run(newer, ["commit", "--allow-empty", "-qm", "Must review"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Threadex paused commit/);
});
