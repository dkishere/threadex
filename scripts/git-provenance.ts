import { fileURLToPath } from "node:url";
import { finishGitProvenance, inspectGitProvenance, installGitProvenanceHooks, prepareGitProvenance } from "../src/server/gitProvenance";

const [command, ...args] = process.argv.slice(2);
const cwd = process.cwd();
switch (command) {
  case "install": installGitProvenanceHooks(cwd, fileURLToPath(import.meta.url), import.meta.resolve("tsx")); break;
  case "prepare-commit-msg": prepareGitProvenance(cwd, args[0]); break;
  case "post-commit": finishGitProvenance(cwd); break;
  case "inspect": console.log(JSON.stringify(inspectGitProvenance(cwd, args[0] || "HEAD", args[1]), null, 2)); break;
  default: throw new Error("Usage: git-provenance.ts install | inspect [commit] [file] | prepare-commit-msg <message-file> | post-commit");
}
