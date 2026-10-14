import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HelperModelSettings, defaultHelperModels } from "./helperModelSettings";

function settingsPath() {
  return join(mkdtempSync(join(tmpdir(), "helper-models-")), "helper-models.json");
}

test("defaults keep the existing summarizer and griller models", () => {
  assert.deepEqual(defaultHelperModels({}), {
    summarizerModel: "gpt-6-luna", summarizerLongModel: "gpt-6-luna", grillModel: "gpt-6-luna", grillLongModel: "gpt-6-sol"
  });
  assert.equal(defaultHelperModels({ SESSION_SUMMARIZER_MODEL: "haiku" }).summarizerModel, "claude-haiku-5-5");
  assert.deepEqual(new HelperModelSettings(settingsPath(), defaultHelperModels({})).read(), defaultHelperModels({}));
});

test("saves partial updates and normalizes aliases", () => {
  const path = settingsPath();
  const settings = new HelperModelSettings(path, defaultHelperModels({}));
  const saved = settings.save({ summarizerModel: "haiku", grillModel: "claude-haiku-5-5" });
  assert.equal(saved.models.summarizerModel, "claude-haiku-5-5");
  assert.equal(saved.models.grillModel, "claude-haiku-5-5");
  assert.equal(saved.models.grillLongModel, "gpt-6-sol");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).summarizerModel, "claude-haiku-5-5");
});

test("rejects unknown models and ignores invalid saved values", () => {
  const path = settingsPath();
  const settings = new HelperModelSettings(path, defaultHelperModels({}));
  assert.throws(() => settings.save({ grillModel: "not-a-model" }), /Choose a model/);
  writeFileSync(path, JSON.stringify({ grillModel: "not-a-model", grillLongModel: "claude-sonnet-5-5" }));
  assert.equal(settings.read().grillModel, "gpt-6-luna");
  assert.equal(settings.read().grillLongModel, "claude-sonnet-5-5");
});
