import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appendGitProvenance, gitProvenanceSource, parseGitProvenance } from "./gitProvenance";
import { installGitWorktreeReviewHooks } from "./gitWorktreeGuard";

/** Explicit runner entry point; never intercepts Git used by an unrelated bot.
 * Run in the target worktree. Global Git overrides are deliberately disallowed
 * so enrollment and Git cannot silently target different repositories/hooks.
 */
export function runProvenanceGit(cwd: string, source: string, args: string[], rebuildFrom?: string) {
  const records = gitProvenanceSource(source);
  const [command, ...options] = args;
  if (!["commit", "commit-tree", "cherry-pick", "rebase", "merge", "revert", "am"].includes(command)) {
    throw new Error("Use run only for commit, commit-tree, cherry-pick, rebase, merge, revert, or am, from the target worktree.");
  }
  if (rebuildFrom && command !== "commit-tree") throw new Error("--rebuild-from is only supported for commit-tree.");
  const env = { ...process.env, THREADEX_PROVENANCE_SOURCE: source };
  const git = (args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (command !== "commit-tree") {
    if (command === "am" && options.some(option => option === "--no-verify" || option === "-n")) {
      throw new Error("git am must run its applypatch-msg provenance hook; remove --no-verify/-n.");
    }
    if (command === "rebase") {
      if (options.includes("--apply") || existsSync(resolve(cwd, git(["rev-parse", "--git-path", "rebase-apply"]).trim()))) {
        throw new Error("Use the merge rebase backend for provenance; an existing apply-backend rebase must be handled separately.");
      }
      // The apply backend can bypass message hooks. Override rebase.backend
      // only when starting a rebase, not when continuing or aborting one.
      if (!options.some(option => ["--continue", "--skip", "--abort", "--quit", "--edit-todo", "--show-current-patch"].includes(option))) {
        args = [command, "--merge", ...options];
      }
    }
    if (!installGitWorktreeReviewHooks(cwd)) throw new Error("The target directory is not a Git worktree.");
    const result = spawnSync("git", args, { cwd, env, stdio: "inherit" });
    if (result.error) throw result.error;
    return result.status ?? 1;
  }

  // commit-tree never invokes prepare-commit-msg. Assemble the message BEFORE
  // Git hashes/signs the object; do not amend it or move any ref afterwards.
  if (rebuildFrom) {
    const oid = git(["rev-parse", "--verify", "--end-of-options", `${rebuildFrom}^{commit}`]).trim();
    records.push(...parseGitProvenance(git(["show", "-s", "--format=%B", oid])));
  }
  const forwarded: string[] = [];
  const messages: string[] = [];
  let stdin: string | undefined;
  const readInput = () => stdin ??= readFileSync(0, "utf8");
  let treeSeen = false;
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    const flag = option.slice(0, 2);
    if (flag === "-m" || flag === "-F" || flag === "-p") {
      const value = option.length > 2 ? option.slice(2) : options[++i];
      if (value === undefined) throw new Error(`Missing value for ${flag}.`);
      if (flag === "-p") forwarded.push(flag, value);
      else messages.push(flag === "-m" ? value : value === "-" ? readInput() : readFileSync(value, "utf8"));
    } else if (option === "--no-gpg-sign" || option.startsWith("-S") || option === "--gpg-sign" || option.startsWith("--gpg-sign=")) {
      forwarded.push(option);
    } else if (!option.startsWith("-") && !treeSeen) {
      forwarded.push(git(["rev-parse", "--verify", "--end-of-options", `${option}^{tree}`]).trim());
      treeSeen = true;
    } else {
      throw new Error(`Unsupported commit-tree argument: ${option}`);
    }
  }
  if (!treeSeen) throw new Error("commit-tree requires a tree object.");
  const message = appendGitProvenance(messages.length ? messages.join("\n\n") : readInput(), records);
  const result = spawnSync("git", ["commit-tree", ...forwarded, "-F", "-"], {
    cwd, env, input: message, stdio: ["pipe", "inherit", "inherit"]
  });
  if (result.error) throw result.error;
  // No pending associations are consumed: this object may never reach a ref,
  // and its tree need not be the current index or worktree.
  return result.status ?? 1;
}
