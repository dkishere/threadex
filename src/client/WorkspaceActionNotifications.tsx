import { useEffect, useId, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { Bell, CheckCircle2, Clock3, ExternalLink, MessageCircle, OctagonAlert, ShieldCheck, X } from "lucide-react";
import { actionNotificationLabel, type ActionNotification } from "./actionNotifications";
import { ActorBlockerCard } from "./ActorBlockers";
import type { ActorBlockerView } from "./actorBlockerPresentation";
import "./WorkspaceActionNotifications.css";

type Props = {
  workspace: { id: string; name: string };
  items: ActionNotification[];
  /** Blocker proposals awaiting the user's approval in this workspace. */
  blockers?: ActorBlockerView[];
  error: string;
  loaded: boolean;
  onRefresh: () => void;
  onDecisionSubmitted: (id: string) => void;
  onBlockerDecided?: (id: string) => void;
  onOpenSession: (id: string) => void;
  ApprovalEvent: ComponentType<any>;
};

function blockerActorName(blocker: ActorBlockerView) {
  return (id: string) => id === blocker.ownerActorId && blocker.ownerActorName ? blocker.ownerActorName : id;
}

export function WorkspaceActionNotifications({ workspace, items, blockers = [], error, loaded, onRefresh, onDecisionSubmitted, onBlockerDecided, onOpenSession, ApprovalEvent }: Props) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ActionNotification | null>(null);
  const [selectedBlocker, setSelectedBlocker] = useState<ActorBlockerView | null>(null);
  const [position, setPosition] = useState({ top: 40, left: 8, maxHeight: 520 });
  const trigger = useRef<HTMLButtonElement>(null);
  const dropdown = useRef<HTMLDivElement>(null);
  const modal = useRef<HTMLDialogElement>(null);
  const id = useId();
  const total = items.length + blockers.length;
  const hasItems = total > 0;
  const modalOpen = !!selected || !!selectedBlocker;
  const modalKey = selected ? `approval:${selected.approvalId}` : selectedBlocker ? `blocker:${selectedBlocker.id}` : null;
  const pending = selected && items.find(item => item.approvalId === selected.approvalId);
  const pendingBlocker = selectedBlocker && blockers.find(blocker => blocker.id === selectedBlocker.id);
  const closeModal = () => { setSelected(null); setSelectedBlocker(null); };
  useEffect(() => {
    if (!hasItems) setOpen(false);
  }, [hasItems]);
  useEffect(() => {
    if (!open && !modalOpen) return;
    const button = trigger.current;
    if (modalOpen) modal.current?.showModal();
    else dropdown.current?.focus();
    function escape(event: KeyboardEvent) {
      if (event.key === "Tab" && modalOpen && modal.current) {
        const controls = [...modal.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')]
          .filter(element => element.getClientRects().length > 0)
          .filter(element => {
            if (!(element instanceof HTMLInputElement) || element.type !== "radio" || !element.name) return true;
            const group = [...modal.current!.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter(input => input.name === element.name);
            return element === (group.find(input => input.checked) ?? group[0]);
          });
        const first = controls[0]; const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      if (event.key !== "Escape") return;
      // Do not let the shell interpret dismissal as an instruction to stop work.
      event.preventDefault(); event.stopImmediatePropagation();
      setOpen(false); closeModal();
    }
    function outside(event: PointerEvent) {
      if (!modalOpen && !dropdown.current?.contains(event.target as Node) && !button?.contains(event.target as Node)) setOpen(false);
    }
    function reposition() {
      const bounds = button?.getBoundingClientRect();
      if (bounds) {
        const top = Math.min(bounds.bottom + 4, Math.max(8, window.innerHeight - 160));
        setPosition({ top, left: Math.max(8, Math.min(bounds.left, window.innerWidth - 388)), maxHeight: Math.min(520, window.innerHeight - top - 8) });
      }
    }
    reposition();
    window.addEventListener("keydown", escape, true);
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("keydown", escape, true); window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true);
      const focusTarget = button?.hidden
        ? button.closest(".workspace-tab-wrap")?.querySelector<HTMLButtonElement>('[role="tab"]')
        : button;
      if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
    };
  }, [open, modalKey]);

  return <>
    <button ref={trigger} type="button" className="workspace-actions-trigger" hidden={!hasItems} data-pending={hasItems}
      aria-label={`${workspace.name} actions${total ? ` (${total} pending)` : ""}`} aria-haspopup="dialog" aria-expanded={open || modalOpen}
      aria-controls={open ? `${id}-actions` : modalOpen ? `${id}-request` : undefined}
      title={`${workspace.name} action notifications`} onClick={() => { setOpen(value => !value); onRefresh(); }}>
      <Bell size={15} aria-hidden="true" />{total > 0 && <span className="workspace-actions-count">{total > 99 ? "99+" : total}</span>}
    </button>
    {open && createPortal(<div ref={dropdown} id={`${id}-actions`} className="workspace-actions-dropdown" role="dialog" aria-label={`${workspace.name} actions`} tabIndex={-1}
      style={position} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) setOpen(false); }}>
      <header className="workspace-actions-header"><div className="workspace-actions-heading"><div className="workspace-actions-title"><strong>Actions</strong><span className="workspace-actions-pending-count">{total} pending</span></div><small className="workspace-actions-workspace">{workspace.name}</small></div><button type="button" className="workspace-action-close" aria-label="Close actions" onClick={() => setOpen(false)}><X size={17} aria-hidden="true" /></button></header>
      {error && <p className="workspace-actions-message workspace-actions-error" role="status">{error} <button type="button" onClick={onRefresh}>Retry</button></p>}
      {!loaded && !error && <p className="workspace-actions-message">Loading actions…</p>}
      {loaded && !total && !error && <p className="workspace-actions-message">No pending actions. You're all caught up.</p>}
      <div className="workspace-actions-list">{items.map(item => <button type="button" className="workspace-action-item" key={item.approvalId} data-approval-id={item.approvalId}
        data-kind={item.method === "item/tool/requestUserInput" ? "input" : "approval"}
        onClick={() => { setSelected(item); setOpen(false); }}>
        <span className="workspace-action-icon" aria-hidden="true">{item.method === "item/tool/requestUserInput" ? <MessageCircle size={18} /> : <ShieldCheck size={18} />}</span>
        <span className="workspace-action-content"><span className="workspace-action-title-row"><strong>{item.method === "item/tool/requestUserInput" ? "Your input requested" : "Approval required"}</strong><span className="workspace-action-pending"><span className="workspace-action-dot" aria-hidden="true" />Pending</span></span>
          <span className="workspace-action-summary">{actionNotificationLabel(item)}</span>
          <span className="workspace-action-meta"><small className="workspace-action-source"><span className="workspace-action-source-label">Session</span>{item.sessionTitle}</small>
            {item.createdAt && <small className="workspace-action-time"><Clock3 size={12} aria-hidden="true" /><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></small>}</span></span>
      </button>)}
      {blockers.map(blocker => <button type="button" className="workspace-action-item" key={blocker.id} data-blocker-id={blocker.id} data-kind="blocker"
        onClick={() => { setSelectedBlocker(blocker); setOpen(false); }}>
        <span className="workspace-action-icon" aria-hidden="true"><OctagonAlert size={18} /></span>
        <span className="workspace-action-content"><span className="workspace-action-title-row"><strong>Blocker solution needs approval</strong><span className="workspace-action-pending"><span className="workspace-action-dot" aria-hidden="true" />{blocker.status === "escalated" ? "Escalated" : "Pending"}</span></span>
          <span className="workspace-action-summary">{blocker.description}</span>
          <span className="workspace-action-meta"><small className="workspace-action-source"><span className="workspace-action-source-label">Session</span>{blocker.taskSessionTitle || blocker.taskSessionId}</small>
            <small className="workspace-action-time"><Clock3 size={12} aria-hidden="true" /><time dateTime={blocker.updated}>{new Date(blocker.updated).toLocaleString()}</time></small></span></span>
      </button>)}</div>
    </div>, document.body)}
    {selectedBlocker && createPortal(<dialog ref={modal} id={`${id}-request`} className="workspace-action-modal" aria-modal="true" aria-labelledby={`${id}-title`}
      onCancel={event => { event.preventDefault(); closeModal(); }} onClick={event => { if (event.target === event.currentTarget) {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeModal();
      } }}>
      <header className="workspace-action-modal-header"><span className="workspace-action-icon" data-kind="blocker" aria-hidden="true"><OctagonAlert size={20} /></span><div className="workspace-action-modal-heading"><h2 id={`${id}-title`}>Blocker solution needs approval</h2>
        <small className="workspace-action-modal-source">{workspace.name} · {selectedBlocker.taskSessionTitle || selectedBlocker.taskSessionId}</small></div><button type="button" className="workspace-action-close" aria-label="Close request" onClick={closeModal}><X size={19} aria-hidden="true" /></button></header>
      <button type="button" className="workspace-action-session" onClick={() => { closeModal(); onOpenSession(selectedBlocker.taskSessionId); }}><ExternalLink size={15} /> Go to session</button>
      {pendingBlocker ? <ActorBlockerCard key={pendingBlocker.id} blocker={pendingBlocker} actorName={blockerActorName(pendingBlocker)} onDecided={() => onBlockerDecided?.(pendingBlocker.id)} />
        : <p className="workspace-action-handled" role="status"><CheckCircle2 size={20} aria-hidden="true" /><span>This blocker decision has been recorded or is no longer pending.</span></p>}
    </dialog>, document.body)}
    {selected && createPortal(<dialog ref={modal} id={`${id}-request`} className="workspace-action-modal" aria-modal="true" aria-labelledby={`${id}-title`}
      onCancel={event => { event.preventDefault(); closeModal(); }} onClick={event => { if (event.target === event.currentTarget) {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeModal();
      } }}>
      <header className="workspace-action-modal-header"><span className="workspace-action-icon" data-kind={selected.method === "item/tool/requestUserInput" ? "input" : "approval"} aria-hidden="true">{selected.method === "item/tool/requestUserInput" ? <MessageCircle size={20} /> : <ShieldCheck size={20} />}</span><div className="workspace-action-modal-heading"><h2 id={`${id}-title`}>{selected.method === "item/tool/requestUserInput" ? "Your input requested" : "Approval required"}</h2>
        <small className="workspace-action-modal-source">{workspace.name} · {selected.sessionTitle}</small></div><button type="button" className="workspace-action-close" aria-label="Close request" onClick={() => setSelected(null)}><X size={19} aria-hidden="true" /></button></header>
      <button type="button" className="workspace-action-session" onClick={() => { setSelected(null); onOpenSession(selected.sessionId); }}><ExternalLink size={15} /> Go to session</button>
      {pending ? <ApprovalEvent key={pending.approvalId} item={pending} onDecisionSubmitted={onDecisionSubmitted} /> : <p className="workspace-action-handled" role="status"><CheckCircle2 size={20} aria-hidden="true" /><span>This request has been handled or is no longer pending.</span></p>}
    </dialog>, document.body)}
  </>;
}
