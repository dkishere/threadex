import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalBrowserBridgeClient } from "./localBrowserBridgeClient";

test("reads and replaces mappings through the daemon's authenticated command API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-browser-bridge-client-"));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({ port: 9327, cliToken: "a".repeat(64) }));
  const mappings = [{ urlPrefix: "https://example.test/", values: { project: "shared" } }];
  let request: { input?: string; init?: RequestInit } = {};
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    request = { input: String(input), init };
    const command = JSON.parse(String(init?.body)) as { type?: string };
    return Response.json({ ok: true, result: { mappings: command.type === "getPageValueMappings" ? mappings : mappings } });
  }) as typeof fetch;
  const client = new LocalBrowserBridgeClient({ configPath, fetchImpl });
  assert.deepEqual(await client.pageValueMappings(), mappings);
  assert.deepEqual(JSON.parse(String(request.init?.body)), { type: "getPageValueMappings" });
  assert.deepEqual(await client.replacePageValueMappings(mappings), mappings);
  assert.equal(request.input, "http://127.0.0.1:9327/v1/command");
  assert.equal((request.init?.headers as Record<string, string>).authorization, `Bearer ${"a".repeat(64)}`);
  assert.deepEqual(JSON.parse(String(request.init?.body)), { type: "setPageValueMappings", mappings });
});

test("rejects malformed credentials before making a request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-browser-bridge-client-"));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({ port: 9327, cliToken: "short" }));
  await assert.rejects(new LocalBrowserBridgeClient({ configPath }).pageValueMappings(), /config is invalid/);
});
