import { fileURLToPath } from "node:url";

export const inspectorScript = fileURLToPath(new URL("../../scripts/session-inspector.mjs", import.meta.url));
export type InspectorCliConfig = { env: Record<string, string>; approvedCommands: string[]; maxCalls?: number };
export const inspectorAliases: Record<string, string> = { search: "search_sessions", get: "get_session", recover: "recover_current_session", ask: "ask_session", prompt: "prompt_session" };
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
export const inspectorCommand = [process.execPath, inspectorScript].map(quote).join(" ");
export const inspectorInstructions = [
  `Threadex commands use the CLI. In these instructions, session-inspector means: ${inspectorCommand}`,
  "Run session-inspector help for available commands, or help <command> for its JSON schema. Invoke a command with one shell-quoted JSON object; omit it for an empty object. Results are JSON on stdout; failures are JSON on stderr with a nonzero exit status.",
  "The runner supplies the session, role, server URL and approval policy. Do not replace them. If sandbox networking blocks an authorized command, request command escalation using the exact CLI invocation; never enable general network access or alter sandbox settings.",
  "Previous instructions naming session_inspector MCP tools refer to the corresponding CLI commands now. Do not start an MCP server."
].join("\n");

/** Deliberately small shell grammar: a single argv, without substitutions,
 * redirects, operators, assignments, or command wrappers. JSON stays data. */
export function inspectorArgv(command: unknown): string[] | null {
  if (Array.isArray(command)) {
    if (!command.every(value => typeof value === "string")) return null;
    if (command.length === 3 && /(?:^|\/)(?:ba|z)?sh$/.test(command[0]) && ["-c", "-lc"].includes(command[1])) {
      return inspectorArgv(command[2]);
    }
    return command;
  }
  if (typeof command !== "string") return null;
  const words: string[] = [];
  let word = "", active = false, quoteChar = "";
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quoteChar === "'") {
      if (char === "'") quoteChar = "";
      else word += char;
    } else if (quoteChar === '"') {
      if (char === '"') quoteChar = "";
      else if (char === "$" || char === "`" || char === "\\") return null;
      else word += char;
    } else if (char === "'" || char === '"') {
      quoteChar = char; active = true;
    } else if (char === " " || char === "\t") {
      if (active) { words.push(word); word = ""; active = false; }
    } else if (char === "\\" && command[i + 1] === "'") {
      word += "'"; active = true; i++;
    } else if (/[\n\r$`;&|<>()\\*?\[\]{}~]/.test(char)) return null;
    else { word += char; active = true; }
  }
  if (quoteChar) return null;
  if (active) words.push(word);
  return words;
}

export function approvedInspectorCommand(command: unknown, allowed: readonly string[]): boolean {
  const argv = inspectorArgv(command);
  if (!argv || argv[0] !== process.execPath || argv[1] !== inspectorScript) return false;
  const [name, ...args] = argv.slice(2);
  if (name === "help" || name === "--help") return args.length <= 1 && (!args[0] || args[0] === "--all" || allowed.includes(inspectorAliases[args[0]] ?? args[0]));
  if (!allowed.includes(inspectorAliases[name] ?? name) || args.length > 1) return false;
  try {
    const value: unknown = JSON.parse(args[0] ?? "{}");
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  } catch { return false; }
}

/** The budget lives in the host runner, across short-lived CLI processes. */
export function inspectorApprovalGate(config: InspectorCliConfig) {
  let calls = 0;
  return (command: unknown) => {
    if (!approvedInspectorCommand(command, config.approvedCommands)) return false;
    const name = inspectorArgv(command)?.[2];
    if (name === "help" || name === "--help") return true;
    if (config.maxCalls !== undefined && calls >= config.maxCalls) return false;
    calls++;
    return true;
  };
}
