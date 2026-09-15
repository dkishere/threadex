import { homedir } from "node:os";
import { relative, resolve } from "node:path";

export type CodexSessionPollWorkspace = {
  id: string;
  codexHome: string;
};

export type CodexSessionPollSource = {
  codexHome: string;
  /**
   * Workspace-owned homes keep their explicit routing. The regular local
   * Codex home is left unset so transcript cwd can select its workspace.
   */
  workspaceId: string | null;
};

/**
 * Codex started outside Threadex normally writes here. Do not read the
 * process CODEX_HOME because manager-owned runner processes set it to a
 * workspace-specific home.
 */
export function localCodexHomeForPolling() {
  return resolve(process.env.SESSION_LOCAL_CODEX_HOME ?? resolve(homedir(), ".codex"));
}

export function codexSessionPollSources(
  workspaces: CodexSessionPollWorkspace[],
  localCodexHome = localCodexHomeForPolling()
): CodexSessionPollSource[] {
  const sources: CodexSessionPollSource[] = workspaces.map((workspace) => ({
    codexHome: resolve(workspace.codexHome),
    workspaceId: workspace.id
  }));
  const resolvedLocalCodexHome = resolve(localCodexHome);
  if (!sources.some((source) => source.codexHome === resolvedLocalCodexHome)) {
    sources.push({ codexHome: resolvedLocalCodexHome, workspaceId: null });
  }
  return sources;
}

export function isPathInsideCodexHome(path: string, codexHome: string) {
  const resolvedPath = resolve(path);
  const resolvedCodexHome = resolve(codexHome);
  const pathFromCodexHome = relative(resolvedCodexHome, resolvedPath);
  return pathFromCodexHome === "" || (!pathFromCodexHome.startsWith("..") && !pathFromCodexHome.startsWith("/"));
}
