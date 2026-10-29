import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ActorTaskBinding, ActorTaskSelection } from "../domainActors";
import type { CodexProject } from "./codexProjects";

export function actorTaskSelection(input: ActorTaskSelection): ActorTaskSelection {
  const selection: ActorTaskSelection = {};
  for (const key of ["newSessionProjectId", "newSessionCwd"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "string" || !input[key]!.trim() || input[key]!.length > 4096) throw new Error("Invalid actor project selection.");
    selection[key] = input[key]!.trim();
  }
  return selection;
}
export function sameActorTaskSelection(left: ActorTaskSelection = {}, right: ActorTaskSelection = {}) {
  return left.newSessionProjectId === right.newSessionProjectId && left.newSessionCwd === right.newSessionCwd;
}
const userPath = (path: string) => resolve(path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Match only this workspace's registry and concrete references in the current user message. */
export function resolveActorTaskBinding(workspace: { id: string; cwd: string }, projects: CodexProject[],
  input: ActorTaskSelection & { userPrompt: string }, repositoryExists = (path: string) => existsSync(join(path, ".git")),
  defaultProjectIds: readonly string[] = []): ActorTaskBinding {
  const selection = actorTaskSelection(input);
  const entries = projects.flatMap(project => project.roots.map(root => ({ project, cwd: userPath(root) })));
  const binding = (entry: typeof entries[number], source: ActorTaskBinding["source"]): ActorTaskBinding =>
    ({ workspaceId: workspace.id, cwd: entry.cwd, projectId: entry.project.id, source });
  if (selection.newSessionProjectId || selection.newSessionCwd) {
    const cwd = selection.newSessionCwd ? userPath(selection.newSessionCwd) : undefined;
    const matching = entries.filter(entry => (!selection.newSessionProjectId || entry.project.id === selection.newSessionProjectId)
      && (!cwd || entry.cwd === cwd));
    if (!matching.length) throw new Error("Actor project and cwd must match a project registered in this workspace's CODEX_HOME.");
    return binding(matching[0], "explicit");
  }
  // A path under a registered root is evidence for that project, not permission
  // to launch in an arbitrary subdirectory. Prefer its most specific root.
  const pathText = input.userPrompt.replace(/file:\/\//g, "");
  const pathPattern = /(?<![\w/.:~-])\/[^\s"'`<>(),]+/g;
  const rootsForPath = (path: string) => {
    const matching = entries.filter(entry => path === entry.cwd || path.startsWith(`${entry.cwd}/`) || path.startsWith(`${entry.cwd}:`));
    const length = Math.max(...matching.map(entry => entry.cwd.length));
    return matching.filter(entry => entry.cwd.length === length);
  };
  const pathMatches = (pathText.match(pathPattern) ?? []).flatMap(rootsForPath);
  // Path components are not additional, independent project-name references.
  const nameText = pathText.replace(pathPattern, " ");
  const named = entries.filter(entry => entry.cwd === userPath(entry.project.roots[0])
    && !pathMatches.some(match => match.project.id === entry.project.id)
    && new RegExp(`(^|[^\\w.-])${escape(entry.project.name)}(?=$|[^\\w.-])`, "i").test(nameText));
  // Resolve a mentioned repository under a registered umbrella project without
  // scanning directories, invoking a model, or inventing a filesystem path.
  const repoNames = [...new Set(nameText.match(/[a-zA-Z0-9]+(?:[-_][a-zA-Z0-9]+)+/g) ?? [])].slice(0, 32);
  const repositories = entries.flatMap(entry => repoNames.flatMap(name => {
    const path = join(entry.cwd, name);
    return repositoryExists(path) ? rootsForPath(path) : [];
  }));
  const matches = [...pathMatches, ...named, ...repositories];
  const unique = [...new Map(matches.map(entry => [JSON.stringify([entry.project.id, entry.cwd]), entry])).values()];
  if (unique.length > 1) throw new Error("This message refers to multiple project roots. Select the project for the actor task before sending.");
  if (unique.length === 1) return binding(unique[0], "message");
  // Membership is a default only for an individual actor; never choose an
  // arbitrary project from a worker that belongs to several project chats.
  const defaults = [...new Set(defaultProjectIds)];
  if (defaults.length > 1) throw new Error("This actor belongs to multiple projects. Select the project for the actor task before sending.");
  if (defaults.length === 1) {
    const entry = entries.find(entry => entry.project.id === defaults[0]);
    if (!entry) throw new Error("This actor's project has no registered root in this workspace. Select a registered project before sending.");
    return binding(entry, "actor");
  }
  return { workspaceId: workspace.id, cwd: workspace.cwd, source: "workspace" };
}
