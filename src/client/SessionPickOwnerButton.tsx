import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MessageSquarePlus } from "lucide-react";
import { loadSessionPickOwner, pickOwnerButtonState, type PickOwnerStatus } from "./sessionPickOwner";
import { setGroupFollowUpDraft } from "./groupFollowUpDraft";
import "./SessionPickOwnerButton.css";

const PENDING_POLL_MS = 5000;

/**
 * Attaches an ownerless session to its project's group chat composer as a "Group follow-up" badge.
 * The user writes the prompt there and sends it; nothing is sent from this button.
 * Renders nothing unless the server says the project has actors that could take the session.
 * `onOpenGroupChat` is omitted where the user is already in the group chat.
 */
export function SessionPickOwnerButton({ sessionId, sessionTitle, onOpenGroupChat }: { sessionId: string; sessionTitle: string; onOpenGroupChat?: (chatProjectId: string) => void }) {
  const [loaded, setLoaded] = useState<{ sessionId: string; status: PickOwnerStatus } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const status = await loadSessionPickOwner(sessionId, signal);
      if (!signal?.aborted && mounted.current) setLoaded({ sessionId, status });
    } catch { /* Without a status the button stays hidden. */ }
  }, [sessionId]);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  const status = loaded?.sessionId === sessionId ? loaded.status : null;
  const state = pickOwnerButtonState(status);
  // While the group chat picks, poll until an owner takes the session or the round ends without one.
  const waiting = state.kind === "pending";
  useEffect(() => {
    if (!waiting) return;
    const controller = new AbortController();
    const timer = setInterval(() => void refresh(controller.signal), PENDING_POLL_MS);
    return () => { clearInterval(timer); controller.abort(); };
  }, [waiting, refresh]);
  function attach() {
    if (!status?.projectId) return;
    setGroupFollowUpDraft({ sessionId, title: sessionTitle, projectId: status.projectId, projectName: status.projectName ?? status.projectId });
    onOpenGroupChat?.(status.projectId);
  }
  if (state.kind === "hidden") return null;
  const ready = state.kind === "ready";
  return <span className="session-pick-owner">
    <button type="button" className="parent-session-link session-pick-owner-button" disabled={state.disabled} aria-busy={!ready}
      aria-label={ready ? "Group follow-up: attach this session to the project group chat composer" : state.label}
      title={ready ? "Group follow-up: attach this session to the project group chat composer, then write your prompt" : state.label}
      onClick={attach}>
      {ready ? <MessageSquarePlus aria-hidden="true" /> : <Loader2 className="spin" aria-hidden="true" />}<span>{state.label}</span>
    </button>
  </span>;
}
