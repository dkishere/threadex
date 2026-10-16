import { DEFAULT_MODEL, MODEL_OPTIONS, normalizeModelId, modelEfforts, normalizeModelEffort } from "./modelCatalog";
import { parseActorAvatar } from "./actorAvatar";

export type RoundtableActor = { id: string; name: string; model: string; effort: string; systemPrompt: string; avatar?: string; presetId?: string };
export type RoundtableAttempt = {
  id: string; logPath: string; startedAt: string; lastActivityAt: string; finishedAt?: string;
  status: "running" | "done" | "error" | "stopped" | "interrupted";
  eventCount: number; lastEvent: string; error?: string;
};
export type RoundtableAnswer = { actor: RoundtableActor; status: "waiting" | "running" | "done" | "error" | "skipped"; text: string; error: string | null; attempts?: RoundtableAttempt[] };
export type RoundtableRound = {
  turnId: string; sessionId: string; revision: number; prompt: string; created: string;
  status: "queued" | "context" | "actors" | "host" | "done" | "error" | "stopped";
  context: string | null; summarizerModel: string; answers: RoundtableAnswer[];
  contextAttempts?: RoundtableAttempt[];
  /** Set on a "Next round" without a new user prompt: actors continue the source round's topic. */
  continuation?: { turnId: string; topic: string };
  hostModel: string; hostEffort: string;
  summary: string; synthesis?: RoundtableConclusion | null; error: string | null; tokenIn: number; tokenOut: number;
};
/** Host output: each issue lists distinct positions and the actors (by name) who hold them. */
export type RoundtableSynthesis = { template?: "decision"; taskType?: "decision"; issues: { topic: string; positions: { view: string; actors: string[]; details?: { actors: string[]; detail: string }[] }[] }[] };
export type RoundtableSummary = {
  template: "summary"; taskType: "code_review" | "research" | "summary";
  overview: string; sections: { title: string; items: { text: string; actors: string[] }[] }[];
};
export type RoundtableConclusion = RoundtableSynthesis | RoundtableSummary;
export const ROUNDTABLE_TASK_LABELS = { decision: "Decision", code_review: "Code review", research: "Research", summary: "Summary" };
export type RoundtableIssueKind = "consensus" | "disagreement" | "partial";

/** Derived, never model-asserted: consensus needs every actor on one position. */
export function roundtableIssueKind(issue: RoundtableSynthesis["issues"][number], actorCount: number): RoundtableIssueKind {
  if (issue.positions.length > 1) return "disagreement";
  return actorCount > 0 && new Set(issue.positions[0]?.actors).size === actorCount ? "consensus" : "partial";
}

export function parseRoundtableSynthesis(text: string, actorNames: string[]): RoundtableSynthesis | null {
  const body = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text;
  let raw: unknown;
  try { raw = JSON.parse(body.trim()); } catch { return null; }
  const known = new Set(actorNames);
  if (!known.size || known.size !== actorNames.length) return null;
  const issuesRaw = (raw as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issuesRaw) || !issuesRaw.length) return null;
  const issues: RoundtableSynthesis["issues"] = [];
  for (const issue of issuesRaw) {
    if (typeof issue?.topic !== "string" || !issue.topic.trim() || !Array.isArray(issue.positions) || !issue.positions.length) return null;
    // Never silently discard an unrecognised or conflicting attribution: keep
    // the original host response instead of presenting a misleading consensus.
    const placed = new Set<string>();
    const positions: RoundtableSynthesis["issues"][number]["positions"] = [];
    for (const position of issue.positions) {
      const { view, actors } = (position ?? {}) as { view?: unknown; actors?: unknown };
      if (typeof view !== "string" || !view.trim() || !Array.isArray(actors) || !actors.length
        || actors.some(name => typeof name !== "string" || !known.has(name) || placed.has(name))) return null;
      const unique = [...new Set<string>(actors)];
      const details: { actors: string[]; detail: string }[] = [];
      const detailed = new Set<string>();
      if (position.details !== undefined) {
        if (!Array.isArray(position.details)) return null;
        for (const item of position.details) {
          if (typeof item?.detail !== "string" || !item.detail.trim() || !Array.isArray(item.actors) || !item.actors.length
            || item.actors.some((name: unknown) => typeof name !== "string" || !unique.includes(name) || detailed.has(name))) return null;
          const names = [...new Set<string>(item.actors)];
          names.forEach(name => detailed.add(name));
          const sameDetail = details.find(entry => entry.detail === item.detail.trim());
          if (sameDetail) sameDetail.actors.push(...names);
          else details.push({ actors: names, detail: item.detail.trim() });
        }
      }
      unique.forEach(name => placed.add(name));
      const sameView = positions.find(item => item.view === view.trim());
      if (sameView) {
        sameView.actors.push(...unique);
        if (details.length) sameView.details = [...(sameView.details ?? []), ...details];
      } else positions.push({ view: view.trim(), actors: unique, ...(details.length ? { details } : {}) });
    }
    issues.push({ topic: issue.topic.trim(), positions });
  }
  return { issues };
}

/** The host classifies the task before choosing a template. Legacy issues-only output is a decision. */
export function parseRoundtableConclusion(text: string, actorNames: string[]): RoundtableConclusion | null {
  const body = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text;
  let raw;
  try { raw = JSON.parse(body.trim()); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.template === undefined || raw.template === "decision") {
    if (raw.template === "decision" ? raw.taskType !== "decision" : raw.taskType !== undefined) return null;
    if (raw.sections !== undefined || raw.overview !== undefined) return null;
    const decision = parseRoundtableSynthesis(text, actorNames);
    return decision && (raw.template === "decision" ? { ...decision, taskType: "decision", template: "decision" } : decision);
  }
  if (raw.template !== "summary" || !["code_review", "research", "summary"].includes(raw.taskType)
    || typeof raw.overview !== "string" || !raw.overview.trim() || !Array.isArray(raw.sections) || raw.issues !== undefined) return null;
  const known = new Set(actorNames);
  if (!known.size || known.size !== actorNames.length) return null;
  const sections: RoundtableSummary["sections"] = [];
  for (const section of raw.sections) {
    if (typeof section?.title !== "string" || !section.title.trim() || !Array.isArray(section.items) || !section.items.length) return null;
    const items: RoundtableSummary["sections"][number]["items"] = [];
    for (const item of section.items) {
      if (typeof item?.text !== "string" || !item.text.trim() || !Array.isArray(item.actors) || !item.actors.length
        || item.actors.some((name: unknown) => typeof name !== "string" || !known.has(name))) return null;
      items.push({ text: item.text.trim(), actors: [...new Set<string>(item.actors)] });
    }
    sections.push({ title: section.title.trim(), items });
  }
  return { template: "summary", taskType: raw.taskType, overview: raw.overview.trim(), sections };
}

/** Readable form kept in the host turn for history, search, copy and the next round's context. */
export function roundtableSynthesisMarkdown(synthesis: RoundtableConclusion, actorCount: number) {
  if (synthesis.template === "summary") return [synthesis.overview, ...synthesis.sections.map(section =>
    `**${section.title}**\n\n${section.items.map(item => `- ${item.text.replace(/\n/g, "\n  ")} — ${item.actors.join(", ")}`).join("\n")}`
  )].join("\n\n");
  const sections: [RoundtableIssueKind, string][] = [["consensus", "Consensus"], ["disagreement", "Disagreements"], ["partial", "Other points"]];
  return sections.flatMap(([kind, title]) => {
    const issues = synthesis.issues.filter(issue => roundtableIssueKind(issue, actorCount) === kind);
    if (!issues.length) return [];
    const lines = issues.map(issue => [`- **${issue.topic}**`, ...issue.positions.flatMap(position => [
      `  - ${position.view} — ${position.actors.join(", ")}`,
      ...(position.details ?? []).map(item => `    - ${item.actors.join(", ")}: ${item.detail}`)
    ])].join("\n"));
    return [`**${title}**\n\n${lines.join("\n")}`];
  }).join("\n\n");
}
export const ROUNDTABLE_NEXT_ROUND_PROMPT = "Next round: actors, continue the discussion.";
/** The discussion topic, carried through chained next rounds. */
export const roundtableTopic = (round: RoundtableRound) => round.continuation?.topic ?? round.prompt;
export const roundtableRunning = (round: RoundtableRound) => ["context", "actors", "host"].includes(round.status);
export const roundtableStatus = (round: RoundtableRound) => ({
  queued: "Queued", context: "Preparing context", actors: "Actors thinking", host: "Concluding",
  done: "Complete", error: "Needs retry", stopped: "Stopped"
})[round.status];

export const roundtableEfforts: (model: string) => readonly string[] = modelEfforts;

export function newRoundtableActor(profile?: { model: string; effort?: string }): RoundtableActor {
  const names = ["Robin", "Willow", "Maple", "Cedar", "Otter", "Finch", "Aspen", "Lark"];
  const id = crypto.randomUUID();
  const model = profile?.model && MODEL_OPTIONS.includes(normalizeModelId(profile.model)) ? normalizeModelId(profile.model) : DEFAULT_MODEL;
  return { id, name: `${names[Math.floor(Math.random() * names.length)]} ${id.slice(0, 4)}`, model,
    effort: normalizeModelEffort(model, profile?.effort ?? "high"), systemPrompt: "" };
}

export function parseRoundtableActor(raw: unknown): RoundtableActor {
  if (!raw || typeof raw !== "object") throw new Error("Invalid round table actor.");
  const actor = raw as RoundtableActor;
  if (typeof actor.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(actor.id)
    || typeof actor.name !== "string" || !actor.name.trim() || actor.name.length > 80
    || typeof actor.model !== "string" || !MODEL_OPTIONS.includes(normalizeModelId(actor.model))
    || !roundtableEfforts(normalizeModelId(actor.model)).includes(actor.effort)
    || typeof actor.systemPrompt !== "string" || actor.systemPrompt.length > 8000) throw new Error("Invalid round table actor settings.");
  if (actor.presetId !== undefined && (typeof actor.presetId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(actor.presetId))) throw new Error("Invalid actor preset ID.");
  return { id: actor.id, name: actor.name.trim(), model: normalizeModelId(actor.model), effort: actor.effort, systemPrompt: actor.systemPrompt, ...(actor.avatar === undefined ? {} : { avatar: parseActorAvatar(actor.avatar) }), ...(actor.presetId === undefined ? {} : { presetId: actor.presetId }) };
}

export function parseRoundtableActors(value: unknown): RoundtableActor[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) throw new Error("Choose 2 to 8 round table actors.");
  const actors = value.map(parseRoundtableActor);
  if (new Set(actors.map(actor => actor.id)).size !== actors.length) throw new Error("Actor IDs must be unique.");
  // The host attributes positions by name.
  if (new Set(actors.map(actor => actor.name)).size !== actors.length) throw new Error("Give each round table actor a different name.");
  return actors;
}

export function roundtableResponse(round: RoundtableRound) {
  if (round.status === "done") return round.summary;
  const progress = round.answers.map(answer => `- **${answer.actor.name}** (${answer.actor.model}): ${answer.status}${answer.error ? ` — ${answer.error}` : ""}`).join("\n");
  return `### Round table · ${roundtableStatus(round)}\n\n${progress}${round.error ? `\n\n${round.error}\n\nOpen Round table to retry the unfinished work.` : ""}`;
}
