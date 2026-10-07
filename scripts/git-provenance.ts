import { readFileSync, writeFileSync } from "node:fs";
import { appendGitProvenance, finishGitProvenance, gitProvenanceSource, inspectGitProvenance, prepareGitProvenance, resolvePendingTurnNumbers } from "../src/server/gitProvenance";
import { installGitWorktreeReviewHooks } from "../src/server/gitWorktreeGuard";
import { runProvenanceGit } from "../src/server/gitProvenanceCommand";

const [command, ...args] = process.argv.slice(2);
const cwd = process.cwd();
switch (command) {
  case "install":
    if (!installGitWorktreeReviewHooks(cwd)) throw new Error("The target directory is not a Git worktree.");
    break;
  case "run": {
    if (args[0] !== "--source" || !args[1]) throw new Error("run requires --source <numbered Threadex URL>.");
    const source = args[1];
    let offset = 2;
    let rebuildFrom: string | undefined;
    if (args[offset] === "--rebuild-from") {
      rebuildFrom = args[offset + 1];
      if (!rebuildFrom) throw new Error("--rebuild-from requires a commit.");
      offset += 2;
    }
    if (args[offset] !== "--") throw new Error("Separate run options from the Git command with --.");
    process.exitCode = runProvenanceGit(cwd, source, args.slice(offset + 1), rebuildFrom);
    break;
  }
  case "prepare-commit-msg":
    await resolvePendingTurnNumbers(cwd, async record => {
      const url = new URL("/api/sessions/resolve-reference", process.env.RUNNER_SERVER_URL || process.env.THREADEX_SERVER_URL || `http://127.0.0.1:${process.env.PORT || "8787"}`);
      url.searchParams.set("target", record.sessionId);
      if (record.workspaceId) url.searchParams.set("workspaceId", record.workspaceId);
      url.searchParams.set("turnId", record.turnId!);
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Threadex turn lookup failed: HTTP ${response.status}`);
      const payload = await response.json();
      return { turnNumber: payload.turns?.find((turn: { turnId: string }) => turn.turnId === record.turnId)?.turnNumber,
        workspaceId: payload.session.workspaceId };
    });
    prepareGitProvenance(cwd, args[0], process.env.THREADEX_PROVENANCE_SOURCE); break;
  case "applypatch-msg":
    // am has not applied the patch yet: the current index is not evidence for
    // this message. Only attribute the explicit creating turn here.
    if (process.env.THREADEX_PROVENANCE_SOURCE) {
      writeFileSync(args[0], appendGitProvenance(readFileSync(args[0], "utf8"), gitProvenanceSource(process.env.THREADEX_PROVENANCE_SOURCE)));
    }
    break;
  case "post-applypatch":
  case "post-commit": finishGitProvenance(cwd); break;
  case "inspect": console.log(JSON.stringify(inspectGitProvenance(cwd, args[0] || "HEAD", args[1]), null, 2)); break;
  default: throw new Error("Usage: git-provenance.ts install | run --source <URL> [--rebuild-from <commit>] -- <git-command> [args...] | inspect [commit] [file] | prepare-commit-msg <message-file> | post-commit");
}
