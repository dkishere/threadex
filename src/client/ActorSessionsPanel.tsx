import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUpRight, Clock3, Cpu, Files, Gauge } from "lucide-react";
import type { ActorRoom, ActorWorkItem, DomainActor } from "../domainActors";
import type { WorkspaceManagerSnapshot, WorkspaceManagerTask } from "../workspaceManager";
import type { SessionRecord } from "./appTypes";
import { actorOwnedSessions, actorTaskPresentation, type ActorOwnedSession } from "./actorRoomPresentation";
import { TaskActivity, workspaceTaskElapsed } from "./WorkspaceManagerPanel";
import { DomainActorIdentity } from "./DomainActorIdentity";
import { ActorBlockersPanel, useOpenBlockersRequest } from "./ActorBlockers";
import { actorBlockers } from "./actorBlockerPresentation";
import { useUnseenBlockers } from "./blockerAcknowledgement";

type ActorPanelTab = "sessions" | "blockers";
import "./ActorSessionsPanel.css";

export type ActorSessionStatusFilter = "all" | "running" | "needs_you" | "completed" | "failed";
const filterOptions: Array<[ActorSessionStatusFilter, string]> = [["all", "All"], ["running", "Running"], ["needs_you", "Needs you"], ["completed", "Completed"], ["failed", "Failed"]];
const filterStatuses: Record<Exclude<ActorSessionStatusFilter, "all">, ReadonlyArray<ActorWorkItem["status"]>> = {
  running: ["claimed", "assigned", "started"], needs_you: ["needs_user"], completed: ["completed"], failed: ["failed"]
};
const earlierLabels: Record<ActorWorkItem["status"], string> = {
  claimed: "Claimed", assigned: "Assigned", started: "Started", completed: "Completed", failed: "Failed", needs_user: "Needs your input"
};
const TITLE_LIMIT = 80;

function truncate(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > TITLE_LIMIT ? `${text.slice(0, TITLE_LIMIT - 1)}…` : text;
}

function sessionTitle(entry: ActorOwnedSession, task: WorkspaceManagerTask | undefined, session: SessionRecord | undefined, room: ActorRoom) {
  return task?.title?.trim() || session?.title?.trim() || entry.workItem.delegatedTask?.trim()
    || truncate(room.rounds.find(round => round.id === entry.workItem.roundId)?.userPrompt ?? "") || "Untitled task";
}

export function ActorSessionsPanel({ actor, room, snapshot, sessions, hidden, onOpenSession }: {
  actor: DomainActor; room: ActorRoom | null; snapshot: WorkspaceManagerSnapshot | null; sessions: SessionRecord[];
  hidden: boolean; onOpenSession: (sessionId: string) => void;
}) {
  const [filter, setFilter] = useState<ActorSessionStatusFilter>("all");
  const [tab, setTab] = useState<ActorPanelTab>("sessions");
  // Reset to Sessions only when the actor actually changes, so a re-run effect cannot undo an open-blockers request.
  const shownActor = useRef(actor.id);
  useEffect(() => {
    if (shownActor.current === actor.id) return;
    shownActor.current = actor.id;
    setTab("sessions");
  }, [actor.id]);
  // The sidebar's "Blocked N" badge opens this actor's Blockers tab (registered after the reset above).
  useOpenBlockersRequest(`actor:${actor.id}`, () => setTab("blockers"));
  const [now, setNow] = useState(() => Date.now());
  const entries = room ? actorOwnedSessions(room, actor) : [];
  const visible = filter === "all" ? entries : entries.filter(entry => filterStatuses[filter].includes(entry.status));
  const runningTasks = new Map((snapshot?.tasks ?? []).map(task => [task.sessionId, task]));
  const completedTasks = new Map((snapshot?.recentCompletedTasks ?? []).map(task => [task.sessionId, task]));
  const hasRunning = entries.some(entry => runningTasks.has(entry.sessionId));
  useEffect(() => {
    if (hidden || !hasRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hidden, hasRunning]);
  const actorName = (id: string) => room?.actors.find(candidate => candidate.id === id)?.name ?? id;
  const blockers = actorBlockers(room?.blockers, actor.id).map(blocker => ({ ...blocker,
    taskSessionTitle: sessions.find(session => session.id === blocker.taskSessionId)?.title?.trim() || undefined }));
  const unseenBlockers = useUnseenBlockers()(blockers).length;
  const blockersTab = tab === "blockers" && !hidden;
  const tabs: Array<[ActorPanelTab, string]> = [["sessions", "session-tab-actor-sessions"], ["blockers", "session-tab-actor-blockers"]];
  function moveTab(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? "sessions" : event.key === "End" ? "blockers" : tab === "sessions" ? "blockers" : "sessions";
    setTab(next);
    document.getElementById(tabs.find(([value]) => value === next)![1])?.focus();
  }
  return <section id="session-panel-actor-sessions" className="actor-sessions-panel" aria-label="Actor sessions" hidden={hidden}>
    <div className="session-view-tabs actor-sessions-tabs" role="tablist" aria-label="Actor views">
      <button type="button" role="tab" id="session-tab-actor-sessions" aria-selected={tab === "sessions"} aria-controls="actor-sessions-list"
        tabIndex={tab === "sessions" ? 0 : -1} onClick={() => setTab("sessions")} onKeyDown={moveTab}>Sessions</button>
      <button type="button" role="tab" id="session-tab-actor-blockers" aria-selected={tab === "blockers"} aria-controls="actor-blockers-list"
        tabIndex={tab === "blockers" ? 0 : -1} onClick={() => setTab("blockers")} onKeyDown={moveTab}
        aria-label={`Blockers${blockers.length ? `, ${blockers.length} active${unseenBlockers ? `, ${unseenBlockers} new` : ""}` : ""}`}>
        Blockers{unseenBlockers > 0 && <span className="actor-blockers-tab-count" aria-hidden="true">{unseenBlockers}</span>}
      </button>
    </div>
    <ActorBlockersPanel id="actor-blockers-list" labelledBy="session-tab-actor-blockers" active={blockersTab} blockers={blockers}
      actorName={actorName} actorLabel={actor.name} onOpenSession={onOpenSession} />
    {tab === "sessions" && <>
    <div className="actor-sessions-toolbar">
      <DomainActorIdentity actor={actor} />
      <select aria-label="Filter sessions" value={filter} onChange={event => setFilter(event.target.value as ActorSessionStatusFilter)}>
        {filterOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </div>
    <div id="actor-sessions-list" className="actor-sessions-list" role="tabpanel" aria-labelledby="session-tab-actor-sessions">
      {!room && <p role="status">Loading sessions…</p>}
      {room && !entries.length && <p role="status">{actor.name} has no sessions yet.</p>}
      {room && entries.length > 0 && !visible.length && <p role="status">No sessions match this filter.</p>}
      {room && visible.map(entry => {
        const running = runningTasks.get(entry.sessionId);
        const task = running ?? completedTasks.get(entry.sessionId);
        const title = sessionTitle(entry, task, sessions.find(session => session.id === entry.sessionId), room);
        const label = entry.current ? actorTaskPresentation(entry.workItem, room.events).label : earlierLabels[entry.status];
        const metrics = task ? [
          ...(running ? [{ label: "Running", value: workspaceTaskElapsed(running.runningSince, now), icon: Clock3 }] : []),
          { label: "Model", value: task.runningModel || "Unavailable", icon: Cpu },
          { label: "Context", value: task.contextPercent == null ? "Unavailable" : `${task.contextPercent}%`, icon: Gauge },
          { label: "Files updated", value: task.updatedFiles == null ? "Unavailable" : String(task.updatedFiles), icon: Files }
        ] : [];
        return <article key={entry.sessionId} className="actor-session-card workspace-task-card" data-session-id={entry.sessionId}
          data-status={entry.status} data-current={entry.current} onClick={() => onOpenSession(entry.sessionId)}>
          <div className="workspace-task-heading">
            <button type="button" className="workspace-task-title" title={title}>
              <span>{title}</span><ArrowUpRight className="workspace-task-open" aria-hidden="true" />
            </button>
            {running && <TaskActivity task={running} now={now} />}
          </div>
          <div className="actor-session-meta">
            <span className="actor-session-status" data-status={entry.status}>{label}</span>
            {entry.executorActorId !== entry.workItem.ownerActorId && <span>Executed by {actorName(entry.executorActorId)}</span>}
            {entry.executorActorId === entry.workItem.ownerActorId && entry.workItem.ownerActorId !== actor.id && <span>Owned by {actorName(entry.workItem.ownerActorId)}</span>}
            {!entry.current && <span className="actor-session-earlier">Earlier session</span>}
          </div>
          {metrics.length > 0 && <dl className="workspace-task-metrics">{metrics.map(({ label: name, value, icon: Icon }) =>
            <div className="workspace-task-metric" data-metric={name} key={name} title={`${name}: ${value}`}>
              <dt><Icon aria-hidden="true" /><span className="workspace-task-sr-only">{name}</span></dt><dd>{value}</dd>
            </div>)}</dl>}
        </article>;
      })}
    </div>
    </>}
  </section>;
}
