import { useEffect, useRef } from "react";
import { eventStore } from "./eventStore";
import { navigationUrl } from "./navigation";

const NOTIFICATION_TTL_MS = 60 * 60 * 1000;
import { ensureNotificationWorker } from "./notificationWorker";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function taskTitle(value: unknown, sessionId: string): string | undefined {
  const session = record(value);
  if (session.id !== sessionId || typeof session.title !== "string") return;
  return session.title.replace(/\s+/g, " ").trim().slice(0, 180) || undefined;
}

async function notificationTaskName(sessionId: string): Promise<string> {
  const state = eventStore.getState();
  const selected = taskTitle(record(state.selectedSessionSnapshot).session, sessionId);
  const listed = state.sessionPage.sessions.map((session) => taskTitle(session, sessionId)).find(Boolean);
  const monitored = state.statusMonitor.flatMap((workspace) => workspace.active_sessions)
    .find((session) => session.id === sessionId)?.name;
  if (selected || listed || monitored) return selected || listed || monitored!;
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/snapshot`, {
      cache: "no-store", signal: AbortSignal.timeout(4000)
    });
    if (response.ok) {
      const snapshot = record(await response.json());
      const title = taskTitle(snapshot.session, sessionId);
      if (title) return title;
    }
  } catch { /* Still identify the session if its title cannot be loaded. */ }
  return `Session ${sessionId}`;
}

async function registration() {
  if (!("Notification" in window) || Notification.permission !== "granted" || !("serviceWorker" in navigator)) return;
  return ensureNotificationWorker();
}

async function closeExpiredNotifications(worker: ServiceWorkerRegistration) {
  const notifications = await worker.getNotifications();
  const now = Date.now();
  for (const notification of notifications) {
    const expiresAt = Number(notification.data?.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= now) notification.close();
  }
}

// System notifications only; no added app UI.
export function TaskNotifications({ runningCount }: { runningCount: number }) {
  const startedAt = useRef(Date.now());
  const seen = useRef(new Set<string>());
  const expiryTimers = useRef(new Map<string, number>());

  function scheduleExpiry(worker: ServiceWorkerRegistration, tag: string, expiresAt: number) {
    const previous = expiryTimers.current.get(tag);
    if (previous) window.clearTimeout(previous);
    const timer = window.setTimeout(() => {
      expiryTimers.current.delete(tag);
      void worker.getNotifications({ tag }).then((notifications) => {
        notifications.forEach((notification) => notification.close());
      }).catch((error) => console.warn("Could not expire task notification", error));
    }, Math.max(0, expiresAt - Date.now()));
    expiryTimers.current.set(tag, timer);
  }

  useEffect(() => () => {
    expiryTimers.current.forEach((timer) => window.clearTimeout(timer));
    expiryTimers.current.clear();
  }, []);

  useEffect(() => eventStore.subscribeTo(["runner.result", "runner.error"], (event) => {
    if (!event.sessionId || !event.turnId || Date.parse(event.timestamp) < startedAt.current) return;
    const payload = record(event.payload);
    if (payload.silent === true || payload.workspaceManaged === true) return;
    const key = `${event.workspaceId}:${event.turnId}`;
    if (seen.current.has(key)) return;
    seen.current.add(key);
    if (seen.current.size > 500) seen.current.delete(seen.current.values().next().value!);
    const text = payload.workspaceManager === true ? "Workspace update" : event.type === "runner.error" ? "Task failed" : "Task completed";
    const url = navigationUrl({ workspaceId: event.workspaceId, sessionId: payload.workspaceManager === true ? null : event.sessionId, view: payload.workspaceManager === true ? "workspace-chat" : null },
      `${location.origin}/${payload.workspaceManager === true ? "?view=workspace-chat" : ""}`);
    void registration().then(async (worker) => {
      if (!worker) return;
      const name = await notificationTaskName(event.sessionId!);
      const tag = `threadex-turn-${key}`;
      const expiresAt = Date.now() + NOTIFICATION_TTL_MS;
      await worker.showNotification(`Threadex · ${text}`, {
        body: payload.workspaceManager === true && typeof payload.reply === "string" ? payload.reply.slice(0, 220) : name, icon: "/icons/threadex-192.png",
        tag, requireInteraction: true, data: { url, expiresAt }
      });
      scheduleExpiry(worker, tag, expiresAt);
    }).catch((error) => console.warn("Task notification unavailable", error));
  }), []);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void registration().then(async (worker) => {
        if (!worker || cancelled) return;
        await closeExpiredNotifications(worker);
        if (runningCount === 0) {
          const notifications = await worker.getNotifications({ tag: "threadex-running" });
          notifications.forEach((notification) => notification.close());
          return;
        }
        await worker.showNotification(`Threadex · ${runningCount} running`, {
          body: "Tasks in progress", tag: "threadex-running", silent: true,
          requireInteraction: true, icon: "/icons/threadex-192.png", data: { url: "/" }
        });
      }).catch((error) => console.warn("Running task notification unavailable", error));
    };
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    const timer = window.setTimeout(refresh, 750);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [runningCount]);
  return null;
}
