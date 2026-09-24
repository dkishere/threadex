import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalAgentInstructions, createGlobalAgentInstructionsRouter } from "./globalAgentInstructions";

test("global instructions API persists text and clears it for every future reader", async () => {
  const dir = mkdtempSync(join(tmpdir(), "threadex-global-instructions-"));
  const path = join(dir, "instructions.md");
  const app = express();
  app.use(express.json());
  app.use("/settings", createGlobalAgentInstructionsRouter(new GlobalAgentInstructions(path)));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/settings`;
  try {
    const instructions = "# Working agreements\n\n- Keep replies concise.\n";
    const saved = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instructions }) });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { instructions });
    assert.equal(new GlobalAgentInstructions(path).read(), instructions);
    assert.equal(statSync(path).mode & 0o777, 0o600);

    const loaded = await fetch(endpoint);
    assert.equal(loaded.headers.get("cache-control"), "no-store");
    assert.deepEqual(await loaded.json(), { instructions });

    const oversized = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instructions: "x".repeat(32769) }) });
    assert.equal(oversized.status, 400);
    assert.equal(new GlobalAgentInstructions(path).read(), instructions);

    const cleared = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instructions: "  " }) });
    assert.deepEqual(await cleared.json(), { instructions: "" });
    assert.equal(existsSync(path), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
