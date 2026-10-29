import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { createEphemeralAgentHome, defaultAgentHomeCandidates } from "./agentCli";
import type { ClaudeRunnerContext } from "./claudeRunner";

export const CODEX_IMAGE_TOOL = "mcp__codex_image__generate_image";
export const ACP_PACKAGE = "@agentclientprotocol/codex-acp@2.2.2";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_LINE_BYTES = 32 * 1024 * 1024;
type Json = Record<string, any>;

/** SDK query options are turn-local; no user/project MCP settings are written. */
export function codexImageMcpConfig(input: { cwd: string; readOnly: boolean; codexHome?: string }, env = process.env): ClaudeRunnerContext["mcpServers"] {
  if (input.readOnly) return {};
  return { codex_image: {
    type: "stdio" as const,
    command: process.execPath,
    args: ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../../scripts/codex-image-mcp.ts", import.meta.url))],
    env: {
      THREADEX_IMAGE_CWD: input.cwd,
      ...(input.codexHome ? { THREADEX_IMAGE_AUTH_HOME: input.codexHome } : {}),
      ...Object.fromEntries(["THREADEX_CODEX_ACP_PATH", "THREADEX_IMAGE_MODEL", "THREADEX_IMAGE_TIMEOUT_MS", "npm_config_cache"]
        .flatMap(key => env[key] ? [[key, env[key]!]] : []))
    }
  } };
}

/** Split only at LF: readline also splits legal JSON string characters U+2028/U+2029. */
export function jsonLines(onMessage: (message: Json) => void, onError: (error: Error) => void) {
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  return (chunk: Buffer) => {
    buffered += decoder.write(chunk);
    let end: number;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) { onError(new Error("Protocol message is too large.")); return; }
      if (line.trim()) {
        try { onMessage(JSON.parse(line)); }
        catch { onError(new Error("Invalid JSON from protocol peer.")); return; }
      }
    }
    if (Buffer.byteLength(buffered) > MAX_LINE_BYTES) { buffered = ""; onError(new Error("Protocol message is too large.")); }
  };
}

export class CodexImageAcp {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private sessionId?: string;
  private images = new Map<string, Json>();
  private notes = "";
  private closed = false;
  private failure?: Error;

  constructor(private options: { cwd: string; command: string; args: string[]; env: NodeJS.ProcessEnv }) {}

  private send(value: Json) { this.child?.stdin.write(`${JSON.stringify(value)}\n`); }
  private fail(error: Error) {
    this.failure ??= error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
  private request(method: string, params: Json): Promise<Json> {
    if (this.closed || this.failure) return Promise.reject(this.failure ?? new Error("ACP connection closed."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  private message(message: Json) {
    if (message.method && message.id !== undefined) {
      // This tool never grants the nested agent additional permissions or filesystem/terminal access.
      this.send(message.method === "session/request_permission"
        ? { jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } }
        : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client operation is unavailable in image generation." } });
      return;
    }
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(`Codex ACP: ${message.error.message}`));
      else waiter?.resolve(message.result ?? {});
      return;
    }
    if (message.method !== "session/update" || message.params?.sessionId !== this.sessionId) return;
    const update = message.params.update;
    const collect = (content: Json) => {
      if (content?.type === "image" && typeof content.data === "string") {
        if (content.mimeType !== "image/png" || !content.data || !/^[A-Za-z0-9+/]+={0,2}$/.test(content.data) ||
            content.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
          this.fail(new Error("Codex returned an unsupported or oversized image (limit 5 MB PNG).")); return;
        }
        const bytes = Buffer.from(content.data, "base64");
        if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
            bytes.length > MAX_IMAGE_BYTES || (this.images.size >= 4 && !this.images.has(content.data))) {
          this.fail(new Error("Codex returned invalid image data or too many images (limit 4).")); return;
        }
        this.images.set(content.data, { type: "image", data: content.data, mimeType: content.mimeType });
      }
    };
    if (update?.sessionUpdate === "agent_message_chunk") {
      collect(update.content);
      if (update.content?.type === "text") this.notes = (this.notes + update.content.text).slice(-4000);
    }
    if (["tool_call", "tool_call_update"].includes(update?.sessionUpdate)) {
      for (const item of update.content ?? []) if (item.type === "content") collect(item.content);
    }
  }

  async generate(prompt: string, signal: AbortSignal) {
    if (signal.aborted) throw new Error("Image generation cancelled.");
    this.child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd, env: this.options.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32"
    });
    this.child.stdout.on("data", jsonLines(value => this.message(value), error => this.fail(error)));
    this.child.stderr.resume(); // Credentials and provider diagnostics never enter MCP stdout.
    this.child.stdin.on("error", error => this.fail(error));
    this.child.on("error", error => this.fail(new Error(`Cannot start Codex ACP adapter: ${error.message}`)));
    this.child.on("exit", (code, reason) => this.fail(new Error(`Codex ACP exited (${reason ?? code}).`)));
    const cancel = () => {
      if (this.sessionId) this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
      this.fail(new Error("Image generation cancelled or timed out."));
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const initialized = await this.request("initialize", { protocolVersion: 1,
        clientInfo: { name: "threadex-codex-image", version: "0.1.0" }, clientCapabilities: {} });
      if (initialized.protocolVersion !== 1) throw new Error("Codex adapter did not negotiate ACP v1.");
      const session = await this.request("session/new", { cwd: this.options.cwd, mcpServers: [] });
      if (typeof session.sessionId !== "string" || !session.sessionId) throw new Error("Codex ACP did not return a session ID.");
      this.sessionId = session.sessionId;
      await this.request("session/set_mode", { sessionId: this.sessionId, modeId: "read-only" });
      const result = await this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text:
        `Use the native image generation tool to generate an image for this request. Do not run commands, edit code, use MCP tools, or delegate. Return the generated image.\n\n${prompt}` }] });
      if (result.stopReason !== "end_turn") throw new Error(`Codex image generation stopped: ${result.stopReason ?? "unknown"}.`);
      if (!this.images.size) throw new Error("Codex ACP returned no inline image. Check account/model image-generation access and adapter compatibility.");
      return { content: [...this.images.values(), ...(this.notes ? [{ type: "text", text: this.notes }] : [])] };
    } finally {
      signal.removeEventListener("abort", cancel);
      await this.close();
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error("ACP connection closed."));
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    const kill = (signal: NodeJS.Signals) => {
      try { process.platform === "win32" ? child.kill(signal) : process.kill(-child.pid!, signal); } catch { /* already gone */ }
    };
    // EOF lets the adapter stop its app-server; kill the owned process group if it fails to stop.
    await new Promise<void>(done => {
      const timer = setTimeout(() => { kill("SIGTERM"); done(); }, 2000);
      if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); done(); }
      else child.once("exit", () => { clearTimeout(timer); done(); });
    });
    kill("SIGKILL");
  }
}

export async function generateCodexImage(prompt: string, signal: AbortSignal, env = process.env) {
  const home = createEphemeralAgentHome({ prefix: "threadex-image-auth-", copyConfig: false,
    sourceHomeCandidates: [env.THREADEX_IMAGE_AUTH_HOME, env.CODEX_HOME, ...defaultAgentHomeCandidates()] });
  // Nested image sessions do not inherit the caller's Threadex actor/turn capabilities.
  const adapterEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("THREADEX_") && !key.startsWith("RUNNER_")));
  const acp = new CodexImageAcp({ cwd: env.THREADEX_IMAGE_CWD || process.cwd(),
    command: env.THREADEX_CODEX_ACP_PATH || "npx",
    args: env.THREADEX_CODEX_ACP_PATH ? [] : ["--yes", ACP_PACKAGE],
    env: { ...adapterEnv, CODEX_HOME: home.home, NO_BROWSER: "1", INITIAL_AGENT_MODE: "read-only",
      CODEX_CONFIG: JSON.stringify({ ...(env.THREADEX_IMAGE_MODEL ? { model: env.THREADEX_IMAGE_MODEL } : {}),
        features: { image_generation: true, shell_tool: false, unified_exec: false, apps: false,
          multi_agent: false, multi_agent_v2: false, browser_use: false, browser_use_external: false,
          browser_use_full_cdp_access: false, computer_use: false, code_mode: false },
        web_search: "disabled", mcp_servers: {}, developer_instructions: "Generate images only using the native image generation tool." }) }
  });
  try {
    const result = await acp.generate(prompt, signal);
    const directory = mkdtempSync(resolve(tmpdir(), "threadex-generated-images-"));
    try {
      const paths: string[] = [];
      for (const [i, item] of result.content.filter(item => item.type === "image").entries()) {
        const path = resolve(directory, `image-${i + 1}.png`);
        writeFileSync(path, Buffer.from(item.data, "base64"), { mode: 0o600 });
        paths.push(path);
      }
      result.content.push({ type: "text", text: `Generated image files (temporary artifacts; copy to your project to keep):\n${paths.join("\n")}` });
      return result;
    } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
  } finally { home.cleanup(); }
}

export const imageToolDefinition = {
  name: "generate_image", description: "Generate an image using Codex over ACP. Returns image content and temporary local PNG paths. Uses the existing Codex login; no extra permissions are granted.",
  inputSchema: { type: "object", properties: { prompt: { type: "string", minLength: 1, maxLength: 32000 } }, required: ["prompt"], additionalProperties: false }
};

export function imageMcpServer(send: (message: Json) => void,
  generate = generateCodexImage, timeoutMs = 180_000) {
  let active: { id: unknown; controller: AbortController } | undefined;
  let initialized = false;
  return {
    close() { active?.controller.abort(); },
    async handle(message: Json) {
      if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string" ||
          (message.id !== undefined && typeof message.id !== "string" && typeof message.id !== "number")) {
        send({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "Invalid JSON-RPC request." } }); return;
      }
      const reply = (result: Json) => send({ jsonrpc: "2.0", id: message.id, result });
      if (message.method === "notifications/cancelled") {
        if (active?.id === message.params?.requestId) active?.controller.abort();
        return;
      }
      if (message.id === undefined) return;
      if (message.method === "initialize") {
        initialized = true;
        reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "threadex-codex-image", version: "0.1.0" } }); return;
      }
      if (!initialized) { send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Initialize first." } }); return; }
      if (message.method === "ping") { reply({}); return; }
      if (message.method === "tools/list") { reply({ tools: [imageToolDefinition] }); return; }
      if (message.method !== "tools/call") { send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found." } }); return; }
      const fail = (text: string) => reply({ isError: true, content: [{ type: "text", text }] });
      const args = message.params?.arguments;
      if (message.params?.name !== "generate_image" || !args || typeof args.prompt !== "string" ||
          !args.prompt.trim() || args.prompt.length > 32000 || Object.keys(args).some(key => key !== "prompt")) {
        fail("Expected generate_image with a prompt of 1–32000 characters."); return;
      }
      if (active) { fail("Image generation is already running; wait for it to finish or cancel it."); return; }
      const controller = new AbortController();
      active = { id: message.id, controller };
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try { reply(await generate(args.prompt, controller.signal)); }
      catch (error) { fail(error instanceof Error ? error.message : "Image generation failed."); }
      finally { clearTimeout(timer); active = undefined; }
    }
  };
}
