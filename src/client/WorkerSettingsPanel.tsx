import { useEffect, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import { actorProjectGroups, type ActorMemoryContent, type ActorProject, type DomainActor } from "../domainActors";
import { DEFAULT_MODEL, MODEL_OPTIONS, modelEfforts, modelLabel, normalizeModelEffort } from "../modelCatalog";
import { apiJson } from "./apiClient";
import { isAuthRequired, notifyActorRoomChanged } from "./actorRoomState";
import "./WorkerSettingsPanel.css";

const memoryFields = ["rolePrompt", "roleSummary", "longTerm", "rolling"] as const;
const memoryLabels = { rolePrompt: "Role prompt", roleSummary: "Role summary", longTerm: "Long-term memory", rolling: "Recent memory" };
const memoryContent = (actor: DomainActor): ActorMemoryContent => Object.fromEntries(memoryFields.map(key => [key, actor.memory[key]])) as ActorMemoryContent;
type SettingsDraft = { name: string; model: string; effort: string; allowedModels: string[]; projectIds?: string[] };
/** Only root workers carry projects; sub-actors follow their root. */
const settingsContent = (actor: DomainActor): SettingsDraft => ({ name: actor.name, model: actor.model, effort: actor.effort, allowedModels: actor.allowedModels,
  ...(actor.parentActorId ? {} : { projectIds: actor.projectIds ?? [] }) });
const sameSettings = (a: SettingsDraft, b: SettingsDraft) => JSON.stringify({ ...a, projectIds: [...a.projectIds ?? []].sort() })
  === JSON.stringify({ ...b, projectIds: [...b.projectIds ?? []].sort() });

/** Registered projects in registry order, then project IDs the worker still names but the workspace no longer registers. */
function ProjectChoices({ projects, projectsError, value, onChange }: {
  projects: ActorProject[] | null; projectsError: string; value: string[]; onChange: (projectIds: string[]) => void;
}) {
  const options = [...projects ?? [], ...value.filter(id => !projects?.some(project => project.id === id)).map(id => ({ id, name: id, missing: true }))];
  const nameOf = (id: string) => options.find(project => project.id === id)?.name ?? id;
  // Only registered projects are move targets; the server rejects adding an unregistered one.
  const targets = (projects ?? []).filter(project => !value.includes(project.id));
  return <fieldset className="worker-projects"><legend>Projects</legend>
    <p>The worker is listed under, and takes part in the group chat of, each project. No project: Unassigned. Changes apply when settings are saved; existing tasks keep their project.</p>
    {projectsError && <p role="alert">Projects could not be loaded: {projectsError}</p>}
    {!projects && !projectsError && <p role="status">Loading projects…</p>}
    {projects && !options.length && <p>No projects are registered in this workspace.</p>}
    {value.length > 0 && <ul className="worker-project-assignments" aria-label="Assigned projects">{value.map(id => <li key={id}>
      <span>{nameOf(id)}</span>
      <select aria-label={`Move from ${nameOf(id)} to`} value="" disabled={!targets.length}
        onChange={event => event.target.value && onChange(value.map(current => current === id ? event.target.value : current))}>
        <option value="">{targets.length ? "Move to…" : "No other project"}</option>
        {targets.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      <button type="button" className="secondary" aria-label={`Remove from ${nameOf(id)}`} onClick={() => onChange(value.filter(current => current !== id))}>Remove</button>
    </li>)}</ul>}
    <div className="worker-allowed-models">{options.map(project => <label className="roundtable-default" key={project.id}>
      <input type="checkbox" checked={value.includes(project.id)}
        onChange={event => onChange(event.target.checked ? [...value, project.id] : value.filter(id => id !== project.id))} />
      {project.name}{"missing" in project && " (no longer registered)"}
    </label>)}</div>
  </fieldset>;
}

// Remounted by workspace and selection so late responses cannot replace another editor's state.
function WorkerEditor({ actor, actors, workspaceId, projects, projectsError, onSaved, onDeleted, onOpen }: {
  actor: DomainActor | null; actors: DomainActor[]; workspaceId: string; projects: ActorProject[] | null; projectsError: string;
  onSaved: (actor: DomainActor) => void; onDeleted: (id: string, name: string) => void; onOpen: (id: string) => void;
}) {
  const [saved, setSaved] = useState(actor);
  const [draft, setDraft] = useState<SettingsDraft>(actor ? settingsContent(actor) : { name: "", model: DEFAULT_MODEL,
    effort: "medium", allowedModels: [...MODEL_OPTIONS], projectIds: [] });
  const [memory, setMemory] = useState<ActorMemoryContent>(actor ? memoryContent(actor) : { rolePrompt: "", roleSummary: "", longTerm: "", rolling: "" });
  const [parentActorId, setParentActorId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const endpoint = `/api/domain-actors/${encodeURIComponent(workspaceId)}/actors`;
  const change = (update: Partial<SettingsDraft>) => { setDraft(value => ({ ...value, ...update })); setNotice(""); };
  const settingsDirty = !saved || !sameSettings(draft, settingsContent(saved));
  const memoryDirty = !saved || JSON.stringify(memory) !== JSON.stringify(memoryContent(saved));
  const valid = draft.name.trim() && draft.allowedModels.includes(draft.model) && draft.allowedModels.length > 0;
  const root = saved ? !saved.parentActorId : !parentActorId;
  async function deleteWorker() {
    if (!saved || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await apiJson<{ deletedActorId: string }>(`${endpoint}/${encodeURIComponent(saved.id)}`, { method: "DELETE" });
      notifyActorRoomChanged(workspaceId);
      onDeleted(result.deletedActorId, saved.name);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function save(kind: "settings" | "memory") {
    setBusy(true); setError(""); setNotice("");
    try {
      const { projectIds, ...fields } = draft;
      let next: DomainActor;
      if (!saved) {
        next = await apiJson<DomainActor>(endpoint, { method: "POST", body: { type: "worker", ...fields, parentActorId: parentActorId || null, memory } });
        // Creation takes no projects; a root worker is assigned right after it exists.
        if (!parentActorId && projectIds?.length)
          next = await apiJson<DomainActor>(`${endpoint}/${encodeURIComponent(next.id)}`, { method: "PATCH", body: { projectIds } });
      } else next = await apiJson<DomainActor>(`${endpoint}/${encodeURIComponent(saved.id)}${kind === "memory" ? "/memory" : ""}`, {
        method: "PATCH",
        body: kind === "memory" ? { expectedVersion: saved.memory.version, sourceEventId: crypto.randomUUID(), memory }
          : saved.parentActorId ? fields : { ...fields, projectIds: projectIds ?? [] }
      });
      setSaved(kind === "settings" && saved ? { ...next, memory: saved.memory } : next);
      // Settings and memory have independent save buttons. Preserve the other draft.
      if (kind === "settings") setDraft(settingsContent(next));
      else setMemory(memoryContent(next));
      onSaved(next); notifyActorRoomChanged(workspaceId);
      setNotice(kind === "memory" ? "Worker memory saved." : "Worker settings saved.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <section className="roundtable-library-actor" aria-label={saved ? `Configure ${saved.name}` : "New worker"}>
    <header><h3>{saved ? saved.name : "New worker"}</h3>{saved && <button type="button" className="secondary" onClick={() => onOpen(saved.id)}>Open worker chat</button>}</header>
    <form onSubmit={event => { event.preventDefault(); void save("settings"); }}>
      <fieldset disabled={busy} className="roundtable-library-fields">
        <div className="roundtable-actor-properties">
          <label>Name<input required maxLength={80} value={draft.name} onChange={event => change({ name: event.target.value })} /></label>
          <label>Model<select value={draft.model} onChange={event => change({ model: event.target.value, effort: normalizeModelEffort(event.target.value, draft.effort) })}>
            {MODEL_OPTIONS.map(model => <option key={model} value={model} disabled={!draft.allowedModels.includes(model)}>{modelLabel(model)}</option>)}
          </select></label>
          <label>Effort<select value={draft.effort} onChange={event => change({ effort: event.target.value })}>
            {modelEfforts(draft.model).map(effort => <option key={effort} value={effort}>{effort}</option>)}
          </select></label>
        </div>
        {!saved && <label>Parent worker<select value={parentActorId} onChange={event => setParentActorId(event.target.value)}>
          <option value="">None (root worker)</option>{actors.filter(item => !item.parentActorId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>}
        {saved && <p>Parent: {actors.find(item => item.id === saved.parentActorId)?.name ?? "None (root worker)"}</p>}
        {root ? <ProjectChoices projects={projects} projectsError={projectsError} value={draft.projectIds ?? []} onChange={projectIds => change({ projectIds })} />
          : <p>Projects: same as its root worker{saved && actors.find(item => item.id === saved.rootActorId) ? ` (${actors.find(item => item.id === saved.rootActorId)!.name}); move or remove projects there` : ""}.</p>}
        <fieldset><legend>Allowed models</legend><p>The default model must remain allowed.</p>
          <div className="worker-allowed-models">{MODEL_OPTIONS.map(model => <label className="roundtable-default" key={model}><input type="checkbox" checked={draft.allowedModels.includes(model)} disabled={model === draft.model}
            onChange={event => change({ allowedModels: event.target.checked ? [...draft.allowedModels, model] : draft.allowedModels.filter(value => value !== model) })} />{modelLabel(model)}</label>)}
          </div>
        </fieldset>
        {!saved && memoryFields.map(key => <label key={key}>{memoryLabels[key]}<textarea rows={3} maxLength={key === "roleSummary" ? 4000 : 100000} value={memory[key]}
          onChange={event => setMemory(value => ({ ...value, [key]: event.target.value }))} /></label>)}
        <button type="submit" className="roundtable-library-save" disabled={!valid || !settingsDirty}>{busy ? "Saving…" : saved ? "Save worker settings" : "Create worker"}</button>
      </fieldset>
    </form>
    {saved && <form onSubmit={event => { event.preventDefault(); void save("memory"); }}>
      <fieldset disabled={busy} className="roundtable-library-fields"><legend>Role and memory</legend>
        <p>Memory version {saved.memory.version}. Reload workers before merging a conflicting memory update; reloading discards unsaved edits.</p>
        {memoryFields.map(key => <label key={key}>{memoryLabels[key]}<textarea rows={3} maxLength={key === "roleSummary" ? 4000 : 100000} value={memory[key]}
          onChange={event => { setMemory(value => ({ ...value, [key]: event.target.value })); setNotice(""); }} /></label>)}
        <button type="submit" className="roundtable-library-save" disabled={!memoryDirty}>{busy ? "Saving…" : "Save worker memory"}</button>
      </fieldset>
    </form>}
    {saved && <section className="worker-delete" aria-label="Delete worker">
      <h4>Delete worker</h4>
      <p>Deleting takes effect immediately, separately from saving settings. Historical tasks and conversations are kept. Remove child workers first; unfinished or running work prevents deletion.</p>
      {!confirmDelete ? <button type="button" className="secondary" disabled={busy} onClick={() => { setError(""); setConfirmDelete(true); }}>Delete worker</button>
        : <div role="group" aria-label="Confirm delete worker">
          <p>Delete {saved.name}?</p>
          <button type="button" className="worker-delete-confirm" disabled={busy} onClick={() => void deleteWorker()}>{busy ? "Deleting…" : "Confirm delete"}</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => { setConfirmDelete(false); setError(""); }}>Cancel</button>
        </div>}
    </section>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}

export function WorkerSettingsPanel({ workspaceId, workspaceName, onOpen, onOpenRoom }: {
  workspaceId: string; workspaceName: string; onOpen: (id: string) => void; onOpenRoom: (chatKey: string) => void;
}) {
  const [actors, setActors] = useState<DomainActor[] | null>(null);
  const [projects, setProjects] = useState<ActorProject[] | null>(null);
  const [projectsError, setProjectsError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void apiJson<{ actors: DomainActor[] }>(`/api/domain-actors/${encodeURIComponent(workspaceId)}/actors`, { fresh: true, signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) { setActors(data.actors); setAuthRequired(false); } })
      .catch(cause => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : String(cause)); setAuthRequired(isAuthRequired(cause)); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workspaceId, revision]);
  useEffect(() => {
    const controller = new AbortController();
    setProjects(null); setProjectsError("");
    void apiJson<{ projects: ActorProject[] }>(`/api/workspaces/projects?workspaceId=${encodeURIComponent(workspaceId)}`, { fresh: true, signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setProjects(data.projects); })
      .catch(cause => { if (!controller.signal.aborted) setProjectsError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [workspaceId, revision]);
  // Same grouping as the sidebar (shared helper); without the registry, project IDs stand in for names.
  const groups = actors ? actorProjectGroups(actors, projects ?? []) : [];
  const childrenOf = (rootId: string) => actors?.filter(actor => actor.id !== rootId && actor.rootActorId === rootId) ?? [];
  const chooser = (actor: DomainActor, sub: boolean) => <button type="button" key={actor.id} aria-pressed={selected === actor.id}
    onClick={() => { setNotice(""); setSelected(actor.id); }}>{sub ? "↳ " : ""}{actor.name}</button>;
  return <section className="roundtable-library worker-settings" aria-label="Workers">
    <div className="settings-section-heading"><div><h3>Workers</h3><p>Workspace: {workspaceName}. Configure worker identity, models, projects, role and memory here. Workers are grouped by project; each project has its own group chat.</p></div></div>
    <button type="button" className="secondary" disabled={loading} onClick={() => { setSelected(null); setActors(null); setRevision(value => value + 1); }}>Reload workers</button>
    {loading && <p role="status">Loading workers…</p>}
    {error && <p role="alert">{authRequired ? "Sign in to configure workers. " : ""}{error}</p>}
    {!loading && !error && actors && <>
      <div className="worker-project-groups">
        {groups.map(group => <section key={group.key} className="worker-project-group" aria-labelledby={`worker-group-${group.key.replace(/[^A-Za-z0-9_-]/g, "_")}`} data-group-key={group.key}>
          <header><h4 id={`worker-group-${group.key.replace(/[^A-Za-z0-9_-]/g, "_")}`}>{group.name}{!group.registered && " (no longer registered)"}</h4>
            <button type="button" className="secondary" aria-label={`Open ${group.name} group chat`} onClick={() => onOpenRoom(group.key)}><MessageCircle aria-hidden="true" />Group chat</button></header>
          <div className="sidebar-view-tabs" role="group" aria-label={`Choose worker in ${group.name}`}>
            {group.actorIds.flatMap(id => actors.find(actor => actor.id === id) ?? []).flatMap(root => [chooser(root, false), ...childrenOf(root.id).map(child => chooser(child, true))])}
            {!group.actorIds.length && <span className="worker-project-empty">No workers</span>}
          </div>
        </section>)}
      </div>
      <button type="button" className="secondary" aria-pressed={selected === "new"} onClick={() => { setNotice(""); setSelected("new"); }}>Add worker</button>
      {!actors.length && <p>No workers in this workspace. Add a worker to get started.</p>}
      {selected && (selected === "new" || actors.some(actor => actor.id === selected)) && <WorkerEditor key={`${workspaceId}:${selected}:${revision}`}
        workspaceId={workspaceId} actors={actors} actor={actors.find(actor => actor.id === selected) ?? null} onOpen={onOpen}
        projects={projects} projectsError={projectsError}
        onDeleted={(id, name) => { if (!mounted.current) return; setActors(items => items?.filter(item => item.id !== id) ?? null);
          setSelected(current => current === id ? null : current); setNotice(`Worker ${name} deleted.`); }}
        onSaved={next => { if (!mounted.current) return; setActors(items => items ? (items.some(item => item.id === next.id) ? items.map(item => item.id === next.id ? next : item) : [...items, next]) : items);
          if (selected === "new") { setSelected(current => current === "new" ? next.id : current); setNotice("Worker created."); } }} />}
      {notice && <p role="status">{notice}</p>}
    </>}
  </section>;
}
