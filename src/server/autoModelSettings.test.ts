import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoModelSettings, createAutoModelSettingsRouter } from "./autoModelSettings";

test("settings API persists and replaces private keys, never returns them, and clearing overrides environment defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "threadex-auto-settings-"));
  const path = join(dir, "key");
  const previous = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  const settings = new AutoModelSettings(path);
  const app = express();
  app.use(express.json());
  app.use("/settings", createAutoModelSettingsRouter(settings));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const endpoint = `http://127.0.0.1:${address.port}/settings`;
  try {
    assert.equal(settings.status().apiKeyConfigured, false);
    for (const key of ["test-secret-first", "test-secret-replacement"]) {
      const response = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: key }) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { apiKeyConfigured: true, selectorModel: "jev-latest" });
      assert.equal(new AutoModelSettings(path).apiKey(), key);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
    const get = await fetch(endpoint);
    assert.equal(get.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(await get.text(), /test-secret/);
    const bad = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: "bad key" }) });
    assert.equal(bad.status, 400);
    assert.equal(settings.apiKey(), "test-secret-replacement");
    process.env.TYPESAFE_API_KEY = "environment-key";
    const cleared = await fetch(endpoint, { method: "DELETE" });
    assert.equal((await cleared.json()).apiKeyConfigured, false);
    assert.equal(new AutoModelSettings(path).apiKey(), undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
