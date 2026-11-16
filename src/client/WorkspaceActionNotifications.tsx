import { useEffect, useId, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { Bell, CheckCircle2, Clock3, ExternalLink, MessageCircle, ShieldCheck, X } from "lucide-react";
import { actionNotificationLabel, type ActionNotification } from "./actionNotifications";
import "./WorkspaceActionNotifications.css";

type Props = {
  workspace: { id: string; name: string };
  items: ActionNotification[];
  error: string;
  loaded: boolean;
  onRefresh: () => void;
  onDecisionSubmitted: (id: string) => void;
  onOpenSession: (id: string) => void;
  ApprovalEvent: ComponentType<any>;
};

const DROPDOWN_MAX_WIDTH = 640;
const DROPDOWN_VIEWPORT_MARGIN = 8;

function isUserInputRequest(item: ActionNotification) {
  return item.method === "item/tool/requestUserInput";
}

/** Workspace-level inbox: each pending request renders the same card used in the session timeline, so it can be
 * approved or answered in place. Cards own their request, busy and error state; a submitted card leaves the list.
 * Blocker solutions are not listed here; they are decided in their task session and the actor workspace. */
export function WorkspaceActionNotifications({ workspace, items, error, loaded, onRefresh, onDecisionSubmitted, onOpenSession, ApprovalEvent }: Props) {
  const [open, setOpen] = useState(false);
  const [handledNotice, setHandledNotice] = useState("");
  const [position, setPosition] = useState({ top: 40, left: DROPDOWN_VIEWPORT_MARGIN, maxHeight: 520 });
  const trigger = useRef<HTMLButtonElement>(null);
  const dropdown = useRef<HTMLDivElement>(null);
  const id = useId();
  const total = items.length;
  const hasItems = total > 0;
  useEffect(() => {
    if (!hasItems) setOpen(false);
  }, [hasItems]);
  useEffect(() => {
    if (!open) setHandledNotice("");
  }, [open]);
  useEffect(() => {
    // A handled card unmounts with its focused button; keep keyboard focus inside the popover.
    const panel = dropdown.current;
    if (open && panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
  }, [open, total]);
  useEffect(() => {
    if (!open) return;
    const button = trigger.current;
    dropdown.current?.focus();
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.isComposing) return;
      // Do not let the shell interpret dismissal as an instruction to stop work.
      event.preventDefault(); event.stopImmediatePropagation();
      setOpen(false);
    }
    function outside(event: PointerEvent) {
      if (!dropdown.current?.contains(event.target as Node) && !button?.contains(event.target as Node)) setOpen(false);
    }
    function reposition() {
      const bounds = button?.getBoundingClientRect();
      if (bounds) {
        const width = Math.min(DROPDOWN_MAX_WIDTH, window.innerWidth - DROPDOWN_VIEWPORT_MARGIN * 2);
        const top = Math.min(bounds.bottom + 4, Math.max(DROPDOWN_VIEWPORT_MARGIN, window.innerHeight - 160));
        const left = Math.max(DROPDOWN_VIEWPORT_MARGIN, Math.min(bounds.left, window.innerWidth - width - DROPDOWN_VIEWPORT_MARGIN));
        setPosition({ top, left, maxHeight: window.innerHeight - top - DROPDOWN_VIEWPORT_MARGIN });
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
  }, [open]);

  function openSession(sessionId: string) { setOpen(false); onOpenSession(sessionId); }
  function approvalHandled(item: ActionNotification) {
    setHandledNotice(`Handled: ${actionNotificationLabel(item)}`);
    onDecisionSubmitted(item.approvalId);
  }

  return <>
    <button ref={trigger} type="button" className="workspace-actions-trigger" hidden={!hasItems} data-pending={hasItems}
      aria-label={`${workspace.name} actions${total ? ` (${total} pending)` : ""}`} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? `${id}-actions` : undefined}
      title={`${workspace.name} action notifications`} onClick={() => { setOpen(value => !value); onRefresh(); }}>
      <Bell size={15} aria-hidden="true" />{total > 0 && <span className="workspace-actions-count">{total > 99 ? "99+" : total}</span>}
    </button>
    {open && createPortal(<div ref={dropdown} id={`${id}-actions`} className="workspace-actions-dropdown" role="dialog" aria-label={`${workspace.name} actions`} tabIndex={-1}
      style={position} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) setOpen(false); }}>
      <header className="workspace-actions-header"><div className="workspace-actions-heading"><div className="workspace-actions-title"><strong>Actions</strong><span className="workspace-actions-pending-count">{total} pending</span></div><small className="workspace-actions-workspace">{workspace.name}</small></div><button type="button" className="workspace-action-close" aria-label="Close actions" onClick={() => setOpen(false)}><X size={17} aria-hidden="true" /></button></header>
      {error && <p className="workspace-actions-message workspace-actions-error" role="status">{error} <button type="button" onClick={onRefresh}>Retry</button></p>}
      <p className="workspace-actions-handled" role="status" hidden={!handledNotice}>{handledNotice && <><CheckCircle2 size={15} aria-hidden="true" /><span>{handledNotice}</span></>}</p>
      {!loaded && !error && <p className="workspace-actions-message">Loading actions…</p>}
      {loaded && !total && !error && <p className="workspace-actions-message">No pending actions. You're all caught up.</p>}
      <div className="workspace-actions-list">{items.map(item => {
        const kind = isUserInputRequest(item) ? "input" : "approval";
        const titleId = `${id}-${item.approvalId}-title`;
        return <article className="workspace-action-item" key={item.approvalId} data-approval-id={item.approvalId} data-kind={kind} aria-labelledby={titleId}>
          <header className="workspace-action-item-header">
            <span className="workspace-action-icon" aria-hidden="true">{kind === "input" ? <MessageCircle size={18} /> : <ShieldCheck size={18} />}</span>
            <span className="workspace-action-content"><span className="workspace-action-title-row"><strong id={titleId}>{kind === "input" ? "Your input requested" : "Approval required"}</strong><span className="workspace-action-pending"><span className="workspace-action-dot" aria-hidden="true" />Pending</span></span>
              <span className="workspace-action-meta"><small className="workspace-action-source"><span className="workspace-action-source-label">Session</span>{item.sessionTitle}</small>
                {item.createdAt && <small className="workspace-action-time"><Clock3 size={12} aria-hidden="true" /><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></small>}</span></span>
            <button type="button" className="workspace-action-session" aria-label={`Go to session ${item.sessionTitle}`} title="Go to session" onClick={() => openSession(item.sessionId)}><ExternalLink size={14} aria-hidden="true" /><span>Go to session</span></button>
          </header>
          <div className="workspace-action-body"><ApprovalEvent item={item} compact onDecisionSubmitted={() => approvalHandled(item)} /></div>
        </article>;
      })}</div>
    </div>, document.body)}
  </>;
}
