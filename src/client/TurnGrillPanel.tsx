import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronDown, Eye, Flame, History, Loader2, MessageSquare, Pencil, RotateCcw, Send, X } from "lucide-react";
import { MarkdownContent } from "./MarkdownContent";
import { GrillHistoryDialog } from "./GrillHistoryDialog";
import { canFollowUpGrill, grillAwaitingAck, grillContentVersion, grillHandoff, mergeGrillEdits, type GrillIssue, type TurnGrill } from "../turnGrill";
import { eventStore, useEventStore } from "./eventStore";
import "./turnGrill.css";

export function useGrilledTurns(sessionId: string | null) {
  const { grillSummaries } = useEventStore();
  const [keys, setKeys] = useState(() => new Set<string>());
  const markGrilled = useCallback((ownerId: string, turnId: string) => {
    const key = `${ownerId}:${turnId}`;
    setKeys((current) => current.has(key) ? current : new Set(current).add(key));
  }, []);
  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/grills`).then(async (response) => {
      if (!response.ok) return;
      const data = await response.json();
      if (!disposed && Array.isArray(data.turnIds)) {
        setKeys((current) => new Set([...current, ...data.turnIds.map((id: string) => `${sessionId}:${id}`)]));
      }
    }).catch(() => { /* Loaded review panels still report their saved status. */ });
    return () => { disposed = true; };
  }, [sessionId]);
  return { grilledTurns: new Set([...keys, ...grillSummaries.map((item) => `${item.sessionId}:${item.turnId}`)]), markGrilled,
    pendingGrillTurns: new Set(grillSummaries.filter((item) => item.pending).map((item) => `${item.sessionId}:${item.turnId}`)),
    pendingGrillSessions: new Set(grillSummaries.filter((item) => item.pending).map((item) => item.sessionId)) };
}

export function TurnGrillPanel({ sessionId, turnId, latest, mainBusy, onImplement, actionExtras, onGrilled }: {
  sessionId: string; turnId: string; latest: boolean; mainBusy: boolean;
  onImplement: (prompt: string, origin: { turnId: string; observedVersion: number }) => Promise<void>;
  actionExtras?: ReactNode;
  onGrilled?: (sessionId: string, turnId: string) => void;
}) {
  const [review, setReview] = useState<TurnGrill | null>(null);
  const { grillSummaries, workspaceSnapshot } = useEventStore();
  const remoteSummary = grillSummaries.find((item) => item.sessionId === sessionId && item.turnId === turnId);
  const remoteRevision = remoteSummary?.revision ?? 0;
  const knownAbsent = workspaceSnapshot !== null && !remoteSummary;
  const [issues, setIssues] = useState<GrillIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [activity, setActivity] = useState("Griller is reviewing this turn…");
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [editing, setEditing] = useState<{ id: string; md: string } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [conflicts, setConflicts] = useState<string[]>([]);
  const conflictRef = useRef(false);
  const reviewRef = useRef<TurnGrill | null>(null);
  const issuesRef = useRef<GrillIssue[]>([]);
  const saveInFlight = useRef<Promise<TurnGrill | null> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/grill`;
  const accept = (value: TurnGrill | null) => {
    if (value && reviewRef.current && value.revision < reviewRef.current.revision) return;
    reviewRef.current = value; issuesRef.current = value?.issues ?? [];
    setReview(value); setIssues(issuesRef.current); setSaveError("");
    conflictRef.current = false; setConflicts([]);
  };
  const flushChanges = useCallback((): Promise<TurnGrill | null> => {
    clearTimeout(saveTimer.current);
    if (conflictRef.current) return Promise.resolve(null);
    if (saveInFlight.current) return saveInFlight.current;
    if (!reviewRef.current || JSON.stringify(issuesRef.current) === JSON.stringify(reviewRef.current.issues)) return Promise.resolve(reviewRef.current);
    setSaving(true);
    const save = async () => {
      try {
        let retries = 0;
        while (reviewRef.current && JSON.stringify(issuesRef.current) !== JSON.stringify(reviewRef.current.issues)) {
          const base = reviewRef.current;
          const snapshot = issuesRef.current;
          if (snapshot.some((issue) => !issue.md.trim())) throw new Error("Questions cannot be empty. Your edits are still here.");
          const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
            action: "save", revision: reviewRef.current.revision, issues: snapshot
          }) });
          const data = await response.json();
          if (response.status === 409) {
            const latestResponse = await fetch(url);
            if (!latestResponse.ok) throw new Error("Could not load the latest review. Your edits are still here.");
            const latest: TurnGrill | null = (await latestResponse.json()).grill;
            if (!latest) throw new Error("The saved review is unavailable. Your edits are still here.");
            const merged = mergeGrillEdits(base.issues, issuesRef.current, latest.issues);
            reviewRef.current = latest; setReview(latest);
            issuesRef.current = merged.issues; setIssues(merged.issues);
            if (merged.conflicts.length) {
              conflictRef.current = true; setConflicts(merged.conflicts);
              throw new Error("Another editor changed the same fields. Choose how to merge your edits.");
            }
            if (latest.status === "running" || ++retries > 2) throw new Error("Review is changing. Your edits are kept; retry autosave when it finishes.");
            continue;
          }
          if (!response.ok) throw new Error(data.error || "Could not save changes. Your edits are still here.");
          if (reviewRef.current && data.grill.revision < reviewRef.current.revision) continue;
          reviewRef.current = data.grill;
          setReview(data.grill);
          // A late response must not replace edits made while this save was running.
          if (issuesRef.current === snapshot) { issuesRef.current = data.grill.issues; setIssues(data.grill.issues); }
          setSaveError("");
        }
        return reviewRef.current;
      } catch (err) { setSaveError(err instanceof Error ? err.message : String(err)); return null; }
      finally { saveInFlight.current = null; setSaving(false); }
    };
    const pending = Promise.resolve().then(save);
    saveInFlight.current = pending;
    return pending;
  }, [url]);
  const queueIssues = (next: GrillIssue[], delay = 0) => {
    issuesRef.current = next; setIssues(next); if (!conflictRef.current) setSaveError("");
    clearTimeout(saveTimer.current);
    if (delay) saveTimer.current = setTimeout(() => void flushChanges(), delay);
    else void flushChanges();
  };
  const acknowledge = useCallback(async () => {
    if (!grillAwaitingAck(reviewRef.current)) return;
    setBusy(true);
    try {
      const saved = await flushChanges();
      if (!saved || !grillAwaitingAck(saved)) return;
      const observedVersion = grillContentVersion(saved);
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ack", observedVersion }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not acknowledge Grill.");
      if (reviewRef.current && data.grill.revision < reviewRef.current.revision) return;
      const merged = mergeGrillEdits(reviewRef.current?.issues ?? [], issuesRef.current, data.grill.issues);
      reviewRef.current = data.grill; setReview(data.grill); issuesRef.current = merged.issues; setIssues(merged.issues);
      if (merged.conflicts.length) { conflictRef.current = true; setConflicts(merged.conflicts); setSaveError("Another editor changed the same fields. Choose how to merge your edits."); }
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  }, [flushChanges, url]);
  useEffect(() => () => { clearTimeout(saveTimer.current); void flushChanges(); }, [flushChanges]);
  useEffect(() => { if (review) { onGrilled?.(sessionId, turnId); eventStore.reportGrill(sessionId, turnId, review); } }, [review, sessionId, turnId, onGrilled]);
  useEffect(() => {
    // The workspace snapshot already lists every saved review. Avoid a request
    // per completed turn just to discover that most turns have no review.
    if (knownAbsent && !reviewRef.current) {
      setLoading(false);
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const response = await fetch(url);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load Grill review.");
        if (!disposed) {
          if (data.grill && reviewRef.current && data.grill.revision < reviewRef.current.revision) return;
          if (reviewRef.current && data.grill && (conflictRef.current || JSON.stringify(issuesRef.current) !== JSON.stringify(reviewRef.current.issues))) {
            const merged = mergeGrillEdits(reviewRef.current.issues, issuesRef.current, data.grill.issues);
            reviewRef.current = data.grill; setReview(data.grill);
            issuesRef.current = merged.issues; setIssues(merged.issues);
            if (merged.conflicts.length) {
              conflictRef.current = true; setConflicts(merged.conflicts);
              setSaveError("Another editor changed the same fields. Choose how to merge your edits.");
            }
          } else accept(data.grill);
          setError("");
          if (data.grill?.status === "running") timer = setTimeout(load, 2000);
        }
      } catch (err) { if (!disposed) {
        setError("Could not reach the review server. Reconnecting…");
        timer = setTimeout(load, 2000);
      } }
      finally { if (!disposed) setLoading(false); }
    }
    if (!reviewRef.current || remoteRevision > reviewRef.current.revision || reviewRef.current.status === "running") void load();
    return () => { disposed = true; clearTimeout(timer); };
  }, [url, review?.status === "running", remoteRevision, knownAbsent]);

  async function act(action: "start" | "respond" | "followup", roundPrompt = "") {
    const observedVersion = grillContentVersion(reviewRef.current);
    let submittedRevision = reviewRef.current?.revision ?? 0;
    setBusy(true); setError("");
    if (action === "start") setStarted(true);
    setActivity(action === "respond" ? "Thread is answering…" : "Griller is reviewing this turn…");
    try {
      if (action !== "start" && !await flushChanges()) return null;
      submittedRevision = reviewRef.current?.revision ?? 0;
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        action, revision: reviewRef.current?.revision ?? 0, issues: issuesRef.current, prompt: roundPrompt, observedVersion
      }) });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409) {
          setError(`${data.error} Reload the review to get its latest state.`);
          return null;
        }
        throw new Error(data.error || "Grill failed.");
      }
      accept(data.grill);
      if (action === "respond" || action === "followup") setPrompt("");
      return data.grill as TurnGrill;
    } catch (err) {
      // The connection may end before inference does. Recover the persisted job
      // instead of retrying it or reporting a transport JSON error as model failure.
      try {
        const response = await fetch(url);
        if (response.ok) {
          const recovered: TurnGrill | null = (await response.json()).grill;
          if (recovered && recovered.revision > submittedRevision) {
            accept(recovered); setError("");
            if (recovered.status !== "error" && action !== "start") setPrompt("");
            return recovered;
          }
        }
      } catch { /* Keep the local draft if recovery is also unavailable. */ }
      setError(err instanceof SyntaxError ? "The server connection ended without a complete response. Reload the review to check whether it finished." : String(err));
      return null;
    } finally { setBusy(false); }
  }

  const locked = loading || busy || review?.status === "running";
  const selectedCount = issues.filter((issue) => issue.selected && !issue.dropped).length;
  const activeCount = issues.filter((issue) => !issue.dropped).length;
  const dirty = JSON.stringify(issues) !== JSON.stringify(review?.issues ?? []);
  const canFollowUp = canFollowUpGrill(review);
  const discussion = (review?.rounds ?? []).filter((round) => round.action !== "save");
  const replyRounds = discussion.filter((round) => round.action === "respond" || round.action === "followup");
  const historyId = `grill-history-${sessionId}-${turnId}`;
  const promptId = `grill-prompt-${sessionId}-${turnId}`;
  const dropOrRestore = (issue: GrillIssue) => queueIssues(issuesRef.current.map((current) => current.id === issue.id
    ? { ...current, dropped: !current.dropped, selected: Boolean(current.dropped) } : current));
  const actions = <div className="message-actions">{actionExtras}{latest && !review && !started && <button
    className="message-action-icon" type="button" title="Grill with Luna Max; long turns use Sol Max" aria-label="Grill agent"
    disabled={locked || mainBusy} onClick={() => void act("start")}><Flame aria-hidden="true" /></button>}</div>;
  if (!review && !started) return <>{actions}{error && <p role="alert">{error}</p>}</>;

  return <>{actions}<section className="turn-grill" data-await-ack={grillAwaitingAck(review) || undefined} aria-label="Grill review" aria-busy={locked}>
    <header className="grill-header">
      <div className="grill-title"><span className="grill-mark"><Flame size={15} aria-hidden="true" /></span><strong>Grill</strong>
        <span className="grill-stage">{canFollowUp ? "Discussion" : issues.length ? "Questions ready" : locked ? "Reviewing" : "Review"}</span>
        {grillAwaitingAck(review) && <span className="grill-await-ack" role="status">Await ack</span>}
      </div>
      {!!review?.rounds.length && <button className="grill-history-toggle" type="button" aria-haspopup="dialog" aria-expanded={historyOpen} aria-controls={historyId} onClick={() => setHistoryOpen(true)}>
        <History size={14} aria-hidden="true" /> History <span>{discussion.length}</span>
      </button>}
    </header>

    {saveError && <div className="grill-error" role="alert"><span>{saveError}</span><div>{conflicts.length ? <>
      <span>{conflicts.join(", ")}</span>
      <button type="button" disabled={saving} onClick={() => { conflictRef.current = false; setConflicts([]); void flushChanges(); }}>Keep local and merge</button>
      <button type="button" disabled={saving} onClick={async () => {
        try { const response = await fetch(url); if (!response.ok) throw new Error("Could not reload latest review."); accept((await response.json()).grill); setEditing(null); }
        catch (err) { setSaveError(String(err)); }
      }}>Reload latest and discard local edits</button>
    </> : <button type="button" disabled={saving} onClick={() => void flushChanges()}>Retry autosave</button>}</div></div>}

    {(error || review?.error) && <div className="grill-error" role="alert">
      <span>{error || review?.error}</span>
      <div><button type="button" disabled={busy} onClick={async () => {
        try { const response = await fetch(url); const data = await response.json(); if (!response.ok) throw new Error(data.error); accept(data.grill); setError(""); } catch (err) { setError(String(err)); }
      }}>Reload review</button>
      {review?.status === "error" && review.request && (review.request.action !== "followup" || canFollowUp) && <button type="button" disabled={locked} onClick={() => void act(review.request!.action, review.request!.prompt)}>Retry</button>}
      {!review && started && <button type="button" disabled={locked || mainBusy} onClick={() => void act("start")}>Retry Grill</button>}</div>
    </div>}

    {locked && <div className="grill-progress" role="status"><Loader2 className="spin" size={14} aria-hidden="true" />{loading ? "Loading review…" : activity}</div>}
    {review?.status === "ready" && !issues.length && <div className="grill-empty"><Check size={18} aria-hidden="true" /><div><strong>No material gaps found</strong><p>This turn is ready to move forward.</p></div></div>}

    {!!issues.length && <>
      <div className="grill-list-toolbar">
        <label><input type="checkbox" aria-label="Select all questions" checked={activeCount > 0 && selectedCount === activeCount} disabled={locked || !activeCount}
          ref={(element) => { if (element) element.indeterminate = selectedCount > 0 && selectedCount < activeCount; }}
          onChange={(event) => { queueIssues(issuesRef.current.map((issue) => ({ ...issue, selected: !issue.dropped && event.target.checked }))); void acknowledge(); }} />
          <span>{selectedCount} of {activeCount} selected</span>
        </label>
        <span className="grill-saved" role="status">{saving || (dirty && !saveError) ? <><Loader2 className="spin" size={12} aria-hidden="true" /> Saving…</> : saveError ? "Not saved" : <><Check size={12} aria-hidden="true" /> Saved</>}</span>
      </div>
      <div className="grill-question-list">
        {issues.map((issue, index) => {
          const questionRounds = replyRounds.filter((round) => round.issues.some((answer) => answer.id === issue.id && answer.selected && !answer.dropped && answer.responseMd.trim()));
          const replies = questionRounds.filter((round) => round === [...questionRounds].reverse().find((candidate) => candidate.action === round.action));
          return <article key={issue.id} className="grill-issue" data-dropped={issue.dropped ? "true" : undefined}>
          <input className="grill-question-select" type="checkbox" aria-label={`Question ${index + 1}`} checked={issue.selected && !issue.dropped} disabled={locked || issue.dropped}
            onChange={(event) => { queueIssues(issuesRef.current.map((candidate) => candidate.id === issue.id ? { ...candidate, selected: event.target.checked } : candidate)); void acknowledge(); }} />
          <div className="grill-issue-body">
            <div className="grill-issue-label"><span>{String(index + 1).padStart(2, "0")}</span>{issue.dropped ? <span>Dropped</span> : issue.status === "resolved" ? <span className="grill-resolved"><Check size={11} aria-hidden="true" /> Satisfied</span> : null}</div>
            {editing?.id === issue.id ? <div className="grill-edit">
              <textarea aria-label={`Edit question ${index + 1}`} value={editing.md} maxLength={16000} disabled={locked} autoFocus
                onBlur={() => { void flushChanges(); if (editing.md.trim()) setEditing(null); }}
                onChange={(event) => {
                  const md = event.target.value; setEditing({ id: issue.id, md });
                  queueIssues(issuesRef.current.map((current) => current.id === issue.id ? { ...current, md, status: "open" } : current), 400);
                }} />
              <small>Changes save automatically</small>
            </div> : <div className="grill-question"><MarkdownContent>{issue.md}</MarkdownContent></div>}
            {!issue.dropped && replies.map((reply) => <details className="grill-turn-response grill-question-response" open key={reply.id}>
              <summary><span>{reply.action === "followup" ? <Flame size={14} /> : <MessageSquare size={14} />}<strong>{reply.action === "followup" ? "Re-grill" : "Thread response"}</strong><span>Round {discussion.indexOf(reply) + 1}</span></span><ChevronDown size={14} /></summary>
              <div className="grill-turn-response-content grill-answer"><MarkdownContent>{reply.issues.find((answer) => answer.id === issue.id)!.responseMd}</MarkdownContent></div>
            </details>)}
          </div>
          <div className="grill-item-tools">
            {!issue.dropped && issue.responseMd.trim() && <button className="grill-icon-button" type="button"
              title={issue.status === "resolved" ? "Reopen question" : "Mark response satisfied"}
              aria-label={issue.status === "resolved" ? `Reopen question ${index + 1}` : `Mark response ${index + 1} satisfied`}
              disabled={locked || !!editing} onClick={() => queueIssues(issuesRef.current.map((current) => current.id === issue.id
                ? { ...current, status: current.status === "resolved" ? "open" : "resolved" } : current))}>
              {issue.status === "resolved" ? <RotateCcw size={13} /> : <Check size={13} />}
            </button>}
            {!issue.dropped && <button className="grill-icon-button" type="button" title="Edit question" aria-label={`Edit question ${index + 1}`} disabled={locked} onClick={() => setEditing({ id: issue.id, md: issue.md })}><Pencil size={13} aria-hidden="true" /></button>}
            <button className="grill-icon-button" type="button" title={issue.dropped ? "Restore question" : "Drop irrelevant question"} aria-label={issue.dropped ? "Restore" : "Drop"} disabled={locked || editing?.id === issue.id} onClick={() => void dropOrRestore(issue)}>
              {issue.dropped ? <RotateCcw size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />}
            </button>
          </div>
        </article>; })}
      </div>
    </>}

    {!!issues.length && <div className="grill-compose">
      <label htmlFor={promptId}>Continue this review</label>
      <p className="grill-selection-hint">Select questions for your next request. Re-grill reviews answers and can add new questions; satisfied questions are skipped. Editing a question reopens it.</p>
      <textarea id={promptId} value={prompt} maxLength={8000} disabled={locked} rows={2} placeholder="Add context, ask a question, or give instructions for the next turn…" onChange={(event) => setPrompt(event.target.value)} />
      <div className="grill-compose-actions">
        <div>
      {grillAwaitingAck(review) && <button type="button" disabled={busy || saving} onClick={() => void acknowledge()}><Eye size={13} aria-hidden="true" /> Ack</button>}
          <button className="grill-button-primary" type="button" disabled={locked || !selectedCount || !!editing} onClick={() => void act("respond", prompt)}><Send size={13} aria-hidden="true" /> Ask thread</button>
          {canFollowUp && <button type="button" disabled={locked || !!editing || !!conflicts.length} onClick={() => void act("followup", prompt)}><Flame size={13} aria-hidden="true" /> Re-grill</button>}
        </div>
        <button className="grill-implement" type="button" disabled={locked || mainBusy || !selectedCount || !!editing} onClick={async () => {
          const observedVersion = grillContentVersion(reviewRef.current);
          const saved = await flushChanges();
          if (saved) { setBusy(true); setActivity("Main thread is working…"); try { await onImplement(grillHandoff(saved.issues, prompt, saved.rounds), { turnId, observedVersion }); setPrompt(""); } catch (err) { setError(String(err)); } finally { setBusy(false); } }
        }}>Start work <ArrowUpRight size={14} aria-hidden="true" /></button>
      </div>
    </div>}

  </section>{historyOpen && <GrillHistoryDialog id={historyId} rounds={review?.rounds ?? []} onClose={() => setHistoryOpen(false)} />}</>;
}
