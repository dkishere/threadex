import { useEffect, useState } from "react";
import { categoryAncestors, sessionCategoryIds, type CategoryExperiment } from "../sessionCategories";
import "./SessionCategoriesPanel.css";

type Snapshot = CategoryExperiment & { sessions: { id: string; title: string }[]; poolStatus?: { running: boolean; error?: string }; classifierStatus?: { running: boolean; error?: string; progress?: string } };
export function SessionCategoriesPanel({ workspaceId, sessionId, onOpenSession }: {
  workspaceId?: string; sessionId: string | null; onOpenSession: (id: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState("threadex");
  const [context, setContext] = useState("");
  const [childName, setChildName] = useState("");
  const [threshold, setThreshold] = useState(12);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState(true);
  const endpoint = `/api/experimental/session-categories?workspaceId=${encodeURIComponent(workspaceId ?? "")}`;
  useEffect(() => {
    if (!workspaceId || !opened) return;
    const controller = new AbortController();
    void fetch(endpoint, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("Unable to load categories");
      const value: Snapshot = await response.json();
      setSnapshot(value); setThreshold(value.threshold);
      setContext(value.categories.find(item => item.id === selected)?.context ?? "");
    }).catch(cause => { if (!controller.signal.aborted) setError(String(cause.message)); });
    return () => controller.abort();
  }, [endpoint, opened]);
  useEffect(() => {
    if (!workspaceId || !opened || !snapshot?.enabled) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void fetch(endpoint, { signal: controller.signal }).then(async response => {
        if (response.ok) setSnapshot(await response.json());
      }).catch(() => {});
    }, 5000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [endpoint, opened, snapshot?.enabled]);
  async function save(change: object) {
    setBusy(true); setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId, ...change }) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "Unable to save categories");
      setSnapshot(value); setThreshold(value.threshold);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const category = snapshot?.categories.find(item => item.id === selected);
  const inherited = snapshot ? categoryAncestors(snapshot, selected).filter(item => item.id !== selected && (item.context.trim() || item.aiContext)) : [];
  function tree(parentId: string | null): React.ReactNode {
    return snapshot?.categories.filter(item => item.parentId === parentId).map(item => {
      const count = snapshot.sessions.filter(session => sessionCategoryIds(snapshot, session.id).some(id => categoryAncestors(snapshot, id).some(ancestor => ancestor.id === item.id))).length;
      return <li key={item.id}><button type="button" aria-pressed={selected === item.id} onClick={() => { setSelected(item.id); setContext(item.context); }}>{item.name} <small>{count}</small></button><ul>{tree(item.id)}</ul></li>;
    });
  }
  return <details open className="category-experiment" onToggle={event => setOpened(event.currentTarget.open)}>
    <summary>Categories <small>Experimental</small></summary>
    {error && <p role="alert">{error}</p>}
    {snapshot && <fieldset disabled={busy}>
      <label><input type="checkbox" checked={snapshot.enabled} onChange={event => void save({ enabled: event.target.checked })} /> Enable for this workspace</label>
      {snapshot.categories.length === 0 && <p>No categories yet. Enable to let Luna plan categories from this workspace’s sessions.</p>}
      <p>Function-first PRD structure, followed by technical domains. Sessions can belong to multiple categories; counts show unique sessions per subtree.</p>
      <label>Review at <input aria-label="Category review threshold" type="number" min={4} max={200} value={threshold} onChange={event => setThreshold(Number(event.target.value))} /> sessions</label>
      <button type="button" disabled={!snapshot.enabled || snapshot.classifierStatus?.running} onClick={() => void save({ replan: true })}>Back up & replan with Luna</button>
      {snapshot.backupPath && <p>Previous classification backed up before replanning.</p>}
      <button type="button" onClick={() => void save({ threshold })}>Save & classify</button>
      <button type="button" disabled={!snapshot.enabled || snapshot.classifierStatus?.running} onClick={() => void save({ reclassify: true })}>{snapshot.classifierStatus?.running ? snapshot.classifierStatus.progress || "Luna classification queued…" : "Reclassify with Luna"}</button>
      {snapshot.classifierStatus?.error && <p role="alert">Classification: {snapshot.classifierStatus.error}</p>}
      {!snapshot.contextPaused && <button type="button" disabled={!snapshot.enabled || snapshot.poolStatus?.running} onClick={() => void save({ refreshPools: true })}>{snapshot.poolStatus?.running ? "AI organising context…" : "Refresh AI context pools manually"}</button>}
      {snapshot.poolStatus?.error && <p role="alert">AI context: {snapshot.poolStatus.error}</p>}
      <ul className="category-tree">{tree(null)}</ul>
      {category && <>
        <strong>{categoryAncestors(snapshot, selected).map(item => item.name).join(" / ")}</strong>
        {category.description && <p>{category.description}</p>}
        {inherited.length > 0 && <details><summary>Inherited context</summary>{inherited.map(item => <p className="category-notes" key={item.id}><b>{item.name}</b>{"\n"}{item.aiContext}{"\n"}{item.context}</p>)}</details>}
        {!snapshot.contextPaused && <details open><summary>AI context pool</summary>
          <p className="category-notes">{category.aiContext || "No AI summary yet."}</p>
          {category.aiUpdatedAt && <small>Updated {new Date(category.aiUpdatedAt).toLocaleString()}</small>}
          <p>Created automatically after the first classification from up to 8 recent sessions and 2 completed turns each. Refresh manually when the category needs a new shared summary.</p>
          <div className="category-members">{category.aiSources?.map(id => <button key={id} type="button" onClick={() => onOpenSession(id)}>{snapshot.sessions.find(item => item.id === id)?.title || id}</button>)}</div>
        </details>}
        {!snapshot.contextPaused && <><label>Additional shared notes<textarea value={context} maxLength={4000} rows={5} onChange={event => setContext(event.target.value)} placeholder="Decisions, constraints and useful references…" /></label>
        <button type="button" onClick={() => void save({ categoryId: selected, context })}>Save context</button></>}
        <form onSubmit={event => { event.preventDefault(); void save({ parentId: selected, name: childName }); }}>
          <input aria-label="New subcategory name" value={childName} maxLength={80} onChange={event => setChildName(event.target.value)} placeholder="Subcategory name" />
          <button disabled={!childName.trim()} type="submit">Add child</button>
        </form>
        {sessionId && snapshot.sessions.some(session => session.id === sessionId) && <button type="button" onClick={() => void save({ categoryId: selected, sessionId })}>Add current session here</button>}
        <div className="category-members">{snapshot.sessions.filter(session => sessionCategoryIds(snapshot, session.id).includes(selected)).map(session => {
          const decision = snapshot.decisions?.[session.id];
          return <div key={session.id}><button type="button" onClick={() => onOpenSession(session.id)}>{session.title || session.id}</button>{decision && <details><summary>{decision.source === "manual" ? "Manually locked" : snapshot.classifierVersion === 2 ? "Luna · multiple categories" : `Luna · ${Math.round(decision.confidence * 100)}%${decision.confidence < 0.75 ? " · Needs review" : ""}`}</summary><p>{decision.reason}</p><p>{sessionCategoryIds(snapshot, session.id).map(id => categoryAncestors(snapshot, id).map(c => c.name).join(" / ")).join(" · ")}</p></details>}</div>;
        })}</div>
      </>}
      <p>{snapshot.sessions.filter(session => !snapshot.decisions?.[session.id]).length} sessions awaiting Luna classification.</p>
      {snapshot.previousTree && <details><summary>Previous keyword tree (saved snapshot)</summary>{snapshot.previousTree.categories.map(item => <p key={item.id}>{item.name}: {Object.values(snapshot.previousTree!.assignments).filter(id => id === item.id).length} sessions{item.context ? ` — ${item.context}` : ""}</p>)}</details>}
      <p>Review adds subcategories only when content has clear distinctions. Sessions may appear in several branches; child counts need not add up to the parent count.</p>
    </fieldset>}
  </details>;
}
