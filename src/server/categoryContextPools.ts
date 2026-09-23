import { createHash } from "node:crypto";
import { categoryAncestors, type CategoryExperiment } from "../sessionCategories";
import type { SessionStore, SessionRecord } from "./sessionStore";
import { SessionCategories } from "./sessionCategories";
import type { RunCategoryModel } from "./categoryClassifier";

export function poolSources(state: CategoryExperiment, categoryId: string, sessions: SessionRecord[]) {
  return sessions.filter(session => categoryAncestors(state, state.assignments[session.id]).some(item => item.id === categoryId))
    .sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id)).slice(0, 8);
}
export function poolSourceHash(sessions: SessionRecord[]) {
  return createHash("sha256").update(JSON.stringify(sessions.map(({ id, updated, title, description }) => ({ id, updated, title, description })))).digest("hex");
}
export function parsePoolResponse(response: string, allowed: string[]) {
  const parsed = JSON.parse(response.replace(/^\s*```(?:json)?\s*/, "").replace(/\s*```\s*$/, ""));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("AI returned an invalid context pool response");
  return Object.fromEntries(allowed.map(id => {
    const text = parsed[id];
    if (typeof text !== "string" || !text.trim() || text.length > 4000) throw new Error(`AI returned an invalid context pool for ${id}`);
    return [id, text.trim()];
  }));
}

/** Debounced, serialized model work. User notes remain separate from generated notes. */
export class CategoryContextPools {
  private pending = new Map<string, boolean>();
  private errors = new Map<string, string>();
  private active: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  constructor(private store: SessionStore, private categories: SessionCategories, private runModel: RunCategoryModel) {}
  status(workspaceId: string) { return { running: this.active === workspaceId || this.pending.has(workspaceId), error: this.errors.get(workspaceId) }; }
  schedule(workspaceId: string, force = false) {
    if (this.closed) return;
    this.pending.set(workspaceId, force || this.pending.get(workspaceId) === true);
    if (!this.active && !this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, 3000);
  }
  close() { this.closed = true; clearTimeout(this.timer); this.pending.clear(); }
  private async drain() {
    if (this.closed || this.active) return;
    const entry = this.pending.entries().next().value;
    if (!entry) return;
    const [workspaceId, force] = entry;
    this.pending.delete(workspaceId); this.active = workspaceId; this.errors.delete(workspaceId);
    try { await this.refresh(workspaceId, force); }
    catch (error) { this.errors.set(workspaceId, error instanceof Error ? error.message : String(error)); }
    finally { this.active = null; if (this.pending.size) void this.drain(); }
  }
  private async refresh(workspaceId: string, force: boolean) {
    const sessions = this.categories.scoped(await this.store.listSessions(workspaceId));
    const state = this.categories.read(workspaceId);
    if (!state.enabled || this.closed) return;
    const dirty = state.categories.map(category => ({ category, sources: poolSources(state, category.id, sessions) }))
      .filter(({ category, sources }) => sources.length && (force || category.aiSourceHash !== poolSourceHash(sources)));
    if (!dirty.length) return;
    const evidence = new Map<string, object>();
    for (const { sources } of dirty) for (const session of sources) {
      if (evidence.has(session.id)) continue;
      const detail = await this.store.inspectSession({ sessionId: session.id, workspaceId, status: "done", order: "desc", turnLimit: 2, maxTextChars: 1200 });
      evidence.set(session.id, {
        id: session.id, title: session.title, description: session.description.slice(0, 1200), updated: session.updated,
        turns: detail?.turns.map(turn => ({ user: turn.userInput.slice(0, 600), assistant: turn.agentResponse.slice(0, 1200) })) ?? []
      });
    }
    {
      // Batches bound input/output size while sharing a single isolated runner.
      for (let offset = 0; offset < dirty.length; offset += 4) {
        if (!this.categories.read(workspaceId).enabled || this.closed) return;
        const batch = dirty.slice(offset, offset + 4);
        const ids = [...new Set(batch.flatMap(item => item.sources.map(session => session.id)))];
        const prompt = [
          "Create shared context pools for these session categories. Return a JSON object mapping category IDs to Markdown strings, each at most 3000 characters.",
          "Use Traditional Chinese/Cantonese with exact technical names. Distill established decisions, constraints, useful paths, and unresolved issues. Cite source session IDs inline. Distinguish confirmed results from proposals and blockers. Do not invent facts or claim full coverage: evidence is bounded to the newest 8 sessions and 2 completed turns per category. Never include credentials. Existing user notes are separate and must not be rewritten. Conflicting facts should retain dates and uncertainty.",
          JSON.stringify({ categories: batch.map(({ category, sources }) => ({ id: category.id, path: categoryAncestors(state, category.id).map(item => item.name), sessions: sources.map(session => session.id) })), evidence: ids.map(id => evidence.get(id)) })
        ].join("\n");
        const response = await this.runModel(workspaceId, "category_context_pool", prompt);
        const result = parsePoolResponse(response, batch.map(item => item.category.id));
        const currentSessions = this.categories.scoped(await this.store.listSessions(workspaceId));
        const latest = this.categories.read(workspaceId);
        if (!latest.enabled || this.closed) return;
        for (const { category, sources } of batch) {
          const target = latest.categories.find(item => item.id === category.id);
          if (!target) continue;
          if (poolSourceHash(poolSources(latest, category.id, currentSessions)) !== poolSourceHash(sources)) {
            this.schedule(workspaceId); continue;
          }
          target.aiContext = result[category.id]; target.aiSources = sources.map(session => session.id);
          target.aiUpdatedAt = new Date().toISOString(); target.aiSourceHash = poolSourceHash(sources);
        }
        this.categories.save(workspaceId, latest);
      }
    }
  }
}
