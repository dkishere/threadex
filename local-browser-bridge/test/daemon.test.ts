import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { startDaemon } from "../src/daemon.js";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const replacementExtensionId = "ponmlkjihgfedcbaponmlkjihgfedcba";

test("daemon keeps command API private to its CLI token", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "local-browser-bridge-")); const daemon = await startDaemon({ dataDir, port: 0 });
  try { const url = `http://127.0.0.1:${daemon.port}/v1/status`; assert.equal((await fetch(url)).status, 401); const response = await fetch(url, { headers: { authorization: `Bearer ${daemon.config.cliToken}` } }); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { connected: false, port: daemon.port, extensionId: null }); }
  finally { await daemon.close(); }
});

test("first extension bootstraps its own credential without token copy and replacement requires CLI pairing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "local-browser-bridge-")); const daemon = await startDaemon({ dataDir, port: 0 });
  const firstToken = "a".repeat(64);
  const first = new WebSocket(`ws://127.0.0.1:${daemon.port}/extension?extensionId=${extensionId}&token=${firstToken}`, { headers: { Origin: `chrome-extension://${extensionId}` } });
  try {
    await new Promise<void>((resolve, reject) => { first.once("open", resolve); first.once("error", reject); });
    assert.equal(daemon.config.extensionId, extensionId); assert.equal(daemon.config.extensionToken, firstToken);
    const unauthorized = await fetch(`http://127.0.0.1:${daemon.port}/v1/extension/pair`, { method: "POST" });
    assert.equal(unauthorized.status, 401);
    const rejected = new WebSocket(`ws://127.0.0.1:${daemon.port}/extension?extensionId=${replacementExtensionId}&token=${"b".repeat(64)}`, { headers: { Origin: `chrome-extension://${replacementExtensionId}` } });
    const rejectedResult = await new Promise<string>((resolve) => { rejected.once("open", () => resolve("opened")); rejected.once("error", () => resolve("rejected")); rejected.once("close", () => resolve("rejected")); });
    assert.equal(rejectedResult, "rejected");
    const pairing = await fetch(`http://127.0.0.1:${daemon.port}/v1/extension/pair`, { method: "POST", headers: { authorization: `Bearer ${daemon.config.cliToken}`, "content-type": "application/json" }, body: "{}" });
    assert.equal(pairing.status, 200);
    const replacementToken = "c".repeat(64);
    const replacement = new WebSocket(`ws://127.0.0.1:${daemon.port}/extension?extensionId=${replacementExtensionId}&token=${replacementToken}`, { headers: { Origin: `chrome-extension://${replacementExtensionId}` } });
    await new Promise<void>((resolve, reject) => { replacement.once("open", resolve); replacement.once("error", reject); });
    assert.equal(daemon.config.extensionId, replacementExtensionId); assert.equal(daemon.config.extensionToken, replacementToken);
    replacement.close();
  } finally { first.close(); await daemon.close(); }
});

test("forwards an authenticated CLI command through the paired extension websocket", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "local-browser-bridge-"));
  const daemon = await startDaemon({ dataDir, port: 0 });
  const extension = new WebSocket(`ws://127.0.0.1:${daemon.port}/extension?extensionId=${extensionId}&token=${daemon.config.extensionToken}`, { headers: { Origin: `chrome-extension://${extensionId}` } });
  try {
    await new Promise<void>((resolve, reject) => { extension.once("open", resolve); extension.once("error", reject); });
    extension.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { id: string; command: { type: string } };
      assert.equal(message.command.type, "listTabs");
      extension.send(JSON.stringify({ id: message.id, ok: true, result: [{ id: 7, url: "https://example.test/" }] }));
    });
    const response = await fetch(`http://127.0.0.1:${daemon.port}/v1/command`, {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.config.cliToken}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "listTabs" })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, result: [{ id: 7, url: "https://example.test/" }] });
  } finally { extension.close(); await daemon.close(); }
});

test("paired extension can read and update page-value mappings", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "local-browser-bridge-"));
  const daemon = await startDaemon({ dataDir, port: 0 });
  const extension = new WebSocket(`ws://127.0.0.1:${daemon.port}/extension?extensionId=${extensionId}&token=${daemon.config.extensionToken}`, { headers: { Origin: `chrome-extension://${extensionId}` } });
  try {
    await new Promise<void>((resolve, reject) => { extension.once("open", resolve); extension.once("error", reject); });
    const reply = (id: string): Promise<{ ok: boolean; result?: { mappings: unknown[] } }> => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("mapping response timed out")), 1_000);
      extension.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { type?: string; id?: string; ok?: boolean; result?: { mappings: unknown[] } };
        if (message.type !== "pageValueMappingsResponse" || message.id !== id) return;
        clearTimeout(timer); resolve({ ok: message.ok === true, result: message.result });
      });
    });
    const set = reply("set");
    extension.send(JSON.stringify({ type: "pageValueMappingsRequest", id: "set", action: "set", mappings: [{ urlPrefix: "https://example.test/", values: { project: "alpha" } }] }));
    assert.deepEqual(await set, { ok: true, result: { mappings: [{ urlPrefix: "https://example.test/", values: { project: "alpha" } }] } });
    const get = reply("get");
    extension.send(JSON.stringify({ type: "pageValueMappingsRequest", id: "get", action: "get" }));
    assert.deepEqual(await get, { ok: true, result: { mappings: [{ urlPrefix: "https://example.test/", values: { project: "alpha" } }] } });
  } finally { extension.close(); await daemon.close(); }
});

test("website commands require extension approval and remain bound to their origin", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "local-browser-bridge-"));
  const daemon = await startDaemon({ dataDir, port: 0 });
  const extension = new WebSocket(`ws://127.0.0.1:${daemon.port}/extension?extensionId=${extensionId}&token=${daemon.config.extensionToken}`, { headers: { Origin: `chrome-extension://${extensionId}` } });
  try {
    await new Promise<void>((resolve, reject) => { extension.once("open", resolve); extension.once("error", reject); });
    extension.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { type?: string; requestId?: string; id?: string; command?: { type?: string } };
      if (message.type === "websiteAuthorizationRequest") extension.send(JSON.stringify({ type: "authorizationDecision", requestId: message.requestId, allow: true, scopes: ["tabs.read"], expiresAt: Date.now() + 60_000 }));
      if (message.type === "command" && message.command?.type === "listTabs") extension.send(JSON.stringify({ id: message.id, ok: true, result: [{ id: 1, url: "https://site.test/page" }, { id: 2, url: "https://other.test/" }] }));
    });
    const pair = await fetch(`http://127.0.0.1:${daemon.port}/v1/web/pair`, { method: "POST", headers: { origin: "https://site.test", "content-type": "application/json" }, body: JSON.stringify({ scopes: ["tabs.read"] }) });
    assert.equal(pair.status, 200); const session = await pair.json() as { token: string };
    const command = await fetch(`http://127.0.0.1:${daemon.port}/v1/web/command`, { method: "POST", headers: { origin: "https://site.test", authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify({ type: "listTabs" }) });
    assert.equal(command.status, 200);
    assert.deepEqual(await command.json(), { ok: true, result: [{ id: 1, url: "https://site.test/page" }] });
    const wrongOrigin = await fetch(`http://127.0.0.1:${daemon.port}/v1/web/command`, { method: "POST", headers: { origin: "https://other.test", authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify({ type: "listTabs" }) });
    assert.equal(wrongOrigin.status, 401);
    assert.equal(wrongOrigin.headers.get("access-control-allow-origin"), "https://other.test");
  } finally { extension.close(); await daemon.close(); }
});
