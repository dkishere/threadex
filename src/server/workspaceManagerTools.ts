import { MODEL_CATALOG, WORKSPACE_MANAGER_MODEL_ORDER } from "../modelCatalog";

const text = { type: "string", minLength: 1 };
const model = { type: "string", enum: [...WORKSPACE_MANAGER_MODEL_ORDER, MODEL_CATALOG.sol.id], description: "Explicit worker model chosen by the persistent workload policy. Use gpt-6.1-sol for the Sol tier; gpt-6-sol is accepted only for an existing requestId retry. Luna is for tightly scoped mechanical work; Astra for 3D, security or large reviews/plans." };
const session = { ...text, description: "An exact session ID from this workspace's status or search results." };
const attachmentSourceTurnId = { ...text, description: "Exact turn ID holding the original uploaded files in this workspace. Omit for files on the current manager turn. The server copies saved files into the destination turn; a filename, path or summary in the brief does not attach them." };
const requestId = { ...text, maxLength: 100, description: "A unique ID for this action. Reuse it only when retrying the same action." };
const brief = { ...text, maxLength: 250000, description: "Forward the user's request verbatim and preserve confirmed clarifications. Add only prerequisite context needed to understand it that exists solely in the manager session and is unavailable to this task. Otherwise add nothing: no inferred requirements, plans, advice, checklists, generic reminders or model rationale. Ask the user first if material ambiguity would change direction. For corrections, identify the superseded assumption." };
const followup = { ...text, maxLength: 250000, description: "Forward only the new user request or correction, preserving its wording. Add only prerequisite context needed to understand it that exists solely in the manager session and is unavailable to this task. Do not repeat known context or add interpretations, plans, advice, checklists or model rationale. Identify the superseded assumption when correcting it. Preserve the full request and actual files on an attachment-bearing request's first handoff. For a fork, include the required handoff details and carry those files into the child." };
const spec = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }
});

export const WORKSPACE_MANAGER_TOOLS = [
  spec("workspace_steer_task", "Deliver a concise correction, review finding or context update to the currently running task. Send only new information, including the verbatim request and actual files when this is their first destination handoff. This continues the active turn without queuing work or changing its model. Requires an inspected running turnId; verify attached files from the returned attachment records. If rejected, inspect current state; never automatically queue the notification or blindly retry an uncertain delivery.", {
    sessionId: session, turnId: text,
    attachmentSourceTurnId,
    message: { ...text, maxLength: 6000, description: "Only the actionable delta and necessary source reference, normally 1–3 short bullets. Quote new user corrections exactly; identify the superseded assumption. Include a new attachment-bearing request verbatim on its first handoff. Omit other repeated background and model-selection rationale." }
  }, ["sessionId", "turnId", "message"]),
  spec("workspace_status", "Read this workspace's live task, pending approval and process status, with recent task results and registered project directories.", {}),
  spec("workspace_search_tasks", "When no suitable thread is already known in manager context, search this workspace's saved task/history and results, including old/completed work. Search each independent objective and inspect plausible matches. Similarity alone does not justify follow-up.", {
    query: { type: "string" }, offset: { type: "integer", minimum: 0 }
  }),
  spec("workspace_inspect_task", "Read five saved turns, completedRoundTrips (completed user/agent exchanges), execution evidence, verified saved attachment counts and recent running activity. Inspect a context-known thread first when relevant; otherwise inspect search results. After create/prompt/fork, pass the returned turnId to verify that exact turn and its uploaded files; queued/accepted is not running. Omit turnId for recent history; increase offset for older turns. You may inspect your own manager history.", {
    sessionId: session, turnId: { ...text, description: "Exact dispatched turn to verify; omit when browsing task history." }, offset: { type: "integer", minimum: 0 }
  }, ["sessionId"]),
  spec("workspace_create_task", "Only when no suitable context-known or searched thread exists, create a separate task for an independent objective. Split unrelated parts of mixed requests. Set parentSessionId only for a clear continuation or established work group; omit it when there is no clear relationship. Forward the user request with only necessary manager-only prerequisite context; choose cwd from the confirmed project. This requests a start: inspect the returned turnId before reporting running.", {
    title: { ...text, maxLength: 180 }, message: brief, requestId, cwd: text, model, attachmentSourceTurnId,
    parentSessionId: { ...session, description: "Use only for a clear continuation or established work group, never mere workspace/project similarity or visibility. Omit if there is no clear relationship. Controls hierarchy only; does not copy or resume context. Keep the same choice on creation retries." }
  }, ["title", "message", "requestId", "cwd", "model"]),
  spec("workspace_prompt_task", "Only for a clear, tight, direct continuation of the same objective established by inspecting a context-known or searched thread with at most 15 completed user/agent round trips (completedRoundTrips <= 15), or an authorized restart. Longer suitable threads use workspace_fork_task. Unrelated objectives use workspace_create_task. Inspect the returned turnId to verify execution.", {
    sessionId: session, message: followup, requestId, model, attachmentSourceTurnId
  }, ["sessionId", "message", "requestId", "model"]),
  spec("workspace_fork_task", "For a direct continuation whose inspected thread has more than 15 completed user/agent round trips (completedRoundTrips > 15). Queue the same Context Fork/Fork badge handoff in that thread; its agent creates a child with inherited context. Tell that agent to carry the canonical user wording verbatim into the child brief. The returned turn is the handoff, not the child. Verify the child session and its actual runner state before saying work started. Reuse requestId on retry.", {
    sessionId: session, message: followup, requestId, model, attachmentSourceTurnId
  }, ["sessionId", "message", "requestId", "model"]),
  spec("workspace_stop_task", "Stop running work and cancel pending turns in an ordinary task in this workspace. Never restart user-stopped work without authorization.", {
    sessionId: session
  }, ["sessionId"]),
  spec("workspace_continue_stronger", "Always available, independent of Loop alerts. For a manager-approved intervention, stop a task's running and queued turns, then continue the same task context on the next stronger supported model (Luna → Sol → Astra). Preserve the existing objective in the continuation brief and explain the intervention. Inspect the returned turnId before claiming the stronger turn started. Never restart work stopped by the user without authorization; a stall alert alone does not require intervention. Reuse requestId on retry.", {
    sessionId: session, message: followup, requestId
  }, ["sessionId", "message", "requestId"])
];

export const WORKSPACE_MANAGER_ACTIONS: Record<string, string> = {
  workspace_steer_task: "steer",
  workspace_status: "status", workspace_search_tasks: "search", workspace_inspect_task: "inspect",
  workspace_create_task: "create", workspace_prompt_task: "prompt", workspace_fork_task: "fork", workspace_stop_task: "stop",
  workspace_continue_stronger: "continue_stronger"
};
