import { readFile } from "node:fs/promises";
import { runCommand, toolsForAgent } from "./sessionInspectorCommands";
import { inspectorAliases as aliases } from "./sessionInspectorCommand";

// All operations require the owning Threadex HTTP server.

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const tools = toolsForAgent();
  if (!command || command === "help" || command === "--help") {
    if (args.length > 1) throw new Error("Expected help [command].");
    if (args[0] === "--all" && args.length === 1) return { commands: tools };
    const name = args[0] && (aliases[args[0]] ?? args[0]);
    const selected = name ? tools.find(tool => tool.name === name) : null;
    if (name && !selected) throw new Error(`Command is not available: ${name}`);
    return selected ?? {
      usage: "session-inspector <command> [JSON | --stdin | --file PATH]; help [command]",
      aliases,
      commands: tools.map(tool => ({ name: tool.name, description: tool.description }))
    };
  }
  const name = aliases[command] ?? command;
  if (!tools.some(tool => tool.name === name)) throw new Error(`Command is not available to this ${process.env.THREADEX_TODO_AGENT_ROLE || "default"} agent: ${name}`);
  let raw = "{}";
  if (args[0] === "--stdin" && args.length === 1) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    raw = Buffer.concat(chunks).toString("utf8");
  } else if (args[0] === "--file" && args.length === 2) {
    raw = await readFile(args[1], "utf8");
  } else if (args.length === 1 && !args[0].startsWith("--")) {
    raw = args[0];
  } else if (args.length) {
    throw new Error("Expected one JSON object, --stdin, or --file PATH.");
  }
  const input: unknown = JSON.parse(raw);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Arguments must be a JSON object.");
  if (!process.env.RUNNER_SERVER_URL && !process.env.SESSION_INSPECTOR_SERVER_URL) {
    throw new Error("RUNNER_SERVER_URL is required. Use the active Threadex server URL; do not open its database directly.");
  }
  return runCommand(name, input as Record<string, unknown>);
}

try {
  process.stdout.write(`${JSON.stringify(await main())}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
