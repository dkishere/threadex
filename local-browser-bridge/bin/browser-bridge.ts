#!/usr/bin/env node
import { spawn } from "node:child_process";
import { lstat, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, sep } from "node:path";
import { dataDirectory, loadConfig, type BridgeConfig } from "../src/config.js";
import { startDaemon } from "../src/daemon.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const result = await main(process.argv.slice(2));
  if (result !== undefined) process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) { process.stderr.write(`browser-bridge: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }

async function main(args: string[]): Promise<unknown> {
  const [operation = "help", ...rest] = args;
  if (operation === "daemon") { await startDaemon(); await new Promise<void>(() => undefined); }
  if (operation === "help" || operation === "--help") return help();
  if (operation === "start") { await ensureDaemon(); return status(); }
  if (operation === "stop") return api(await loadConfig(dataDirectory()), "/v1/shutdown", {});
  if (operation === "pair") return pair();
  if (operation === "status") return status();
  if (operation === "page-values") return (await api(await ensureDaemon(), "/v1/command", { type: "getPageValueMappings" })).result;
  if (operation === "set-page-values") return (await api(await ensureDaemon(), "/v1/command", { type: "setPageValueMappings", mappings: json(required(rest[0], "mappings JSON"), "mappings JSON") })).result;
  const command = parse(operation, rest); const response = await api(await ensureDaemon(), "/v1/command", command);
  if (operation === "screenshot" && rest[1]) {
    const dataUrl = (response.result as { dataUrl?: unknown })?.dataUrl;
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) throw new Error("Bridge did not return a PNG screenshot.");
    await validateRestrictedOutput(rest[1]);
    await writeFile(rest[1], Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64")); return { path: rest[1] };
  }
  if (operation === "context-screenshot") {
    const output = required(rest[1], "output path");
    const result = response.result as { dataUrl?: unknown; key?: unknown; capturedAt?: unknown; expiresAt?: unknown; width?: unknown; height?: unknown; size?: unknown };
    if (typeof result?.dataUrl !== "string" || !result.dataUrl.startsWith("data:image/webp;base64,")) throw new Error("Bridge did not return a WebP context screenshot.");
    await validateRestrictedOutput(output);
    await writeFile(output, Buffer.from(result.dataUrl.slice("data:image/webp;base64,".length), "base64"));
    return { path: output, key: result.key, capturedAt: result.capturedAt, expiresAt: result.expiresAt, width: result.width, height: result.height, size: result.size };
  }
  if (operation === "context-snapshot") {
    const output = required(rest[1], "output path");
    const result = response.result as { snapshot?: unknown; key?: unknown; capturedAt?: unknown; expiresAt?: unknown; size?: unknown };
    if (!result || typeof result.snapshot !== "object" || result.snapshot === null || Array.isArray(result.snapshot)) throw new Error("Bridge did not return a page context snapshot.");
    await validateRestrictedOutput(output);
    await writeFile(output, `${JSON.stringify(result.snapshot)}\n`, "utf8");
    return { path: output, key: result.key, capturedAt: result.capturedAt, expiresAt: result.expiresAt, size: result.size };
  }
  return response.result;
}

async function pair(): Promise<unknown> {
  const config = await ensureDaemon(); let current = await statusFor(config);
  if (current.connected) return { paired: true, connected: true, extensionId: current.extensionId, automatic: true };
  await api(config, "/v1/extension/pair", {});
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { await delay(250); current = await statusFor(config); if (current.connected) return { paired: true, connected: true, extensionId: current.extensionId, automatic: true }; }
  throw new Error("Pairing timed out. Enable Local Browser Bridge in Chrome, then run browser-bridge pair again; no token needs to be pasted.");
}
async function status(): Promise<unknown> { return statusFor(await ensureDaemon()); }
async function statusFor(config: BridgeConfig): Promise<{ connected: boolean; port: number; extensionId: string | null }> { const response = await fetch(`http://127.0.0.1:${config.port}/v1/status`, { headers: { authorization: `Bearer ${config.cliToken}` } }); if (!response.ok) throw new Error(`Daemon returned HTTP ${response.status}`); return response.json() as Promise<{ connected: boolean; port: number; extensionId: string | null }>; }
async function ensureDaemon(): Promise<BridgeConfig> {
  let config = await loadConfig(dataDirectory()); if (await running(config)) return config;
  const child = spawn(process.execPath, [resolve(root, "bin/browser-bridge.js"), "daemon"], { detached: true, stdio: "ignore" }); child.unref();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) { await delay(100); config = await loadConfig(dataDirectory()); if (await running(config)) return config; }
  throw new Error("Could not start the Browser Bridge daemon.");
}
async function running(config: BridgeConfig): Promise<boolean> { try { return (await fetch(`http://127.0.0.1:${config.port}/v1/status`, { headers: { authorization: `Bearer ${config.cliToken}` }, signal: AbortSignal.timeout(300) })).ok; } catch { return false; } }
async function api(config: BridgeConfig, path: string, body: Record<string, unknown>): Promise<{ ok?: boolean; result?: unknown; error?: string }> { const response = await fetch(`http://127.0.0.1:${config.port}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.cliToken}` }, body: JSON.stringify(body) }); const payload = await response.json().catch(() => ({})) as { ok?: boolean; result?: unknown; error?: string }; if (!response.ok || payload.ok !== true) throw new Error(payload.error || `Daemon returned HTTP ${response.status}`); return payload; }
function parse(operation: string, args: string[]): Record<string, unknown> {
  switch (operation) {
    case "tabs": return { type: "listTabs" };
    case "windows": return { type: "listWindows" };
    case "targets": return { type: "listTargets" };
    case "new-tab": return { type: "createTab", url: required(args[0], "url"), active: true };
    case "activate-tab": return { type: "activateTab", tabId: tab(args[0]) };
    case "close-tab": return { type: "closeTab", tabId: tab(args[0]) };
    case "navigate": return { type: "navigate", tabId: tab(args[0]), url: required(args[1], "url") };
    case "reload": return { type: "reload", tabId: tab(args[0]), ignoreCache: args[1] === "--ignore-cache" };
    case "snapshot": return { type: "snapshot", tabId: tab(args[0]) };
    case "page-context": return { type: "pageContext", tabId: tab(args[0]), ...(args[1] ? { selector: args[1] } : {}) };
    case "evaluate": return { type: "evaluate", tabId: tab(args[0]), expression: required(args[1], "javascript") };
    case "react-inspect": return { type: "reactInspect", tabId: tab(args[0]), selector: required(args[1], "selector") };
    case "click": return { type: "clickSelector", tabId: tab(args[0]), selector: required(args[1], "selector") };
    case "type": return { type: "typeSelector", tabId: tab(args[0]), selector: required(args[1], "selector"), text: args.slice(2).join(" ") };
    case "screenshot": return { type: "screenshot", tabId: tab(args[0]) };
    case "context-screenshot": return { type: "getContextScreenshot", key: required(args[0], "screenshot key") };
    case "context-snapshot": return { type: "getPageSnapshot", key: required(args[0], "page snapshot key") };
    case "cdp": return { type: "cdp", tabId: tab(args[0]), method: required(args[1], "method"), params: json(args[2] ?? "{}", "params JSON") };
    case "api": return { type: "chromeApi", namespace: required(args[0], "namespace"), method: required(args[1], "method"), args: json(args[2] ?? "[]", "args JSON") };
    default: throw new Error(`Unknown operation '${operation}'. Run browser-bridge help.`);
  }
}
function tab(value: string | undefined): number { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 0) throw new Error("A valid tab id is required."); return parsed; }
function required(value: string | undefined, name: string): string { if (!value?.trim()) throw new Error(`${name} is required.`); return value; }
function json(value: string, label: string): unknown { try { return JSON.parse(value); } catch { throw new Error(`${label} must be valid JSON.`); } }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function validateRestrictedOutput(value: string): Promise<void> {
  if (process.env.LOCAL_BROWSER_BRIDGE_RESTRICT_OUTPUTS !== "1") return;
  const output = resolve(value);
  const parent = await realpath(dirname(output));
  const roots = await Promise.all(
    [process.cwd(), tmpdir(), "/private/tmp", "/tmp"].map((item) => realpath(item).catch(() => resolve(item)))
  );
  if (!roots.some((allowed) => parent === allowed || parent.startsWith(`${allowed}${sep}`))) {
    throw new Error("Screenshot output must be inside the current workspace or a temporary directory.");
  }
  const existing = await lstat(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) throw new Error("Screenshot output must not be a symbolic link.");
}
function help(): void {
  process.stdout.write([
    "browser-bridge start",
    "browser-bridge stop",
    "browser-bridge pair",
    "browser-bridge status",
    "browser-bridge page-values",
    "browser-bridge set-page-values '<mappings-json>'",
    "browser-bridge tabs",
    "browser-bridge windows",
    "browser-bridge targets",
    "browser-bridge new-tab <url>",
    "browser-bridge activate-tab <tabId>",
    "browser-bridge close-tab <tabId>",
    "browser-bridge navigate <tabId> <url>",
    "browser-bridge reload <tabId> [--ignore-cache]",
    "browser-bridge snapshot <tabId>",
    "browser-bridge page-context <tabId> [css-selector]",
    "browser-bridge evaluate <tabId> <javascript>",
    "browser-bridge react-inspect <tabId> <css-selector>",
    "browser-bridge click <tabId> <css-selector>",
    "browser-bridge type <tabId> <css-selector> <text>",
    "browser-bridge screenshot <tabId> [output.png]",
    "browser-bridge context-screenshot <key> <output.webp>",
    "browser-bridge context-snapshot <key> <output.json>",
    "browser-bridge cdp <tabId> <Method.name> [params-json]",
    "browser-bridge api <namespace> <method> [args-json]"
  ].join("\n") + "\n");
}
