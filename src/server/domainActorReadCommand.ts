import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Deliberately small argv grammar: no shell, interpreters, hooks or write flags. */
export async function actorReadCommand(request: Record<string, unknown>, workspaceCwd?: string): Promise<{ executable: string; args: string[]; cwd: string }> {
  if (!workspaceCwd) throw new Error("Project directory is unavailable during job pickup.");
  if (typeof request.command !== "string" || !Array.isArray(request.args) || request.args.length > 64
    || request.args.some(arg => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0"))) throw new Error("Invalid read-command arguments.");
  const args = request.args as string[];
  const cwd = await realpath(workspaceCwd);
  const checkPaths = async (paths: string[], allowRoot = false) => {
    if (!paths.length) throw new Error("Supply explicit project paths for this read command.");
    for (const path of paths) {
      if (path.startsWith("-")) throw new Error("Options are not allowed in file paths.");
      const target = await realpath(resolve(cwd, path));
      const scope = relative(cwd, target);
      if (isAbsolute(scope) || scope === ".." || scope.startsWith(`..${sep}`) || (!scope && !allowRoot)
        || scope.split(sep).some(part => [".git", ".aws", ".codex", ".agents", "data", "node_modules", "dist"].includes(part))) {
        throw new Error("Read paths must stay in explicit project source, test, config or documentation paths; runtime, credentials and generated data are excluded.");
      }
    }
  };
  if (request.command === "pwd" && !args.length) return { executable: "pwd", args, cwd };
  if (["cat", "ls", "wc"].includes(request.command)) {
    const allowed = request.command === "ls" ? ["-l", "-a", "-la", "-1"] : request.command === "wc" ? ["-l", "-c", "-w"] : [];
    let offset = 0;
    while (allowed.includes(args[offset])) offset++;
    if (args[offset] === "--") offset++;
    await checkPaths(args.slice(offset), request.command === "ls");
    return { executable: request.command, args: [...args.slice(0, offset).filter(arg => arg !== "--"), "--", ...args.slice(offset)], cwd };
  }
  if (request.command === "rg") {
    const split = args.indexOf("--");
    if (split < 0 || args.slice(0, split).some(arg => !["-n", "-i", "-F", "-l", "--files"].includes(arg))) throw new Error("Use rg [--files|-n|-i|-F|-l] -- [pattern] <explicit project paths>.");
    const files = args.slice(0, split).includes("--files");
    if (!files && typeof args[split + 1] !== "string") throw new Error("Missing search pattern.");
    await checkPaths(args.slice(split + (files ? 1 : 2)));
    return { executable: "rg", args: ["--no-config", ...args], cwd };
  }
  if (request.command === "git") {
    const [operation, ...rest] = args;
    const split = rest.indexOf("--");
    const flags = split < 0 ? rest : rest.slice(0, split);
    const paths = split < 0 ? [] : rest.slice(split + 1);
    const allowed: Record<string, string[]> = {
      status: ["--short", "--branch", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--untracked-files=no"],
      diff: ["--stat", "--numstat", "--name-only", "--name-status", "--cached", "--staged", "--check", "--no-color", "--no-ext-diff", "--no-textconv"],
      "ls-files": ["--cached", "--modified", "--deleted"],
      log: ["--oneline", "--no-decorate", "--no-color"]
    };
    if (!allowed[operation] || flags.some(flag => !allowed[operation].includes(flag))) throw new Error("Only git status/diff/ls-files/log with supported read-only flags are allowed during job pickup.");
    if (paths.length) await checkPaths(paths);
    return { executable: "git", args: ["--no-pager", "-c", "core.fsmonitor=false", operation,
      ...(operation === "diff" ? ["--no-ext-diff", "--no-textconv"] : []),
      ...(operation === "log" ? ["--no-show-signature", "-n", "20"] : []), ...rest], cwd };
  }
  throw new Error("Unsupported read-only command. Available: pwd, cat, ls, wc, rg, git status/diff/ls-files/log. Ask a targeted question if these cannot supply the evidence.");
}
