import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import test from "node:test";
import express from "express";
import { ThreadexAcpConnection, createAcpRouter, type AcpBackend, type AcpMessage } from "./acp";

function fixture() {
  const turns = new Map<string, { sessionId: string; userInput: string; agentResponse: string; status: "todo" | "done"; runnerExitCode: number | null }>();
  const queued: string[] = [], cancelled: string[] = [];
  const backend: AcpBackend = {
    async create(cwd) { return { id: "new-session", cwd }; },
    async session(id) { return id === "session" ? { id, cwd: "/project" } : null; },
    async enqueue(sessionId, message, id) {
      queued.push(id);
      turns.set(id, { sessionId, userInput: message.trim(), agentResponse: "", status: "todo", runnerExitCode: null });
    },
    async turn(id) { return turns.get(id) ?? null; },
    async cancel(_session, id) {
      cancelled.push(id);
      Object.assign(turns.get(id)!, { status: "done", runnerExitCode: 143 });
    }
  };
  const rpc = new ThreadexAcpConnection(backend, "test-connection-123", 2);
  const output: AcpMessage[] = [];
  const call = async (method: string, params: Record<string, unknown> = {}, id: number | undefined = 1) => {
    const request: AcpMessage = { jsonrpc: "2.0", method, params, ...(id !== undefined ? { id } : {}) };
    await rpc.handle(request, message => output.push(message));
    return output.at(-1)!;
  };
  const ready = async () => {
    await call("initialize", { protocolVersion: 1 });
    await call("session/resume", { sessionId: "session", cwd: "/project", mcpServers: [] });
  };
  return { backend, turns, queued, cancelled, rpc, output, call, ready };
}
const prompt = (text = "Keep the original selection.", requestId = "document:comment") => ({
  sessionId: "session", prompt: [{ type: "text", text }], _meta: { "threadex/requestId": requestId }
});
async function until(check: () => boolean) {
  for (let attempt = 0; !check(); attempt++) {
    assert.ok(attempt < 1000, "Expected event did not arrive");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

test("minimal ACP negotiates capabilities and rejects unsupported or unbound input before dispatch", async () => {
  const f = fixture();
  assert.equal((await f.call("session/prompt", prompt())).error?.code, -32000);
  const initialized = await f.call("initialize", { protocolVersion: 2 });
  assert.equal((initialized.result as any).protocolVersion, 1);
  assert.equal((initialized.result as any).agentCapabilities.loadSession, false);
  assert.equal((await f.call("session/prompt", prompt())).error?.code, -32602);
  assert.equal((await f.call("session/new", { cwd: "/project", mcpServers: [{ command: "untrusted" }] })).error?.code, -32602);
  assert.equal((await f.call("session/resume", { sessionId: "session", cwd: "/wrong", mcpServers: [] })).error?.code, -32602);
  await f.ready();
  assert.equal((await f.call("session/prompt", { ...prompt(), prompt: [{ type: "image", data: "unknown" }] })).error?.code, -32602);
  assert.equal((await f.call("session/list")).error?.code, -32601);
  assert.equal(f.queued.length, 0);
  assert.deepEqual((await f.call("session/new", { cwd: "/project", mcpServers: [] })).result, { sessionId: "new-session" });
});

test("feedback acknowledgement is separate from prompt completion and retries reuse the durable turn", async () => {
  const f = fixture(); await f.ready();
  const pending = f.call("session/prompt", prompt(), 10);
  await until(() => f.output.some(message => message.method === "session/update"));
  assert.equal(f.output.some(message => message.id === 10), false);
  const receipt = (f.output.at(-1)?.params?.update as any)._meta["threadex/receipt"];
  assert.equal(receipt.accepted, true);
  const turn = f.turns.get(receipt.turnId)!;
  Object.assign(turn, { status: "done", agentResponse: "Selection preserved." });
  await pending;
  assert.deepEqual(f.output.at(-1)?.result, { stopReason: "end_turn" });
  assert.equal((f.output.at(-2)?.params?.update as any).content.text, "Selection preserved.");
  await f.call("session/prompt", prompt(), 11);
  assert.equal(f.queued.length, 1);
  assert.equal((await f.call("session/prompt", prompt("Changed content"), 12)).error?.code, -32602);
  assert.equal(f.queued.length, 1);
});

test("multiple comments can queue while a turn runs; cancel affects only this connection's feedback", async () => {
  const f = fixture(); await f.ready();
  const first = f.call("session/prompt", prompt("First", "first"), 10);
  await until(() => f.queued.length === 1);
  const second = f.call("session/prompt", prompt("Second", "second"), 11);
  await until(() => f.queued.length === 2);
  const before = f.output.length;
  await f.rpc.handle({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "unrelated" } }, m => f.output.push(m));
  assert.equal(f.cancelled.length, 0);
  await f.rpc.handle({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "session" } }, m => f.output.push(m));
  assert.deepEqual(f.cancelled, f.queued);
  await Promise.all([first, second]);
  assert.equal(f.output.slice(before).filter(m => m.id === undefined).every(m => m.method === "session/update"), true);
  assert.deepEqual(f.output.filter(m => m.id === 10 || m.id === 11).map(m => m.result), [
    { stopReason: "cancelled" }, { stopReason: "cancelled" }
  ]);
});

test("disconnect leaves the accepted prompt intact and a new connection can safely retry it", async () => {
  const f = fixture(); await f.ready();
  const abort = new AbortController();
  const pending = f.rpc.handle({ jsonrpc: "2.0", id: 10, method: "session/prompt", params: prompt() }, m => f.output.push(m), abort.signal);
  await until(() => f.output.some(m => m.method === "session/update"));
  abort.abort(); await pending;
  assert.equal(f.cancelled.length, 0);
  f.turns.get(f.queued[0])!.status = "done";
  const other = new ThreadexAcpConnection(f.backend, "new-connection", 2);
  const output: AcpMessage[] = [];
  for (const [method, params] of [["initialize", { protocolVersion: 1 }], ["session/resume", { sessionId: "session", cwd: "/project", mcpServers: [] }], ["session/prompt", prompt()]] as const) {
    await other.handle({ jsonrpc: "2.0", id: 20, method, params }, m => output.push(m));
  }
  assert.equal(f.queued.length, 1);
  assert.deepEqual(output.at(-1)?.result, { stopReason: "end_turn" });
});

test("stdio speaks ACP JSON-RPC through the HTTP bridge and can cancel an outstanding prompt", { timeout: 15000 }, async () => {
  const f = fixture();
  const app = express(); app.use(express.json()); app.use("/api/acp", createAcpRouter(f.backend));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(done => server.once("listening", done));
  const child = spawn(process.execPath, [resolve(import.meta.dirname, "../../scripts/acp.mjs")], {
    env: { ...process.env, RUNNER_SERVER_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}` }, stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout }), replies: AcpMessage[] = [];
  lines.on("line", line => replies.push(JSON.parse(line)));
  const send = (message: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  try {
    send({ id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await until(() => replies.some(m => m.id === 1));
    send({ id: 2, method: "session/resume", params: { sessionId: "session", cwd: "/project", mcpServers: [] } });
    await until(() => replies.some(m => m.id === 2));
    send({ id: 3, method: "session/prompt", params: prompt() });
    await until(() => replies.some(m => m.method === "session/update"));
    send({ method: "session/cancel", params: { sessionId: "session" } });
    await until(() => replies.some(m => m.id === 3));
    assert.deepEqual(replies.find(m => m.id === 3)?.result, { stopReason: "cancelled" });
    assert.equal(replies.every(m => m.jsonrpc === "2.0"), true);
  } finally { child.kill(); lines.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});
