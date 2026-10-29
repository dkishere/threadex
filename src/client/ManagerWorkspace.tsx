import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ActorRound } from "../domainActors";
import { ActorRoomPanel } from "./ActorRoomPanel";
import { WorkspaceManagerDashboard, type useWorkspaceManagerDashboard } from "./WorkspaceManagerPanel";
import { Loader2, PanelRightClose } from "lucide-react";
import { apiJson } from "./apiClient";
import type { SwitchSessionResponse } from "./appTypes";
import "./ManagerWorkspace.css";

type Props = {
  workspaceId: string;
  approvalPolicy: ActorRound["approvalPolicy"];
  dashboard: ReturnType<typeof useWorkspaceManagerDashboard>;
  onOpenSession: (session: NonNullable<SwitchSessionResponse["session"]>) => Promise<void>;
  onCloseSession: () => void;
  renderSession: (collapseButton: ReactNode) => ReactNode;
  resetKey: number;
  selectedSessionId?: string | null;
  /** Project group chat shown on the left: a project ID or "unassigned". */
  chatKey?: string;
  chatName?: string;
  /** The chat to show is still being chosen (workspace switch): show a loading state, not a default chat. */
  chatLoading?: boolean;
};

export function ManagerWorkspace({ workspaceId, approvalPolicy, dashboard, onOpenSession, onCloseSession, renderSession, resetKey, selectedSessionId = null, chatKey, chatName, chatLoading = false }: Props) {
  const [sessionId, setSessionId] = useState<string | null>(selectedSessionId);
  // A reloaded or shared group chat + session link shows that session first on a phone.
  const [mobilePanel, setMobilePanel] = useState(selectedSessionId ? "details" : "chat");
  const [load, setLoad] = useState<{ id: string; ready?: boolean; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const openSessionAction = useRef(onOpenSession);
  openSessionAction.current = onOpenSession;
  const opener = useRef<HTMLElement | null>(null);
  const dashboardHeader = useRef<HTMLElement>(null);
  useEffect(() => { setSessionId(selectedSessionId); }, [resetKey, selectedSessionId]);

  function openSession(id: string) {
    if (!id.trim()) return;
    opener.current = document.activeElement as HTMLElement;
    setSessionId(id); setMobilePanel("details");
  }

  function closeSession() {
    setSessionId(null);
    onCloseSession();
    requestAnimationFrame(() => {
      if (window.matchMedia("(width < 768px)").matches)
        document.getElementById("manager-details-tab")?.focus();
      else if (opener.current?.isConnected) opener.current.focus();
      else dashboardHeader.current?.focus();
    });
  }

  useEffect(() => {
    if (!sessionId) { setLoad(null); return; }
    const controller = new AbortController();
    setLoad(null);
    void apiJson<SwitchSessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/snapshot`, { signal: controller.signal })
      .then(async snapshot => {
        if (snapshot.session?.id !== sessionId || snapshot.session.workspaceId !== workspaceId)
          throw new Error("This session is not available in this workspace.");
        if (controller.signal.aborted) return;
        await openSessionAction.current(snapshot.session);
        if (!controller.signal.aborted) setLoad({ id: sessionId, ready: true });
      }).catch(error => {
        if (!controller.signal.aborted) setLoad({ id: sessionId, error: String(error.message ?? error) });
      });
    return () => controller.abort();
  }, [sessionId, workspaceId, retry]);

  const collapseButton = <button type="button" className="ghost-icon manager-session-collapse" aria-label="Close session and show dashboard" title="Collapse session and show dashboard" onClick={closeSession}><PanelRightClose aria-hidden="true" /></button>;
  return <div className="manager-workspace" data-mobile-panel={mobilePanel}>
    <nav className="manager-workspace-tabs" aria-label="Manager panels">
      <button type="button" aria-pressed={mobilePanel === "chat"} aria-controls="manager-conversation" onClick={() => setMobilePanel("chat")}>Chat</button>
      <button type="button" id="manager-details-tab" aria-pressed={mobilePanel === "details"} aria-controls="manager-details" onClick={() => setMobilePanel("details")}>{sessionId ? "Task session" : "Dashboard"}</button>
    </nav>
    <section id="manager-conversation" className="manager-conversation" aria-label="Manager conversation">
      {chatLoading
        ? <p className="side-chat-state" role="status"><Loader2 className="spin" aria-hidden="true" />Opening group chat…</p>
        : <ActorRoomPanel workspaceId={workspaceId} approvalPolicy={approvalPolicy} onOpenSession={openSession} disableEscapeStop chatKey={chatKey} chatName={chatName} />}
    </section>
    <aside id="manager-details" className="manager-details" aria-label={sessionId ? "Task session panel" : "Dashboard panel"}>
      {!sessionId && <header ref={dashboardHeader} tabIndex={-1} className="manager-dashboard-header"><h2>Dashboard</h2><span>Workspace activity</span></header>}
      <WorkspaceManagerDashboard hidden={!!sessionId} workspaceId={workspaceId} dashboard={dashboard} onOpenTask={openSession} />
      {sessionId && (load?.id === sessionId && load.ready ?
        renderSession(collapseButton) :
        <section className="manager-task-session" aria-label="Task session">
          <header className="manager-task-header">{collapseButton}<h2>{sessionId}</h2></header>
          {load?.id === sessionId && load.error ? <div className="manager-task-transcript" role="alert"><p>{load.error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Retry session</button></div> : <p role="status">Loading session…</p>}
        </section>)}
    </aside>
  </div>;
}
