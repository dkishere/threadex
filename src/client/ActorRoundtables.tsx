import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, MessageCircle, RotateCcw, Users } from "lucide-react";
import { actorRoundtablesPath, type ActorRoundtable, type ActorRoundtableView } from "../actorRoundtables";
import type { RoundtableActor } from "../roundtable";
import { defaultRoundtableActors, roundtableLibraryEndpoint, syncRoundtableDraftAvatars, type RoundtableLibrary, type RoundtablePreset } from "../roundtablePresets";
import { apiJson } from "./apiClient";
import { ActorMultiSelect } from "./ActorMultiSelect";
import { RoundtableLibraryPopup } from "./Roundtable";
import { actorRoundtableActive, actorRoundtableRequest, actorRoundtableStateLabel, mergeActorRoundtables, parseActorRoundtableReceipts,
  type ActorRoundtableLink, type ActorRoundtableReceipt } from "./actorRoundtablePresentation";
import "./Roundtable.css";

const POLL_MS = 3000;
const receiptsKey = (workspaceId: string) => `threadex.actorRoom.roundtables:${workspaceId}`;
const actorsKey = (workspaceId: string) => `threadex.actorRoom.roundtableActors:${workspaceId}`;
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function readActors(workspaceId: string): RoundtableActor[] {
  try { const value = JSON.parse(localStorage.getItem(actorsKey(workspaceId)) ?? "null"); return Array.isArray(value) ? value : []; }
  catch { return []; }
}

/**
 * Group chat round table mode, like the session composer's: the cast is
 * remembered per workspace, the mode is enabled for one prompt at a time.
 */
export function useActorRoundtableDraft(workspaceId: string, gears: { model: string; effort?: string }[], active = true) {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState(() => ({ workspaceId, actors: readActors(workspaceId) }));
  const [presets, setPresets] = useState<RoundtablePreset[]>([]);
  const [error, setError] = useState("");
  const loading = useRef(false);
  const stored = state.workspaceId === workspaceId ? state.actors : readActors(workspaceId);
  const actors = syncRoundtableDraftAvatars(stored, presets);
  const loadPresets = useCallback(async () => {
    const library = await apiJson<RoundtableLibrary>(roundtableLibraryEndpoint, { fresh: true });
    setPresets(library.actors); setError(""); return library.actors;
  }, []);
  useEffect(() => {
    if (!active) return;
    const refresh = () => { void loadPresets().catch(cause => setError(message(cause))); };
    refresh(); window.addEventListener("roundtable-library-changed", refresh);
    return () => window.removeEventListener("roundtable-library-changed", refresh);
  }, [loadPresets, active]);
  useEffect(() => { setEnabled(false); setState({ workspaceId, actors: readActors(workspaceId) }); }, [workspaceId]);
  const setActors = (next: RoundtableActor[]) => {
    try { localStorage.setItem(actorsKey(workspaceId), JSON.stringify(next)); } catch { /* The in-memory cast still works. */ }
    setState({ workspaceId, actors: next });
  };
  async function toggle() {
    if (enabled) { setEnabled(false); return; }
    if (actors.length >= 2) { setEnabled(true); return; }
    if (loading.current) return;
    loading.current = true;
    try { setActors(defaultRoundtableActors(await loadPresets(), gears)); setEnabled(true); }
    // Without the library, gear models fill the cast, as in the session round table; the panel shows the error.
    catch (cause) { setError(message(cause)); setActors(defaultRoundtableActors([], gears)); setEnabled(true); }
    finally { loading.current = false; }
  }
  return { enabled, actors, presets, error, toggle, setActors, disable: () => setEnabled(false) };
}
export type ActorRoundtableDraft = ReturnType<typeof useActorRoundtableDraft>;

/**
 * Round tables started from the group chat. Room links say which exist; the
 * list route adds state, read again while any is queued or running because
 * progress does not change the room revision.
 */
export function useActorRoundtables(workspaceId: string, links: ActorRoundtable[] | undefined, revision: number | undefined) {
  const path = actorRoundtablesPath(workspaceId);
  const [views, setViews] = useState<{ workspaceId: string; items: ActorRoundtableView[] }>({ workspaceId, items: [] });
  const [receipts, setReceiptsValue] = useState(() => ({ workspaceId, items: parseActorRoundtableReceipts(readStorage(receiptsKey(workspaceId))) }));
  const [sending, setSending] = useState<string[]>([]);
  const [readError, setReadError] = useState("");
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  const [token, setToken] = useState(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const items = views.workspaceId === workspaceId ? views.items : [];
  const pending = receipts.workspaceId === workspaceId ? receipts.items : parseActorRoundtableReceipts(readStorage(receiptsKey(workspaceId)));
  const merged = mergeActorRoundtables(links, items);
  const active = merged.some(link => actorRoundtableActive(link.view?.state));
  const linkKey = (links ?? []).map(link => link.requestId).join("|");
  useEffect(() => {
    setReceiptsValue({ workspaceId, items: parseActorRoundtableReceipts(readStorage(receiptsKey(workspaceId))) });
  }, [workspaceId]);
  const activeRef = useRef(active); activeRef.current = active;
  useEffect(() => {
    // Read when the room links a round table, again when the room changes, and keep polling while any is unfinished.
    if (revision === undefined || !linkKey) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const data = await apiJson<{ roundtables: ActorRoundtableView[] }>(path, { fresh: true, signal: controller.signal });
        if (controller.signal.aborted) return;
        const list = Array.isArray(data?.roundtables) ? data.roundtables : [];
        setViews({ workspaceId, items: list }); setReadError("");
        if (list.some(view => actorRoundtableActive(view.state))) timer = setTimeout(() => void read(), POLL_MS);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setReadError(message(cause));
        if (activeRef.current) timer = setTimeout(() => void read(), POLL_MS);
      }
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [path, workspaceId, linkKey, revision, token]);
  function setReceipts(update: (items: ActorRoundtableReceipt[]) => ActorRoundtableReceipt[]) {
    const key = receiptsKey(workspaceId);
    const next = update(parseActorRoundtableReceipts(readStorage(key)));
    try { if (next.length) sessionStorage.setItem(key, JSON.stringify(next)); else sessionStorage.removeItem(key); } catch { /* Kept in memory. */ }
    if (mounted.current) setReceiptsValue({ workspaceId, items: next });
  }
  // A link in the room acknowledges a request whose response was lost.
  const delivered = pending.filter(receipt => merged.some(link => link.requestId === receipt.requestId));
  useEffect(() => {
    if (delivered.length) setReceipts(list => list.filter(receipt => !delivered.some(item => item.requestId === receipt.requestId)));
  }, [delivered.map(receipt => receipt.requestId).join("|")]);
  async function submit(receipt: ActorRoundtableReceipt): Promise<ActorRoundtableView | null> {
    if (inFlight.current.has(receipt.requestId)) return null;
    inFlight.current.add(receipt.requestId); setSending([...inFlight.current]);
    setReceipts(list => list.map(item => item.requestId === receipt.requestId ? { ...item, error: undefined } : item));
    try {
      // The same request ID makes an uncertain-delivery retry return the same round table.
      const view = await apiJson<ActorRoundtableView>(path, { method: "POST", body: actorRoundtableRequest(receipt) });
      setReceipts(list => list.filter(item => item.requestId !== receipt.requestId));
      if (mounted.current) {
        setViews(current => ({ workspaceId, items: [view, ...(current.workspaceId === workspaceId ? current.items : []).filter(item => item.requestId !== view.requestId)] }));
        setToken(value => value + 1);
      }
      return view;
    } catch (cause) {
      setReceipts(list => list.map(item => item.requestId === receipt.requestId ? { ...item, error: message(cause) } : item));
      return null;
    } finally { inFlight.current.delete(receipt.requestId); if (mounted.current) setSending([...inFlight.current]); }
  }
  return {
    // A read failure matters only when there is something to show.
    links: merged, error: merged.length || pending.length ? readError : "", sending,
    receipts: pending.filter(receipt => !delivered.includes(receipt)),
    start: (input: Omit<ActorRoundtableReceipt, "requestId" | "created">) => {
      const receipt: ActorRoundtableReceipt = { ...input, requestId: crypto.randomUUID(), created: new Date().toISOString() };
      setReceipts(list => [...list, receipt]);
      return submit(receipt);
    },
    retry: submit,
    discard: (requestId: string) => setReceipts(list => list.filter(item => item.requestId !== requestId))
  };
}
function readStorage(key: string) { try { return sessionStorage.getItem(key); } catch { return null; } }

/** Group chat keeps only this reference; the discussion itself runs in the linked session. */
export function ActorRoundtableCard({ link, onOpen }: { link: ActorRoundtableLink; onOpen: (sessionId: string) => void }) {
  const state = link.view?.state;
  const unavailable = state === "missing" || !link.sessionId.trim();
  return <section className="actor-room-round actor-roundtable-entry" aria-label="Round table" data-request-id={link.requestId}>
    <button type="button" className="actor-roundtable-card" data-state={state ?? "loading"} disabled={unavailable}
      title={unavailable ? "This round table session is no longer available" : "Open the round table session"}
      onClick={() => onOpen(link.sessionId)}>
      <span className="actor-roundtable-card-head"><Users aria-hidden="true" /><span>Round table · own session</span>
        <span className="actor-roundtable-state" data-state={state ?? "loading"} role="status">
          {(actorRoundtableActive(state) || !state) && <Loader2 className="spin" aria-hidden="true" />}{actorRoundtableStateLabel(state)}</span></span>
      <strong className="actor-roundtable-title">{link.title || "Round table"}</strong>
      {!!link.actorNames.length && <span className="actor-roundtable-participants">{link.actorNames.join(", ")}</span>}
      {link.view?.conclusion && <span className="actor-roundtable-conclusion">{link.view.conclusion}</span>}
      {link.view?.error && <span className="actor-roundtable-error">{link.view.error}</span>}
      <span className="actor-roundtable-open">{!unavailable && <><ExternalLink aria-hidden="true" />Open session</>}
        {link.view && link.view.rounds > 1 && <small>{link.view.rounds} rounds</small>}</span>
    </button>
  </section>;
}

export function ActorRoundtableReceiptCard({ receipt, sending, onRetry, onDiscard }: {
  receipt: ActorRoundtableReceipt; sending: boolean; onRetry: () => void; onDiscard: () => void;
}) {
  return <section className="actor-room-round actor-roundtable-entry" aria-label="Round table delivery" data-request-id={receipt.requestId}>
    <div className="actor-roundtable-card" data-state={receipt.error ? "error" : "queued"}>
      <span className="actor-roundtable-card-head"><Users aria-hidden="true" /><span>Round table · own session</span></span>
      <strong className="actor-roundtable-title">{receipt.message}</strong>
      <span className="actor-roundtable-participants">{receipt.actors.map(actor => actor.name).join(", ")}</span>
      {receipt.error ? <p role="alert" className="actor-room-error">{receipt.error} Your round table request is saved.</p>
        : <p className="side-chat-state" role="status"><Loader2 className="spin" aria-hidden="true" />{sending ? "Opening round table session…" : "Confirming round table…"}</p>}
      {!sending && <span className="actor-roundtable-actions">
        <button type="button" className="secondary" aria-label="Retry same request" title="Retry same request" onClick={onRetry}><RotateCcw aria-hidden="true" />Retry</button>
        {receipt.error && <button type="button" className="secondary" onClick={onDiscard}>Discard</button>}
      </span>}
    </div>
  </section>;
}

/** The same cast picker as the session round table, inside the group chat composer. */
export function ActorRoundtableComposerPanel({ draft, disabled }: { draft: ActorRoundtableDraft; disabled?: boolean }) {
  const [libraryOpen, setLibraryOpen] = useState(false);
  return <div className="actor-room-roundtable" role="group" aria-label="Round table actors">
    <p><Users aria-hidden="true" />Round table opens in a new session. This chat keeps a link to it.</p>
    {draft.error && <p role="alert" className="actor-room-error">{draft.error}</p>}
    <ActorMultiSelect actors={draft.actors} presets={draft.presets} onChange={draft.setActors} onManage={() => setLibraryOpen(true)} min={2} disabled={disabled} />
    {libraryOpen && <RoundtableLibraryPopup onClose={() => setLibraryOpen(false)} />}
  </div>;
}

/** Inside a session started from the group chat: a way back to the chat that started it. */
export function ActorRoundtableSourceLink({ workspaceId, sessionId, onOpen }: { workspaceId: string; sessionId: string; onOpen: () => void }) {
  const [source, setSource] = useState<{ sessionId: string; roundtable: ActorRoundtableView | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void apiJson<{ roundtable: ActorRoundtableView | null }>(`${actorRoundtablesPath(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`, { fresh: true, signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setSource({ sessionId, roundtable: data.roundtable && data.roundtable.sessionId === sessionId ? data.roundtable : null }); })
      .catch(() => { /* Without a source the session renders as usual. */ });
    return () => controller.abort();
  }, [workspaceId, sessionId]);
  const roundtable = source?.sessionId === sessionId ? source.roundtable : null;
  if (!roundtable) return null;
  return <button type="button" className="parent-session-link actor-roundtable-source" onClick={onOpen}
    title="Open the group chat that started this round table" aria-label="Open group chat that started this round table">
    <MessageCircle aria-hidden="true" /><span>From group chat</span>
  </button>;
}
