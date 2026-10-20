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
  "Previous instructions naming session_inspector MCP tools refer to the corresponding CLI commands now. Do not start an MCP server.",
  "For Codex native children only: immediately after every successful spawn_agent, before continuing task work, call session-inspector record_subagent_prompt with {taskName: <full task_name returned by spawn>, kind: 'spawn', prompt: <exact plaintext task sent>}. Native V2 may return only task_name (e.g. /root/check), with no thread UUID: use taskName directly; do not skip recording or wait for an ID. If a thread UUID is available, threadId may be used instead. Do the same with kind 'followup' after sending follow-up instructions. Native encrypted delegation is not visible to Threadex, so this saves the original text for the child card; it does not send work. Never reconstruct a historical prompt from a summary or results. Preserve the user's language. If recording fails, report it instead of claiming the prompt was saved. Claude Agent/Task prompts are captured from native events and do not need this command.",
  "On Codex execution turns, when explicit user authorization is missing, use request_intent_approval (native tool when available, otherwise session-inspector request_intent_approval). Give concrete scope, actions, exclusions and consequences. Wait for its result before related actions. If interrupted, repeat the exact request to reconnect to its existing card and decision. Do not ask again for authorization already provided. Grants are limited to the current turn and do not override sandbox or risk policy. If native review still rejects the operation, explain that failure and ask for an ordinary explicit user reply rather than repeatedly requesting cards."
].join("\n");

/** Deliberately small shell grammar: a single argv, without substitutions,
 * redirects, operators, assignments, or command wrappers. JSON stays data. */
export function inspectorArgv(command: unknown, depth = 0): string[] | null {
  if (depth > 4) return null;
  if (Array.isArray(command)) {
    if (!command.every(value => typeof value === "string")) return null;
    if (command.length === 3 && /(?:^|\/)(?:ba|z)?sh$/.test(command[0]) && ["-c", "-lc"].includes(command[1])) {
      return inspectorArgv(command[2], depth + 1);
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
      else if (char === "$" || char === "`") return null;
      else if (char === "\\") {
        // Codex serializes its shell argv as a quoted command string. Decode
        // only literal double-quote escapes, then validate the inner shell too.
        const next = command[i + 1];
        if (!next || !['"', "\\", "$", "`"].includes(next)) return null;
        word += next;
        i++;
      }
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
  return inspectorArgv(words, depth + 1);
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
