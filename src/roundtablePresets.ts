import { MODEL_OPTIONS, normalizeModelId } from "./modelCatalog";
import { newRoundtableActor, roundtableEfforts, type RoundtableActor } from "./roundtable";
import { dicebearAvatar, parseActorAvatar } from "./actorAvatar";
import { actorTypeForRegistry } from "./actorTypes";

export type RoundtablePreset = { type?: "consultant"; id: string; name: string; model: string; effort: string; rolePrompt: string; isDefault: boolean; avatar?: string };
export type RoundtableLibrary = { revision: number; actors: RoundtablePreset[] };
export const roundtableLibraryEndpoint = "/api/settings/roundtable-actors";
export function parseRoundtablePresets(value: unknown): RoundtablePreset[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Save up to 100 actors.");
  const actors = value.map(raw => {
    const actor = raw as RoundtablePreset;
    actorTypeForRegistry("roundtable", actor?.type);
    if (!actor || typeof actor.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(actor.id)
      || typeof actor.name !== "string" || !actor.name.trim() || actor.name.length > 80
      || typeof actor.model !== "string" || !MODEL_OPTIONS.includes(normalizeModelId(actor.model))
      || typeof actor.rolePrompt !== "string" || actor.rolePrompt.length > 8000 || typeof actor.isDefault !== "boolean") {
      throw new Error("Each actor needs a name, supported model, role prompt and default flag.");
    }
    const effort = actor.effort === undefined ? "high" : actor.effort;
    if (!roundtableEfforts(normalizeModelId(actor.model)).includes(effort)) throw new Error(`Choose a reasoning effort supported by ${actor.model}.`);
    return { type: "consultant" as const, id: actor.id, name: actor.name.trim(), model: normalizeModelId(actor.model), effort, rolePrompt: actor.rolePrompt, isDefault: actor.isDefault, ...(actor.avatar === undefined ? {} : { avatar: parseActorAvatar(actor.avatar) }) };
  });
  if (new Set(actors.map(actor => actor.id)).size !== actors.length) throw new Error("Actor IDs must be unique.");
  if (actors.filter(actor => actor.isDefault).length > 8) throw new Error("Choose at most 8 default actors.");
  return actors;
}
export function actorFromPreset(preset: RoundtablePreset): RoundtableActor {
  return { ...newRoundtableActor({ model: preset.model, effort: preset.effort }), name: preset.name, systemPrompt: preset.rolePrompt, avatar: preset.avatar ?? dicebearAvatar(preset.id), presetId: preset.id };
}
/** Linked draft actors follow library edits (name, model, effort, role prompt, avatar); a draft
 * customised per actor drops its presetId. Submitted round snapshots stay immutable. */
export function syncRoundtableDraftWithPresets(actors: RoundtableActor[], presets: RoundtablePreset[]): RoundtableActor[] {
  let changed = false;
  const next = actors.map(actor => {
    const candidates = actor.presetId ? presets.filter(preset => preset.id === actor.presetId)
      : presets.filter(preset => preset.name === actor.name && normalizeModelId(preset.model) === normalizeModelId(actor.model)
        && preset.effort === actor.effort && preset.rolePrompt === actor.systemPrompt
        && (!actor.avatar || actor.avatar === preset.avatar || actor.avatar === dicebearAvatar(preset.id)));
    if (candidates.length !== 1) return actor;
    const preset = candidates[0];
    const linked = { ...actor, name: preset.name, model: preset.model, effort: preset.effort, systemPrompt: preset.rolePrompt,
      avatar: preset.avatar ?? dicebearAvatar(preset.id), presetId: preset.id };
    if ((["name", "model", "effort", "systemPrompt", "avatar", "presetId"] as const).every(field => actor[field] === linked[field])) return actor;
    changed = true;
    return linked;
  });
  return changed ? next : actors;
}
export function detachRoundtableActorFromPreset(actor: RoundtableActor, update: Partial<RoundtableActor>): RoundtableActor {
  const { presetId: _presetId, ...customised } = { ...actor, ...update };
  return customised;
}
export function defaultRoundtableActors(presets: RoundtablePreset[], gears: { model: string; effort?: string }[]) {
  const actors = presets.filter(preset => preset.isDefault).map(actorFromPreset);
  while (actors.length < 2) actors.push(newRoundtableActor(gears[actors.length] ?? gears[0]));
  return actors;
}
