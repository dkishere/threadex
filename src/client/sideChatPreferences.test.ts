import assert from "node:assert/strict";
import test from "node:test";
import { defaultGearProfiles } from "../modelCatalog";
import { readSideChatPreferences, saveSideChatPreferences, SIDE_CHAT_PREFERENCES_KEY } from "./sideChatPreferences";

test("side chat restores selected gear and edited model/effort from storage", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  } });
  try {
    assert.deepEqual(readSideChatPreferences(), { gearProfiles: defaultGearProfiles(), activeGearIndex: 1 });
    const preferences = readSideChatPreferences();
    preferences.activeGearIndex = 4;
    preferences.gearProfiles[4] = { model: "claude-opus-5-5", effort: "max" };
    saveSideChatPreferences(preferences);
    assert.deepEqual(readSideChatPreferences(), preferences);
    values.set(SIDE_CHAT_PREFERENCES_KEY, JSON.stringify({ activeGearIndex: 99, gearProfiles: [{ model: "unknown" }] }));
    assert.deepEqual(readSideChatPreferences(), { gearProfiles: defaultGearProfiles(), activeGearIndex: 1 });
    values.set(SIDE_CHAT_PREFERENCES_KEY, "broken JSON");
    assert.equal(readSideChatPreferences().activeGearIndex, 1);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Storage blocked"); } });
    assert.doesNotThrow(() => saveSideChatPreferences(preferences));
    assert.deepEqual(readSideChatPreferences().gearProfiles, defaultGearProfiles());
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
