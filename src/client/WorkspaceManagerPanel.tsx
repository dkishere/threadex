import { Loader2, MessageCircle, Pause, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState, type ComponentProps, type ComponentType } from "react";
import type { WorkspaceManagerRecord, WorkspaceManagerSnapshot, WorkspaceManagerTask } from "../workspaceManager";
import type { LiveItem } from "./appTypes";
import { apiJson } from "./apiClient";
import "./WorkspaceManagerPanel.css";

type ApprovalItem = Extract<LiveItem, { itemType: "approval" }>;
type ManagerState = {
  manager: WorkspaceManagerRecord | null;
  workspaceName: string;
  approvals: Array<Omit<ApprovalItem, "id" | "eventType" | "itemType" | "status"> & { title: string }>;
};

/** A workspace view around the normal session renderer, independent of session identity. */
export function WorkspaceManagerView(props: ComponentProps<"section">) {
  return <section {...props} data-workspace-manager="true" aria-label="Workspace manager chat" />;
}

export function useWorkspaceManager(workspaceId: string | undefined) {
  const [state, setState] = useState<(ManagerState & { workspaceId: string }) | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    let fetching = false;
    const read = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const next = await apiJson<ManagerState>(`/api/workspace-manager/conversation?workspaceId=${encodeURIComponent(workspaceId)}&summary=true`, { signal: controller.signal });
        if (!controller.signal.aborted) setState({ ...next, workspaceId });
      } catch { /* Keep the last snapshot during reconnect; navigation reports errors. */ }
      finally { fetching = false; }
    };
    void read();
    const timer = window.setInterval(() => void read(), 5000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [workspaceId, revision]);
  return { state: state?.workspaceId === workspaceId ? state : null, refresh };
}

export function WorkspaceManagerToggle({ active, busy, onToggle }: { active: boolean; busy: boolean; onToggle: () => void }) {
  return <button type="button" className="workspace-manager-toggle" role="switch" aria-checked={active}
    aria-label="Workspace manager" title={active ? "Return to session" : "Open workspace manager"} disabled={busy} onClick={onToggle}>
    {busy ? <Loader2 className="spin" /> : <MessageCircle />}<span>Manager</span>
  </button>;
}

export function workspaceTaskElapsed(started: string | null | undefined, now: number): string {
  if (!started) return "Unavailable";
  const start = Date.parse(started);
  if (!Number.isFinite(start)) return "Unavailable";
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function RunningTaskCard({ task, now, onOpenTask }: {
  task: WorkspaceManagerTask; now: number; onOpenTask: (sessionId: string) => void;
}) {
  const metrics = [
    ["Running", workspaceTaskElapsed(task.runningSince, now)],
    ["Turn", task.turnNumber ? `#${task.turnNumber}` : "Unavailable"],
    ["Files updated", task.updatedFiles == null ? "Unavailable" : String(task.updatedFiles)],
    ["Queued", task.queuedTurns == null ? "Unavailable" : String(task.queuedTurns)],
    ["Model", task.runningModel || "Awaiting model"]
  ];
  return <article className="workspace-task-card" data-session-id={task.sessionId}>
    <div className="workspace-task-heading"><span className="workspace-task-status-dot" aria-hidden="true" />
      <span>RUNNING TASK</span></div>
    <button type="button" className="workspace-task-title" onClick={() => onOpenTask(task.sessionId)}>{task.title}</button>
    <div className="workspace-task-metrics">{metrics.map(([label, value]) =>
      <div className="workspace-task-metric" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
  </article>;
}

export function WorkspaceManagerDashboard({ hidden, workspaceId, onOpenTask }: {
  hidden: boolean; workspaceId: string | undefined; onOpenTask: (sessionId: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<WorkspaceManagerSnapshot | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (hidden || !workspaceId) return;
    const controller = new AbortController();
    const read = async () => {
      try {
        const next = await apiJson<WorkspaceManagerSnapshot>(`/api/workspace-manager?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setSnapshot(next); setError(""); }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    setSnapshot(null);
    void read();
    const refresh = window.setInterval(() => void read(), 5000);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { controller.abort(); window.clearInterval(refresh); window.clearInterval(clock); };
  }, [hidden, workspaceId]);
  const running = snapshot?.tasks.filter(task => task.status === "running") ?? [];
  return <section className="workspace-manager-dashboard" id="session-panel-dashboard" role="tabpanel"
    aria-labelledby="session-tab-dashboard" hidden={hidden}>
    <div className="workspace-dashboard-content">
      <header><span className="workspace-dashboard-label">WORKSPACE</span><h2>Work in progress</h2></header>
      {error && <p role="alert">Could not refresh task status: {error}</p>}
      <div className="workspace-dashboard-grid">
        <div className="workspace-dashboard-summary"><span>Running</span><strong>{snapshot?.runningTasks ?? "—"}</strong></div>
        <div className="workspace-dashboard-summary"><span>Queued tasks</span><strong>{snapshot?.pendingTasks ?? "—"}</strong></div>
        {running.map(task => <RunningTaskCard key={task.sessionId} task={task} now={now} onOpenTask={onOpenTask} />)}
      </div>
      {snapshot && running.length === 0 && <p className="workspace-dashboard-empty">No tasks running right now.</p>}
      {!snapshot && !error && <p className="workspace-dashboard-empty">Loading workspace tasks…</p>}
    </div>
  </section>;
}

export function WorkspaceManagerFollowUp({ manager, onChanged, onReset }: {
  manager: WorkspaceManagerRecord | null; onChanged: () => void;
  onReset: (manager: WorkspaceManagerRecord) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!manager) return null;
  return <div className="workspace-manager-follow-up">
    <button type="button" className="ghost-icon" disabled={busy}
      title={manager.notificationsEnabled ? "Pause automatic follow-up" : "Resume automatic follow-up"}
      aria-label={manager.notificationsEnabled ? "Pause automatic follow-up" : "Resume automatic follow-up"}
      onClick={async () => {
        setBusy(true); setError("");
        try { await apiJson("/api/workspace-manager", { method: "POST", body: { workspaceId: manager.workspaceId, notificationsEnabled: !manager.notificationsEnabled } }); onChanged(); }
        catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setBusy(false); }
      }}>{manager.notificationsEnabled ? <Pause /> : <Play />}</button>
    <button type="button" className="workspace-manager-reset" disabled={busy}
      title="Start a fresh manager and archive this session"
      aria-label="Clear manager session"
      onClick={async () => {
        setBusy(true); setError("");
        try { await onReset(manager); onChanged(); }
        catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setBusy(false); }
      }}><RotateCcw aria-hidden="true" /><span>Clear</span></button>
    {!manager.notificationsEnabled && <small>Follow-up paused</small>}
    {error && <small role="alert">{error}</small>}
  </div>;
}

export function WorkspaceManagerApprovals({ state, ApprovalEvent, onChanged }: {
  state: ManagerState | null;
  ApprovalEvent: ComponentType<{ item: ApprovalItem; onDecisionSubmitted?: (id: string) => void }>;
  onChanged: () => void;
}) {
  return <>{state?.approvals.filter(item => item.sessionId !== state.manager?.sessionId).map(approval =>
    <section className="workspace-manager-question" key={approval.approvalId}>
      <strong>{approval.title}</strong>
      <ApprovalEvent item={{ ...approval, id: `approval:${approval.approvalId}`, eventType: "item.started", itemType: "approval", status: "pending" }} onDecisionSubmitted={onChanged} />
    </section>)}</>;
}
