import type { ComposerGearProfile } from "./ComposerFrame";

export type WorkspaceGearPreferences = {
  gearProfiles: ComposerGearProfile[];
  activeGearIndex: number;
};

export type SessionGearOverride = { sessionId: string; activeGearIndex: number };
const SESSION_GEAR_OVERRIDE_KEY = "threadex.session-gear-override";

/** Restore only the visible task's manual selection after a browser reload. */
export function readSessionGearOverride(): SessionGearOverride | null {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_GEAR_OVERRIDE_KEY) ?? "null");
    return saved && typeof saved.sessionId === "string" && saved.sessionId
      && Number.isInteger(saved.activeGearIndex) && saved.activeGearIndex >= 0 && saved.activeGearIndex < 6
      ? { sessionId: saved.sessionId, activeGearIndex: saved.activeGearIndex } : null;
  } catch {
    return null;
  }
}

export function saveSessionGearOverride(override: SessionGearOverride | null): void {
  try {
    if (override) localStorage.setItem(SESSION_GEAR_OVERRIDE_KEY, JSON.stringify(override));
    else localStorage.removeItem(SESSION_GEAR_OVERRIDE_KEY);
  } catch { /* Keep the visible task usable when browser storage is unavailable. */ }
}

export function workspaceGearPreferencesKey(workspaceId: string | null): string {
  return `threadex.workspace-gear-preferences:${encodeURIComponent(workspaceId ?? "__new_session__")}`;
}

/** Keep the user's presets after the preference outbox has been acknowledged. */
export function readWorkspaceGearPreferences(workspaceId: string | null): WorkspaceGearPreferences | null {
  try {
    const saved = JSON.parse(localStorage.getItem(workspaceGearPreferencesKey(workspaceId)) ?? "null");
    if (!saved || !Array.isArray(saved.gearProfiles) || ![3, 6, 7].includes(saved.gearProfiles.length)
      || !Number.isInteger(saved.activeGearIndex) || saved.activeGearIndex < 0 || saved.activeGearIndex >= 6
      || !saved.gearProfiles.every((gear: unknown) => gear && typeof gear === "object"
        && typeof (gear as ComposerGearProfile).model === "string" && typeof (gear as ComposerGearProfile).effort === "string")) return null;
    return { gearProfiles: saved.gearProfiles, activeGearIndex: saved.activeGearIndex };
  } catch {
    return null;
  }
}

export function saveWorkspaceGearPreferences(workspaceId: string | null, preferences: WorkspaceGearPreferences): void {
  try {
    localStorage.setItem(workspaceGearPreferencesKey(workspaceId), JSON.stringify({
      gearProfiles: preferences.gearProfiles,
      activeGearIndex: preferences.activeGearIndex
    }));
  } catch { /* The live selector and server preference outbox remain usable. */ }
}
