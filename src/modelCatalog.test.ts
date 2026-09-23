import assert from "node:assert/strict";
import test from "node:test";
import { AUTO_MODEL_ORDER, MODEL_OPTIONS, defaultGearProfiles, normalizeModelId, supportsUltraEffort } from "./modelCatalog";
import { AUTO_MODEL_CHOICES } from "./autoModelCatalog";
import { MODEL_OPTIONS as composerModels } from "./client/appConstants";
import { modelOptionLabel, normalizeStoredModel } from "./client/sessionHelpers04";

test("composer, persisted gears and Auto share the catalog", () => {
  assert.equal(composerModels, MODEL_OPTIONS);
  assert.deepEqual(Object.keys(AUTO_MODEL_CHOICES), AUTO_MODEL_ORDER);
  for (const model of AUTO_MODEL_ORDER) {
    assert.ok(composerModels.includes(model));
    assert.equal(normalizeStoredModel({ AUTO_MODEL_VALUE: "auto", MODEL_OPTIONS }, model), model);
    assert.match(modelOptionLabel({}, model), /^6 (Luna|Sol|Astra)$/);
    assert.equal(supportsUltraEffort(model), true);
  }
  const first = defaultGearProfiles();
  first[0].model = "changed" as typeof first[0]["model"];
  assert.notEqual(defaultGearProfiles()[0].model, "changed");
  assert.ok(defaultGearProfiles().every(gear => composerModels.includes(gear.model)));
  assert.equal(normalizeModelId("gpt-5.6-terra"), "gpt-6-luna");
  assert.equal(normalizeModelId("gpt-5.6-sol"), "gpt-6-sol");
});
