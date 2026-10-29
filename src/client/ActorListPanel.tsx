import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { ChevronRight, Loader2, Users } from "lucide-react";
import { actorProjectGroups, UNASSIGNED_ACTOR_PROJECT, type ActorProjectGroup, type ActorSummary, type ActorSummaryEntry } from "../domainActors";
import { apiJson } from "./apiClient";
import { actorWorkloadBadge } from "./actorRoomPresentation";
import { actorBlockers, blockerCountLabel, blockerCounts, type ActorBlockerView } from "./actorBlockerPresentation";
import { DomainActorIdentity } from "./DomainActorIdentity";
import { useUnseenBlockers } from "./blockerAcknowledgement";
import { ACTOR_ROOM_CHANGED, isAuthRequired } from "./actorRoomState";
import "./ActorListPanel.css";
import { ACTOR_TYPE_LABELS } from "../actorTypes";

export type SidebarView = "actors" | "sessions";
const sidebarViewKey = (workspaceId: string) => `threadex.sidebarView:${workspaceId}`;

export function readSidebarView(workspaceId: string): SidebarView | null {
  try {
    const value = sessionStorage.getItem(sidebarViewKey(workspaceId));
    return value === "actors" || value === "sessions" ? value : null;
  } catch { return null; }
}

export function writeSidebarView(workspaceId: string, view: SidebarView): void {
  try { sessionStorage.setItem(sidebarViewKey(workspaceId), view); } catch { /* The in-memory selection still applies. */ }
}

export function defaultSidebarView(summary: ActorSummary | null): SidebarView {
  return summary?.actors.length ? "actors" : "sessions";
}

type SummaryState = { workspaceId: string; summary: ActorSummary | null; error: string | null; authRequired: boolean };

/** Polls the lightweight actor summary (never the full room) every 5s. */
export function useDomainActorSummary(workspaceId: string | undefined) {
  const [state, setState] = useState<SummaryState | null>(null);
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
        const next = await apiJson<ActorSummary>(`/api/domain-actors/${encodeURIComponent(workspaceId)}/actors/summary`, { fresh: true, signal: controller.signal });
        if (!controller.signal.aborted) setState(current => {
          const previous = current?.workspaceId === workspaceId ? current.summary : null;
          return { workspaceId, summary: !previous || next.revision >= previous.revision ? next : previous, error: null, authRequired: false };
        });
      } catch (cause) {
        if (!controller.signal.aborted) setState(current => ({
          workspaceId, summary: current?.workspaceId === workspaceId ? current.summary : null,
          error: cause instanceof Error ? cause.message : String(cause), authRequired: isAuthRequired(cause)
        }));
      } finally { fetching = false; }
    };
    void read();
    const timer = window.setInterval(() => void read(), 5000);
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ workspaceId: string }>).detail.workspaceId === workspaceId) refresh();
    };
    window.addEventListener(ACTOR_ROOM_CHANGED, changed);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener(ACTOR_ROOM_CHANGED, changed); };
  }, [workspaceId, revision]);
  const current = state && state.workspaceId === workspaceId ? state : null;
  return { summary: current?.summary ?? null, error: current?.error ?? null, authRequired: current?.authRequired ?? false, refresh };
}

function moveTabFocus(event: KeyboardEvent<HTMLButtonElement>) {
  const tabs = Array.from(event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
  const index = tabs.indexOf(event.currentTarget);
  const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
    : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
  if (next >= 0) { event.preventDefault(); tabs[next].focus(); tabs[next].click(); }
}

export function SidebarViewTabs({ value, onChange, runningActors = 0, runningSessions = 0 }: {
  value: SidebarView; onChange: (view: SidebarView) => void; runningActors?: number; runningSessions?: number;
}) {
  const tabs: Array<[SidebarView, string]> = [["actors", ACTOR_TYPE_LABELS.worker], ["sessions", "Sessions"]];
  const running = { actors: runningActors, sessions: runningSessions };
  return <div className="sidebar-view-tabs" role="tablist" aria-label="Sidebar views">
    {tabs.map(([view, label]) => <button key={view} type="button" role="tab" id={`sidebar-tab-${view}`} aria-selected={value === view}
      aria-controls={`sidebar-panel-${view}`} tabIndex={value === view ? 0 : -1} onClick={() => onChange(view)} onKeyDown={moveTabFocus}>
      {label}
      {running[view] > 0 && <>{" "}<span className="actor-list-running sidebar-view-running" role="img" aria-label={`${running[view]} running`} title={`${running[view]} running`}>
        <Loader2 className="spin" aria-hidden="true" /><span aria-hidden="true">{running[view]}</span>
      </span></>}
    </button>)}
  </div>;
}

/** Hover summary for the blocker badge: the count, then each blocker with its task. */
function blockerBadgeTitle(blockers: ActorBlockerView[]) {
  return [`${blockerCountLabel(blockerCounts(blockers))} not yet viewed`,
    ...blockers.map(blocker => `• ${blocker.description}${blocker.taskSessionId ? ` — ${blocker.taskSessionTitle || blocker.taskSessionId}` : ""}`),
    "Click to view blockers"].join("\n");
}

function ActorRow({ actor, sub, selected, blockers, onSelect, onOpenBlockers }: {
  actor: ActorSummaryEntry; sub: boolean; selected: boolean; blockers: ActorBlockerView[]; onSelect: (id: string) => void;
  onOpenBlockers: (id: string) => void;
}) {
  const badge = actorWorkloadBadge(actor.counts);
  const counts = blockerCounts(blockers);
  return <div className="actor-list-entry" data-has-blocker={counts.active > 0 || undefined}>
    <button type="button" className="actor-list-row" data-actor-id={actor.id} data-sub={sub || undefined}
    aria-current={selected ? "true" : undefined} onClick={() => onSelect(actor.id)}>
    <DomainActorIdentity actor={actor} detail={sub ? "Sub-worker" : "Worker"} />
    <span className="actor-list-badges">
      <span className="actor-list-badge" data-kind="open">{badge.open}</span>
      {badge.attention && <span className="actor-list-badge" data-kind="attention">{badge.attention}</span>}
      {!!actor.unreadConclusions && <span className="actor-list-badge" data-kind="conclusion"
        aria-label={`${actor.unreadConclusions} unacknowledged conclusions`} title="Open this actor's timeline to read and acknowledge">
        Conclusions {actor.unreadConclusions}
      </span>}
      {actor.running > 0 && <span className="actor-list-running" role="img" aria-label={`${actor.running} running`} title={`${actor.running} running`}>
        <Loader2 className="spin" aria-hidden="true" /><span aria-hidden="true">{actor.running}</span>
      </span>}
    </span>
    </button>
    {counts.active > 0 && <button type="button" className="actor-list-badge" data-kind="blocker" data-actor-id={actor.id} data-escalated={counts.escalated > 0 || undefined}
      aria-label={`${blockerCountLabel(counts)} not yet viewed. View ${actor.name} blockers`} title={blockerBadgeTitle(blockers)} onClick={() => onOpenBlockers(actor.id)}>
      Blocked {counts.active}
    </button>}
  </div>;
}

/** Server groups when present; if the project registry could not be read, the same shared helper over the
 * workers' own project IDs (no registry names), so no worker silently disappears. */
export function workerProjectGroups(summary: ActorSummary | null): ActorProjectGroup[] {
  const workers = (summary?.actors ?? []).filter(actor => (actor.type ?? "worker") === "worker");
  return summary?.groups ?? actorProjectGroups(workers, []);
}

/** Running work of a group: each worker in the group's trees counts once (a sub-actor is not added to its root). */
export function groupRunningCount(group: ActorProjectGroup, actors: readonly ActorSummaryEntry[]) {
  const roots = new Set(group.actorIds);
  return actors.filter(actor => roots.has(actor.rootActorId) || roots.has(actor.id)).reduce((total, actor) => total + (actor.running || 0), 0);
}

const collapsedKey = (workspaceId: string) => `threadex.actorGroupsCollapsed:${workspaceId}`;
function readCollapsed(workspaceId: string | undefined): string[] {
  if (!workspaceId) return [];
  try { const value = JSON.parse(sessionStorage.getItem(collapsedKey(workspaceId)) ?? "[]"); return Array.isArray(value) ? value.filter(item => typeof item === "string") : []; }
  catch { return []; }
}

function RunningBadge({ count }: { count: number }) {
  return count > 0 ? <span className="actor-list-running" role="img" aria-label={`${count} running`} title={`${count} running`}>
    <Loader2 className="spin" aria-hidden="true" /><span aria-hidden="true">{count}</span>
  </span> : null;
}

export function ActorListPanel({ summary, error, authRequired, selectedActorId, roomSelected = false, roomChatKey = UNASSIGNED_ACTOR_PROJECT, onSelectActor, onOpenActorBlockers, onOpenRoom, id = "sidebar-panel-actors" }: {
  summary: ActorSummary | null; error: string | null; authRequired: boolean; selectedActorId: string | null; roomSelected?: boolean;
  /** Group chat currently open (with `roomSelected`). */
  roomChatKey?: string;
  onSelectActor: (actorId: string) => void; onOpenActorBlockers: (actorId: string) => void; onOpenRoom: (chatKey: string) => void; id?: string;
}) {
  // Only workers are listed here; consultants live in the session inspector and Settings.
  const actors = (summary?.actors ?? []).filter(actor => (actor.type ?? "worker") === "worker");
  const byId = new Map(actors.map(actor => [actor.id, actor]));
  const groups = workerProjectGroups(summary);
  const workspaceId = summary?.workspaceId;
  const [collapsed, setCollapsed] = useState<{ workspaceId?: string; keys: string[] }>(() => ({ workspaceId, keys: readCollapsed(workspaceId) }));
  const collapsedKeys = collapsed.workspaceId === workspaceId ? collapsed.keys : readCollapsed(workspaceId);
  function toggleGroup(key: string) {
    const keys = collapsedKeys.includes(key) ? collapsedKeys.filter(item => item !== key) : [...collapsedKeys, key];
    setCollapsed({ workspaceId, keys });
    if (workspaceId) try { sessionStorage.setItem(collapsedKey(workspaceId), JSON.stringify(keys)); } catch { /* The in-memory state still applies. */ }
  }
  // Row badges count only blockers the user has not opened since their last update; viewed ones live on in the actor's Blockers tab.
  const unseen = useUnseenBlockers();
  const blockersOf = (actorId: string) => unseen(actorBlockers(summary?.blockers, actorId));
  const domId = (key: string) => `actor-group-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  return <nav id={id} className="actor-list-panel" aria-label="Workers">
    {authRequired ? <p className="actor-list-notice" role="alert"><a href="/">Sign in to Threadex</a> to see your actors.</p>
      : error && <p className="actor-list-notice" role="alert">{error}</p>}
    {!summary && !error && <p className="actor-list-notice" role="status">Loading actors…</p>}
    {summary && !actors.length && <p className="actor-list-notice" role="status">No actors yet.</p>}
    {summary && !summary.groups && actors.length > 0 && <p className="actor-list-notice" role="status">Project names are unavailable; workers are grouped by project ID.</p>}
    {summary && groups.map(group => {
      const open = !collapsedKeys.includes(group.key);
      const roots = group.actorIds.flatMap(actorId => byId.get(actorId) ?? []);
      const running = groupRunningCount(group, actors);
      const body = `${domId(group.key)}-body`;
      return <section key={group.key} className="actor-list-group" data-group-key={group.key} data-registered={group.registered ? undefined : "false"} aria-labelledby={`${domId(group.key)}-heading`}>
        <h3 className="actor-list-group-heading" id={`${domId(group.key)}-heading`}>
          <button type="button" className="actor-list-group-toggle" aria-expanded={open} aria-controls={body} onClick={() => toggleGroup(group.key)}>
            <ChevronRight className="actor-list-group-chevron" aria-hidden="true" />
            <span className="actor-list-group-name" title={group.registered ? group.name : `${group.name} (no longer registered in this workspace)`}>{group.name}</span>
            <small>{roots.length}</small>
            <RunningBadge count={running} />
          </button>
        </h3>
        <div id={body} className="actor-list-group-body" hidden={!open}>
          <button type="button" className="actor-list-room" aria-current={roomSelected && roomChatKey === group.key ? "true" : undefined} onClick={() => onOpenRoom(group.key)}
            aria-label={`${group.name} group chat`}>
            <Users aria-hidden="true" /><span>Group chat</span><small>{group.name}</small>
          </button>
          {!roots.length && <p className="actor-list-notice actor-list-group-empty">{group.projectId === null ? "Every worker has a project." : "No workers in this project."}</p>}
          {roots.length > 0 && <ul className="actor-list-tree">
            {roots.map(root => {
              const subs = actors.filter(actor => actor.id !== root.id && actor.rootActorId === root.id);
              return <li key={root.id}>
                <ActorRow actor={root} sub={false} selected={selectedActorId === root.id} blockers={blockersOf(root.id)} onSelect={onSelectActor} onOpenBlockers={onOpenActorBlockers} />
                {subs.length > 0 && <ul className="actor-list-subs">
                  {subs.map(actor => <li key={actor.id}>
                    <ActorRow actor={actor} sub selected={selectedActorId === actor.id} blockers={blockersOf(actor.id)} onSelect={onSelectActor} onOpenBlockers={onOpenActorBlockers} />
                  </li>)}
                </ul>}
              </li>;
            })}
          </ul>}
        </div>
      </section>;
    })}
  </nav>;
}
