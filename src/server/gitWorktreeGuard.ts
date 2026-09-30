import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const marker = "# Threadex worktree review hook v1";
const enrollmentName = "threadex/worktree-review.json";
const hookNames = ["pre-commit", "pre-push"] as const;
const forwardedHooks = ["applypatch-msg", "pre-applypatch", "post-applypatch", "pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-receive", "update", "proc-receive", "post-receive", "post-update", "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate", "fsmonitor-watchman", "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit", "post-index-change"];
type Enrollment = { version: 1; fallbackHooksPath: string | null; originalDirectories: Record<string, string> };
export type WorktreeReviewHook = typeof hookNames[number];
type Worktree = { path: string; head?: string; branch?: string; bare?: boolean; prunable?: string };
export type WorktreeConcern = { path: string; branch: string; reasons: string[] };

function git(cwd: string, args: string[], env = process.env) {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

// Git exports the invoking worktree's index/GIT_DIR to hooks. Never let those
// values leak into commands inspecting a sibling worktree (or its index).
function inspectionEnv(cwd: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const name of git(cwd, ["rev-parse", "--local-env-vars"]).trim().split("\n")) delete env[name];
  return env;
}

function worktrees(cwd: string, env: NodeJS.ProcessEnv): Worktree[] {
  return git(cwd, ["worktree", "list", "--porcelain", "-z"], env).split("\0\0").filter(Boolean).map(record => {
    const fields = new Map(record.split("\0").filter(Boolean).map(field => {
      const space = field.indexOf(" ");
      return space < 0 ? [field, ""] : [field.slice(0, space), field.slice(space + 1)];
    }));
    return { path: fields.get("worktree")!, head: fields.get("HEAD"), branch: fields.get("branch"),
      bare: fields.has("bare"), ...(fields.has("prunable") ? { prunable: fields.get("prunable") } : {}) };
  });
}

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const entryExists = (path: string) => { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };

// Other Threadex hook installers must write to the preserved hook directory,
// not replace a dispatcher or mistake an empty forwarder for a user hook.
export function originalGitHookPath(cwd: string, hook: string) {
  const root = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
  const common = realpathSync(resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]).trim()));
  const effective = resolve(root, git(root, ["rev-parse", "--git-path", `hooks/${hook}`]).trim());
  if (dirname(effective) !== resolve(common, "threadex/worktree-review-hooks")) return effective;
  const enrollment: Enrollment = JSON.parse(readFileSync(resolve(common, enrollmentName), "utf8"));
  const directory = enrollment.originalDirectories[root] ?? (enrollment.fallbackHooksPath ? resolve(root, enrollment.fallbackHooksPath) : resolve(common, "hooks"));
  return resolve(directory, hook);
}

/** Install a repo-local dispatcher for a Threadex repository and its worktrees.
 * Original hooks stay at their original paths (important for Husky and scripts
 * using $0). Every other hook is forwarded with its original execution context.
 */
export function installGitWorktreeReviewHooks(cwd: string): boolean {
  let common: string;
  try { common = realpathSync(resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]).trim())); }
  catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (/not a git repository/.test(stderr)) return false;
    throw error;
  }
  const env = inspectionEnv(cwd);
  const cli = fileURLToPath(new URL("../../scripts/git-worktree-review.ts", import.meta.url));
  const tsx = import.meta.resolve("tsx");
  const hooksDirectory = resolve(common, "threadex/worktree-review-hooks");
  const enrollmentPath = resolve(common, enrollmentName);
  const previous: Enrollment | null = existsSync(enrollmentPath) ? JSON.parse(readFileSync(enrollmentPath, "utf8")) : null;
  const configuredPath = (path: string) => {
    try { return git(path, ["config", "--path", "--get", "core.hooksPath"], env).trim(); }
    catch (error) { if ((error as { status?: number }).status === 1) return null; throw error; }
  };
  const currentPath = configuredPath(cwd);
  if (currentPath === hooksDirectory && !previous) throw new Error("Threadex worktree hook configuration is missing its original-hook mapping.");
  const enrollment: Enrollment = { version: 1,
    fallbackHooksPath: currentPath === hooksDirectory ? previous!.fallbackHooksPath : currentPath,
    originalDirectories: { ...previous?.originalDirectories } };
  const trees: string[] = [];
  const names = new Set<string>([...hookNames, ...forwardedHooks]);
  for (const tree of worktrees(cwd, env)) {
    if (tree.bare || !existsSync(tree.path)) continue;
    const path = realpathSync(tree.path);
    trees.push(path);
    const original = dirname(resolve(path, git(path, ["rev-parse", "--git-path", "hooks/pre-commit"], env).trim()));
    if (original !== hooksDirectory) enrollment.originalDirectories[path] = original;
    else enrollment.originalDirectories[path] ??= enrollment.fallbackHooksPath ? resolve(path, enrollment.fallbackHooksPath) : resolve(common, "hooks");
    const directory = enrollment.originalDirectories[path];
    if (existsSync(directory)) for (const name of readdirSync(directory)) {
      if (/^[a-z][a-z0-9-]*$/.test(name)) names.add(name);
    }
  }
  if (!trees.length) return false;
  // Refuse to replace anything other than our own dispatcher.
  for (const name of names) {
    const path = resolve(hooksDirectory, name);
    if (entryExists(path) && (lstatSync(path).isSymbolicLink() || !readFileSync(path, "utf8").includes(marker))) throw new Error(`Existing hook preserved: ${path}`);
  }
  mkdirSync(resolve(common, "threadex"), { recursive: true });
  mkdirSync(hooksDirectory, { recursive: true });
  for (const name of names) {
    const path = resolve(hooksDirectory, name);
    // Unrelated hooks use a shell-only forwarder: don't start Node for every
    // index refresh/reference transaction, and preserve arbitrary stdin bytes.
    const fallback = enrollment.fallbackHooksPath ?? resolve(common, "hooks");
    const forward = ["case \"$(pwd -P)\" in",
      ...Object.entries(enrollment.originalDirectories).map(([root, directory]) => `  ${quote(root)}) original=${quote(resolve(directory, name))} ;;`),
      `  *) original=${quote(`${fallback}/${name}`)} ;;`, "esac",
      'if [ -x "$original" ]; then exec "$original" "$@"; fi', "exit 0"].join("\n");
    const command = name === "pre-commit" || name === "pre-push"
      ? `exec ${quote(process.execPath)} --import ${quote(tsx)} ${quote(cli)} ${quote(name)} "$@"`
      : forward;
    const content = `#!/bin/sh\n${marker}\n${command}\n`;
    if (existsSync(path) && readFileSync(path, "utf8") === content) continue;
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, content, { mode: 0o755 });
    try {
      renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
  }
  const temporary = `${enrollmentPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(enrollment), { mode: 0o600 });
    renameSync(temporary, enrollmentPath);
  } finally { rmSync(temporary, { force: true }); }
  git(cwd, ["config", "--local", "core.hooksPath", hooksDirectory], env);
  for (const path of trees) {
    // An existing per-worktree override takes precedence over common config.
    if (configuredPath(path) !== hooksDirectory) git(path, ["config", "--worktree", "core.hooksPath", hooksDirectory], env);
  }
  return true;
}

function pushedTogether(tree: Worktree, input: string, remote: string | undefined, upstreamRemote: string, upstreamRef: string) {
  return input.split("\n").some(line => {
    const [localRef, oid, remoteRef] = line.split(" ");
    if (!tree.head || /^0+$/.test(oid ?? "") || oid !== tree.head || localRef !== tree.branch) return false;
    return !upstreamRemote || (remote === upstreamRemote && remoteRef === upstreamRef);
  });
}

export function inspectOtherWorktrees(cwd: string, hook: WorktreeReviewHook, pushInput = "", remote?: string) {
  const current = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
  const env = inspectionEnv(cwd);
  const snapshot = createHash("sha256").update(JSON.stringify([current, hook, remote, pushInput]));
  const concerns: WorktreeConcern[] = [];
  for (const tree of worktrees(current, env)) {
    if (tree.bare) continue;
    if (existsSync(tree.path) && realpathSync(tree.path) === current) continue;
    const reasons: string[] = [];
    snapshot.update(JSON.stringify(tree));
    if (!existsSync(tree.path)) {
      reasons.push("Worktree is unavailable; its uncommitted/unpushed state cannot be checked.");
    } else {
      try {
        const status = git(tree.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], env);
        snapshot.update(status);
        if (status) {
          reasons.push("Uncommitted changes (staged, unstaged, or untracked files).");
          snapshot.update(git(tree.path, ["diff", "--no-ext-diff", "--no-textconv", "--binary"], env));
          snapshot.update(git(tree.path, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary"], env));
          // Include untracked file metadata, not just filenames, in the token.
          for (const path of git(tree.path, ["ls-files", "--others", "--exclude-standard", "-z"], env).split("\0").filter(Boolean)) {
            const absolute = resolve(tree.path, path);
            const stat = lstatSync(absolute);
            snapshot.update(JSON.stringify([path, stat.size, stat.mtimeMs]));
          }
        }
        if (!tree.head || /^0+$/.test(tree.head)) {
          reasons.push("Branch has no commit yet; push status is unknown.");
        } else if (!tree.branch) {
          const unpublished = Number(git(tree.path, ["rev-list", "--count", tree.head, "--not", "--remotes"], env).trim());
          snapshot.update(String(unpublished));
          if (unpublished) reasons.push(`Detached HEAD has ${unpublished} commit(s) absent from locally known remote refs.`);
        } else {
          const upstream = git(tree.path, ["for-each-ref", "--format=%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)", tree.branch], env).trim().split("\0");
          const [ref, upstreamRemote = "", upstreamRef = ""] = upstream;
          snapshot.update(JSON.stringify(upstream));
          if (hook === "pre-push" && pushedTogether(tree, pushInput, remote, upstreamRemote, upstreamRef)) {
            // This exact branch tip is already included in the pending push.
          } else if (!ref) {
            reasons.push("No upstream configured; push status is unknown.");
          } else if (upstreamRemote === ".") {
            reasons.push("Upstream is a local branch; remote push status is unknown.");
          } else {
            try {
              const ahead = Number(git(tree.path, ["rev-list", "--count", `${ref}..${tree.head}`], env).trim());
              snapshot.update(String(ahead));
              if (ahead) reasons.push(`${ahead} unpushed commit(s) ahead of ${ref.replace(/^refs\/remotes\//, "")} (local tracking ref).`);
            } catch { reasons.push(`Upstream ${ref} is unavailable; push status is unknown.`); }
          }
        }
      } catch (error) {
        reasons.push(`Cannot inspect worktree: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      }
    }
    if (reasons.length) concerns.push({ path: tree.path, branch: tree.branch?.replace(/^refs\/heads\//, "") ?? "detached HEAD", reasons });
  }
  snapshot.update(JSON.stringify(concerns));
  return { concerns, token: snapshot.digest("hex").slice(0, 24) };
}

export function worktreeReviewMessage(review: ReturnType<typeof inspectOtherWorktrees>, hook: WorktreeReviewHook) {
  const operation = hook === "pre-commit" ? "commit" : "push";
  return [
    `Threadex paused ${operation}: other worktrees need review.`,
    ...review.concerns.flatMap(item => [`- ${JSON.stringify(item.path)} [${item.branch}]`, ...item.reasons.map(reason => `  ${reason}`)]),
    "Remote status uses local tracking refs; no fetch or worktree mutation was performed.",
    "",
    "Choose how to proceed:",
    "1. Handle related work together, within the user's authorization, then retry the original command.",
    `2. SKIP this review for your ${operation} retry: leave the listed worktrees unchanged and continue with your original command.`,
    "The agent can choose to skip clearly separate work after explaining why. Ask the user only when ownership, scope, or permission is unclear.",
    "",
    `HOW TO SKIP: put BOTH variable assignments below immediately before your ORIGINAL git ${operation} command:`,
    `THREADEX_WORKTREE_REVIEW=${review.token} THREADEX_WORKTREE_REASON='Replace with your reason for leaving this work separate' git ${operation} <original arguments>`,
    "Replace the reason and <original arguments>; do not type the angle-bracket placeholder literally. Keep all original Git options (including -C, if used), message, remote and refspecs unchanged.",
    "This skips only the Threadex worktree review for the reported snapshot. Existing repository hooks still run; other worktrees are not committed, pushed or modified.",
    "If blocked again, review the new report and use its new token. Commit and push require their own tokens.",
    "Set the variables inline for the retry, not with export. Do not use --no-verify or disable hooks."
  ].join("\n");
}

/** Invoked by Git, without requiring a running Threadex server. */
export function runGitWorktreeReviewHook(hook: string, args: string[], input?: string) {
  const cwd = process.cwd();
  let original: string;
  try {
    const common = realpathSync(resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]).trim()));
    const enrollment: Enrollment = JSON.parse(readFileSync(resolve(common, enrollmentName), "utf8"));
    const root = realpathSync(cwd);
    const directory = enrollment.originalDirectories[root] ?? (enrollment.fallbackHooksPath ? resolve(root, enrollment.fallbackHooksPath) : resolve(common, "hooks"));
    original = resolve(directory, hook);
    if (directory === resolve(common, "threadex/worktree-review-hooks")) throw new Error("Original Git hook points back to Threadex dispatcher.");
    // Older installations wrapped hooks in place and passed the backup path
    // as a CLI argument. Follow that backup directly: invoking the old wrapper
    // with the current CLI would dispatch back to itself indefinitely.
    if ((hook === "pre-commit" || hook === "pre-push") && existsSync(original) && (statSync(original).mode & 0o111)) {
      const content = readFileSync(original, "utf8");
      if (content.includes(marker)) {
        const backup = `${original}.threadex-original`;
        if (!content.includes(quote(backup))) throw new Error("Original Git hook is an unexpected Threadex dispatcher.");
        original = backup;
        if (existsSync(original) && readFileSync(original, "utf8").includes(marker)) {
          throw new Error("Original Git hook backup points back to Threadex dispatcher.");
        }
      }
    }
    if (hook === "pre-commit" || hook === "pre-push") {
      const review = inspectOtherWorktrees(cwd, hook, input, args[0]);
      if (review.concerns.length) {
        const reason = process.env.THREADEX_WORKTREE_REASON?.trim();
        if (process.env.THREADEX_WORKTREE_REVIEW !== review.token || !reason) {
          process.stderr.write(`${worktreeReviewMessage(review, hook)}\n`);
          return 1;
        }
        process.stderr.write(`Threadex worktree review SKIPPED for this ${hook === "pre-commit" ? "commit" : "push"} retry. Other worktrees are unchanged; existing repository hooks still run. Reason: ${reason}\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`Threadex worktree review could not run: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (existsSync(original) && (statSync(original).mode & 0o111)) {
    const result = spawnSync(original, args, { cwd, env: process.env, ...(input === undefined ? { stdio: "inherit" as const } : { input, stdio: ["pipe", "inherit", "inherit"] as const }) });
    if (result.error) process.stderr.write(`Original Git hook failed: ${result.error.message}\n`);
    return result.status ?? 1;
  }
  return 0;
}

export const GIT_WORKTREE_REVIEW_INSTRUCTIONS = [
  "Threadex automatically installs Git pre-commit/pre-push hooks to review unfinished work in other worktrees of this repository.",
  "When a hook pauses an operation, inspect its worktree/branch report. Decide whether the work belongs to the same authorized task and should be completed/committed/pushed together. If ownership, intent, or permission is unclear, ask the user. Never sweep unrelated work into a commit or push automatically.",
  "You may SKIP the worktree review for clearly separate work after explaining why; user confirmation is needed only when ownership, scope, or permission is unclear. To skip, prepend BOTH THREADEX_WORKTREE_REVIEW=<exact token from this hook report> and THREADEX_WORKTREE_REASON='your reason for leaving the listed worktrees separate' to the ORIGINAL git commit/push command, preserving all of its options and arguments. Set these variables inline for that retry. This leaves the other worktrees untouched and still runs existing repository hooks. If blocked again, review the new report and use its new token; commit and push tokens differ. Do not export these variables, use --no-verify, remove/disable hooks, or change core.hooksPath to avoid the check.",
  "Push status is based on locally known tracking refs; missing upstreams, detached unpublished commits, and inaccessible worktrees require review. The hooks do not fetch, merge, commit, or push other worktrees for you."
].join("\n");
