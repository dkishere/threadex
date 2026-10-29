import { useSyncExternalStore } from "react";
import { normalizeModelEffort } from "../modelCatalog";
import type { ComposerGearProfile } from "./ComposerFrame";
import { readSideChatPreferences, saveSideChatPreferences, sideChatPreferencesKey, type SideChatPreferences } from "./sideChatPreferences";

const snapshots = new Map<string, SideChatPreferences>();
const listeners = new Set<() => void>();
function snapshot(workspaceId: string) {
  if (!snapshots.has(workspaceId)) snapshots.set(workspaceId, readSideChatPreferences(workspaceId));
  return snapshots.get(workspaceId)!;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    for (const id of snapshots.keys()) {
      if (event.key === null || event.key === sideChatPreferencesKey(id)) snapshots.delete(id);
    }
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}

/** One live, persisted gearbox per workspace, independent of dialog drafts and lifetimes. */
export function useWorkspaceChatGears(workspaceId: string) {
  const preferences = useSyncExternalStore(subscribe, () => snapshot(workspaceId));
  function update(change: (current: SideChatPreferences) => SideChatPreferences) {
    const next = change(snapshot(workspaceId));
    snapshots.set(workspaceId, next);
    saveSideChatPreferences(next, workspaceId);
    listeners.forEach(listener => listener());
  }
  return { ...preferences,
    setActiveGearIndex: (index: number) => update(current => ({ ...current, activeGearIndex: index })),
    updateGear: (index: number, patch: Partial<ComposerGearProfile>) => update(current => ({ ...current,
      gearProfiles: current.gearProfiles.map((gear, i) => {
        if (i !== index) return gear;
        const next = { ...gear, ...patch };
        return { ...next, effort: normalizeModelEffort(next.model, next.effort) };
      }) }))
  };
}
