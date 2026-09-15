import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type CodexProject = {
  id: string;
  name: string;
  roots: string[];
};

type ProjectRow = {
  id: string;
  name: string;
  path: string | null;
};

/** Reads the projects registered by Codex itself, rather than scanning a cwd. */
export function listCodexProjects(codexHome: string): CodexProject[] {
  const statePath = currentCodexStatePath(codexHome);
  if (!statePath) return [];

  const database = new DatabaseSync(statePath, { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT projects.id, projects.name, project_roots.path
      FROM projects
      LEFT JOIN project_roots ON project_roots.project_id = projects.id
      ORDER BY projects.position ASC, projects.id ASC, project_roots.position ASC
    `).all() as ProjectRow[];
    const projects = new Map<string, CodexProject>();
    for (const row of rows) {
      const project = projects.get(row.id) ?? { id: row.id, name: row.name, roots: [] };
      if (row.path) project.roots.push(row.path);
      projects.set(row.id, project);
    }
    return [...projects.values()];
  } finally {
    database.close();
  }
}

/** The first Codex project root is the cwd used for a new root session. */
export function resolveCodexProjectCwd(codexHome: string, projectId: string): string | null {
  const project = listCodexProjects(codexHome).find((candidate) => candidate.id === projectId.trim());
  return project?.roots[0] ? resolve(project.roots[0]) : null;
}

function currentCodexStatePath(codexHome: string): string | null {
  const home = resolve(codexHome);
  if (!existsSync(home)) return null;
  const stateFiles = readdirSync(home, { withFileTypes: true })
    .flatMap((entry) => {
      const match = entry.isFile() ? /^state_(\d+)\.sqlite$/.exec(entry.name) : null;
      return match ? [{ name: entry.name, version: Number(match[1]) }] : [];
    })
    .sort((left, right) => right.version - left.version);
  return stateFiles[0] ? resolve(home, stateFiles[0].name) : null;
}
