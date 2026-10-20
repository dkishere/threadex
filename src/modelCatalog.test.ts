import assert from "node:assert/strict";
import test from "node:test";
import { AUTO_MODEL_ORDER, MODEL_OPTIONS, defaultGearProfiles, isClaudeModel, modelProvider, normalizeModelId, supportsUltraEffort } from "./modelCatalog";
import { AUTO_MODEL_CHOICES } from "./autoModelCatalog";
import { MODEL_OPTIONS as composerModels } from "./client/appConstants";
import { modelOptionLabel, normalizeStoredModel } from "./client/sessionHelpers04";
import { modelEfforts, normalizeModelEffort } from "./modelCatalog";
import { roundtableEfforts, parseRoundtableActors, newRoundtableActor } from "./roundtable";
import { normalizeEffortForModel } from "./client/sessionHelpers04";
import { updateGearProfile } from "./client/sessionActions05";

test("Claude gears and actors share provider effort choices and model-switch normalization", () => {
  for (const model of ["opus", "sonnet", "haiku", "fable", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]) {
    assert.deepEqual(modelEfforts(model), ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(roundtableEfforts(model), modelEfforts(model));
    assert.equal(normalizeModelEffort(model, "minimal"), "low");
    assert.equal(normalizeModelEffort(model, "ultra"), "max");
    assert.equal(normalizeEffortForModel({ AUTO_MODEL_VALUE: "auto" }, "max", model), "max");
    let gears = [{ model: "gpt-6-luna", effort: "ultra" }];
    updateGearProfile({ AUTO_MODEL_VALUE: "auto", modelPreferencesEditRevisionRef: { current: 0 },
      setGearProfiles: (update: (current: typeof gears) => typeof gears) => { gears = update(gears); }
    }, 0, { model });
    assert.equal(gears[0].effort, "max");
    const actors = [newRoundtableActor({ model, effort: "max" }), newRoundtableActor({ model, effort: "minimal" })];
    actors[0].name = "First";
    actors[1].name = "Second";
    assert.equal(parseRoundtableActors(actors)[0].effort, "max");
    assert.equal(actors[1].effort, "low");
    assert.throws(() => parseRoundtableActors([{ ...actors[0], effort: "minimal" }, actors[1]]));
  }
  assert.deepEqual(modelEfforts("gpt-5.4"), ["minimal", "low", "medium", "high", "xhigh"]);
  assert.ok(modelEfforts("gpt-6-luna").includes("ultra"));
  assert.equal(normalizeModelEffort("gpt-5.4", "max"), "xhigh");
});

test("Fable 5.1 is selectable, survives stored preferences and routes to Claude", () => {
  const model = "claude-fable-5-1";
  assert.ok(composerModels.includes(model));
  assert.equal(modelOptionLabel({}, model), "Fable 5.1");
  for (const value of [model, "fable"]) {
    assert.equal(normalizeModelId(value), model);
    assert.equal(normalizeStoredModel({ AUTO_MODEL_VALUE: "auto", MODEL_OPTIONS }, value), model);
    assert.equal(modelProvider(value), "claude");
    assert.equal(isClaudeModel(value), true);
  }
  assert.ok(!(AUTO_MODEL_ORDER as readonly string[]).includes(model));
  assert.equal(supportsUltraEffort(model), false);
});

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
