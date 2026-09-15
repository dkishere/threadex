import assert from "node:assert/strict";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("creates persistent private CLI and extension pairing tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-browser-bridge-"));
  const first = await loadConfig(directory); const second = await loadConfig(directory);
  assert.equal(first.cliToken, second.cliToken); assert.equal(first.extensionToken, second.extensionToken); assert.notEqual(first.cliToken, first.extensionToken);
});

test("reads an existing config without requiring write access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-browser-bridge-readonly-"));
  const first = await loadConfig(directory);
  await chmod(join(directory, "config.json"), 0o400);
  const second = await loadConfig(directory);
  assert.deepEqual(second, first);
});
