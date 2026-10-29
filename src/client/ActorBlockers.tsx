import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, ExternalLink, MessageSquarePlus, OctagonAlert, SquarePen, X } from "lucide-react";
import { blockerComposerText, requestBlockerComposer } from "./blockerComposer";
import { actorBlockerPendingDecision, type ActorBlocker, type ActorBlockerProposal } from "../actorBlockers";
import { apiJson } from "./apiClient";
import { notifyActorRoomChanged } from "./actorRoomState";
import { BLOCKER_ESCALATION_LABELS, BLOCKER_KIND_LABELS, BLOCKER_STATUS_LABELS, blockerCountLabel, blockerCounts, blockerProposalState, type ActorBlockerView } from "./actorBlockerPresentation";
import { markBlockersSeen, useUnseenBlockers } from "./blockerAcknowledgement";
import "./ActorBlockers.css";

type ActorName = (id: string) => string;

/** Approve or reject the proposal awaiting the user's decision; a rejection may carry a reason. */
export function BlockerDecision({ blocker, proposal, onDecided }: {
  blocker: ActorBlocker; proposal: ActorBlockerProposal; onDecided?: (blocker: ActorBlocker) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState("");
  const reasonId = useId();
  async function decide(action: "approve" | "reject") {
    if (busy) return;
    setBusy(action); setError("");
    try {
      const updated = await apiJson<ActorBlocker>(`/api/domain-actors/${encodeURIComponent(blocker.workspaceId)}/blockers/${encodeURIComponent(blocker.id)}/action`,
        { method: "POST", body: { action, proposalId: proposal.id, ...(action === "reject" && reason.trim() ? { note: reason.trim() } : {}) } });
      notifyActorRoomChanged(blocker.workspaceId);
      onDecided?.(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(null); }
  }
  return <div className="actor-blocker-decision">
    {rejecting && <label className="actor-blocker-reason" htmlFor={reasonId}>
      <span>Reason for rejecting (optional)</span>
      <textarea id={reasonId} value={reason} rows={2} disabled={busy !== null} onChange={event => setReason(event.target.value)} autoFocus />
    </label>}
    <div className="actor-blocker-decision-actions">
      {rejecting ? <>
        <button type="button" className="secondary" disabled={busy !== null} onClick={() => { setRejecting(false); setReason(""); }}>Cancel</button>
        <button type="button" className="secondary actor-blocker-reject" disabled={busy !== null} onClick={() => void decide("reject")}
          aria-label="Confirm rejecting this proposal"><X aria-hidden="true" />{busy === "reject" ? "Rejecting…" : "Reject proposal"}</button>
      </> : <>
        <button type="button" className="secondary actor-blocker-reject" disabled={busy !== null} onClick={() => setRejecting(true)}
          aria-label="Reject this proposal"><X aria-hidden="true" />Reject</button>
        <button type="button" className="secondary primary actor-blocker-approve" disabled={busy !== null} onClick={() => void decide("approve")}
          aria-label="Approve this proposal"><Check aria-hidden="true" />{busy === "approve" ? "Approving…" : "Approve"}</button>
      </>}
    </div>
    {error && <p role="alert" className="actor-blocker-error">{error}</p>}
  </div>;
}

export function ActorBlockerCard({ blocker, actorName, onOpenSession, onDecided, showDecision = true, compactActions = false }: {
  blocker: ActorBlockerView; actorName: ActorName; onOpenSession?: (sessionId: string) => void;
  onDecided?: (blocker: ActorBlocker) => void; showDecision?: boolean; compactActions?: boolean;
}) {
  const proposal = blocker.proposals.at(-1);
  const pending = actorBlockerPendingDecision(blocker);
  const escalated = blocker.status === "escalated";
  const owner = blocker.ownerActorName || actorName(blocker.ownerActorId);
  return <article className="actor-blocker-card" data-blocker-id={blocker.id} data-status={blocker.status} data-escalated={escalated || undefined}
    aria-label={`${escalated ? "Escalated blocker" : "Blocker"}: ${blocker.description}`}>
    <header className="actor-blocker-card-header">
      <span className="actor-blocker-status" data-status={blocker.status}>
        {escalated ? <OctagonAlert aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}{BLOCKER_STATUS_LABELS[blocker.status]}
      </span>
      <span className="actor-blocker-kind">{BLOCKER_KIND_LABELS[blocker.kind]}</span>
      <time className="actor-blocker-time" dateTime={blocker.updated}>{new Date(blocker.updated).toLocaleString()}</time>
    </header>
    <p className="actor-blocker-description">{blocker.description}</p>
    <dl className="actor-blocker-meta">
      <div><dt>Owner</dt><dd>{owner}</dd></div>
      {blocker.executorActorId !== blocker.ownerActorId && <div><dt>Executor</dt><dd>{actorName(blocker.executorActorId)}</dd></div>}
      {blocker.taskSessionTitle && <div><dt>Task</dt><dd>{blocker.taskSessionTitle}</dd></div>}
      {escalated && blocker.escalation && <div><dt>Escalated</dt><dd>Because {BLOCKER_ESCALATION_LABELS[blocker.escalation.reason]}{blocker.escalation.note ? `: ${blocker.escalation.note}` : ""}</dd></div>}
    </dl>
    {proposal ? <section className="actor-blocker-proposal" aria-label="Proposed solution" data-pending={pending ? true : undefined}>
      <header><strong>Proposed solution</strong><span>{actorName(proposal.actorId)} · {blockerProposalState(proposal)}</span></header>
      <p>{proposal.text}</p>
      {proposal.outcomeNote && <small>{proposal.outcomeNote}</small>}
    </section> : <p className="actor-blocker-no-proposal">No solution proposed yet.</p>}
    <footer className="actor-blocker-actions">
      <div className="actor-blocker-composer-actions">
        <button type="button" className="secondary" aria-label="Send blocker to this session's composer" title="Prefill the current session's composer (not sent)"
          onClick={() => requestBlockerComposer({ target: "current", text: blockerComposerText(blocker, owner) })}><MessageSquarePlus aria-hidden="true" />Send to session composer</button>
        <button type="button" className="secondary" aria-label="Open a new session composer with this blocker" title="Prefill a new session's composer (not sent)"
          onClick={() => requestBlockerComposer({ target: "new", text: blockerComposerText(blocker, owner) })}><SquarePen aria-hidden="true" />New session composer</button>
      </div>
      {onOpenSession && blocker.taskSessionId && <button type="button" className="secondary actor-blocker-open" aria-label="Go to session" title="Go to session" onClick={() => onOpenSession(blocker.taskSessionId)}>
        <ExternalLink aria-hidden="true" />{!compactActions && "Go to session"}</button>}
      {pending && showDecision && <BlockerDecision key={pending.id} blocker={blocker} proposal={pending} onDecided={onDecided} />}
    </footer>
  </article>;
}

/** A labelled list of blockers; renders nothing when there are none. */
export function ActorBlockerList({ blockers, actorName, label, title, onOpenSession, onDecided, className, compactActions = false }: {
  blockers: ActorBlockerView[]; actorName: ActorName; label: string; title: string;
  onOpenSession?: (sessionId: string) => void; onDecided?: (blocker: ActorBlocker) => void; className?: string; compactActions?: boolean;
}) {
  if (!blockers.length) return null;
  const counts = blockerCounts(blockers);
  return <section className={`actor-blocker-list${className ? ` ${className}` : ""}`} aria-label={label} data-escalated={counts.escalated > 0 || undefined}>
    <header className="actor-blocker-list-header"><strong>{title}</strong><span>{blockerCountLabel(counts)}</span></header>
    {blockers.map(blocker => <ActorBlockerCard key={blocker.id} blocker={blocker} actorName={actorName} onOpenSession={onOpenSession} onDecided={onDecided} compactActions={compactActions} />)}
  </section>;
}

const OPEN_BLOCKERS_EVENT = "threadex:open-blockers";
let pendingOpenBlockers: string | null = null;

/** Ask the view registered for `openKey` (e.g. an actor's Blockers tab) to show its blockers, now or once it mounts after navigation. */
export function requestOpenBlockers(openKey: string) {
  pendingOpenBlockers = openKey;
  window.dispatchEvent(new CustomEvent(OPEN_BLOCKERS_EVENT, { detail: openKey }));
}

/** Calls `onOpen` when `requestOpenBlockers(openKey)` is (or was, before mount) requested. */
export function useOpenBlockersRequest(openKey: string, onOpen: () => void) {
  const callback = useRef(onOpen);
  callback.current = onOpen;
  useEffect(() => {
    const take = () => {
      if (pendingOpenBlockers !== openKey) return;
      pendingOpenBlockers = null;
      callback.current();
    };
    take();
    window.addEventListener(OPEN_BLOCKERS_EVENT, take);
    return () => window.removeEventListener(OPEN_BLOCKERS_EVENT, take);
  }, [openKey]);
}

/** While `active`, every listed blocker counts as seen, including ones that change while it stays open. */
function useMarkSeenWhile(active: boolean, blockers: readonly ActorBlockerView[]) {
  const revision = blockers.map(blocker => `${blocker.id}@${blocker.updated}`).join("|");
  useEffect(() => { if (active) markBlockersSeen(blockers); }, [active, revision]);
}

/** Session header chip for the task's active blockers, with a disclosure panel; hidden when there are none. */
export function TaskBlockersButton({ blockers, actorName }: { blockers: ActorBlockerView[]; actorName: ActorName }) {
  return <BlockersButton blockers={blockers} actorName={actorName} scope="Task blockers" listLabel="Active blockers for this task" />;
}

/** Fixed placement under the trigger, kept inside the viewport so narrow or clipping containers (the sidebar) cannot hide it. */
function blockersPanelPlacement(trigger: HTMLElement): CSSProperties {
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(440, window.innerWidth - 16);
  const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
  const top = rect.bottom + 6;
  return { position: "fixed", top, left, right: "auto", width, maxHeight: Math.max(160, Math.min(560, window.innerHeight - top - 8)) };
}

/** Chip with a click-to-open panel listing blockers; hidden when there are none. The count shows only unseen blockers. */
export function BlockersButton({ blockers, actorName, scope, listLabel, onOpenSession }: {
  blockers: ActorBlockerView[]; actorName: ActorName; scope: string; listLabel: string; onOpenSession?: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<CSSProperties>();
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const counts = blockerCounts(blockers);
  const unseen = useUnseenBlockers()(blockers).length;
  useMarkSeenWhile(open, blockers);
  useEffect(() => { if (!blockers.length) setOpen(false); }, [blockers.length]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => { if (trigger.current) setPlacement(blockersPanelPlacement(trigger.current)); };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // Closing the panel must not reach the session's Esc-to-stop shortcut.
      event.preventDefault(); event.stopImmediatePropagation();
      setOpen(false); trigger.current?.focus();
    }
    function outside(event: PointerEvent) { if (!wrap.current?.contains(event.target as Node)) setOpen(false); }
    window.addEventListener("keydown", escape, true);
    window.addEventListener("pointerdown", outside, true);
    return () => { window.removeEventListener("keydown", escape, true); window.removeEventListener("pointerdown", outside, true); };
  }, [open]);
  if (!blockers.length) return null;
  const label = `${blockerCountLabel(counts)}${unseen ? `, ${unseen} new` : ""}`;
  return <div className="task-blockers" ref={wrap}>
    <button ref={trigger} type="button" className="task-blockers-trigger" data-escalated={counts.escalated > 0 || undefined} data-seen={!unseen || undefined}
      aria-expanded={open} aria-controls={open ? `${id}-panel` : undefined} aria-label={`${scope}: ${label}`} title={`${scope}: ${label}`}
      onClick={() => setOpen(value => !value)}>
      {counts.escalated ? <OctagonAlert aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
      <span>{counts.escalated ? "Escalated" : "Blocked"}</span>{unseen > 0 && <span className="task-blockers-count">{unseen}</span>}
    </button>
    {open && <div id={`${id}-panel`} className="task-blockers-panel" role="region" aria-label={scope} style={placement}>
      <ActorBlockerList blockers={blockers} actorName={actorName} label={listLabel} title={scope}
        onOpenSession={onOpenSession && (sessionId => { setOpen(false); onOpenSession(sessionId); })} />
    </div>}
  </div>;
}

/** Toolbar button for the workspace's escalated blockers; opens a large table dialog. Hidden when there are none. */
export function ProjectBlockersButton({ blockers, actorName, onOpenSession }: {
  blockers: ActorBlockerView[]; actorName: ActorName; onOpenSession: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const unseen = useUnseenBlockers()(blockers).length;
  useMarkSeenWhile(open, blockers);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => { if (!blockers.length) setOpen(false); }, [blockers.length]);
  useEffect(() => {
    if (!open) return;
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // Closing the dialog must not reach the session's Esc-to-stop shortcut.
      event.preventDefault(); event.stopImmediatePropagation(); close();
    }
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [open]);
  if (!blockers.length) return null;
  const label = blockerCountLabel(blockerCounts(blockers));
  return <>
    <button ref={trigger} type="button" className="ghost-icon project-blockers-trigger" aria-haspopup="dialog" aria-expanded={open} data-seen={!unseen || undefined}
      aria-label={`Workspace blockers: ${label}${unseen ? `, ${unseen} new` : ""}`} title={`Workspace blockers: ${label}`} onClick={() => setOpen(true)}>
      <OctagonAlert aria-hidden="true" />
      {unseen > 0 && <span className="pending-waits-badge" aria-hidden="true">{unseen > 99 ? "99+" : unseen}</span>}
    </button>
    {open && createPortal(<div className="modal-backdrop project-blockers-backdrop" role="presentation"
      onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <section className="session-search-modal project-blockers-modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
        <div className="pending-waits-modal-header">
          <OctagonAlert aria-hidden="true" />
          <div><strong id={`${id}-title`}>Workspace blockers</strong><small>Escalated · {label}</small></div>
          <button type="button" className="ghost-icon" onClick={close} title="Close workspace blockers" aria-label="Close workspace blockers" autoFocus><X aria-hidden="true" /></button>
        </div>
        <div className="project-blockers-results">
          <BlockersTable blockers={blockers} actorName={actorName} label="Escalated workspace blockers" onOpenSession={sessionId => { close(); onOpenSession(sessionId); }} />
        </div>
      </section>
    </div>, document.body)}
  </>;
}

/** Blockers as table rows; each row expands to the full card (with Approve/Reject when a decision is pending). `stacked` lays rows out as labelled blocks for narrow columns. */
export function BlockersTable({ blockers, actorName, label, onOpenSession, stacked = false }: {
  blockers: ActorBlockerView[]; actorName: ActorName; label: string; onOpenSession: (sessionId: string) => void; stacked?: boolean;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const id = useId();
  return <table className="project-blockers-table" data-stacked={stacked || undefined} aria-label={label}>
    <thead><tr><th>Blocker</th><th>Status</th><th>Kind</th><th>Actor</th><th>Task</th><th>Updated</th><th><span className="project-blockers-sr">Actions</span></th></tr></thead>
    <tbody>{blockers.map(blocker => {
      const pending = actorBlockerPendingDecision(blocker);
      const detailsOpen = expanded === blocker.id;
      const detailsId = `${id}-details-${blocker.id}`;
      return <Fragment key={blocker.id}>
        <tr data-blocker-id={blocker.id} data-status={blocker.status}>
          <td className="project-blockers-description">
            <span>{blocker.description}</span>
            {blocker.status === "escalated" && blocker.escalation && <small>Escalated because {BLOCKER_ESCALATION_LABELS[blocker.escalation.reason]}</small>}
          </td>
          <td data-label="Status"><span className="actor-blocker-status" data-status={blocker.status}>{BLOCKER_STATUS_LABELS[blocker.status]}</span>
            {pending && <small className="project-blockers-pending">Awaiting your decision</small>}</td>
          <td data-label="Kind">{BLOCKER_KIND_LABELS[blocker.kind]}</td>
          <td data-label="Actor">{blocker.ownerActorName || actorName(blocker.ownerActorId)}</td>
          <td data-label="Task" className="project-blockers-task">{blocker.taskSessionTitle || blocker.taskSessionId}</td>
          <td data-label="Updated"><time dateTime={blocker.updated}>{new Date(blocker.updated).toLocaleString()}</time></td>
          <td><div className="project-blockers-actions">
            <button type="button" className="secondary" aria-expanded={detailsOpen} aria-controls={detailsOpen ? detailsId : undefined}
              onClick={() => setExpanded(detailsOpen ? null : blocker.id)}>{pending ? "Review" : "Details"}</button>
            <button type="button" className="secondary" onClick={() => onOpenSession(blocker.taskSessionId)}>
              <ExternalLink aria-hidden="true" />Go to session</button>
          </div></td>
        </tr>
        {detailsOpen && <tr id={detailsId} className="project-blockers-detail"><td colSpan={7}>
          <ActorBlockerCard blocker={blocker} actorName={actorName} />
        </td></tr>}
      </Fragment>;
    })}</tbody>
  </table>;
}

/** An actor's blockers tab panel: the table stacked for the narrow column; viewing it marks them seen. */
export function ActorBlockersPanel({ blockers, actorName, actorLabel, onOpenSession, active, id, labelledBy }: {
  blockers: ActorBlockerView[]; actorName: ActorName; actorLabel: string; onOpenSession: (sessionId: string) => void;
  active: boolean; id: string; labelledBy: string;
}) {
  useMarkSeenWhile(active, blockers);
  return <div id={id} className="actor-blockers-panel" role="tabpanel" aria-labelledby={labelledBy} hidden={!active}>
    {blockers.length ? <>
      <p className="actor-blockers-summary">{blockerCountLabel(blockerCounts(blockers))}</p>
      <BlockersTable blockers={blockers} actorName={actorName} label={`${actorLabel} blockers`} onOpenSession={onOpenSession} stacked />
    </> : <p role="status" className="actor-blockers-empty">{actorLabel} has no active blockers.</p>}
  </div>;
}
