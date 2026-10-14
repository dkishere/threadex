import { MODEL_OPTIONS, normalizeModelId } from "./modelCatalog";
import { newRoundtableActor, roundtableEfforts, type RoundtableActor } from "./roundtable";
import { dicebearAvatar, parseActorAvatar } from "./actorAvatar";

export type RoundtablePreset = { id: string; name: string; model: string; effort: string; rolePrompt: string; isDefault: boolean; avatar?: string };
export type RoundtableLibrary = { revision: number; actors: RoundtablePreset[] };
export const roundtableLibraryEndpoint = "/api/settings/roundtable-actors";
export function parseRoundtablePresets(value: unknown): RoundtablePreset[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Save up to 100 actors.");
  const actors = value.map(raw => {
    const actor = raw as RoundtablePreset;
    if (!actor || typeof actor.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(actor.id)
      || typeof actor.name !== "string" || !actor.name.trim() || actor.name.length > 80
      || typeof actor.model !== "string" || !MODEL_OPTIONS.includes(normalizeModelId(actor.model))
      || typeof actor.rolePrompt !== "string" || actor.rolePrompt.length > 8000 || typeof actor.isDefault !== "boolean") {
      throw new Error("Each actor needs a name, supported model, role prompt and default flag.");
    }
    const effort = actor.effort === undefined ? "high" : actor.effort;
    if (!roundtableEfforts(normalizeModelId(actor.model)).includes(effort)) throw new Error(`Choose a reasoning effort supported by ${actor.model}.`);
    return { id: actor.id, name: actor.name.trim(), model: normalizeModelId(actor.model), effort, rolePrompt: actor.rolePrompt, isDefault: actor.isDefault, ...(actor.avatar === undefined ? {} : { avatar: parseActorAvatar(actor.avatar) }) };
  });
  if (new Set(actors.map(actor => actor.id)).size !== actors.length) throw new Error("Actor IDs must be unique.");
  if (actors.filter(actor => actor.isDefault).length > 8) throw new Error("Choose at most 8 default actors.");
  return actors;
}
export function actorFromPreset(preset: RoundtablePreset): RoundtableActor {
  return { ...newRoundtableActor({ model: preset.model, effort: preset.effort }), name: preset.name, systemPrompt: preset.rolePrompt, avatar: preset.avatar ?? dicebearAvatar(preset.id), presetId: preset.id };
}
/** Only draft avatars follow the library. Submitted round snapshots stay immutable. */
export function syncRoundtableDraftAvatars(actors: RoundtableActor[], presets: RoundtablePreset[]): RoundtableActor[] {
  let changed = false;
  const next = actors.map(actor => {
    const candidates = actor.presetId ? presets.filter(preset => preset.id === actor.presetId)
      : presets.filter(preset => preset.name === actor.name && normalizeModelId(preset.model) === normalizeModelId(actor.model)
        && preset.effort === actor.effort && preset.rolePrompt === actor.systemPrompt
        && (!actor.avatar || actor.avatar === preset.avatar || actor.avatar === dicebearAvatar(preset.id)));
    if (candidates.length !== 1) return actor;
    const preset = candidates[0];
    const avatar = preset.avatar ?? dicebearAvatar(preset.id);
    if (actor.avatar === avatar && actor.presetId === preset.id) return actor;
    changed = true;
    return { ...actor, presetId: preset.id, avatar };
  });
  return changed ? next : actors;
}
export function defaultRoundtableActors(presets: RoundtablePreset[], gears: { model: string; effort?: string }[]) {
  const actors = presets.filter(preset => preset.isDefault).map(actorFromPreset);
  while (actors.length < 2) actors.push(newRoundtableActor(gears[actors.length] ?? gears[0]));
  return actors;
}
