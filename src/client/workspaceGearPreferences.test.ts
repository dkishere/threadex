import assert from "node:assert/strict";
import test from "node:test";
import { defaultGearProfiles } from "../modelCatalog";
import { readSessionGearOverride, saveSessionGearOverride, readWorkspaceGearPreferences, saveWorkspaceGearPreferences, workspaceGearPreferencesKey } from "./workspaceGearPreferences";

test("the visible task's unlocked gear selection survives reload and can return to inheritance", () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const savedValues = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => savedValues.get(key) ?? null,
    setItem: (key: string, value: string) => savedValues.set(key, value),
    removeItem: (key: string) => savedValues.delete(key)
  } });
  try {
    assert.equal(readSessionGearOverride(), null);
    saveSessionGearOverride({ sessionId: "task-a", activeGearIndex: 5 });
    assert.deepEqual(readSessionGearOverride(), { sessionId: "task-a", activeGearIndex: 5 });
    saveSessionGearOverride(null);
    assert.equal(readSessionGearOverride(), null);
    for (const invalid of ["broken JSON", JSON.stringify({ sessionId: "task-a", activeGearIndex: 99 }), JSON.stringify({ activeGearIndex: 1 })]) {
      savedValues.set("threadex.session-gear-override", invalid);
      assert.equal(readSessionGearOverride(), null);
    }
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("workspace gears retain 6.2 models, effort, Fast and selection independently of the save outbox", () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const savedValues = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => savedValues.get(key) ?? null,
    setItem: (key: string, value: string) => savedValues.set(key, value)
  } });
  try {
    assert.equal(readWorkspaceGearPreferences("workspace/one"), null);
    const preferences = { gearProfiles: defaultGearProfiles().map(gear => ({ ...gear, model: String(gear.model), fastMode: false })), activeGearIndex: 5 };
    preferences.gearProfiles[4] = { model: "gpt-6.2-astra", effort: "high", fastMode: false };
    preferences.gearProfiles[5] = { model: "gpt-6.2-sol", effort: "xhigh", fastMode: true };
    saveWorkspaceGearPreferences("workspace/one", preferences);
    savedValues.delete("threadex.model-selector");
    assert.deepEqual(readWorkspaceGearPreferences("workspace/one"), preferences);
    assert.equal(readWorkspaceGearPreferences("workspace-two"), null);
    assert.equal(readWorkspaceGearPreferences(null), null);
    savedValues.set(workspaceGearPreferencesKey("workspace-two"), "broken JSON");
    assert.equal(readWorkspaceGearPreferences("workspace-two"), null);
    for (const invalid of [{}, { gearProfiles: [{}], activeGearIndex: 0 }, { gearProfiles: preferences.gearProfiles, activeGearIndex: 99 }]) {
      savedValues.set(workspaceGearPreferencesKey("workspace-two"), JSON.stringify(invalid));
      assert.equal(readWorkspaceGearPreferences("workspace-two"), null);
    }
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Storage unavailable"); } });
    assert.doesNotThrow(() => saveWorkspaceGearPreferences("workspace/one", preferences));
    assert.equal(readWorkspaceGearPreferences("workspace/one"), null);
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
