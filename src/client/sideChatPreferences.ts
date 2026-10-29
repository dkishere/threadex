import { defaultGearProfiles, MODEL_OPTIONS, normalizeModelEffort, normalizeModelId } from "../modelCatalog";
import type { ComposerGearProfile } from "./ComposerFrame";

export const SIDE_CHAT_PREFERENCES_KEY = "threadex.sideChatGearPreferences";

export type SideChatPreferences = {
  gearProfiles: ComposerGearProfile[];
  activeGearIndex: number;
};

export function sideChatPreferencesKey(workspaceId?: string): string {
  return workspaceId ? `${SIDE_CHAT_PREFERENCES_KEY}:${encodeURIComponent(workspaceId)}` : SIDE_CHAT_PREFERENCES_KEY;
}

export function readSideChatPreferences(workspaceId?: string): SideChatPreferences {
  const fallback = { gearProfiles: defaultGearProfiles(), activeGearIndex: 1 };
  try {
    const saved = JSON.parse(localStorage.getItem(sideChatPreferencesKey(workspaceId)) ?? localStorage.getItem(SIDE_CHAT_PREFERENCES_KEY) ?? "null");
    if (!saved || typeof saved !== "object") return fallback;
    const gearProfiles = fallback.gearProfiles.map((gear, index) => {
      const candidate = saved.gearProfiles?.[index];
      if (!candidate || typeof candidate.model !== "string") return gear;
      const model = normalizeModelId(candidate.model);
      if (!MODEL_OPTIONS.includes(model)) return gear;
      return { model, effort: normalizeModelEffort(model, typeof candidate.effort === "string" ? candidate.effort : gear.effort) };
    });
    const activeGearIndex = Number.isInteger(saved.activeGearIndex)
      && saved.activeGearIndex >= 0 && saved.activeGearIndex < gearProfiles.length
      ? saved.activeGearIndex : fallback.activeGearIndex;
    return { gearProfiles, activeGearIndex };
  } catch {
    return fallback;
  }
}

export function saveSideChatPreferences(preferences: SideChatPreferences, workspaceId?: string): void {
  try {
    localStorage.setItem(sideChatPreferencesKey(workspaceId), JSON.stringify(preferences));
  } catch { /* Keep the current selection usable when storage is unavailable. */ }
}
