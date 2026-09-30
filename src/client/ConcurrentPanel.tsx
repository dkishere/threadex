import { GitPullRequestCreateArrow, X, ArrowUpRight, Pause, Play, Send, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CollaborationView } from "../collaboration";
import "./ConcurrentPanel.css";

async function json<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Concurrent request failed.");
  return data as T;
}

export function ConcurrentPanel({ sessionId, sourceTurnId, refreshToken, onClose, onOpen }: {
  sessionId: string; sourceTurnId: string | null; refreshToken?: number; onClose: () => void; onOpen: (id: string) => void;
}) {
  const [anchor, setAnchor] = useState<Element | null>(null);
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState<CollaborationView | null>(null);
  const [task, setTask] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const base = `/api/concurrent/sessions/${encodeURIComponent(sessionId)}`;
  useEffect(() => { setAnchor(document.querySelector(".content-header-actions")); }, [sessionId]);
  useEffect(() => { if (sourceTurnId) setOpen(true); }, [sourceTurnId]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const data = await json<{ group: CollaborationView | null }>(base);
        if (active) setGroup(data.group);
      } catch (cause) { if (active && open) setError(cause instanceof Error ? cause.message : String(cause)); }
    };
    void load();
    const timer = setInterval(() => void load(), open ? 3000 : 15000);
    return () => { active = false; clearInterval(timer); };
  }, [base, open, refreshToken]);
  const action = async (path: string, body: unknown) => {
    setBusy(true); setError("");
    try {
      await json(`${base}/${path}`, body);
      const data = await json<{ group: CollaborationView | null }>(base);
      setGroup(data.group);
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { setBusy(false); }
  };
  const submit = async () => {
    const fingerprint = JSON.stringify({ task, target });
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
    if (await action("send", { requestId: request.current.id, to: target, message: task, reason: "User follow-up from Concurrent panel" })) {
      setTask(""); request.current = null;
    }
  };
  const main = !group || group.mainSessionId === sessionId;
  const workers = group?.members.filter(member => member.localId !== "main") ?? [];
  const activeCount = workers.filter(member => ["running", "queued", "waiting"].includes(group?.activity[member.localId]?.status ?? "")).length;
  const uncertain = group?.messages.filter(message => message.state === "uncertain") ?? [];
  if (!anchor) return null;
  return createPortal(<div className="concurrent-widget" ref={root}>
    <button ref={trigger} type="button" className="concurrent-trigger" aria-label="Concurrent" aria-haspopup="dialog" aria-expanded={open}
      data-active={sourceTurnId || activeCount ? "true" : undefined} onClick={() => setOpen(value => !value)}>
      <GitPullRequestCreateArrow aria-hidden="true" /><span>Concurrent</span>
      {workers.length > 0 && <span className="concurrent-count">{activeCount || workers.length}</span>}
    </button>
    {open && <section className="concurrent-panel" role="dialog" aria-label="Concurrent sessions">
      <header className="concurrent-heading"><div><strong>Concurrent</strong><span>{activeCount ? `${activeCount} working` : workers.length ? `${workers.length} workers · All settled` : "Work together in this session"}</span></div>
        <button className="concurrent-icon-button" type="button" onClick={() => setOpen(false)} aria-label="Close Concurrent"><X /></button></header>
      <div className="concurrent-body">
        {sourceTurnId && <div className="concurrent-source"><GitPullRequestCreateArrow aria-hidden="true" /><div><strong>New worker selected</strong><p>Enter a task in the composer and send it. The result will return to main automatically.</p></div><button className="concurrent-icon-button" onClick={onClose} aria-label="Cancel Concurrent spawn"><X /></button></div>}
        {error && <p className="concurrent-notice" role="alert">{error}</p>}
        {group?.error && <p className="concurrent-notice" role="alert">{group.error}</p>}
        {group?.conflicts.map(conflict => <p className="concurrent-notice" role="status" key={conflict.path}>Editing the same file: {conflict.path} · {conflict.members.join(", ")}</p>)}
        {!workers.length && <div className="concurrent-empty"><Users aria-hidden="true" /><strong>Start working together</strong><p>Select the Concurrent icon on a completed turn or in the composer, then send a task.</p></div>}
        {workers.length > 0 && <ul className="concurrent-members">{workers.map(member => {
          const activity = group?.activity[member.localId];
          return <li key={member.localId}><div className="concurrent-member-heading">
            <button className="concurrent-member-link" onClick={() => onOpen(member.sessionId)}>{member.localId}<ArrowUpRight aria-hidden="true" /></button>
            <span className="concurrent-status" data-status={activity?.status}>{activity?.status ?? "creating"}</span>
            {main && <button className="concurrent-icon-button concurrent-member-control" disabled={busy} onClick={() => void action("control", { localId: member.localId, stopped: !member.stopped })}
              title={member.stopped ? "Allow follow-ups" : "Stop worker"} aria-label={`${member.stopped ? "Allow follow-ups for" : "Stop"} ${member.localId}`}>{member.stopped ? <Play /> : <Pause />}</button>}
          </div><p className="concurrent-task" title={member.task}>{member.task}</p>
            {activity?.progress && <p className="concurrent-progress">{activity.progress.slice(-350)}</p>}
            {group?.messages.filter(m => m.from === member.localId && m.wait && !m.completed && m.state !== "cancelled")
              .map(m => <small className="concurrent-wait" key={m.id}>Waiting for {m.to} · {m.reason}</small>)}
          </li>;
        })}</ul>}
        {main && workers.some(member => !member.stopped) && <div className="concurrent-compose"><h3>Follow-up</h3>
          <label><span>Send to</span><select aria-label="Concurrent recipient" value={target} onChange={event => setTarget(event.target.value)} disabled={busy}>
            <option value="">Choose a worker</option>{workers.filter(member => !member.stopped).map(member => <option key={member.localId} value={member.localId}>{member.localId} · {member.task.slice(0, 45)}</option>)}
          </select></label>
          <textarea aria-label="Concurrent task" value={task} onChange={event => setTask(event.target.value)} placeholder="Follow-up for a teammate…" rows={3} disabled={busy} />
          <div className="concurrent-send-row"><small>Steer a running worker; queue for an idle worker.</small><button className="concurrent-send" disabled={busy || !task.trim() || !target} onClick={() => void submit()}><Send aria-hidden="true" />{busy ? "Sending…" : "Send"}</button></div>
        </div>}
        {group?.messages.filter(m => m.error && m.state !== "uncertain" && m.state !== "cancelled" && !m.completed).map(m => <p className="concurrent-notice" role="status" key={m.id}>{m.from} → {m.to}：{m.error}</p>)}
        {uncertain.map(m => <div key={m.id} className="concurrent-notice"><strong>Delivery needs review · {m.from} → {m.to}</strong><p>{m.text.slice(0, 200)}</p><p>Check the recipient's turn before confirming. The message will not be resent automatically.</p>
          {main && <div className="concurrent-review-actions"><button disabled={busy} onClick={() => void action("resolveDelivery", { id: m.id, action: "delivered" })}>Confirm delivered</button><button disabled={busy} onClick={() => void action("resolveDelivery", { id: m.id, action: "cancel" })}>Cancel message</button></div>}
        </div>)}
        {Boolean(group?.results.length) && <div className="concurrent-results"><h3>Results <span>{group!.results.length}</span></h3>{[...group!.results].reverse().map(result => <details key={result.id}>
          <summary><span className="concurrent-result-id">{result.localId}</span><span>{result.summary.slice(0, 100)}</span><span className="concurrent-status" data-status={result.status}>{result.status}</span></summary>
          <pre>{result.summary}</pre><ul>{result.changes.map(change => <li key={`${change.path}:${change.kind}`}>{change.path} <span>+{change.additions} / −{change.deletions}</span></li>)}</ul>
          <button className="concurrent-member-link" onClick={() => onOpen(result.sessionId)}>Open worker<ArrowUpRight aria-hidden="true" /></button>
        </details>)}</div>}
      </div>
    </section>}
  </div>, anchor);
}
