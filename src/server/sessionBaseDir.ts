import type { SessionRecord, WorkspaceRecord } from "./sessionStore";

type SessionCwdSource = Pick<SessionRecord, "workspaceId" | "cwd">;

export function resolveNewSessionCwd(input: {
  workspace: Pick<WorkspaceRecord, "id" | "cwd">;
  reusableSession: SessionCwdSource | null;
  baseSession: SessionCwdSource | null;
  requestedBaseSessionId: string | undefined;
  requestedNewSessionCwd?: string;
}) {
  if (input.reusableSession) return input.reusableSession.cwd;
  if (input.requestedBaseSessionId && !input.baseSession) {
    throw new Error("Base session not found.");
  }
  if (input.baseSession && input.baseSession.workspaceId !== input.workspace.id) {
    throw new Error("Base session must belong to the active workspace.");
  }
  return input.baseSession?.cwd ?? input.requestedNewSessionCwd ?? input.workspace.cwd;
}
