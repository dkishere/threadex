import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig, saveConfig, type BridgeConfig } from "./config.js";
import { cloneMappings, normalizePageValueMappings, pageValuesForUrl } from "./pageValues.js";

type Command = Record<string, unknown>;
type BrowserTab = { id?: number; url?: string; [key: string]: unknown };
type Pending<T> = { resolve(value: T): void; reject(error: Error): void; timer: NodeJS.Timeout };
type WebsiteDecision = { allow: boolean; scopes: WebsiteScope[]; expiresAt: number | null };
type WebsiteScope = "tabs.read" | "page.read" | "page.interact";

const scopes = new Set<WebsiteScope>(["tabs.read", "page.read", "page.interact"]);
const commandScopes: Record<string, WebsiteScope> = { listTabs: "tabs.read", snapshot: "page.read", screenshot: "page.read", navigate: "page.interact", clickSelector: "page.interact", typeSelector: "page.interact" };

export async function startDaemon(options: { dataDir?: string; port?: number } = {}) {
  const config = await loadConfig(options.dataDir, Number.isInteger(options.port) ? { port: options.port! } : {});
  const commands = new Map<string, Pending<unknown>>();
  const authorizations = new Map<string, Pending<WebsiteDecision>>();
  const websiteSessions = new Map<string, { origin: string; scopes: WebsiteScope[]; expiresAt: number | null }>();
  const wss = new WebSocketServer({ noServer: true });
  let extension: WebSocket | null = null;
  let pairingUntil = 0;
  const heartbeat = setInterval(() => {
    if (extension?.readyState === WebSocket.OPEN) extension.send(JSON.stringify({ type: "ping" }));
  }, 20_000);
  heartbeat.unref();

  const dispatch = (command: Command, timeoutMs = 15_000): Promise<unknown> => {
    if (!extension || extension.readyState !== WebSocket.OPEN) throw new Error("Chrome extension is not connected. Enable it, then run browser-bridge pair.");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { commands.delete(id); reject(new Error(`Browser command timed out after ${timeoutMs}ms.`)); }, timeoutMs);
      commands.set(id, { resolve, reject, timer });
      extension!.send(JSON.stringify({ type: "command", id, command }), (error) => {
        if (!error) return;
        clearTimeout(timer); commands.delete(id); reject(error);
      });
    });
  };

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (!loopback(request.socket.remoteAddress)) return json(response, 403, { error: "Local Browser Bridge only accepts loopback connections." });
      if (request.method === "GET" && url.pathname === "/v1/status") {
        if (!cli(request, config)) return json(response, 401, { error: "CLI authorization required." });
        return json(response, 200, { connected: extension?.readyState === WebSocket.OPEN, port: config.port, extensionId: config.extensionId });
      }
      if (request.method === "POST" && url.pathname === "/v1/command") {
        if (!cli(request, config)) return json(response, 401, { error: "CLI authorization required." });
        return json(response, 200, { ok: true, result: await run(await body(request)) });
      }
      if (request.method === "POST" && url.pathname === "/v1/extension/pair") {
        if (!cli(request, config)) return json(response, 401, { error: "CLI authorization required." });
        pairingUntil = Date.now() + 60_000;
        return json(response, 200, { ok: true, result: { pairingUntil } });
      }
      if (request.method === "POST" && url.pathname === "/v1/shutdown") {
        if (!cli(request, config)) return json(response, 401, { error: "CLI authorization required." });
        json(response, 200, { ok: true }); setTimeout(() => server.close(() => process.exit(0)), 20).unref(); return;
      }
      if (request.method === "OPTIONS" && (url.pathname === "/v1/web/pair" || url.pathname === "/v1/web/command")) return cors(response, request, 204).end();
      if (request.method === "POST" && url.pathname === "/v1/web/pair") {
        const origin = originOf(request); cors(response, request, 200);
        const requested = normalizeScopes((await body(request)).scopes);
        const decision = await authorize(origin, requested);
        if (!decision.allow) return json(response, 403, { error: "Website access was denied." });
        const token = randomUUID(); websiteSessions.set(token, { origin, scopes: decision.scopes, expiresAt: decision.expiresAt });
        return json(response, 200, { token, scopes: decision.scopes, expiresAt: decision.expiresAt });
      }
      if (request.method === "POST" && url.pathname === "/v1/web/command") {
        const origin = originOf(request); cors(response, request, 200); const session = websiteSessions.get(bearer(request));
        if (!session || session.origin !== origin || (session.expiresAt && session.expiresAt < Date.now())) return json(response, 401, { error: "A valid website session is required." });
        return json(response, 200, { ok: true, result: await websiteCommand(origin, session.scopes, await body(request)) });
      }
      return json(response, 404, { error: "Not found." });
    } catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
  });

  function authorize(origin: string, requested: WebsiteScope[]): Promise<WebsiteDecision> {
    if (!extension || extension.readyState !== WebSocket.OPEN) throw new Error("The Browser Bridge extension must be connected before a website can request access.");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { authorizations.delete(requestId); reject(new Error("Website authorization timed out.")); }, 60_000);
      authorizations.set(requestId, { resolve, reject, timer });
      extension!.send(JSON.stringify({ type: "websiteAuthorizationRequest", requestId, origin, scopes: requested }));
    });
  }

  async function websiteCommand(origin: string, allowed: WebsiteScope[], command: Command): Promise<unknown> {
    const scope = typeof command.type === "string" ? commandScopes[command.type] : undefined;
    if (!scope || !allowed.includes(scope)) throw new Error("This website is not allowed to use that browser command.");
    if (command.type === "listTabs") {
      const tabs = await dispatch(command); return Array.isArray(tabs) ? (tabs as BrowserTab[]).filter((tab) => tabOrigin(tab.url) === origin) : [];
    }
    if (!Number.isInteger(command.tabId)) throw new Error("A valid tabId is required.");
    const tabs = await dispatch({ type: "listTabs" });
    const tab = Array.isArray(tabs) ? (tabs as BrowserTab[]).find((item) => item.id === command.tabId) : undefined;
    if (!tab || tabOrigin(tab.url) !== origin) throw new Error("Websites may only control tabs with their own origin.");
    return run(command);
  }

  async function run(command: Command): Promise<unknown> {
    if (command.type === "getPageValueMappings") return { mappings: cloneMappings(config.pageValueMappings) };
    if (command.type === "setPageValueMappings") {
      config.pageValueMappings = normalizePageValueMappings(command.mappings);
      await saveConfig(config, options.dataDir);
      return { mappings: cloneMappings(config.pageValueMappings) };
    }
    if (command.type === "pageContext") {
      const captured = await dispatch(command) as Record<string, unknown>;
      const url = typeof captured.url === "string" ? captured.url : "";
      const pageValues = pageValuesForUrl(url, config.pageValueMappings);
      return {
        kind: "browser-bridge-context",
        capturedAt: new Date().toISOString(),
        ...captured,
        ...(pageValues ? { "page-values": pageValues.values, "match-by-url": pageValues.matchedPrefixes } : {})
      };
    }
    if (command.type === "reactInspect") {
      const inspected = await dispatch(command) as Record<string, unknown>;
      const url = typeof inspected.url === "string" ? inspected.url : "";
      const pageValues = pageValuesForUrl(url, config.pageValueMappings);
      return {
        ...inspected,
        ...(pageValues ? { "page-values": pageValues.values, "match-by-url": pageValues.matchedPrefixes } : {})
      };
    }
    return dispatch(command);
  }

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const extensionId = url.searchParams.get("extensionId"); const token = url.searchParams.get("token");
    const validIdentity = Boolean(extensionId && token && /^[a-p]{32}$/.test(extensionId) && /^[A-Za-z0-9_-]{32,128}$/.test(token) && request.headers.origin === `chrome-extension://${extensionId}`);
    const credentialsMatch = validIdentity && config.extensionId === extensionId && config.extensionToken === token;
    const mayClaim = validIdentity && (!config.extensionId || Date.now() < pairingUntil);
    if (url.pathname !== "/extension" || !loopback(request.socket.remoteAddress) || (!credentialsMatch && !mayClaim)) return socket.destroy();
    if (!credentialsMatch) { config.extensionId = extensionId!; config.extensionToken = token!; pairingUntil = 0; void saveConfig(config, options.dataDir); }
    wss.handleUpgrade(request, socket, head, (ws) => {
      extension?.close(1000, "Replaced by newer extension connection"); extension = ws;
      ws.on("message", (raw) => receive(raw.toString()));
      ws.on("close", () => { if (extension === ws) extension = null; rejectCommands("Chrome extension disconnected."); });
    });
  });

  function receive(raw: string): void {
    let message: Record<string, unknown>; try { message = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (message.type === "pageValueMappingsRequest" && typeof message.id === "string") {
      void handlePageValueMappingsRequest(message); return;
    }
    if (message.type === "authorizationDecision" && typeof message.requestId === "string") {
      const pending = authorizations.get(message.requestId); if (!pending) return;
      clearTimeout(pending.timer); authorizations.delete(message.requestId);
      pending.resolve({ allow: message.allow === true, scopes: normalizeScopes(message.scopes), expiresAt: expiry(message.expiresAt) }); return;
    }
    if (typeof message.id !== "string") return;
    const pending = commands.get(message.id); if (!pending) return;
    clearTimeout(pending.timer); commands.delete(message.id);
    message.ok === true ? pending.resolve(message.result) : pending.reject(new Error(typeof message.error === "string" ? message.error : "Chrome extension command failed."));
  }
  async function handlePageValueMappingsRequest(message: Record<string, unknown>): Promise<void> {
    if (!extension || extension.readyState !== WebSocket.OPEN) return;
    try {
      let result: { mappings: ReturnType<typeof cloneMappings> };
      if (message.action === "get") result = { mappings: cloneMappings(config.pageValueMappings) };
      else if (message.action === "set") {
        config.pageValueMappings = normalizePageValueMappings(message.mappings);
        await saveConfig(config, options.dataDir);
        result = { mappings: cloneMappings(config.pageValueMappings) };
      } else throw new Error("Unknown page-value mapping request.");
      extension.send(JSON.stringify({ type: "pageValueMappingsResponse", id: message.id, ok: true, result }));
    } catch (error) {
      extension.send(JSON.stringify({ type: "pageValueMappingsResponse", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  function rejectCommands(message: string): void { for (const pending of commands.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); } commands.clear(); }
  await new Promise<void>((resolve) => server.listen(config.port, "127.0.0.1", resolve));
  const address = server.address(); const port = typeof address === "object" && address ? address.port : config.port;
  if (port !== config.port) { config.port = port; await saveConfig(config, options.dataDir); }
  return { port, config, close: async () => { clearInterval(heartbeat); extension?.close(); wss.close(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

function cli(request: IncomingMessage, config: BridgeConfig): boolean { return bearer(request) === config.cliToken; }
function bearer(request: IncomingMessage): string { return request.headers.authorization?.replace(/^Bearer\s+/i, "") || ""; }
function loopback(address: string | undefined): boolean { return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"; }
function originOf(request: IncomingMessage): string { const value = request.headers.origin; if (!value || !/^https?:\/\//.test(value)) throw new Error("A browser Origin header is required."); return new URL(value).origin; }
function tabOrigin(value: unknown): string | null { try { return new URL(String(value)).origin; } catch { return null; } }
function normalizeScopes(value: unknown): WebsiteScope[] { const result = Array.isArray(value) ? value.filter((item): item is WebsiteScope => typeof item === "string" && scopes.has(item as WebsiteScope)) : []; if (!result.length) throw new Error("At least one supported scope is required."); return [...new Set(result)]; }
function expiry(value: unknown): number | null { return Number.isSafeInteger(value) && (value as number) > Date.now() ? value as number : null; }
function cors(response: ServerResponse, request: IncomingMessage, status: number): ServerResponse { const value = request.headers.origin; if (value && /^https?:\/\//.test(value)) response.setHeader("Access-Control-Allow-Origin", new URL(value).origin); response.setHeader("Vary", "Origin"); response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization"); response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS"); if (request.headers["access-control-request-private-network"] === "true") response.setHeader("Access-Control-Allow-Private-Network", "true"); response.statusCode = status; return response; }
async function body(request: IncomingMessage): Promise<Command> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const raw = Buffer.concat(chunks).toString("utf8"); const parsed: unknown = raw ? JSON.parse(raw) : {}; if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("A JSON object is required."); return parsed as Command; }
function json(response: ServerResponse, status: number, value: unknown): void { response.statusCode = status; response.setHeader("content-type", "application/json; charset=utf-8"); response.end(JSON.stringify(value)); }
