import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, Users, RotateCcw, Check } from "lucide-react";
import { DEFAULT_MODEL, MODEL_OPTIONS, modelLabel, normalizeModelEffort } from "../modelCatalog";
import { roundtableEfforts } from "../roundtable";
import { roundtableLibraryEndpoint, type RoundtableLibrary, type RoundtablePreset } from "../roundtablePresets";
import { apiJson } from "./apiClient";
import { ActorAvatarEditor } from "./ActorAvatar";
import { ACTOR_TYPE_LABELS } from "../actorTypes";
import "./Roundtable.css";

export function RoundtableActorsPanel({ addNew = false, embedded = false }: { addNew?: boolean; embedded?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const focusedNewActor = useRef(false);
  const [library, setLibrary] = useState<RoundtableLibrary | null>(null);
  const [actors, setActors] = useState<RoundtablePreset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function load(signal?: AbortSignal) {
    try {
      const data = await apiJson<RoundtableLibrary>(roundtableLibraryEndpoint, { fresh: true, signal });
      if (!signal?.aborted) { setLibrary(data); setActors(addNew && data.actors.length < 100 ? [...data.actors, { type: "consultant", id: crypto.randomUUID(), name: "", model: DEFAULT_MODEL, effort: "high", rolePrompt: "", isDefault: false }] : data.actors); setError(""); }
    } catch (cause) { if (!signal?.aborted) setError(String(cause instanceof Error ? cause.message : cause)); }
  }
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, []);
  useEffect(() => {
    if (addNew && library && !focusedNewActor.current) {
      focusedNewActor.current = true;
      root.current?.querySelector<HTMLInputElement>(".roundtable-library-actor:last-of-type .roundtable-actor-properties input")?.focus();
    }
  }, [addNew, library]);
  const change = (id: string, update: Partial<RoundtablePreset>) => {
    setActors(items => items.map(actor => actor.id === id ? { ...actor, ...update } : actor)); setNotice("");
  };
  async function save() {
    if (!library) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const data = await apiJson<RoundtableLibrary>(roundtableLibraryEndpoint, { method: "PUT", body: { revision: library.revision, actors } });
      setLibrary(data); setActors(data.actors); setNotice("Saved. Defaults apply to new round tables.");
      window.dispatchEvent(new Event("roundtable-library-changed"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <div ref={root} className={embedded ? "roundtable-library" : "settings-content roundtable-library"} role={embedded ? "region" : "tabpanel"} aria-label="Consultants">
    <div className="settings-section-heading"><div><h2>{ACTOR_TYPE_LABELS.consultant}</h2><p>Shared across workspaces. A reusable cast of perspectives for round tables and side chat.</p></div><span className="roundtable-library-count">{actors.length} consultants · {actors.filter(actor => actor.isDefault).length} default</span></div>
    <form className="roundtable-library-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="roundtable-library-hint"><Users size={18} /><p>Default actors join new round tables automatically. You can choose others before each discussion.</p></div>
      <fieldset disabled={busy || !library} className="roundtable-library-fields">
        {actors.map((actor, index) => <section className="roundtable-library-actor" key={actor.id} aria-label={`Saved actor ${index + 1}`}>
          <header><span className="roundtable-actor-number">{String(index + 1).padStart(2, "0")}</span><strong>{actor.name || "New actor"}</strong>
            <label className="roundtable-default"><input type="checkbox" checked={actor.isDefault} onChange={event => change(actor.id, { isDefault: event.target.checked })} />Default actor</label>
            <button type="button" className="roundtable-delete" aria-label="Remove actor" title="Remove actor" onClick={() => { setActors(items => items.filter(item => item.id !== actor.id)); setNotice(""); }}><Trash2 size={16} /></button>
          </header>
          <ActorAvatarEditor actor={actor} onChange={avatar => change(actor.id, { avatar })} />
          <div className="roundtable-actor-properties">
          <label>Name<input required maxLength={80} value={actor.name} onChange={event => change(actor.id, { name: event.target.value })} /></label>
          <label>Model<select aria-label="Model" value={actor.model} onChange={event => change(actor.id, { model: event.target.value, effort: normalizeModelEffort(event.target.value, actor.effort) })}>{MODEL_OPTIONS.map(model => <option key={model} value={model}>{modelLabel(model)}</option>)}</select></label>
          <label>Effort<select aria-label="Effort" value={actor.effort} onChange={event => change(actor.id, { effort: event.target.value })}>{roundtableEfforts(actor.model).map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label>
          </div>
          <label>Role prompt<textarea rows={3} maxLength={8000} value={actor.rolePrompt} placeholder="Optional perspective or role…" onChange={event => change(actor.id, { rolePrompt: event.target.value })} /></label>
        </section>)}
        {!actors.length && library && <div className="roundtable-library-empty"><Users size={28} /><h3>Build your round table</h3><p>Add a critic, a builder, or a fresh perspective.<br />Give each actor a model and a role.</p></div>}
        <button type="button" className="roundtable-library-add" disabled={actors.length >= 100} onClick={() => { setActors(items => [...items, { type: "consultant", id: crypto.randomUUID(), name: "", model: DEFAULT_MODEL, effort: "high", rolePrompt: "", isDefault: false }]); setNotice(""); }}><Plus size={16} />Add saved actor</button>
      </fieldset>
      <footer className="roundtable-library-footer"><span>Fewer than 2 defaults? Gearbox models fill the remaining places.</span><div><button type="button" className="roundtable-library-reload" aria-label="Reload saved actors" title="Reload saved actors" disabled={busy} onClick={() => void load()}><RotateCcw size={16} /></button><button type="submit" className="roundtable-library-save" disabled={busy || !library || JSON.stringify(actors) === JSON.stringify(library.actors)}><Check size={16} />{busy ? "Saving…" : "Save actors"}</button></div></footer>
      {!library && !error && <p role="status">Loading actors…</p>}
      {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    </form>
  </div>;
}
