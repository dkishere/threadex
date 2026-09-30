import { readFileSync } from "node:fs";
import { runGitWorktreeReviewHook } from "../src/server/gitWorktreeGuard";

const [hook, ...args] = process.argv.slice(2);
if (!hook || !/^[a-z][a-z0-9-]*$/.test(hook)) {
  process.stderr.write("Usage: git-worktree-review.ts <hook-name> [hook args...]\n");
  process.exitCode = 1;
} else {
  // Preserve pre-push's ref updates for the original hook, including empty input.
  const input = hook === "pre-push" ? readFileSync(0, "utf8") : undefined;
  process.exitCode = runGitWorktreeReviewHook(hook, args, input);
}
