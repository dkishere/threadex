import { useCallback, useSyncExternalStore } from "react";
import type { ActorBlocker } from "../actorBlockers";

/**
 * Client-side "seen" marks for blockers: badges count only blockers the user has not opened since their last update.
 * Display state only; the blocker itself stays active until it is resolved. A later update (new proposal, escalation)
 * changes `updated`, so the blocker counts as unseen again.
 */
const STORAGE_KEY = "threadex:blocker-seen";
const MAX_ENTRIES = 500;
const listeners = new Set<() => void>();
let cache: Record<string, string> | null = null;

function read(): Record<string, string> {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    cache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { cache = {}; }
  return cache!;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const storage = (event: StorageEvent) => { if (event.key === STORAGE_KEY) { cache = null; listener(); } };
  window.addEventListener("storage", storage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", storage); };
}

export function blockerSeen(seen: Record<string, string>, blocker: Pick<ActorBlocker, "id" | "updated">) {
  return seen[blocker.id] === blocker.updated;
}

export function markBlockersSeen(blockers: readonly Pick<ActorBlocker, "id" | "updated">[]) {
  const current = read();
  if (blockers.every(blocker => blockerSeen(current, blocker))) return;
  const next = { ...current };
  for (const blocker of blockers) { delete next[blocker.id]; next[blocker.id] = blocker.updated; }
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete next[key];
  cache = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* storage full or blocked: keep in memory */ }
  for (const listener of listeners) listener();
}

/** Returns the blockers not yet seen at their current revision. */
export function useUnseenBlockers() {
  const seen = useSyncExternalStore(subscribe, read, () => ({}));
  return useCallback(<T extends Pick<ActorBlocker, "id" | "updated">>(blockers: readonly T[]) =>
    blockers.filter(blocker => !blockerSeen(seen, blocker)), [seen]);
}
