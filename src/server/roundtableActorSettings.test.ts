import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL } from "../modelCatalog";
import { actorFromPreset, defaultRoundtableActors, detachRoundtableActorFromPreset, parseRoundtablePresets, syncRoundtableDraftWithPresets } from "../roundtablePresets";
import { RoundtableActorSettings } from "./roundtableActorSettings";
import { dicebearAvatar, parseActorAvatar } from "../actorAvatar";

const actor = { id: "critic", name: "Critic", model: DEFAULT_MODEL, effort: "max", rolePrompt: "Question assumptions", isDefault: true };
test("saved legacy Claude efforts migrate on read while new invalid choices are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "roundtable-effort-"));
  try {
    const path = join(dir, "actors.json");
    writeFileSync(path, JSON.stringify({ revision: 2, actors: [{ ...actor, model: "haiku", effort: "minimal" }] }));
    const settings = new RoundtableActorSettings(path);
    assert.equal(settings.read().actors[0].effort, "low");
    assert.throws(() => settings.save([{ ...actor, model: "haiku", effort: "minimal" }], 2));
    assert.equal(settings.save([{ ...actor, model: "haiku", effort: "max" }], 2).actors[0].effort, "max");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("legacy drafts adopt a uniquely matching preset and linked drafts follow library edits", () => {
  const preset = { ...actor, avatar: dicebearAvatar("chosen", "pixel-art") };
  const legacy = { id: "old-instance", name: actor.name, model: actor.model, effort: actor.effort, systemPrompt: actor.rolePrompt };
  const migrated = syncRoundtableDraftWithPresets([legacy], [preset]);
  assert.equal(migrated[0].avatar, preset.avatar);
  assert.equal(migrated[0].presetId, preset.id);
  assert.equal(migrated[0].id, legacy.id);
  assert.equal(syncRoundtableDraftWithPresets(migrated, [preset]), migrated, "an unchanged library keeps the same draft");
  const updated = { ...preset, name: "Critic 2", model: "gpt-6.2-astra", effort: "xhigh", rolePrompt: "Be sharper", avatar: dicebearAvatar("new", "lorelei") };
  const followed = syncRoundtableDraftWithPresets(migrated, [updated])[0];
  assert.deepEqual({ name: followed.name, model: followed.model, effort: followed.effort, systemPrompt: followed.systemPrompt, avatar: followed.avatar },
    { name: updated.name, model: updated.model, effort: updated.effort, systemPrompt: updated.rolePrompt, avatar: updated.avatar });
  assert.equal(followed.id, legacy.id);
  assert.equal(migrated[0].avatar, preset.avatar, "earlier snapshots are not mutated");
  assert.equal(actorFromPreset(preset).presetId, preset.id);
  const ambiguous = [legacy];
  assert.equal(syncRoundtableDraftWithPresets(ambiguous, [preset, { ...preset, id: "duplicate" }]), ambiguous);
  const custom = [{ ...legacy, avatar: dicebearAvatar("custom") }];
  assert.equal(syncRoundtableDraftWithPresets(custom, [preset]), custom);
  const customised = [detachRoundtableActorFromPreset(migrated[0], { model: "claude-opus-5-5" })];
  assert.equal(customised[0].presetId, undefined);
  assert.equal(syncRoundtableDraftWithPresets(customised, [updated]), customised, "per-draft customisation is not overwritten");
});
test("actor library survives reload and rejects stale writes without losing saved actors", () => {
  const dir = mkdtempSync(join(tmpdir(), "roundtable-library-"));
  try {
    const path = join(dir, "actors.json");
    const store = new RoundtableActorSettings(path);
    assert.deepEqual(store.read(), { revision: 0, actors: [] });
    assert.equal(store.save([actor], 0).revision, 1);
    const reopened = new RoundtableActorSettings(path);
    assert.deepEqual(reopened.read().actors, [{ ...actor, type: "consultant" }]);
    assert.throws(() => reopened.save([], 0), /Reload/);
    assert.deepEqual(store.read().actors, [{ ...actor, type: "consultant" }]);
    assert.deepEqual(reopened.save([], 1), { revision: 2, actors: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("actor library validates defaults, IDs, model and role prompt", () => {
  assert.equal(parseActorAvatar(dicebearAvatar("example")), dicebearAvatar("example"));
  assert.throws(() => parseActorAvatar("https://example.com/tracking.png"), /Avatar/);
  assert.throws(() => parseActorAvatar("data:image/svg+xml;base64,PHN2Zz4="), /Avatar/);
  assert.throws(() => parseActorAvatar("data:image/png;base64," + "A".repeat(65536)), /Avatar/);
  const withAvatar = { ...actor, avatar: dicebearAvatar("saved-avatar", "lorelei") };
  assert.equal(defaultRoundtableActors(parseRoundtablePresets([withAvatar]), [])[0].avatar, withAvatar.avatar);
  assert.equal(parseRoundtablePresets([{ ...actor, effort: undefined }])[0].effort, "high");
  assert.throws(() => parseRoundtablePresets([{ ...actor, effort: "bogus" }]), /effort/);
  assert.throws(() => parseRoundtablePresets([actor, actor]), /unique/);
  assert.throws(() => parseRoundtablePresets([{ ...actor, model: "unsupported" }]), /supported model/);
  assert.throws(() => parseRoundtablePresets([{ ...actor, rolePrompt: "x".repeat(8001) }]), /role prompt/);
  assert.throws(() => parseRoundtablePresets(Array.from({ length: 9 }, (_, i) => ({ ...actor, id: `actor${i}` }))), /8 default/);
  assert.equal(parseRoundtablePresets(Array.from({ length: 20 }, (_, i) => ({ ...actor, id: `actor${i}`, isDefault: false }))).length, 20);
});
test("defaults become independent snapshots with gearbox fallback and fresh IDs", () => {
  const presets = [actor, { ...actor, id: "optional", isDefault: false }];
  const first = defaultRoundtableActors(presets, [{ model: DEFAULT_MODEL, effort: "max" }]);
  const second = defaultRoundtableActors(presets, []);
  assert.equal(first.length, 2);
  assert.equal(first[0].name, actor.name);
  assert.equal(first[0].effort, "max");
  assert.equal(first[0].systemPrompt, actor.rolePrompt);
  assert.equal(first[1].effort, "max");
  assert.equal(first[1].systemPrompt, "");
  assert.notEqual(first[0].id, second[0].id);
  first[0].name = "Changed locally";
  assert.equal(presets[0].name, "Critic");
});
