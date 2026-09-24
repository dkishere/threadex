const text = { type: "string", minLength: 1 };
const session = { ...text, description: "An exact session ID from this workspace's status or search results." };
const requestId = { ...text, maxLength: 100, description: "A unique ID for this action. Reuse it only when retrying the same action." };
const brief = { ...text, maxLength: 250000, description: "Preserve the relevant user's original words verbatim as the canonical request and quote confirmed clarifications. Label your interpretation of meaning/cause as possibly wrong; require the worker to verify original intent and context before acting. Ask the user first if material ambiguity would change direction. For corrections, explicitly supersede the old assumption and conflicting brief." };
const spec = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }
});

export const WORKSPACE_MANAGER_TOOLS = [
  spec("workspace_status", "Read this workspace's live task, pending approval and process status, with recent task results and registered project directories.", {}),
  spec("workspace_search_tasks", "When no suitable thread is already known in manager context, search this workspace's saved task/history and results, including old/completed work. Search each independent objective and inspect plausible matches. Similarity alone does not justify follow-up.", {
    query: { type: "string" }, offset: { type: "integer", minimum: 0 }
  }),
  spec("workspace_inspect_task", "Read five saved turns, completedRoundTrips (completed user/agent exchanges) and execution evidence. Inspect a context-known thread first when relevant; otherwise inspect search results. After create/prompt/fork, pass the returned turnId to verify that exact turn; queued/accepted is not running. Omit turnId for recent history; increase offset for older turns. You may inspect your own manager history.", {
    sessionId: session, turnId: { ...text, description: "Exact dispatched turn to verify; omit when browsing task history." }, offset: { type: "integer", minimum: 0 }
  }, ["sessionId"]),
  spec("workspace_create_task", "Only when no suitable context-known or searched thread exists, create a separate task for an independent objective. Split unrelated parts of mixed requests. Deliberately choose parentSessionId. Give a self-contained brief with findings and acceptance checks; choose cwd from the confirmed project. This requests a start: inspect the returned turnId before reporting running.", {
    title: { ...text, maxLength: 180 }, message: brief, requestId, cwd: text,
    parentSessionId: { ...session, description: "Choose a suitable parent in this workspace using history or the user's choice. Omit only when the manager is the deliberate best parent. Controls hierarchy only; does not copy or resume context. Keep the same parent on creation retries." }
  }, ["title", "message", "requestId", "cwd"]),
  spec("workspace_prompt_task", "Only for a clear, tight, direct continuation of the same objective established by inspecting a context-known or searched thread with at most 15 completed user/agent round trips (completedRoundTrips <= 15), or an authorized restart. Longer suitable threads use workspace_fork_task. Unrelated objectives use workspace_create_task. Inspect the returned turnId to verify execution.", {
    sessionId: session, message: brief, requestId
  }, ["sessionId", "message", "requestId"]),
  spec("workspace_fork_task", "For a direct continuation whose inspected thread has more than 15 completed user/agent round trips (completedRoundTrips > 15). Queue the same Context Fork/Fork badge handoff in that thread; its agent creates a child with inherited context. Tell that agent to carry the canonical user wording verbatim into the child brief. The returned turn is the handoff, not the child. Verify the child session and its actual runner state before saying work started. Reuse requestId on retry.", {
    sessionId: session, message: brief, requestId
  }, ["sessionId", "message", "requestId"]),
  spec("workspace_stop_task", "Stop running work and cancel pending turns in an ordinary task in this workspace. Never restart user-stopped work without authorization.", {
    sessionId: session
  }, ["sessionId"])
];

export const WORKSPACE_MANAGER_ACTIONS: Record<string, string> = {
  workspace_status: "status", workspace_search_tasks: "search", workspace_inspect_task: "inspect",
  workspace_create_task: "create", workspace_prompt_task: "prompt", workspace_fork_task: "fork", workspace_stop_task: "stop"
};
