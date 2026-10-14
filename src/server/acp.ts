import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Router } from "express";

export type AcpMessage = {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};
type AcpSession = { id: string; cwd: string };
type AcpTurn = {
  sessionId: string;
  userInput: string;
  agentResponse: string;
  status: "todo" | "running" | "done";
  runnerExitCode: number | null;
};
export type AcpBackend = {
  create(cwd: string): Promise<AcpSession>;
  session(id: string): Promise<AcpSession | null>;
  enqueue(sessionId: string, message: string, turnId: string): Promise<void>;
  turn(id: string): Promise<AcpTurn | null>;
  cancel(sessionId: string, turnId: string): Promise<void>;
};

class AcpError extends Error {
  constructor(public code: number, message: string) { super(message); }
}
function invalid(message: string): never { throw new AcpError(-32602, message); }
function text(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) return invalid(`${name} is required.`);
  return value;
}
function setup(params: Record<string, unknown>) {
  const cwd = text(params.cwd, "cwd");
  if (!isAbsolute(cwd)) invalid("cwd must be absolute.");
  if (!Array.isArray(params.mcpServers) || params.mcpServers.length) {
    invalid("This minimal adapter requires mcpServers: []; it uses the session's existing tools.");
  }
  if (params.additionalDirectories !== undefined) invalid("Additional directories are not supported.");
  return cwd;
}

// The connection owns its active prompt, so cancel never stops an unrelated UI turn.
export class ThreadexAcpConnection {
  private initialized = false;
  private sessions = new Set<string>();
  private active = new Map<string, Map<string, number>>();
  constructor(private backend: AcpBackend, private connectionId: string, private pollMs = 300) {}

  async handle(message: AcpMessage, send: (message: AcpMessage) => void, signal?: AbortSignal) {
    const id = message?.id;
    try {
      if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string" ||
          (id !== undefined && typeof id !== "string" && typeof id !== "number") ||
          (message.params !== undefined && (!message.params || typeof message.params !== "object" || Array.isArray(message.params)))) {
        throw new AcpError(-32600, "Invalid JSON-RPC request.");
      }
      const params = message.params ?? {};
      let result: unknown;
      if (message.method === "initialize") {
        if (id === undefined) invalid("initialize requires a request ID.");
        if (!Number.isInteger(params.protocolVersion) || Number(params.protocolVersion) < 1) invalid("protocolVersion is required.");
        this.initialized = true;
        result = { protocolVersion: 1, agentInfo: { name: "threadex", version: "0.1.0" },
          agentCapabilities: { loadSession: false, sessionCapabilities: { resume: {} } },
          authMethods: [], _meta: { "threadex/feedback": { queuedPrompts: true, requestIds: true } } };
      } else {
        if (!this.initialized) throw new AcpError(-32000, "Initialize the connection first.");
        if (message.method !== "session/cancel" && id === undefined) invalid("This method requires a request ID.");
        switch (message.method) {
          case "session/new": {
            const session = await this.backend.create(setup(params));
            this.sessions.add(session.id);
            result = { sessionId: session.id };
            break;
          }
          case "session/resume": {
            const cwd = setup(params);
            const session = await this.backend.session(text(params.sessionId, "sessionId"));
            if (!session || session.cwd !== cwd) invalid("Session not found in this working directory.");
            this.sessions.add(session.id);
            result = {};
            break;
          }
          case "session/prompt": {
            const sessionId = text(params.sessionId, "sessionId");
            if (!this.sessions.has(sessionId)) invalid("Create or resume this session first.");
            if (!Array.isArray(params.prompt) || !params.prompt.length || params.prompt.some(block =>
              !block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string")) {
              invalid("Only text prompt content is supported.");
            }
            const prompt = params.prompt.map(block => block.text).join("\n");
            if (!prompt.trim() || prompt.length > 250_000) invalid("Prompt must contain 1–250000 characters.");
            const meta = params._meta as Record<string, unknown> | undefined;
            const requestId = meta?.["threadex/requestId"];
            if (requestId !== undefined && (typeof requestId !== "string" || !requestId || requestId.length > 200)) invalid("Invalid request ID.");
            const turnId = `acp_${createHash("sha256").update(JSON.stringify([sessionId, requestId ?? [this.connectionId, id]])).digest("hex")}`;
            const active = this.active.get(sessionId) ?? new Map<string, number>();
            this.active.set(sessionId, active);
            active.set(turnId, (active.get(turnId) ?? 0) + 1);
            try {
              const existing = await this.backend.turn(turnId);
              if (existing && (existing.sessionId !== sessionId || existing.userInput !== prompt.trim())) {
                invalid("Request ID was already used for different prompt content.");
              }
              if (!existing) await this.backend.enqueue(sessionId, prompt, turnId);
              send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: {
                sessionUpdate: "user_message_chunk", content: { type: "text", text: prompt },
                _meta: { "threadex/receipt": { turnId, accepted: true, requestId } }
              } } });
              while (!signal?.aborted) {
                const turn = await this.backend.turn(turnId);
                if (!turn || turn.sessionId !== sessionId) throw new AcpError(-32000, "The accepted turn is unavailable.");
                if (turn.status === "done") {
                  if (turn.agentResponse) send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: {
                    sessionUpdate: "agent_message_chunk", content: { type: "text", text: turn.agentResponse }
                  } } });
                  if (turn.runnerExitCode && turn.runnerExitCode !== 143 && turn.runnerExitCode !== 130) {
                    throw new AcpError(-32000, "The Threadex runner failed. See the saved turn for details.");
                  }
                  result = { stopReason: turn.runnerExitCode === 143 || turn.runnerExitCode === 130 ? "cancelled" : "end_turn" };
                  break;
                }
                await delay(this.pollMs, undefined, { signal });
              }
            } finally {
              const count = (active.get(turnId) ?? 1) - 1;
              if (count) active.set(turnId, count); else active.delete(turnId);
              if (!active.size) this.active.delete(sessionId);
            }
            break;
          }
          case "session/cancel": {
            if (id !== undefined) invalid("session/cancel is a notification.");
            const sessionId = text(params.sessionId, "sessionId");
            for (const turnId of this.active.get(sessionId)?.keys() ?? []) await this.backend.cancel(sessionId, turnId);
            break;
          }
          default: throw new AcpError(-32601, "Method not supported by the minimal Threadex ACP adapter.");
        }
      }
      if (id !== undefined && !signal?.aborted) send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      if (id !== undefined && !signal?.aborted) send({ jsonrpc: "2.0", id, error: {
        code: error instanceof AcpError ? error.code : -32000,
        message: error instanceof Error ? error.message : "ACP request failed."
      } });
    }
  }
}

// Browser transport: POST one JSON-RPC message; receive newline-delimited updates
// and its final response. Reuse the connection header across requests and retries.
export function createAcpRouter(backend: AcpBackend) {
  const router = Router();
  const connections = new Map<string, { rpc: ThreadexAcpConnection; touched: number; requests: number }>();
  router.post("/", async (req, res) => {
    const key = req.get("X-Threadex-ACP-Connection");
    if (!key || !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) {
      res.status(400).json({ error: "A valid X-Threadex-ACP-Connection header is required." }); return;
    }
    for (const [id, entry] of connections) {
      if (!entry.requests && Date.now() - entry.touched > 60 * 60 * 1000) connections.delete(id);
    }
    let entry = connections.get(key);
    if (!entry) {
      if (connections.size >= 1000) { res.status(503).json({ error: "Too many ACP connections." }); return; }
      entry = { rpc: new ThreadexAcpConnection(backend, key), touched: Date.now(), requests: 0 };
      connections.set(key, entry);
    }
    entry.requests++;
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    try {
      await entry.rpc.handle(req.body, message => res.write(`${JSON.stringify(message)}\n`), abort.signal);
    } finally {
      entry.requests--; entry.touched = Date.now();
      res.end();
    }
  });
  return router;
}
