import { useContext, useEffect, useRef, useState } from "react";
import { SessionHeaderTarget } from "./sessionHeaderTarget";
import { createPortal } from "react-dom";
import { CheckCircle2, ClipboardCheck, CircleHelp, Users, Loader2, MessageSquare, Repeat, Scale, X } from "lucide-react";
import { MODEL_OPTIONS, modelLabel, normalizeModelEffort } from "../modelCatalog";
import { ROUNDTABLE_TASK_LABELS, newRoundtableActor, roundtableEfforts, roundtableIssueKind, roundtableRunning, roundtableStatus, type RoundtableActor, type RoundtableIssueKind, type RoundtableRound, type RoundtableConclusion } from "../roundtable";
import { apiJson } from "./apiClient";
import { defaultRoundtableActors, syncRoundtableDraftAvatars, roundtableLibraryEndpoint, type RoundtableLibrary, type RoundtablePreset } from "../roundtablePresets";
import { ActorMultiSelect } from "./ActorMultiSelect";
import { MarkdownContent } from "./MarkdownContent";
import { ActorAvatar } from "./ActorAvatar";
import { RoundtableActorsPanel } from "./RoundtableActorsPanel";
import "./Roundtable.css";

type Draft = { enabled: boolean; actors: RoundtableActor[] };
const draftKey = (workspaceId: string | null, sessionId: string | null) => `threadex.roundtable:${workspaceId ?? "default"}:${sessionId ?? "new"}`;
function readDraft(key: string): Draft | null {
  try { const value = JSON.parse(localStorage.getItem(key) ?? "null"); return value && Array.isArray(value.actors) ? { enabled: false, actors: value.actors } : null; }
  catch { return null; }
}
// Remember the cast, but require an explicit toggle for each prompt.
function saveDraft(key: string, draft: Draft) { try { localStorage.setItem(key, JSON.stringify({ actors: draft.actors })); } catch { /* The in-memory draft still works. */ } }

export function useRoundtable({ sessionId, workspaceId, gearProfiles, onChanged }: {
  sessionId: string | null; workspaceId: string | null; gearProfiles: { model: string; effort: string }[];
  onChanged: (sessionId: string, turnId: string) => void;
}) {
  const key = draftKey(workspaceId, sessionId);
  const [draft, setDraft] = useState<{ key: string; value: Draft | null }>(() => ({ key, value: readDraft(key) }));
  const [view, setView] = useState<{ sessionId: string | null; rounds: RoundtableRound[] }>({ sessionId, rounds: [] });
  const [error, setError] = useState("");
  const [continuing, setContinuing] = useState(false);
  const [nextRoundError, setNextRoundError] = useState("");
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<RoundtablePreset[]>([]);
  const [libraryError, setLibraryError] = useState("");
  const loadingLibrary = useRef(false);
  const currentKey = useRef(key); currentKey.current = key;
  async function loadPresets() {
    const library = await apiJson<RoundtableLibrary>(roundtableLibraryEndpoint, { fresh: true });
    setPresets(library.actors); setLibraryError(""); return library.actors;
  }
  useEffect(() => {
    const refresh = () => { void loadPresets().catch(cause => setLibraryError(cause instanceof Error ? cause.message : String(cause))); };
    refresh(); window.addEventListener("roundtable-library-changed", refresh);
    return () => window.removeEventListener("roundtable-library-changed", refresh);
  }, []);
  useEffect(() => {
    if (open) void loadPresets().catch(cause => setLibraryError(cause instanceof Error ? cause.message : String(cause)));
  }, [open]);
  const [refreshToken, setRefreshToken] = useState(0);
  const callback = useRef(onChanged); callback.current = onChanged;
  const latest = useRef<{ key: string; revision: string }>({ key, revision: "" });
  const value = draft.key === key ? draft.value : readDraft(key);
  const rounds = view.sessionId === sessionId ? view.rounds : [];
  const enabled = value?.enabled ?? false;
  const actors = syncRoundtableDraftAvatars(value?.actors ?? [], presets);
  useEffect(() => {
    if (value && actors !== value.actors) {
      const updated = { ...value, actors };
      saveDraft(key, updated); setDraft({ key, value: updated });
    }
  }, [key, value, actors]);
  useEffect(() => { setDraft({ key, value: readDraft(key) }); setOpen(false); setError(""); setNextRoundError(""); }, [key]);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    // Load once per session; keep polling only while a round is unfinished.
    // Submitting a round calls refresh(), which restarts this effect.
    let pending = true;
    async function poll() {
      try {
        const data = await apiJson<{ rounds: RoundtableRound[] }>(`/api/roundtable/sessions/${encodeURIComponent(sessionId!)}`, { signal: controller.signal, fresh: true });
        if (controller.signal.aborted) return;
        pending = data.rounds.some(round => roundtableRunning(round) || round.status === "queued");
        setView({ sessionId, rounds: data.rounds });
        const last = data.rounds.at(-1);
        if (!readDraft(key) && last) {
          const restored = { enabled: false, actors: last.answers.map(answer => answer.actor) };
          saveDraft(key, restored); setDraft({ key, value: restored });
        }
        const revision = data.rounds.map(round => `${round.turnId}:${round.revision}`).join("|");
        if (last && (latest.current.key !== key || latest.current.revision !== revision)) callback.current(sessionId!, last.turnId);
        latest.current = { key, revision };
        setError("");
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (!controller.signal.aborted && pending) timer = setTimeout(() => void poll(), 1500); }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key, sessionId, refreshToken]);
  const change = (next: Draft) => { saveDraft(key, next); setDraft({ key, value: next }); };
  /** Same actors continue the latest round's topic without a new user prompt. */
  const nextRound = async (round: RoundtableRound) => {
    if (continuing) return;
    setContinuing(true); setNextRoundError("");
    try {
      await apiJson(`/api/roundtable/sessions/${encodeURIComponent(round.sessionId)}/turns/${encodeURIComponent(round.turnId)}/next`, { method: "POST", body: { turnId: `rt_${crypto.randomUUID()}` } });
      setRefreshToken(token => token + 1);
    } catch (cause) { setNextRoundError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setContinuing(false); }
  };
  const toggle = async () => {
    if (loadingLibrary.current) return;
    const next = !enabled;
    if (actors.length) { change({ enabled: next, actors }); setOpen(next); return; }
    loadingLibrary.current = true;
    try {
      const saved = await loadPresets();
      if (currentKey.current !== key) return;
      change({ enabled: next, actors: defaultRoundtableActors(saved, gearProfiles) }); setOpen(next);
    } catch (cause) { setLibraryError(cause instanceof Error ? cause.message : String(cause)); }
    finally { loadingLibrary.current = false; }
  };
  return { enabled, actors, rounds, error: libraryError || error, open, setOpen, toggle, presets,
    resetNewTask: () => {
      const newKey = draftKey(workspaceId, null);
      const next = { enabled: false, actors: readDraft(newKey)?.actors ?? [] };
      saveDraft(newKey, next);
      if (!sessionId) setDraft({ key: newKey, value: next });
      setOpen(false);
    },
    setActors: (next: RoundtableActor[]) => change({ enabled, actors: next }),
    disable: () => { if (enabled) change({ enabled: false, actors }); },
    adopt: (id: string) => {
      const next = { enabled: false, actors };
      saveDraft(draftKey(workspaceId, id), next);
      if (currentKey.current === key) { change(next); setOpen(false); }
      if (!sessionId) { try { localStorage.removeItem(key); } catch { /* Optional draft cleanup. */ } }
    },
    refresh: () => setRefreshToken(token => token + 1),
    skip: async (round: RoundtableRound, actorId: string) => {
      try {
        await apiJson(`/api/roundtable/sessions/${encodeURIComponent(round.sessionId)}/turns/${encodeURIComponent(round.turnId)}/actors/${encodeURIComponent(actorId)}/skip`, { method: "POST", body: {} });
        setRefreshToken(token => token + 1);
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    },
    retry: async (round: RoundtableRound) => {
      try {
        await apiJson(`/api/roundtable/sessions/${encodeURIComponent(round.sessionId)}/turns/${encodeURIComponent(round.turnId)}/retry`, { method: "POST", body: { revision: round.revision } });
        setRefreshToken(token => token + 1);
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    },
    nextRoundFor: (round: RoundtableRound) => rounds.at(-1)?.turnId === round.turnId && round.status === "done"
      ? { run: () => void nextRound(round), busy: continuing, error: nextRoundError } : undefined
  };
}
export type RoundtableController = ReturnType<typeof useRoundtable>;

export function RoundtableSettings({ controller }: { controller: RoundtableController }) {
  const headerTarget = useContext(SessionHeaderTarget);
  const [editing, setEditing] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [anchor, setAnchor] = useState<Element | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { setAnchor(headerTarget === undefined ? document.querySelector(".content-header-actions") : headerTarget); }, [headerTarget]);
  useEffect(() => {
    if (!controller.open) return;
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) controller.setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !libraryOpen) { controller.setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("mousedown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [controller.open, libraryOpen]);
  if (!anchor || (!controller.enabled && !controller.rounds.length)) return null;
  const latest = controller.rounds.at(-1);
  const working = latest && (roundtableRunning(latest) || latest.status === "queued");
  const change = (id: string, update: Partial<RoundtableActor>) => controller.setActors(controller.actors.map(actor => actor.id === id ? { ...actor, ...update } : actor));
  return createPortal(<div className="roundtable-widget" ref={root}>
    <button type="button" ref={trigger} className="roundtable-trigger" aria-label="Round table settings" aria-haspopup="dialog" aria-expanded={controller.open}
      data-active={controller.enabled} onClick={() => controller.setOpen(!controller.open)}>
      {working ? <Loader2 className="spin" aria-hidden="true" /> : <Users aria-hidden="true" />}<span>Round table</span><small>{controller.actors.length}</small>
    </button>
    {controller.open && <section className="roundtable-settings" role="dialog" aria-label="Round table settings">
      <header><div><strong>Round table</strong><p>{working ? roundtableStatus(latest) : "Independent actors · One host response"}</p></div>
        <button type="button" onClick={() => controller.setOpen(false)} aria-label="Close round table settings"><X /></button></header>
      <div className="roundtable-settings-body">
        <p>Send the topic in the composer. Actors discuss independently; the host brings their points together.</p>
        <p className="roundtable-note">The host identifies the task first: Decision compares choices and differences; Summary brings together code review findings, research and ideas.</p>
        <p className="roundtable-note">Actors can read host context, search the web and verify ideas in a private scratch directory. They cannot implement project changes. Enable Round table for each prompt; it turns off after sending. Your actors are remembered.</p>
        {controller.error && <p role="alert">{controller.error}</p>}
        <ActorMultiSelect actors={controller.actors} presets={controller.presets} onChange={controller.setActors}
          onManage={() => setLibraryOpen(true)} min={2} />
        <details className="roundtable-customise-actors"><summary>Customise selected actors</summary>
        <div className="roundtable-actor-grid" aria-label="Selected actors">
          {controller.actors.map((actor, index) => <div className="roundtable-actor-tile" key={actor.id}>
            <button type="button" className="roundtable-actor-select" aria-label={`Edit actor ${index + 1}`} aria-expanded={editing === actor.id} onClick={() => setEditing(editing === actor.id ? null : actor.id)}>
              <ActorAvatar actor={actor} /><strong>{actor.name}</strong><small>{modelLabel(actor.model)} · {actor.effort}</small>
            </button>
          </div>)}
        </div>
        {controller.actors.map((actor, index) => editing === actor.id && <fieldset key={actor.id}><legend>Actor {index + 1}</legend>
          <label>Name<input aria-label={`Actor ${index + 1} name`} maxLength={80} value={actor.name} onChange={event => change(actor.id, { name: event.target.value })} /></label>
          <label>Model<select aria-label={`Actor ${index + 1} model`} value={actor.model} onChange={event => change(actor.id, { model: event.target.value, effort: normalizeModelEffort(event.target.value, actor.effort) })}>{MODEL_OPTIONS.map(model => <option key={model} value={model}>{modelLabel(model)}</option>)}</select></label>
          <label>Effort<select aria-label={`Actor ${index + 1} effort`} value={actor.effort} onChange={event => change(actor.id, { effort: event.target.value })}>{roundtableEfforts(actor.model).map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label>
          <label>System prompt<textarea aria-label={`Actor ${index + 1} system prompt`} rows={3} maxLength={8000} value={actor.systemPrompt} onChange={event => change(actor.id, { systemPrompt: event.target.value })} /></label>
        </fieldset>)}
        </details>
        {latest && <RoundtableTurn round={latest} onRetry={() => void controller.retry(latest)} nextRound={controller.nextRoundFor(latest)} />}
      </div>
    </section>}
    {libraryOpen && <RoundtableLibraryPopup onClose={() => setLibraryOpen(false)} />}
  </div>, anchor);
}

export function RoundtableLibraryPopup({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="roundtable-library-popup" aria-label="Agent actor settings" onCancel={onClose}>
    <header><span>Settings / Agent actors</span><button type="button" aria-label="Close actor settings" onClick={onClose}><X size={18} /></button></header>
    <RoundtableActorsPanel addNew />
  </dialog>;
}

function RoundtableAnswers({ round, onSkip }: { round: RoundtableRound; onSkip?: (actorId: string) => Promise<void> }) {
  const [skipping, setSkipping] = useState<string[]>([]);
  return round.answers.map(answer => <details key={answer.actor.id} className="roundtable-answer">
    <summary><ActorAvatar actor={answer.actor} /><span>{answer.actor.name}</span><small>{modelLabel(answer.actor.model)} · {answer.actor.effort}</small><span data-status={answer.status}>{answer.status === "running" ? "Thinking…" : answer.status}</span>
      {onSkip && ["actors", "error"].includes(round.status) && ["running", "error"].includes(answer.status) && <button type="button" aria-label={`Skip ${answer.actor.name}`} disabled={skipping.includes(answer.actor.id)} onClick={event => {
        event.preventDefault(); event.stopPropagation();
        setSkipping(ids => [...ids, answer.actor.id]);
        void onSkip(answer.actor.id).finally(() => setSkipping(ids => ids.filter(id => id !== answer.actor.id)));
      }}>{skipping.includes(answer.actor.id) ? "Skipping…" : "Skip"}</button>}
    </summary>
    {answer.text && <MarkdownContent>{answer.text}</MarkdownContent>}
    {answer.error && <p role="alert">{answer.error}</p>}
    {answer.attempts?.map((attempt, index) => <p className="roundtable-activity" key={attempt.id}>
      <a href={`/api/roundtable/sessions/${encodeURIComponent(round.sessionId)}/turns/${encodeURIComponent(round.turnId)}/attempts/${encodeURIComponent(attempt.id)}/log`} target="_blank" rel="noreferrer">Activity log · Attempt {index + 1}</a>
      {` · ${attempt.status} · ${attempt.eventCount} events · Last activity: `}<time dateTime={attempt.lastActivityAt}>{new Date(attempt.lastActivityAt).toLocaleString()}</time>
    </p>)}
  </details>);
}

const SYNTHESIS_GROUPS: { kind: RoundtableIssueKind; title: string; Icon: typeof Scale }[] = [
  { kind: "consensus", title: "Consensus", Icon: CheckCircle2 },
  { kind: "disagreement", title: "Disagreements", Icon: Scale },
  { kind: "partial", title: "Other points", Icon: MessageSquare }
];

type NextRound = { run: () => void; busy: boolean; error: string };
function NextRoundButton({ nextRound }: { nextRound?: NextRound }) {
  if (!nextRound) return null;
  return <>
    <button type="button" className="roundtable-next" disabled={nextRound.busy} onClick={nextRound.run}
      title="Actors respond to each other's answers without a new prompt">
      {nextRound.busy ? <Loader2 className="spin" aria-hidden="true" /> : <Repeat aria-hidden="true" />}Next round
    </button>
    {nextRound.error && <p className="roundtable-error" role="alert">{nextRound.error}</p>}
  </>;
}

function RoundtableContextButton({ round }: { round: RoundtableRound }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, [open]);
  return <>
    <button type="button" className="roundtable-context-button" aria-haspopup="dialog" onClick={() => setOpen(true)}>Context</button>
    {open && createPortal(<dialog ref={dialog} className="roundtable-context-popup" aria-label="Round table context"
      onCancel={() => setOpen(false)} onClose={() => setOpen(false)} onClick={event => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) setOpen(false);
      }}>
      <header><strong>Round table context</strong><button type="button" aria-label="Close round table context" onClick={() => setOpen(false)}><X size={18} /></button></header>
      <div className="roundtable-context-body">{round.context?.trim()
        ? <MarkdownContent>{round.context}</MarkdownContent>
        : <p>No context was saved for this round.</p>}</div>
    </dialog>, document.body)}
  </>;
}

function RoundtableSynthesisCard({ round, synthesis, nextRound }: { round: RoundtableRound; synthesis: RoundtableConclusion; nextRound?: NextRound }) {
  const completed = round.answers.filter(answer => answer.status === "done");
  const actors = new Map(round.answers.map(answer => [answer.actor.name, answer.actor]));
  const actorOrder = new Map(round.answers.map((answer, index) => [answer.actor.name, index]));
  const rank = (names: string[]) => Math.min(...names.map(name => actorOrder.get(name) ?? Infinity));
  const byActors = <T extends { actors: string[] },>(items: T[]) => [...items].sort((a, b) => rank(a.actors) - rank(b.actors));
  const tags = (names: string[], label = synthesis.template === "summary" ? "Contributors" : "Supported by") => <span className="roundtable-supporters" aria-label={label}>{[...names].sort((a, b) => rank([a]) - rank([b])).map(name => <span key={name} className="roundtable-supporter">
    {actors.has(name) && <ActorAvatar actor={actors.get(name)!} />}{name}</span>)}</span>;
  return <section className="roundtable-turn roundtable-synthesis" aria-label="Round table synthesis" data-status={round.status} data-template={synthesis.template ?? "decision"}>
    <header><Users aria-hidden="true" /><strong>Round table</strong><small>{round.answers.length} actors · {synthesis.template === "summary" ? `${synthesis.sections.reduce((count, section) => count + section.items.length, 0)} points` : `${synthesis.issues.length} topics`}</small>
      <span className="roundtable-template">{ROUNDTABLE_TASK_LABELS[synthesis.taskType ?? "decision"]}{synthesis.template === "summary" && synthesis.taskType !== "summary" ? " · Summary" : ""}</span>
      <RoundtableContextButton round={round} />
      <span className="roundtable-cast">{round.answers.map(answer => <ActorAvatar key={answer.actor.id} actor={answer.actor} />)}</span></header>
    {synthesis.template === "summary" ? <>
      <MarkdownContent className="roundtable-overview">{synthesis.overview}</MarkdownContent>
      {synthesis.sections.map((section, index) => <section key={index} className="roundtable-group roundtable-summary-group" aria-label={section.title}>
        <h4>{section.title}<small>{section.items.length}</small></h4>
        <ul>{section.items.map((item, itemIndex) => <li key={itemIndex} className="roundtable-summary-item">
          <MarkdownContent>{item.text}</MarkdownContent>{tags(item.actors)}
        </li>)}</ul>
      </section>)}
    </> : SYNTHESIS_GROUPS.map(({ kind, title, Icon }) => {
      const issues = synthesis.issues.filter(issue => roundtableIssueKind(issue, completed.length) === kind);
      return issues.length > 0 && <section key={kind} className="roundtable-group" data-kind={kind} aria-label={title}>
        <h4><Icon aria-hidden="true" />{title}<small>{issues.length}</small></h4>
        <ul>{issues.map((issue, index) => <li key={index} className="roundtable-issue">
          <MarkdownContent className="roundtable-topic">{issue.topic}</MarkdownContent>
          <div className="roundtable-positions">{byActors(issue.positions).map(position => <div key={position.view} className="roundtable-position">
            <div className="roundtable-view">{tags(position.actors)}<span>：</span><MarkdownContent>{position.view}</MarkdownContent></div>
            {byActors(position.details ?? []).map((item, detailIndex) => <div className="roundtable-detail" key={detailIndex}>
              {tags(item.actors)}<span>：</span><MarkdownContent>{item.detail}</MarkdownContent>
            </div>)}
          </div>)}</div>
          {completed.some(answer => !issue.positions.some(position => position.actors.includes(answer.actor.name))) &&
            <p className="roundtable-unaddressed">No position recorded: {completed.filter(answer => !issue.positions.some(position => position.actors.includes(answer.actor.name))).map(answer => answer.actor.name).join(", ")}</p>}
        </li>)}</ul>
      </section>;
    })}
    {synthesis.template !== "summary" && [
      { kind: "questions", title: "Open questions", label: "Raised by", Icon: CircleHelp, notes: synthesis.openQuestions },
      { kind: "scope", title: "Verification scope", label: "Reported by", Icon: ClipboardCheck, notes: synthesis.scope }
    ].map(({ kind, title, label, Icon, notes }) => notes && notes.length > 0 && <section key={kind} className="roundtable-group" data-kind={kind} aria-label={title}>
      <h4><Icon aria-hidden="true" />{title}<small>{notes.length}</small></h4>
      <ul>{byActors(notes).map((note, index) => <li key={index} className="roundtable-detail">
        {tags(note.actors, label)}<span>：</span><MarkdownContent>{note.text}</MarkdownContent>
      </li>)}</ul>
    </section>)}
    <details className="roundtable-responses"><summary>Actor responses ({round.answers.length})</summary><RoundtableAnswers round={round} /></details>
    <NextRoundButton nextRound={nextRound} />
  </section>;
}

/** `nextRound` is offered only for the session's latest completed round. */
export function RoundtableTurn({ round, onRetry, onSkip, nextRound }: { round: RoundtableRound; onRetry: () => void; onSkip?: (actorId: string) => Promise<void>; nextRound?: NextRound }) {
  if (round.status === "done" && round.synthesis) return <RoundtableSynthesisCard round={round} synthesis={round.synthesis} nextRound={nextRound} />;
  const working = roundtableRunning(round);
  return <section className="roundtable-turn" aria-label="Round table progress" data-status={round.status}>
    <header>{working ? <Loader2 className="spin" aria-hidden="true" /> : <Users aria-hidden="true" />}<strong>Round table</strong><span role="status">{roundtableStatus(round)}</span>{round.status === "done" && <RoundtableContextButton round={round} />}</header>
    <ol className="roundtable-stages"><li data-active={round.status === "context"}>Preparing context</li><li data-active={round.status === "actors"}>Actors thinking</li><li data-active={round.status === "host"}>Concluding</li></ol>
    <RoundtableAnswers round={round} onSkip={onSkip} />
    {round.error && <p className="roundtable-error" role="alert">{round.error}</p>}
    {["error", "stopped"].includes(round.status) && <button type="button" onClick={onRetry}>Retry unfinished work</button>}
    {round.status === "done" && <NextRoundButton nextRound={nextRound} />}
  </section>;
}
