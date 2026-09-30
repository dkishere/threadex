import { ArrowLeft, ArrowUpRight, CheckCircle2, ChevronDown, Clock3, Cpu, ExternalLink, FileDiff, Files, Flame, Gauge, GitFork, ListOrdered, Loader2, MessageCircle, MessageSquareText, Pause, Play, Repeat2, RotateCcw, Sigma, Square } from "lucide-react";
import { TerminalSquare, Wrench } from "lucide-react";
import { createContext, memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type ComponentType, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceManagerLineCounts, WorkspaceManagerQueuedPrompt, WorkspaceManagerRecord, WorkspaceManagerSnapshot, WorkspaceManagerTask, WorkspaceManagerTaskComment } from "../workspaceManager";
import type { LiveItem } from "./appTypes";
import { apiJson } from "./apiClient";
import { workspaceManagerSessionUrl } from "./navigation";
import "./WorkspaceManagerPanel.css";

type ApprovalItem = Extract<LiveItem, { itemType: "approval" }>;
type ManagerState = {
  manager: (WorkspaceManagerRecord & { backgroundUpdateStatus: "queued" | "running" | null }) | null;
  workspaceName: string;
  approvals: Array<Omit<ApprovalItem, "id" | "eventType" | "itemType" | "status"> & { title: string }>;
};

/** A workspace view around the normal session renderer, independent of session identity. */
export const WorkspaceManagerDisplayContext = createContext(false);

export function WorkspaceManagerView(props: ComponentProps<"section">) {
  return <WorkspaceManagerDisplayContext.Provider value={true}>
    <section {...props} data-workspace-manager="true" aria-label="Workspace manager chat" />
  </WorkspaceManagerDisplayContext.Provider>;
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

function workspaceTaskCompletedTime(completedAt: string | null | undefined): string {
  if (!completedAt) return "Unavailable";
  const timestamp = Date.parse(completedAt);
  if (!Number.isFinite(timestamp)) return "Unavailable";
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function workspaceTaskLines(lines: WorkspaceManagerLineCounts | null | undefined): string {
  return lines ? `+${lines.additions.toLocaleString()} −${lines.deletions.toLocaleString()}` : "—";
}

function taskActivityPresentation(task: WorkspaceManagerTask, now: number) {
  const activity = task.activity;
  const timestamp = activity ? Date.parse(activity.updatedAt) : NaN;
  const age = Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : null;
  const recent = age !== null && age < 15000;
  const kind = activity?.kind ?? "unknown";
  const label = !activity ? "Activity unavailable"
    : kind === "thinking" ? (activity.completed ? "Thinking ended" : "Thinking")
    : kind === "command" ? (activity.completed ? "Command finished" : "Local command")
    : kind === "tool" ? (activity.completed ? "Tool finished" : "Tool call")
    : kind === "text" ? (recent ? "Text updated" : "Last: text") : "Progress updated";
  const quiet = age !== null && age >= 60000;
  const description = `${!recent && activity && kind !== "text" ? `Last: ${label.toLowerCase()}` : label}${quiet ? `. No activity update for ${workspaceTaskElapsed(activity!.updatedAt, now)}` : ""}. Latest recorded activity; refreshed every 5 seconds. Commentary may appear only when complete, and some MCP/wrapped commands do not expose activity items. Silence does not mean stuck; commands can run without output.`;
  const Icon = kind === "thinking" ? Cpu : kind === "command" ? TerminalSquare
    : kind === "tool" ? Wrench : kind === "text" ? MessageSquareText : kind === "progress" ? Gauge : Clock3;
  return { kind, description, Icon };
}

function TaskActivity({ task, now }: { task: WorkspaceManagerTask; now: number }) {
  const { kind, description, Icon } = taskActivityPresentation(task, now);
  return <span className="workspace-task-activity" data-kind={kind} role="img" aria-label={description} title={description}>
    <Icon aria-hidden="true" />
  </span>;
}

const WorkspaceTokenChart = memo(function WorkspaceTokenChart({ activity }: { activity: WorkspaceManagerSnapshot["tokenActivity"] }) {
  const minute = activity ? Math.floor(Date.parse(activity.capturedAt) / 60000) * 60000 : NaN;
  const samples = new Map(activity?.minutes.map(item => [Date.parse(item.minute), item.tokens]));
  const columns = Array.from({ length: 120 }, (_, index) => {
    const timestamp = minute - (119 - index) * 60000;
    const tokens = samples.get(timestamp);
    return { timestamp, tokens, label: Number.isFinite(timestamp)
      ? new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—" };
  });
  const scale = Math.max(1000, ...columns.map(item => item.tokens ?? 0));
  const description = `Workspace reported output tokens, including completed threads. 120 one-minute buckets covering the last two hours, oldest on left; last bucket is partial. Bar heights share an automatic scale. No sample does not mean zero output. Reports can arrive in batches, not at token generation time. ${activity ? `Snapshot: ${new Date(activity.capturedAt).toLocaleString()}.` : "Snapshot unavailable."} ${columns.map(item => `${item.label}: ${item.tokens === undefined ? "no sample" : item.tokens.toLocaleString()}`).join("; ")}`;
  return <section className="workspace-token-chart" aria-label="Workspace output tokens" title={description}>
    <div className="workspace-token-columns" role="img" aria-label={description}>
      {columns.map(({ tokens, label }, index) => <div className="workspace-token-column" key={index}
        title={`${label}${index === 119 ? " (partial minute)" : ""}: ${tokens === undefined ? "no sample" : `${tokens.toLocaleString()} reported output tokens`}`}>
        <div className="workspace-token-bar-track"><div className="workspace-token-bar" style={{ height: `${(tokens ?? 0) / scale * 100}%` }} /></div>
      </div>)}
    </div>
  </section>;
});

function RunningTaskCard({ task, now, onOpenTask, onStopTask, stopping, globalLoopEnabled, onToggleLoopMode, loopSaving,
  workspaceId, forkQueuedPrompt, forkingTurnIds, forkErrors }: {
  task: WorkspaceManagerTask; now: number; onOpenTask: (sessionId: string) => void;
  onStopTask: (sessionId: string) => void; stopping: boolean; globalLoopEnabled: boolean;
  onToggleLoopMode: (sessionId: string, enabled: boolean) => void; loopSaving: boolean;
  workspaceId: string | undefined; forkQueuedPrompt: (sessionId: string, turnId: string) => Promise<boolean>;
  forkingTurnIds: Set<string>; forkErrors: Record<string, string>;
}) {
  const metrics = [
    { label: "Running", value: workspaceTaskElapsed(task.runningSince, now), icon: Clock3 },
    { label: "Turn", value: task.turnNumber ? `#${task.turnNumber}` : "Unavailable", icon: Repeat2 },
    { label: "Files updated", value: task.updatedFiles == null ? "Unavailable" : String(task.updatedFiles), icon: Files },
    { label: "Current turn lines", scope: "Turn", value: workspaceTaskLines(task.currentTurnLines), lines: task.currentTurnLines, icon: FileDiff,
      description: task.currentTurnLines ? "Added / deleted lines in this turn's latest saved diff."
        : "Unavailable: this turn's complete saved diff is missing." },
    { label: "Whole session lines", scope: "Session", value: workspaceTaskLines(task.sessionLines), lines: task.sessionLines, icon: Sigma,
      description: task.sessionLines ? "Added / deleted lines summed once per turn, including the current turn. Repeated edits in different turns count again."
        : "Unavailable: a turn's complete saved diff is missing; no partial total is shown." },
    { label: "Model", value: task.runningModel || "Awaiting model", icon: Cpu },
    { label: "Context", value: task.contextPercent == null ? "Unavailable" : `${task.contextPercent}%`, icon: Gauge }
  ];
  return <article className="workspace-task-card" data-session-id={task.sessionId}>
    <div className="workspace-task-heading">
      <button type="button" className="workspace-task-title" title={task.title} onClick={() => onOpenTask(task.sessionId)}>
        <span>{task.title}</span><ArrowUpRight className="workspace-task-open" aria-hidden="true" />
      </button>
      <div className="workspace-task-actions">
        <WorkspaceTaskLoopToggle task={task} globalLoopEnabled={globalLoopEnabled} saving={loopSaving} onToggle={onToggleLoopMode} />
        <button type="button" className="workspace-task-stop" data-task-session-id={task.sessionId}
          aria-label={`Stop ${task.title} and cancel queued turns`} title="Stop this task and cancel its queued turns"
          disabled={stopping} onClick={() => onStopTask(task.sessionId)}>
          {stopping ? <Loader2 className="spin" aria-hidden="true" /> : <Square aria-hidden="true" />}<span>{stopping ? "Stopping" : "Stop"}</span>
        </button>
      </div>
    </div>
    <dl className="workspace-task-metrics">{metrics.map(({ label, scope, value, lines, description, icon: Icon }) =>
      <div className="workspace-task-metric" data-metric={label} key={label} title={`${label}: ${value}${description ? `. ${description}` : ""}`}>
        <dt><Icon aria-hidden="true" />{scope && <span className="workspace-task-metric-scope" aria-hidden="true">{scope}</span>}<span className="workspace-task-sr-only">{label}</span></dt>
        <dd>{lines ? <><span className="workspace-task-lines-added">+{lines.additions.toLocaleString()}</span>{" "}<span className="workspace-task-lines-deleted">−{lines.deletions.toLocaleString()}</span></> : value}</dd>
      </div>)}</dl>
    <div className="workspace-task-request-row">
      <WorkspaceTaskPrompt prompt={task.requestPrompt} label="Current request" />
      <WorkspaceTaskQueuedPrompts count={task.queuedTurns ?? 0} prompts={task.queuedPrompts ?? []} title={task.title}
        sessionId={task.sessionId} workspaceId={workspaceId} onForkPrompt={forkQueuedPrompt}
        forkingTurnIds={forkingTurnIds} forkErrors={forkErrors} />
    </div>
    <div className="workspace-task-activity-comment">
      <WorkspaceTaskComments title={task.title} comments={task.comments ?? []} activity={{ task, now }} />
    </div>
  </article>;
}

function RecentCompletedTaskCard({ task, onOpenTask, globalLoopEnabled, onToggleLoopMode, loopSaving }: {
  task: WorkspaceManagerTask; onOpenTask: (sessionId: string) => void; globalLoopEnabled: boolean;
  onToggleLoopMode: (sessionId: string, enabled: boolean) => void; loopSaving: boolean;
}) {
  const completedTime = workspaceTaskCompletedTime(task.completedAt);
  return <article className="workspace-task-card workspace-task-card--completed" data-session-id={task.sessionId}>
    <div className="workspace-task-heading">
      <span className="workspace-task-status-dot workspace-task-status-dot--completed" role="img"
        aria-label="Recently completed task" title="Recently completed task" />
      <button type="button" className="workspace-task-title" title={task.title} onClick={() => onOpenTask(task.sessionId)}>
        <span>{task.title}</span><ArrowUpRight className="workspace-task-open" aria-hidden="true" />
      </button>
      <div className="workspace-task-actions">
        <WorkspaceTaskLoopToggle task={task} globalLoopEnabled={globalLoopEnabled} saving={loopSaving} onToggle={onToggleLoopMode} />
      </div>
    </div>
    <div className="workspace-task-completed-meta" title={`Completed ${completedTime}`}>
      <CheckCircle2 aria-hidden="true" /><span>Completed {completedTime}</span>
    </div>
    <WorkspaceTaskPrompt prompt={task.requestPrompt} label="Last request" />
    <WorkspaceTaskComments title={task.title} comments={task.comments ?? []} />
  </article>;
}

function WorkspaceTaskPrompt({ prompt, label }: { prompt?: string | null; label: string }) {
  const text = prompt?.trim() || `${label} unavailable`;
  return <div className="workspace-task-prompt" title={`${label}: ${text}`} aria-label={`${label}: ${text}`}>
    <MessageCircle aria-hidden="true" /><span>{text}</span>
  </div>;
}

function WorkspaceTaskLoopToggle({ task, globalLoopEnabled, saving, onToggle }: {
  task: WorkspaceManagerTask; globalLoopEnabled: boolean; saving: boolean;
  onToggle: (sessionId: string, enabled: boolean) => void;
}) {
  if (task.status === "stopped") return null;
  const enabled = task.sessionLoopEnabled === true;
  const title = saving ? "Saving thread Loop mode"
    : globalLoopEnabled ? "Global Loop mode is on; this thread setting is preserved and disabled"
      : enabled ? "Turn off Loop mode for this thread" : "Turn on Loop mode for this thread";
  return <button type="button" className="workspace-task-loop-toggle" role="switch" aria-checked={enabled}
    aria-label={`Loop mode for ${task.title}`} title={title} data-active={enabled ? "true" : undefined}
    disabled={globalLoopEnabled || saving} aria-busy={saving}
    onClick={() => onToggle(task.sessionId, !enabled)}>
    {saving ? <Loader2 className="spin" aria-hidden="true" /> : <Repeat2 aria-hidden="true" />}
  </button>;
}

function WorkspaceTaskQueuedPrompts({ count, prompts, title, sessionId, workspaceId, onForkPrompt, forkingTurnIds, forkErrors }: {
  count: number; prompts: WorkspaceManagerQueuedPrompt[]; title: string; sessionId: string; workspaceId: string | undefined;
  onForkPrompt: (sessionId: string, turnId: string) => Promise<boolean>;
  forkingTurnIds: Set<string>; forkErrors: Record<string, string>;
}) {
  const triggerId = useId();
  const popoverId = `${triggerId}-queued-prompts`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const suppressFocusOpenRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const label = `${count} queued prompt${count === 1 ? "" : "s"}`;

  const cancelClose = () => {
    if (closeTimerRef.current !== undefined) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      if (triggerRef.current === document.activeElement || popoverRef.current?.contains(document.activeElement)) {
        closeTimerRef.current = undefined;
        return;
      }
      setOpen(false);
      closeTimerRef.current = undefined;
    }, 180);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const placePopover = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 12;
      const gap = 8;
      const width = Math.min(420, window.innerWidth - margin * 2);
      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
      const below = window.innerHeight - rect.bottom - gap - margin;
      const above = rect.top - gap - margin;
      const useBelow = below >= 200 || below >= above;
      const maxHeight = Math.min(320, window.innerHeight - margin * 2, Math.max(96, useBelow ? below : above));
      const top = useBelow
        ? Math.max(margin, Math.min(rect.bottom + gap, window.innerHeight - maxHeight - margin))
        : Math.max(margin, rect.top - gap - maxHeight);
      setPosition({ top, left, width, maxHeight });
    };
    placePopover();
    window.addEventListener("resize", placePopover);
    window.addEventListener("scroll", placePopover, true);
    return () => {
      window.removeEventListener("resize", placePopover);
      window.removeEventListener("scroll", placePopover, true);
    };
  }, [open]);

  useEffect(() => () => cancelClose(), []);
  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (triggerRef.current?.contains(target) || popoverRef.current?.contains(target))) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      suppressFocusOpenRef.current = document.activeElement !== triggerRef.current;
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return <>
    <button ref={triggerRef} id={triggerId} className="workspace-task-queued" type="button"
      aria-label={`${label}${prompts.length ? "; hover or focus to read the queued prompts." : ". No prompt details available."}`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={popoverId}
      title={prompts.length ? `View ${label}` : label} disabled={prompts.length === 0}
      onMouseEnter={() => { cancelClose(); if (prompts.length) setOpen(true); }} onMouseLeave={scheduleClose}
      onFocus={() => {
        if (suppressFocusOpenRef.current) { suppressFocusOpenRef.current = false; return; }
        cancelClose();
        if (prompts.length) setOpen(true);
      }}
      onBlur={event => {
        if (popoverRef.current?.contains(event.relatedTarget as Node | null)) return;
        scheduleClose();
      }}
      onClick={() => { cancelClose(); if (prompts.length) setOpen(true); }}
      onKeyDown={event => {
        if (event.key === "ArrowDown" && prompts.length) {
          event.preventDefault();
          setOpen(true);
          window.setTimeout(() => popoverRef.current?.focus(), 0);
        }
      }}>
      <ListOrdered aria-hidden="true" /><span>{count}</span>
    </button>
    {open && createPortal(<section ref={popoverRef} id={popoverId} className="workspace-task-queue-popover"
      role="dialog" aria-label={`Queued prompts for ${title}`} aria-labelledby={`${popoverId}-title`} tabIndex={0}
      style={position ? { top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight } : { visibility: "hidden" }}
      onMouseEnter={cancelClose} onMouseLeave={scheduleClose}
      onBlur={event => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        if (!triggerRef.current?.contains(event.relatedTarget as Node | null)) scheduleClose();
      }}>
      <header className="workspace-task-queue-popover-heading">
        <strong id={`${popoverId}-title`}>Queued prompts</strong><span>{count}</span>
      </header>
      <div className="workspace-task-queue-list">
        {prompts.map(prompt => <article className="workspace-task-queue-item" key={prompt.id}>
          <p>{prompt.prompt}</p>
          {prompt.steerPending && <small>Steer pending; Fork becomes available if delivery fails.</small>}
          <button type="button" className="workspace-task-queue-fork" aria-label={`Fork queued prompt: ${prompt.prompt}`}
            title={prompt.steerPending ? "Wait for Steer delivery to fail before forking this prompt" : "Prepare this prompt in a temporary Luna session and create a new task"}
            disabled={!workspaceId || prompt.steerPending || forkingTurnIds.has(prompt.id)} aria-busy={forkingTurnIds.has(prompt.id)}
            onClick={async event => {
              event.stopPropagation();
              if (await onForkPrompt(sessionId, prompt.id)) setOpen(false);
            }}>
            {forkingTurnIds.has(prompt.id) ? <Loader2 className="spin" aria-hidden="true" /> : <GitFork aria-hidden="true" />}
            <span>{forkingTurnIds.has(prompt.id) ? "Preparing" : "Fork"}</span>
          </button>
          {forkErrors[prompt.id] && <p className="workspace-task-queue-fork-error" role="alert">Fork failed: {forkErrors[prompt.id]}</p>}
        </article>)}
      </div>
    </section>, document.body)}
  </>;
}

function WorkspaceTaskComments({ title, comments, activity }: {
  title: string; comments: WorkspaceManagerTaskComment[]; activity?: { task: WorkspaceManagerTask; now: number };
}) {
  const triggerId = useId();
  const popoverId = `${triggerId}-comments`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const suppressFocusOpenRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const latest = comments[comments.length - 1];

  const cancelClose = () => {
    if (closeTimerRef.current !== undefined) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      if (triggerRef.current === document.activeElement || popoverRef.current?.contains(document.activeElement)) {
        closeTimerRef.current = undefined;
        return;
      }
      setOpen(false);
      closeTimerRef.current = undefined;
    }, 180);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const placePopover = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 12;
      const gap = 8;
      const width = Math.min(420, window.innerWidth - margin * 2);
      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
      const below = window.innerHeight - rect.bottom - gap - margin;
      const above = rect.top - gap - margin;
      const useBelow = below >= 200 || below >= above;
      const maxHeight = Math.min(320, window.innerHeight - margin * 2, Math.max(96, useBelow ? below : above));
      const top = useBelow
        ? Math.max(margin, Math.min(rect.bottom + gap, window.innerHeight - maxHeight - margin))
        : Math.max(margin, rect.top - gap - maxHeight);
      setPosition({ top, left, width, maxHeight });
    };
    placePopover();
    window.addEventListener("resize", placePopover);
    window.addEventListener("scroll", placePopover, true);
    return () => {
      window.removeEventListener("resize", placePopover);
      window.removeEventListener("scroll", placePopover, true);
    };
  }, [open]);

  useEffect(() => () => cancelClose(), []);
  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (triggerRef.current?.contains(target) || popoverRef.current?.contains(target))) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      suppressFocusOpenRef.current = document.activeElement !== triggerRef.current;
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  if (!latest) return activity ? <TaskActivity {...activity} /> : null;
  const orderedComments = [...comments].reverse();
  return <>
    <button ref={triggerRef} id={triggerId} className="workspace-task-comment" type="button"
      aria-label={`${activity ? `${taskActivityPresentation(activity.task, activity.now).description} ` : ""}Latest comment: ${latest.summary}. ${comments.length} comments; hover or focus to read all.`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={popoverId} title={latest.summary}
      onMouseEnter={() => { cancelClose(); setOpen(true); }} onMouseLeave={scheduleClose}
      onFocus={() => {
        if (suppressFocusOpenRef.current) { suppressFocusOpenRef.current = false; return; }
        cancelClose();
        setOpen(true);
      }}
      onBlur={event => {
        if (popoverRef.current?.contains(event.relatedTarget as Node | null)) return;
        scheduleClose();
      }}
      onClick={() => { cancelClose(); setOpen(true); }}
      onKeyDown={event => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setOpen(true);
          window.setTimeout(() => popoverRef.current?.focus(), 0);
        }
      }}>
      {activity ? <TaskActivity {...activity} /> : <MessageSquareText aria-hidden="true" />}<span>{latest.summary}</span>
    </button>
    {open && createPortal(<section ref={popoverRef} id={popoverId} className="workspace-task-comment-popover"
      role="dialog" aria-label={`Comments for ${title}`} aria-labelledby={`${popoverId}-title`} tabIndex={0}
      style={position ? { top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight } : { visibility: "hidden" }}
      onMouseEnter={cancelClose} onMouseLeave={scheduleClose}
      onBlur={event => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        if (!triggerRef.current?.contains(event.relatedTarget as Node | null)) scheduleClose();
      }}>
      <header className="workspace-task-comment-popover-heading">
        <strong id={`${popoverId}-title`}>Comments</strong><span>{comments.length}</span>
      </header>
      <div className="workspace-task-comment-list">
        {orderedComments.map(comment => <details className="workspace-task-comment-item" key={comment.id}>
          <summary className="workspace-task-comment-summary">
            <span>{comment.summary || "Comment"}</span><ChevronDown aria-hidden="true" />
          </summary>
          <p>{comment.detail}</p>
        </details>)}
      </div>
    </section>, document.body)}
  </>;
}

export function WorkspaceManagerDashboard({ hidden, workspaceId, onOpenTask }: {
  hidden: boolean; workspaceId: string | undefined; onOpenTask: (sessionId: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<WorkspaceManagerSnapshot | null>(null);
  const [error, setError] = useState("");
  const [stopError, setStopError] = useState("");
  const [stoppingTaskIds, setStoppingTaskIds] = useState<Set<string>>(() => new Set());
  const [loopError, setLoopError] = useState("");
  const [loopSavingTaskIds, setLoopSavingTaskIds] = useState<Set<string>>(() => new Set());
  const [forkingTurnIds, setForkingTurnIds] = useState<Set<string>>(() => new Set());
  const [forkErrors, setForkErrors] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (hidden || !workspaceId) return;
    const controller = new AbortController();
    let fetching = false;
    const read = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const next = await apiJson<WorkspaceManagerSnapshot>(`/api/workspace-manager?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setSnapshot(next); setError(""); }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      } finally { fetching = false; }
    };
    setSnapshot(null);
    void read();
    const refresh = window.setInterval(() => void read(), 5000);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { controller.abort(); window.clearInterval(refresh); window.clearInterval(clock); };
  }, [hidden, workspaceId]);
  const running = snapshot?.tasks.filter(task => task.status === "running") ?? [];
  const recentCompleted = snapshot?.recentCompletedTasks ?? [];
  const stopTask = useCallback(async (sessionId: string) => {
    const managerSessionId = snapshot?.manager?.sessionId;
    if (!managerSessionId || stoppingTaskIds.has(sessionId)) return;
    setStoppingTaskIds(current => new Set(current).add(sessionId));
    setStopError("");
    try {
      await apiJson(`/api/workspace-manager/${encodeURIComponent(managerSessionId)}/action`, {
        method: "POST", body: { action: "stop", sessionId }
      });
      setSnapshot(current => current ? {
        ...current,
        tasks: current.tasks.map(task => task.sessionId === sessionId
          ? { ...task, status: "stopped", pendingReason: "stopped" }
          : task)
      } : current);
    } catch (cause) {
      setStopError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStoppingTaskIds(current => {
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
    }
  }, [snapshot?.manager?.sessionId, stoppingTaskIds]);
  const toggleTaskLoopMode = useCallback(async (sessionId: string, enabled: boolean) => {
    if (!workspaceId || snapshot?.globalLoopEnabled || loopSavingTaskIds.has(sessionId)) return;
    setLoopSavingTaskIds(current => new Set(current).add(sessionId));
    setLoopError("");
    try {
      const result = await apiJson<{ enabled: boolean }>(`/api/workspace-manager/tasks/${encodeURIComponent(sessionId)}/loop-mode`, {
        method: "PUT", body: { workspaceId, enabled }
      });
      setSnapshot(current => current ? {
        ...current,
        tasks: current.tasks.map(task => task.sessionId === sessionId ? { ...task, sessionLoopEnabled: result.enabled } : task),
        recentCompletedTasks: current.recentCompletedTasks?.map(task => task.sessionId === sessionId
          ? { ...task, sessionLoopEnabled: result.enabled } : task)
      } : current);
    } catch (cause) {
      setLoopError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoopSavingTaskIds(current => {
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
    }
  }, [loopSavingTaskIds, snapshot?.globalLoopEnabled, workspaceId]);
  const forkQueuedPrompt = useCallback(async (sessionId: string, turnId: string) => {
    if (!workspaceId || forkingTurnIds.has(turnId)) return false;
    setForkingTurnIds(current => new Set(current).add(turnId));
    setForkErrors(current => { const next = { ...current }; delete next[turnId]; return next; });
    try {
      await apiJson(`/api/workspace-manager/tasks/${encodeURIComponent(sessionId)}/queued-prompts/${encodeURIComponent(turnId)}/fork`, {
        method: "POST", body: { workspaceId }
      });
      setSnapshot(current => current ? {
        ...current,
        pendingTasks: Math.max(0, current.pendingTasks - 1),
        tasks: current.tasks.map(task => task.sessionId === sessionId ? {
          ...task,
          queuedTurns: Math.max(0, (task.queuedTurns ?? 0) - 1),
          queuedPrompts: (task.queuedPrompts ?? []).filter(prompt => prompt.id !== turnId)
        } : task)
      } : current);
      return true;
    } catch (cause) {
      setForkErrors(current => ({ ...current, [turnId]: cause instanceof Error ? cause.message : String(cause) }));
      return false;
    } finally {
      setForkingTurnIds(current => { const next = new Set(current); next.delete(turnId); return next; });
    }
  }, [forkingTurnIds, workspaceId]);
  return <section className="workspace-manager-dashboard" id="session-panel-dashboard" aria-label="Workspace dashboard" hidden={hidden}>
    <div className="workspace-dashboard-content">
      <WorkspaceTokenChart activity={snapshot?.tokenActivity} />
      {error && <p role="alert">Could not refresh task status: {error}</p>}
      <div className="workspace-dashboard-grid">
        <div className="workspace-dashboard-summary"><span>Running</span><strong>{snapshot?.runningTasks ?? "—"}</strong></div>
        <div className="workspace-dashboard-summary"><span>Queued tasks</span><strong>{snapshot?.pendingTasks ?? "—"}</strong></div>
        {running.map(task => <RunningTaskCard key={task.sessionId} task={task} now={now} onOpenTask={onOpenTask}
          onStopTask={stopTask} stopping={stoppingTaskIds.has(task.sessionId)}
          globalLoopEnabled={snapshot?.globalLoopEnabled === true} onToggleLoopMode={toggleTaskLoopMode}
          loopSaving={loopSavingTaskIds.has(task.sessionId)} workspaceId={workspaceId}
          forkQueuedPrompt={forkQueuedPrompt} forkingTurnIds={forkingTurnIds} forkErrors={forkErrors} />)}
      </div>
      {stopError && <p className="workspace-dashboard-error" role="alert">Could not stop task: {stopError}</p>}
      {loopError && <p className="workspace-dashboard-error" role="alert">Could not change thread Loop mode: {loopError}</p>}
      {snapshot && running.length === 0 && <p className="workspace-dashboard-empty">No tasks running right now.</p>}
      {recentCompleted.length > 0 && <section className="workspace-dashboard-recent" aria-labelledby="workspace-recent-title">
        <header><h3 id="workspace-recent-title">Recently completed</h3><span>Last 120 minutes</span></header>
        <div className="workspace-dashboard-grid">
          {recentCompleted.map(task => <RecentCompletedTaskCard key={task.sessionId} task={task} onOpenTask={onOpenTask}
            globalLoopEnabled={snapshot?.globalLoopEnabled === true} onToggleLoopMode={toggleTaskLoopMode}
            loopSaving={loopSavingTaskIds.has(task.sessionId)} />)}
        </div>
      </section>}
      {!snapshot && !error && <p className="workspace-dashboard-empty">Loading workspace tasks…</p>}
    </div>
  </section>;
}

function followManagerSessionLink(event: MouseEvent<HTMLAnchorElement>, onNavigate: () => void) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  onNavigate();
}

export function WorkspaceManagerReturnLink({ manager, onNavigate }: {
  manager: WorkspaceManagerRecord; onNavigate: () => void;
}) {
  return <a className="workspace-manager-session-link" href={workspaceManagerSessionUrl(manager, "manager", window.location.href)}
    aria-label="Back to Manager" title="Back to Manager" onClick={event => followManagerSessionLink(event, onNavigate)}>
    <ArrowLeft aria-hidden="true" /><span>Back to Manager</span>
  </a>;
}

export function WorkspaceManagerBackgroundUpdateIndicator({ status }: {
  status: "queued" | "running" | null;
}) {
  if (!status) return null;
  const label = status === "running" ? "Processing background update…" : "Background update queued…";
  return <small className="workspace-manager-background-update" role="status" aria-live="polite" aria-label={label} title={label}>
    <Loader2 className="spin" aria-hidden="true" />
    {label}
  </small>;
}

export function WorkspaceManagerFollowUp({ manager, onChanged, onReset, onOpenRaw }: {
  manager: (WorkspaceManagerRecord & { backgroundUpdateStatus: "queued" | "running" | null }) | null; onChanged: () => void;
  onReset: (manager: WorkspaceManagerRecord) => Promise<void>;
  onOpenRaw: (manager: WorkspaceManagerRecord) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!manager) return null;
  return <div className="workspace-manager-follow-up">
    <a className="workspace-manager-session-link" href={workspaceManagerSessionUrl(manager, "raw", window.location.href)}
      aria-label="Open raw manager session" title="Open raw manager session"
      onClick={event => followManagerSessionLink(event, () => onOpenRaw(manager))}>
      <ExternalLink aria-hidden="true" /><span>Raw session</span>
    </a>
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
