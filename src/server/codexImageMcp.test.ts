import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { codexImageMcpConfig, CodexImageAcp, imageMcpServer, jsonLines } from "./codexImageMcp";

function adapter(scenario = "success") {
  return new CodexImageAcp({ cwd: process.cwd(), command: process.execPath,
    args: [fileURLToPath(new URL("./testFixtures/codexImageAcp.mjs", import.meta.url)), scenario], env: process.env });
}

test("Claude receives turn-local MCP configuration; read-only turns have no image tool", () => {
  assert.deepEqual(codexImageMcpConfig({ cwd: "/repo", readOnly: true }), {});
  const config = codexImageMcpConfig({ cwd: "/repo", readOnly: false, codexHome: "/account" }, { THREADEX_CODEX_ACP_PATH: "/adapter" });
  assert.equal(config.codex_image.env.THREADEX_IMAGE_CWD, "/repo");
  assert.equal(config.codex_image.env.THREADEX_IMAGE_AUTH_HOME, "/account");
  assert.equal(config.codex_image.env.THREADEX_CODEX_ACP_PATH, "/adapter");
  assert.match(config.codex_image.args.at(-1)!, /scripts\/codex-image-mcp.ts$/);
});

test("ACP image lifecycle returns usable PNG and deduplicates image updates", async () => {
  const result = await adapter().generate("A green cube", AbortSignal.timeout(5000));
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "image");
  assert.equal(Buffer.from(result.content[0].data, "base64").subarray(1, 4).toString(), "PNG");
});

for (const [scenario, expected] of [
  ["no-image", /no inline image/], ["auth", /Authentication required/], ["exit", /exited/],
  ["permission", /cancelled/], ["invalid-json", /Invalid JSON/], ["bad-image", /invalid image data/]
] as const) test(`ACP reports ${scenario} without a false success`, async () => {
  await assert.rejects(adapter(scenario).generate("test", AbortSignal.timeout(5000)), expected);
});

test("ACP timeout cancels and closes owned child; next request starts a fresh session", async () => {
  const started = Date.now();
  await assert.rejects(adapter("hang").generate("test", AbortSignal.timeout(150)), /cancelled or timed out/);
  assert.ok(Date.now() - started < 4000);
  assert.equal((await adapter().generate("retry", AbortSignal.timeout(5000))).content[0].type, "image");
});

test("ACP startup errors reject immediately", async () => {
  const client = new CodexImageAcp({ cwd: process.cwd(), command: "/missing/threadex-codex-acp", args: [], env: process.env });
  await assert.rejects(client.generate("test", AbortSignal.timeout(5000)), /Cannot start/);
});

test("NDJSON preserves unicode separators and split UTF-8", () => {
  const received: any[] = [];
  const errors: Error[] = [];
  const read = jsonLines(message => received.push(message), error => errors.push(error));
  const bytes = Buffer.from(JSON.stringify({ text: "圖\u2028片\u2029" }) + "\n");
  for (const byte of bytes) read(Buffer.from([byte]));
  assert.deepEqual(received, [{ text: "圖\u2028片\u2029" }]);
  assert.deepEqual(errors, []);
});

function mcpFixture(generate?: Parameters<typeof imageMcpServer>[1], timeout = 5000) {
  const replies: any[] = [];
  const server = imageMcpServer(message => replies.push(message), generate, timeout);
  let id = 0;
  const call = async (method: string, params?: any) => {
    const currentId = ++id;
    await server.handle({ jsonrpc: "2.0", id: currentId, method, params });
    return replies.find(reply => reply.id === currentId);
  };
  return { server, call, replies };
}

test("MCP discovers the tool and returns actual ACP output through tools/call", async () => {
  const f = mcpFixture((prompt, signal) => adapter().generate(prompt, signal));
  assert.match((await f.call("tools/list")).error.message, /Initialize/);
  assert.equal((await f.call("initialize")).result.capabilities.tools.constructor, Object);
  assert.equal((await f.call("tools/list")).result.tools[0].name, "generate_image");
  const reply = await f.call("tools/call", { name: "generate_image", arguments: { prompt: "Cube" } });
  assert.equal(reply.result.content[0].type, "image");
  assert.equal(reply.result.isError, undefined);
});

test("MCP rejects invalid input and concurrent calls and handles cancellation", async () => {
  const f = mcpFixture((prompt, signal) => adapter("hang").generate(prompt, signal));
  await f.call("initialize");
  assert.equal((await f.call("tools/call", { name: "generate_image", arguments: { prompt: "" } })).result.isError, true);
  const request = f.call("tools/call", { name: "generate_image", arguments: { prompt: "wait" } });
  assert.match((await f.call("tools/call", { name: "generate_image", arguments: { prompt: "second" } })).result.content[0].text, /already running/);
  await f.server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } });
  assert.match((await request).result.content[0].text, /cancelled/);
});

test("MCP timeout and disconnect abort the active ACP operation", async () => {
  for (const disconnect of [false, true]) {
    const f = mcpFixture((prompt, signal) => adapter("hang").generate(prompt, signal), 100);
    await f.call("initialize");
    const request = f.call("tools/call", { name: "generate_image", arguments: { prompt: "wait" } });
    if (disconnect) f.server.close();
    assert.equal((await request).result.isError, true);
  }
});

test("malformed MCP messages do not crash the server", async () => {
  const f = mcpFixture();
  await f.server.handle(null as any);
  assert.equal(f.replies[0].error.code, -32600);
  assert.equal((await f.call("initialize")).result.serverInfo.name, "threadex-codex-image");
});

test("MCP entrypoint discovers tools over stdio and exits cleanly on disconnect", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/codex-image-mcp.ts"], { stdio: ["pipe", "pipe", "pipe"] });
  const replies: any[] = [];
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  const exited = new Promise<number | null>((done, reject) => { child.on("exit", done); child.on("error", reject); });
  child.stdout.on("data", jsonLines(message => {
    replies.push(message);
    if (message.id === 1) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    if (message.id === 2) child.stdin.end();
  }, () => child.kill("SIGKILL")));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n");
  try {
    assert.equal(await exited, 0, stderr);
    assert.equal(replies[1].result.tools[0].name, "generate_image");
  } finally { clearTimeout(timer); child.kill(); }
});
