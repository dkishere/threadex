import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { inspectorArgv } from "./sessionInspectorCommand";

export type BrowserBridgeCliConfig = { executable: string; dataDir: string };

/** Resolve before the helper replaces HOME; never copy the bridge's credentials. */
export function resolveBrowserBridgeCli(env: NodeJS.ProcessEnv = process.env): BrowserBridgeCliConfig | undefined {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const executable = resolve(directory, "browser-bridge");
    try {
      accessSync(executable, constants.X_OK);
      if (statSync(executable).isFile()) return {
        executable,
        dataDir: resolve(env.LOCAL_BROWSER_BRIDGE_DATA_DIR || resolve(env.HOME || homedir(), ".local-browser-bridge"))
      };
    } catch { /* Try the next installed location. */ }
  }
  return undefined;
}

export function browserBridgeEnvironment(config: BrowserBridgeCliConfig) {
  return { LOCAL_BROWSER_BRIDGE_DATA_DIR: config.dataDir, LOCAL_BROWSER_BRIDGE_RESTRICT_OUTPUTS: "1" };
}

export function browserBridgeInstructions(config: BrowserBridgeCliConfig) {
  const command = `'${config.executable.replace(/'/g, "'\\''")}'`;
  return [
    `Browser inspection is available through the installed Browser Bridge CLI: ${command}. It connects to the user's existing authenticated Chrome profile; it is not a web-search or MCP tool.`,
    `Use ${command} help for syntax. Available inspection commands: status, tabs, windows, targets, page-values, new-tab <url>, navigate <tabId> <url>, snapshot <tabId>, page-context <tabId> [selector], react-inspect <tabId> <selector>, evaluate <tabId> '<read-only JavaScript>', click <tabId> <selector>, type <tabId> <selector> <text>, screenshot <tabId> <absolute-scratch-path>, context-snapshot <key> <absolute-scratch-path>, context-screenshot <key> <absolute-scratch-path>.`,
    "Read supplied browser-bridge-context first and use its tabId directly; use context-snapshot for captured text. Otherwise list tabs to find the relevant page, or open the requested URL. For authenticated pages such as private GitHub PR comments, use this browser instead of assuming a web-search 404 means the page is unavailable.",
    "Run each CLI call as a separate command, using the exact executable above, without shell chaining, environment assignments or redirection. In Codex request sandbox_permissions=require_escalated; in Claude use Bash with dangerouslyDisableSandbox=true. Only these CLI calls are approved outside the sandbox; general shell network access remains blocked. The runner already supplies the correct bridge settings location; do not change HOME or bridge configuration.",
    "Use browser actions only to inspect the requested content, including opening pages or expanding review threads. Do not post comments, send messages, submit changes, change account settings, or expose cookies or credentials. Save captures only to absolute paths inside your private scratch directory. If the bridge reports it is disconnected, report that the Local Browser Bridge extension needs enabling; do not pair or reconfigure it."
  ].join("\n");
}

/** Single CLI invocations only, with file output confined to the helper's scratch. */
export function approvedBrowserBridgeCommand(command: unknown, config: BrowserBridgeCliConfig, scratchDir?: string | null) {
  const argv = inspectorArgv(command);
  if (!argv || argv[0] !== config.executable) return false;
  const [operation = "help", ...args] = argv.slice(1);
  if (["help", "--help", "status", "tabs", "windows", "targets", "page-values"].includes(operation)) return args.length === 0;
  const tab = (value: string | undefined) => typeof value === "string" && /^\d+$/.test(value);
  const httpUrl = (value: string | undefined) => {
    try { return ["http:", "https:"].includes(new URL(value ?? "").protocol); } catch { return false; }
  };
  if (operation === "new-tab") return args.length === 1 && httpUrl(args[0]);
  if (operation === "navigate") return args.length === 2 && tab(args[0]) && httpUrl(args[1]);
  if (operation === "snapshot") return args.length === 1 && tab(args[0]);
  if (operation === "page-context") return (args.length === 1 || args.length === 2) && tab(args[0]);
  if (["evaluate", "react-inspect", "click"].includes(operation)) return args.length === 2 && tab(args[0]);
  if (operation === "type") return args.length === 3 && tab(args[0]);
  if (["screenshot", "context-snapshot", "context-screenshot"].includes(operation)) {
    if (args.length !== 2 || !scratchDir || !isAbsolute(args[1])) return false;
    if (operation === "screenshot" ? !tab(args[0]) : !args[0].startsWith("codex-browser-bridge:context:")) return false;
    try {
      const root = realpathSync(scratchDir);
      const output = existsSync(args[1]) ? realpathSync(args[1]) : resolve(realpathSync(dirname(args[1])), basename(args[1]));
      const path = relative(root, output);
      return Boolean(path) && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
    } catch { return false; }
  }
  return false;
}
