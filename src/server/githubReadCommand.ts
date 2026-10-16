import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectorArgv } from "./sessionInspectorCommand";

export type GitHubReadCliConfig = { executable: string; configDir: string; hostHome: string };
const helperScript = fileURLToPath(new URL("../../scripts/helper-github.mjs", import.meta.url));

export function githubReadArgv(config: GitHubReadCliConfig) {
  return [process.execPath, helperScript, config.hostHome, config.executable];
}

export function resolveGitHubReadCli(env: NodeJS.ProcessEnv = process.env): GitHubReadCliConfig | undefined {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const executable = resolve(directory, "gh");
    try {
      accessSync(executable, constants.X_OK);
      if (statSync(executable).isFile()) return {
        executable,
        hostHome: resolve(env.HOME || homedir()),
        configDir: resolve(env.GH_CONFIG_DIR || (env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME, "gh")
          : process.platform === "win32" && env.AppData ? resolve(env.AppData, "GitHub CLI")
          : resolve(env.HOME || homedir(), ".config/gh")))
      };
    } catch { /* Try the next installed location. */ }
  }
  return undefined;
}

export function githubReadEnvironment(config: GitHubReadCliConfig) {
  return { GH_CONFIG_DIR: config.configDir, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", GH_NO_UPDATE_NOTIFIER: "1" };
}

export function githubReadInstructions(config: GitHubReadCliConfig) {
  const command = githubReadArgv(config).map(value => `'${value.replace(/'/g, "'\\''")}'`).join(" ");
  return [
    `Read-only GitHub CLI access is available using the existing login. In these instructions gh means this exact invocation: ${command}. It runs the installed GitHub CLI with its original credential environment, while your own HOME stays isolated. Do not change HOME or GH_CONFIG_DIR yourself or read credentials.`,
    `Use ${command} pr view <PR-url> --json number,title,body,url,comments,reviews,files,headRefOid,baseRefOid, or pr view <number> --repo <owner/repo> --comments. Read-only pr diff and pr checks are also allowed.`,
    `For inline review comments use ${command} api repos/<owner>/<repo>/pulls/<number>/comments --paginate; for conversation comments use repos/<owner>/<repo>/issues/<number>/comments. GET endpoints for the PR, reviews, files and commits are allowed. Use --jq for compact output instead of shell pipes. API calls must use GET (the default); do not send fields, request bodies, GraphQL or mutations.`,
    "Run each command separately with the exact invocation above, no environment assignments, redirection or shell chaining. In Codex use sandbox_permissions=require_escalated; in Claude Bash use dangerouslyDisableSandbox=true. These read-only requests are already allowed for the user's review task; do not ask the user to approve them again. Do not post replies, approve or merge PRs, or change GitHub state.",
    "If the CLI reports an actual login or access failure, use Browser Bridge when available. If neither can retrieve the requested PR, report the exact limitation; never guess a PR's identity from local branch names or push times or claim its comments were reviewed."
  ].join("\n");
}

/** Known read-only subcommands and REST PR resources; unknown flags fail closed. */
export function approvedGitHubReadCommand(command: unknown, config: GitHubReadCliConfig) {
  const parsed = inspectorArgv(command);
  if (!parsed) return false;
  const prefix = githubReadArgv(config);
  const argv = prefix.every((part, index) => parsed[index] === part)
    ? [config.executable, ...parsed.slice(prefix.length)] : parsed;
  if (argv[0] !== config.executable) return false;
  let args: string[];
  let booleans: string[];
  let values: string[];
  const api = argv[1] === "api";
  if (api) {
    args = argv.slice(2);
    booleans = ["--help", "--paginate", "--slurp", "--include", "-i"];
    values = ["--method", "-X", "--jq", "-q"];
  } else if (argv[1] === "pr" && ["view", "diff", "checks"].includes(argv[2])) {
    args = argv.slice(3);
    booleans = ["--help", ...(argv[2] === "view" ? ["--comments", "-c"] : argv[2] === "diff" ? ["--patch", "--name-only"] : ["--required"])];
    values = ["--repo", "-R", ...(argv[2] === "diff" ? [] : ["--json", "--jq", "-q"])];
  } else return false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!argument.startsWith("-")) { positional.push(argument); continue; }
    if (booleans.includes(argument)) continue;
    const equal = argument.indexOf("=");
    const flag = equal < 0 ? argument : argument.slice(0, equal);
    if (!values.includes(flag)) return false;
    const value = equal < 0 ? args[++index] : argument.slice(equal + 1);
    if (!value || value.startsWith("-")) return false;
    if (["--method", "-X"].includes(flag) && value !== "GET") return false;
  }
  if (positional.length === 0) return args.includes("--help");
  if (positional.length !== 1) return false;
  if (!api) return /^\d+$/.test(positional[0]) || /^https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(positional[0]);
  return /^\/?repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:pulls\/\d+(?:\/(?:comments|reviews|files|commits)|\/reviews\/\d+\/comments)?|issues\/\d+(?:\/comments)?)(?:\?(?:per_page|page)=\d+(?:&(?:per_page|page)=\d+)*)?$/.test(positional[0]);
}
