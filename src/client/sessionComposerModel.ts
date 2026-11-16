import type { ComposerGearProfile } from "./ComposerFrame";
import type { SessionTurnRecord } from "./appTypes";

export type SessionComposerModel = {
  sessionId: string;
  viewKey: number;
  inherited: ComposerGearProfile;
  override: { gears: ComposerGearProfile[]; activeGearIndex: number } | null;
};

export function inheritSessionComposerModel(
  previous: SessionComposerModel | null, sessionId: string, viewKey: number,
  turns: Pick<SessionTurnRecord, "model" | "reasoningEffort" | "requestedServiceTier">[],
  fallback: ComposerGearProfile
): SessionComposerModel | null {
  const turn = turns.at(-1);
  if (!turn || (!turn.model && !turn.reasoningEffort && !turn.requestedServiceTier)) return null;
  return {
    sessionId, viewKey,
    inherited: {
      model: turn.model || fallback.model,
      effort: (turn.reasoningEffort || fallback.effort) as ComposerGearProfile["effort"],
      fastMode: turn.requestedServiceTier ? turn.requestedServiceTier === "fast" : fallback.fastMode === true
    },
    override: previous?.sessionId === sessionId && previous.viewKey === viewKey ? previous.override : null
  };
}

export function effectiveSessionComposerModel(state: SessionComposerModel | null, fallback: ComposerGearProfile): ComposerGearProfile {
  return state?.override ? state.override.gears[state.override.activeGearIndex] ?? state.inherited : state?.inherited ?? fallback;
}

/** Releasing the inherited lock means the user does not want the last turn's
 * settings, so the session-scoped override starts from a copy of the user's own
 * workspace gears (including the active default), never from `state.inherited`. */
export function enableSessionComposerOverride(state: SessionComposerModel, gears: ComposerGearProfile[], activeGearIndex: number): SessionComposerModel {
  return { ...state, override: { gears: gears.map(gear => ({ ...gear })), activeGearIndex } };
}

/** Round table normalizes session preferences through its active gear. Ordinary
 * chat instead persists workspace gears and reads the separate selected fields. */
export function roundtableSessionModelPreferences<T extends {
  selectedModel: string; selectedEffort: ComposerGearProfile["effort"]; fastMode: boolean;
  gearProfiles: ComposerGearProfile[]; activeGearIndex: number;
}>(preferences: T): T {
  return { ...preferences, gearProfiles: preferences.gearProfiles.map((gear, index) => index === preferences.activeGearIndex
    ? { model: preferences.selectedModel, effort: preferences.selectedEffort, fastMode: preferences.fastMode } : gear) };
}

export function sessionModelConfirmationMatches(
  pending: { sessionId: string; viewKey: number; config: ComposerGearProfile },
  sessionId: string | null, viewKey: number, config: ComposerGearProfile
) {
  return pending.sessionId === sessionId && pending.viewKey === viewKey &&
    pending.config.model === config.model && pending.config.effort === config.effort &&
    Boolean(pending.config.fastMode) === Boolean(config.fastMode);
}
