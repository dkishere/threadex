import assert from "node:assert/strict";
import test from "node:test";
import { crossesModelGroup } from "../modelCatalog";
import { effectiveSessionComposerModel, enableSessionComposerOverride, inheritSessionComposerModel, roundtableSessionModelPreferences, sessionModelConfirmationMatches } from "./sessionComposerModel";
import type { ComposerGearProfile } from "./ComposerFrame";

const fallback: ComposerGearProfile = { model: "gpt-6.1-sol", effort: "high", fastMode: false };
const turns = [{ model: "claude-opus-4-6", reasoningEffort: "max", requestedServiceTier: "fast" as const }];

test("existing sessions inherit the final turn model, effort and requested fast tier", () => {
  const state = inheritSessionComposerModel(null, "A", 1, [{ model: fallback.model }, ...turns], fallback);
  assert.deepEqual(effectiveSessionComposerModel(state, fallback), { model: turns[0].model, effort: "max", fastMode: true });
  const standard = inheritSessionComposerModel(null, "A", 1, [{ ...turns[0], requestedServiceTier: "default" }], { ...fallback, fastMode: true });
  assert.equal(effectiveSessionComposerModel(standard, fallback).fastMode, false);
});

test("missing legacy fields use preferences, and a new session keeps its gears", () => {
  assert.equal(inheritSessionComposerModel(null, "A", 1, [{}], fallback), null);
  assert.deepEqual(effectiveSessionComposerModel(inheritSessionComposerModel(null, "A", 1, [{ model: fallback.model }], fallback), fallback), fallback);
  assert.equal(inheritSessionComposerModel(null, "new", 1, [], fallback), null);
  assert.equal(effectiveSessionComposerModel(null, fallback), fallback);
});

test("enabling seeds the user's default gears, not the inherited last-turn settings; refresh keeps edits", () => {
  const inherited = inheritSessionComposerModel(null, "A", 1, turns, fallback)!;
  assert.deepEqual(effectiveSessionComposerModel(inherited, fallback), inherited.inherited);
  const secondGear: ComposerGearProfile = { model: "gpt-6.1-terra", effort: "medium", fastMode: false };
  const workspaceGears = [fallback, secondGear];
  const override = enableSessionComposerOverride(inherited, workspaceGears, 1);
  assert.deepEqual(effectiveSessionComposerModel(override, fallback), secondGear);
  assert.notEqual(effectiveSessionComposerModel(override, fallback).model, inherited.inherited.model);
  assert.deepEqual(override.override!.gears, workspaceGears);
  assert.notEqual(override.override!.gears[0], fallback);
  assert.deepEqual(workspaceGears, [fallback, secondGear]);
  assert.deepEqual(inherited.inherited, { model: turns[0].model, effort: "max", fastMode: true });
  const defaultOverride = enableSessionComposerOverride(inherited, [fallback], 0);
  assert.deepEqual(effectiveSessionComposerModel(defaultOverride, fallback), fallback);
  override.override!.gears[0] = { ...fallback, effort: "low", fastMode: true };
  override.override!.activeGearIndex = 0;
  const refreshed = inheritSessionComposerModel(override, "A", 1, turns, fallback);
  assert.deepEqual(effectiveSessionComposerModel(refreshed, fallback), { ...fallback, effort: "low", fastMode: true });
  assert.deepEqual(fallback, { model: "gpt-6.1-sol", effort: "high", fastMode: false });
  assert.equal(inheritSessionComposerModel(override, "B", 1, turns, fallback)!.override, null);
  assert.equal(inheritSessionComposerModel(override, "A", 2, turns, fallback)!.override, null);
});

test("cross-provider confirmation is required only for a group change and binds all send settings", () => {
  const inherited = inheritSessionComposerModel(null, "A", 1, turns, fallback)!;
  assert.equal(crossesModelGroup(inherited.inherited.model, fallback.model), true);
  assert.equal(crossesModelGroup(fallback.model, "gpt-6.1-terra"), false);
  assert.equal(crossesModelGroup(inherited.inherited.model, "auto"), true);
  const pending = { sessionId: "A", viewKey: 1, config: fallback };
  assert.equal(sessionModelConfirmationMatches(pending, "A", 1, { ...fallback }), true);
  assert.equal(sessionModelConfirmationMatches(pending, "B", 1, fallback), false);
  assert.equal(sessionModelConfirmationMatches(pending, "A", 2, fallback), false);
  assert.equal(sessionModelConfirmationMatches(pending, "A", 1, inherited.inherited), false);
  assert.equal(sessionModelConfirmationMatches(pending, "A", 1, { ...fallback, effort: "low" }), false);
  assert.equal(sessionModelConfirmationMatches(pending, "A", 1, { ...fallback, fastMode: true }), false);
  const cancelled = { ...inherited, override: null };
  assert.deepEqual(effectiveSessionComposerModel(cancelled, fallback), inherited.inherited);
});

test("round table aligns only its session-scoped active gear without mutating workspace gears", () => {
  const preferences = { selectedModel: turns[0].model, selectedEffort: "max" as const, fastMode: true, gearProfiles: [fallback], activeGearIndex: 0 };
  const sessionPreferences = roundtableSessionModelPreferences(preferences);
  assert.deepEqual(sessionPreferences.gearProfiles[0], { model: turns[0].model, effort: "max", fastMode: true });
  assert.deepEqual(preferences.gearProfiles, [fallback]);
  assert.notEqual(sessionPreferences.gearProfiles, preferences.gearProfiles);
});
