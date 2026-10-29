import { useCallback, useEffect, useRef, useState } from "react";
import { actorBlockerPendingDecision } from "../actorBlockers";
import type { LiveItem } from "./appTypes";
import type { ActorBlockerView } from "./actorBlockerPresentation";
import { ACTOR_ROOM_CHANGED } from "./actorRoomState";

export type ActionNotification = Extract<LiveItem, { itemType: "approval" }> & {
  workspaceId: string | null;
  sessionTitle: string;
  createdAt: string;
};

export function actionNotification(value: unknown): ActionNotification | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.approvalId !== "string" || typeof record.sessionId !== "string" || typeof record.method !== "string") return null;
  return { id: `approval:${record.approvalId}`, itemType: "approval", eventType: "item.started", status: "pending",
    approvalId: record.approvalId, sessionId: record.sessionId, turnId: typeof record.turnId === "string" ? record.turnId : "",
    method: record.method, params: record.params ?? null,
    workspaceId: typeof record.workspaceId === "string" ? record.workspaceId : null,
    sessionTitle: typeof record.sessionTitle === "string" ? record.sessionTitle : record.sessionId,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "" };
}

export function actionNotificationLabel(item: ActionNotification) {
  const params = item.params as { title?: string; reason?: string; command?: string; questions?: { question?: string }[] } | null;
  return params?.questions?.[0]?.question || params?.title || params?.reason || params?.command || "Approval required";
}

// The global endpoint includes hidden manager sessions and inactive workspaces.
// Reconcile after events, reconnect/focus and periodically for missed events.
export function useActionNotifications(revision: unknown, enabled: boolean) {
  const [items, setItems] = useState<ActionNotification[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const removed = useRef(new Set<string>());
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let busy = false;
    let again = false;
    const controller = new AbortController();
    async function refresh() {
      if (disposed) return;
      if (busy) { again = true; return; }
      busy = true;
      try {
        const response = await fetch("/api/approvals", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        if (!response.ok) throw new Error("Could not refresh actions. Retrying…");
        const payload = await response.json();
        if (!Array.isArray(payload.approvals)) throw new Error("Could not refresh actions. Retrying…");
        const unique = new Map<string, ActionNotification>();
        for (const value of payload.approvals) {
          const item = actionNotification(value);
          if (item && !removed.current.has(item.approvalId)) unique.set(item.approvalId, item);
        }
        if (!disposed) {
          const next = [...unique.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          setItems(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
          setError(""); setLoaded(true);
        }
      } catch {
        if (!disposed) setError("Could not refresh actions. Retrying…");
      } finally {
        busy = false;
        if (again && !disposed) { again = false; void refresh(); }
      }
    }
    refreshRef.current = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = window.setInterval(() => void refresh(), 5000);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    void refresh();
    return () => {
      disposed = true; controller.abort(); window.clearInterval(timer);
      window.removeEventListener("focus", onVisible); document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);
  useEffect(() => {
    const timer = window.setTimeout(() => refreshRef.current(), 100);
    return () => window.clearTimeout(timer);
  }, [revision]);
  const remove = useCallback((id: string) => {
    removed.current.add(id);
    setItems(current => current.filter(item => item.approvalId !== id));
    refreshRef.current();
  }, []);
  return { items, error, loaded, remove, refresh: () => refreshRef.current() };
}

/** Blocker proposals awaiting the user's approval, across every workspace. Blocker decisions do not advance the
 * central event cursor, so this polls and also refreshes on local room changes (e.g. after a decision). */
export function useBlockerNotifications(revision: unknown, enabled: boolean) {
  const [items, setItems] = useState<ActorBlockerView[]>([]);
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let busy = false;
    let again = false;
    const controller = new AbortController();
    async function refresh() {
      if (disposed) return;
      if (busy) { again = true; return; }
      busy = true;
      try {
        const response = await fetch("/api/domain-actors/blockers/pending", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        // Signed out or an older server without the endpoint: there is nothing to show.
        if (response.status === 401 || response.status === 404) { if (!disposed) setItems(current => current.length ? [] : current); return; }
        if (!response.ok) return;
        const payload = await response.json();
        if (!Array.isArray(payload.blockers) || disposed) return;
        const next = (payload.blockers as ActorBlockerView[]).filter(blocker => blocker && typeof blocker.id === "string" && actorBlockerPendingDecision(blocker));
        setItems(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
      } catch {
        // Keep the last list; the next poll retries.
      } finally {
        busy = false;
        if (again && !disposed) { again = false; void refresh(); }
      }
    }
    refreshRef.current = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = window.setInterval(() => void refresh(), 5000);
    window.addEventListener("focus", onVisible);
    window.addEventListener(ACTOR_ROOM_CHANGED, onVisible);
    document.addEventListener("visibilitychange", onVisible);
    void refresh();
    return () => {
      disposed = true; controller.abort(); window.clearInterval(timer);
      window.removeEventListener("focus", onVisible); window.removeEventListener(ACTOR_ROOM_CHANGED, onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);
  useEffect(() => {
    const timer = window.setTimeout(() => refreshRef.current(), 100);
    return () => window.clearTimeout(timer);
  }, [revision]);
  const remove = useCallback((id: string) => {
    setItems(current => current.filter(item => item.id !== id));
    refreshRef.current();
  }, []);
  return { items, remove, refresh: () => refreshRef.current() };
}
