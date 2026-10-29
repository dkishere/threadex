import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoModelSettings, createAutoModelSettingsRouter } from "./autoModelSettings";
import { DEFAULT_DECISION_POLICIES } from "../decisionSettings";

test("Decision settings save backend keys privately, persist policies, and reject invalid configurations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "threadex-decisions-"));
  const path = join(dir, "key");
  const settings = new AutoModelSettings(path);
  const app = express();
  app.use(express.json());
  app.use("/settings", createAutoModelSettingsRouter(settings));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/settings`;
    const put = (body: unknown) => fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    for (const backend of ["openai"] as const) {
      const response = await put({ backend, apiKey: "test-secret" });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.backends[backend].apiKeyConfigured, true);
      assert.doesNotMatch(JSON.stringify(body), /test-secret/);
      assert.equal(new AutoModelSettings(path).backendKey(backend), "test-secret");
      assert.equal(statSync(`${path}.${backend}`).mode & 0o777, 0o600);
      assert.equal((await put({ backend, apiKey: "" })).status, 200);
      assert.equal(settings.backendKey(backend), undefined);
    }
    const policies = structuredClone(DEFAULT_DECISION_POLICIES);
    assert.equal((await put({ backend: "llm", apiKey: "unused-secret" })).status, 400);
    assert.equal(settings.backendKey("llm"), undefined);
    assert.equal(settings.status().backends.llm.execution, "cli");
    policies.model_select.order = ["openai", "llm", "jev"];
    policies.sh_pick.threshold.llm = 0.8;
    assert.equal((await put({ policies })).status, 200);
    assert.deepEqual(new AutoModelSettings(path).policies(), policies);
    for (const body of [
      { backend: "fake", apiKey: "secret" },
      { backend: "openai", apiKey: "bad key" },
      { policies: { ...policies, sh_pick: { order: ["jev", "jev"], threshold: policies.sh_pick.threshold } } },
      { policies: { ...policies, sh_pick: { order: ["llm"], threshold: { jev: 0.5, openai: 0.5, llm: 2 } } } }
    ]) assert.equal((await put(body)).status, 400);
    assert.deepEqual(settings.policies(), policies);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Luna max Auto rule survives an API save and reload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "threadex-luna-max-"));
  const path = join(dir, "key");
  const app = express();
  app.use(express.json());
  app.use("/settings", createAutoModelSettingsRouter(new AutoModelSettings(path)));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/settings`;
    const rules = { "gpt-6-luna": { enabled: true, efforts: ["max"], condition: "" } };
    const response = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customRulesEnabled: true, customRules: rules }) });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).customRules, rules);
    assert.deepEqual(new AutoModelSettings(path).customRules(), { customRulesEnabled: true, customRules: rules });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

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
      const body = await response.json();
      assert.equal(body.apiKeyConfigured, true);
      assert.equal(body.backends.jev.apiKeyConfigured, true);
      assert.equal(body.selectorModel, "jev-latest");
      assert.equal(body.customRulesEnabled, false);
      assert.deepEqual(body.customRules, {});
      assert.deepEqual(body.policies.model_select.order, ["jev"]);
      assert.doesNotMatch(JSON.stringify(body), /test-secret/);
      assert.equal(new AutoModelSettings(path).apiKey(), key);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
    const get = await fetch(endpoint);
    assert.equal(get.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(await get.text(), /test-secret/);
    const bad = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: "bad key" }) });
    assert.equal(bad.status, 400);
    assert.equal(settings.apiKey(), "test-secret-replacement");
    const rules = {
      "gpt-6-luna": { enabled: true, efforts: ["max"], condition: "" },
      "gpt-6-sol": { enabled: true, efforts: ["high", "xhigh"], condition: "Database work" },
      "gpt-6-astra": { enabled: false, efforts: ["high"], condition: "" }
    };
    const routing = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customRulesEnabled: true, customRules: rules }) });
    assert.equal(routing.status, 200);
    const saved = await routing.json();
    assert.equal(saved.customRulesEnabled, true);
    assert.deepEqual(saved.customRules, rules);
    assert.deepEqual(new AutoModelSettings(path).customRules(), { customRulesEnabled: true, customRules: rules });
    assert.equal(statSync(`${path}.custom-rules.json`).mode & 0o777, 0o600);
    const restored = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customRulesEnabled: false, customRules: {} }) });
    assert.equal((await restored.json()).customRulesEnabled, false);
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
