import { ApiError, apiJson } from "./apiClient";

export type PickOwnerReason = "session_actor_bound" | "session_project_unresolved" | "project_has_no_actors" | "pick_owner_pending";
export type PickOwnerStatus = {
  eligible: boolean;
  reason: PickOwnerReason | null;
  projectId: string | null;
  projectName: string | null;
  actorCount: number;
  pending: { requestId: string; roundId: string | null; status: string } | null;
};
export type PickOwnerResponse = { requestId: string; chatProjectId: string; projectName: string };
export type PickOwnerButtonState = { kind: "hidden" } | { kind: "ready" | "pending"; label: string; disabled: boolean };

/** Hidden unless the project has actors that could take the session; pending stays visible but disabled. */
export function pickOwnerButtonState(status: PickOwnerStatus | null): PickOwnerButtonState {
  if (!status) return { kind: "hidden" };
  if (status.reason === "pick_owner_pending" || status.pending) return { kind: "pending", label: "Picking owner…", disabled: true };
  if (!status.eligible || status.reason) return { kind: "hidden" };
  return { kind: "ready", label: "Group follow-up", disabled: false };
}

export function newPickOwnerRequestId() {
  return `pick_owner_${crypto.randomUUID()}`;
}

export function pickOwnerSuccessMessage(response: Pick<PickOwnerResponse, "projectName">) {
  return `Sent to the ${response.projectName} group chat. A stakeholder can take over this session.`;
}

export function pickOwnerErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === "pick_owner_pending") return "Picking an owner is already in progress.";
    if (error.code === "session_actor_bound") return "This session already has an owner.";
    if (error.code === "project_has_no_actors") return "This project has no workers to pick from.";
    if (error.code === "session_project_unresolved") return "This session does not belong to this project's group chat.";
    if (error.code === "session_not_found") return "This session no longer exists.";
    if (error.code === "session_not_accepting") return "This session cannot take a follow-up right now.";
    if (error.code === "pick_owner_invalid") return error.message || "The follow-up request was invalid.";
    return error.message;
  }
  return error instanceof Error ? error.message : "Unexpected error. Please try again.";
}

export function loadSessionPickOwner(sessionId: string, signal?: AbortSignal) {
  return apiJson<PickOwnerStatus>(`/api/sessions/${encodeURIComponent(sessionId)}/pick-owner`, { signal, fresh: true });
}

export function submitSessionPickOwner(sessionId: string, input: { requestId: string; message: string; chatProjectId: string }) {
  return apiJson<PickOwnerResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/pick-owner`, { method: "POST", body: input });
}
