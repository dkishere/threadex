type WorkspaceIdentity = { id: string };

export async function resolveSessionWorkspace<T extends WorkspaceIdentity>(input: {
  requestedWorkspaceId: unknown;
  sessionWorkspaceId?: string | null;
  getWorkspace: (id: string) => Promise<T | null>;
  getActiveWorkspace: () => Promise<T>;
}): Promise<T> {
  const sessionWorkspaceId = normalizeWorkspaceId(input.sessionWorkspaceId);
  if (sessionWorkspaceId) {
    const workspace = await input.getWorkspace(sessionWorkspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${sessionWorkspaceId}`);
    }
    return workspace;
  }

  const requestedWorkspaceId = normalizeWorkspaceId(input.requestedWorkspaceId);
  if (requestedWorkspaceId) {
    const workspace = await input.getWorkspace(requestedWorkspaceId);
    if (workspace) {
      return workspace;
    }
  }

  return input.getActiveWorkspace();
}

function normalizeWorkspaceId(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
