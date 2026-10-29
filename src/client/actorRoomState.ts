import { useCallback, useEffect, useRef, useState } from "react";
import type { ActorRoom } from "../domainActors";
import { apiJson, ApiError } from "./apiClient";

export type ActorRoomState = {
  room: ActorRoom | null; error: string | null; authRequired: boolean;
  refresh: () => Promise<void>; setRoom: (room: ActorRoom) => void;
};

type Snapshot = { workspaceId: string; chat: string | null; room: ActorRoom | null; error: string | null; authRequired: boolean };
export const ACTOR_ROOM_CHANGED = "threadex:actor-room-changed";

export function notifyActorRoomChanged(workspaceId: string) {
  window.dispatchEvent(new CustomEvent(ACTOR_ROOM_CHANGED, { detail: { workspaceId } }));
}

export function isAuthRequired(cause: unknown) {
  return cause instanceof ApiError && (cause.code === "AUTH_REQUIRED" || cause.status === 401);
}

/** Polls the workspace actor room every 2.5s; an older revision never replaces a newer one.
 * With `chat` (a project ID or "unassigned") the server returns only that group chat's rounds;
 * without it the full room (actor views). See docs/actor-project-chats.md. */
export function useActorRoom(workspaceId: string, options: { enabled?: boolean; chat?: string | null } = {}): ActorRoomState {
  const enabled = options.enabled ?? true;
  const chat = options.chat ?? null;
  const [state, setState] = useState<Snapshot>({ workspaceId, chat, room: null, error: null, authRequired: false });
  const controller = useRef<AbortController | null>(null);
  const same = (current: Snapshot) => current.workspaceId === workspaceId && current.chat === chat;
  const adopt = useCallback((next: ActorRoom) => {
    setState(current => !same(current) ? current : {
      ...current, room: !current.room || next.revision >= current.room.revision ? next : current.room });
  }, [workspaceId, chat]);
  const refresh = useCallback(async () => {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    try {
      const query = chat === null ? "" : `?chat=${encodeURIComponent(chat)}`;
      const next = await apiJson<ActorRoom>(`/api/domain-actors/${encodeURIComponent(workspaceId)}/room${query}`, { fresh: true, signal });
      if (signal.aborted) return;
      setState(current => !same(current) ? current : {
        workspaceId, chat, room: !current.room || next.revision >= current.room.revision ? next : current.room, error: null, authRequired: false });
    } catch (cause) {
      if (signal.aborted) return;
      setState(current => !same(current) ? current : {
        ...current, authRequired: isAuthRequired(cause), error: cause instanceof Error ? cause.message : String(cause) });
    }
  }, [workspaceId, chat]);
  useEffect(() => {
    setState(current => same(current) ? current : { workspaceId, chat, room: null, error: null, authRequired: false });
    if (!enabled) return;
    const active = new AbortController();
    controller.current = active;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => { active.abort(); if (controller.current === active) controller.current = null; window.clearInterval(timer); };
  }, [workspaceId, chat, enabled, refresh]);
  const current = same(state) ? state : { room: null, error: null, authRequired: false };
  return { room: current.room, error: current.error, authRequired: current.authRequired, refresh, setRoom: adopt };
}
