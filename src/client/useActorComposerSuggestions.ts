import { useEffect, useState } from "react";
import { apiJson } from "./apiClient";
import type { ComposerSuggestion, SkillSuggestion } from "./appTypes";
import { findComposerSuggestionTrigger, loadComposerSuggestionKeywords } from "./ComposerSuggestions";

type Trigger = { start: number; end: number; query: string; slash: boolean };
export function actorComposerTrigger(value: string, caret: number | null = value.length): Trigger | null {
  const end = caret ?? value.length;
  const slash = /(?:^|\s)\/([^\s]*)$/.exec(value.slice(0, end));
  if (slash) return { start: end - slash[1].length - 1, end, query: slash[1], slash: true };
  const trigger = findComposerSuggestionTrigger(value, end);
  return trigger && !trigger.query.startsWith("@") ? { ...trigger, slash: false } : null;
}

/** Chat has no thread execution modes; its applicable suggestions are skills, files and keywords. */
export function actorSuggestionScope(workspaceId: string, projectId?: string | null) {
  const workspace = encodeURIComponent(workspaceId);
  return { files: `workspaceId=${workspace}&${projectId ? `projectId=${encodeURIComponent(projectId)}` : "scope=workspace"}`,
    skills: `workspaceId=${workspace}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}` };
}

/** `projectId` scopes file and skill suggestions to that project's cwd; omit it for the workspace root (Unassigned, actor chats). */
export function useActorComposerSuggestions(workspaceId: string, projectId?: string | null) {
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [index, setIndex] = useState(-1);
  const scopeKey = `${workspaceId}\n${projectId ?? ""}`;
  const [source, setSource] = useState<{ workspaceId: string; entries: ComposerSuggestion[] }>({ workspaceId: scopeKey, entries: [] });
  const [skills, setSkills] = useState<{ workspaceId: string; entries: ComposerSuggestion[] }>({ workspaceId: scopeKey, entries: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setTrigger(null); setError("");
    const scope = actorSuggestionScope(workspaceId, projectId);
    void Promise.allSettled([
      loadComposerSuggestionKeywords(workspaceId),
      apiJson<{ entries: Array<{ path: string; kind: "directory" | "file" }> }>(`/api/composer-suggestions?${scope.files}`)
    ]).then(([keywords, paths]) => {
      if (cancelled) return;
      const entries: ComposerSuggestion[] = [];
      if (paths.status === "fulfilled") entries.push(...paths.value.entries.map(entry => ({ kind: "path" as const,
        name: entry.path, path: entry.path, description: `${projectId ? "Project" : "Workspace"} ${entry.kind}`, scope: entry.kind,
        insertText: `@${entry.path}${entry.kind === "directory" ? "/" : ""} ` })));
      if (keywords.status === "fulfilled") entries.push(...keywords.value.map(keyword => ({ kind: "keyword" as const,
        name: keyword, description: "Saved suggestion keyword", scope: "keyword" as const, insertText: `${keyword} ` })));
      setSource({ workspaceId: scopeKey, entries });
    });
    return () => { cancelled = true; };
  }, [workspaceId, projectId]);
  useEffect(() => {
    if (!trigger?.slash || skills.workspaceId === scopeKey && skills.entries.length) return;
    let cancelled = false;
    setLoading(true);
    void apiJson<{ skills: SkillSuggestion[] }>(`/api/skills?${actorSuggestionScope(workspaceId, projectId).skills}`).then(result => {
      if (!cancelled) setSkills({ workspaceId: scopeKey, entries: result.skills.map(skill => ({ ...skill, kind: "skill" })) });
    }).catch(() => { if (!cancelled) setError("Skill suggestions could not be loaded."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId, projectId, trigger?.slash]);
  const candidates = trigger?.slash ? skills : source;
  const suggestions = trigger && candidates.workspaceId === scopeKey
    ? candidates.entries.filter(entry => entry.name.toLowerCase().includes(trigger.query.toLowerCase())) : [];
  function change(value: string, caret: number | null = value.length) { setTrigger(actorComposerTrigger(value, caret)); setIndex(-1); }
  function dismiss() { setTrigger(null); setIndex(-1); }
  function replacement(value: string, suggestion: ComposerSuggestion) {
    if (!trigger) return null;
    const insert = suggestion.kind === "skill" ? `$${suggestion.name} ` : suggestion.kind === "path" || suggestion.kind === "keyword" ? suggestion.insertText : "";
    const next = `${value.slice(0, trigger.start)}${insert}${value.slice(trigger.end)}`;
    const caret = trigger.start + insert.length;
    dismiss();
    return { value: next, caret };
  }
  return { trigger, suggestions, index, setIndex, loading, error, change, dismiss, replacement };
}
