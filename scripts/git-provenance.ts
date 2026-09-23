import { fileURLToPath } from "node:url";
import { finishGitProvenance, inspectGitProvenance, installGitProvenanceHooks, prepareGitProvenance, resolvePendingTurnNumbers } from "../src/server/gitProvenance";

const [command, ...args] = process.argv.slice(2);
const cwd = process.cwd();
switch (command) {
  case "install": installGitProvenanceHooks(cwd, fileURLToPath(import.meta.url), import.meta.resolve("tsx")); break;
  case "prepare-commit-msg":
    await resolvePendingTurnNumbers(cwd, async record => {
      const url = new URL("/api/sessions/resolve-reference", process.env.RUNNER_SERVER_URL || "http://127.0.0.1:8787");
      url.searchParams.set("target", record.sessionId);
      if (record.workspaceId) url.searchParams.set("workspaceId", record.workspaceId);
      url.searchParams.set("turnId", record.turnId!);
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Threadex turn lookup failed: HTTP ${response.status}`);
      const payload = await response.json();
      return { turnNumber: payload.turns?.find((turn: { turnId: string }) => turn.turnId === record.turnId)?.turnNumber,
        workspaceId: payload.session.workspaceId };
    });
    prepareGitProvenance(cwd, args[0]); break;
  case "post-commit": finishGitProvenance(cwd); break;
  case "inspect": console.log(JSON.stringify(inspectGitProvenance(cwd, args[0] || "HEAD", args[1]), null, 2)); break;
  default: throw new Error("Usage: git-provenance.ts install | inspect [commit] [file] | prepare-commit-msg <message-file> | post-commit");
}
