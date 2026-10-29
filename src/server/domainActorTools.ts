import { CONSULTANT_TOOLS } from "./consultantTools";
import { ACTOR_BLOCKER_KINDS } from "../actorBlockers";
const text = { type: "string", minLength: 1 };
const spec = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({
  name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }
});
export const DOMAIN_ACTOR_TOOLS = [
  ...CONSULTANT_TOOLS,
  spec("actor_create_root", "Create a root actor in the current workspace when requested by the user. Inherits caller model permissions; does not start work. List actors before creating and after an uncertain result.", {
    name: text, model: text, memory: { type: "object", required: ["rolePrompt", "roleSummary", "longTerm", "rolling"],
      properties: { rolePrompt: text, roleSummary: text, longTerm: { type: "string" }, rolling: { type: "string" } }, additionalProperties: false }
  }, ["name", "model", "memory"]),
  spec("actor_list", "List a bounded page of workspace actors and their domains to choose collaborators. This does not authorize execution.", {
    offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 20 }
  }, []),
  spec("actor_tree_status", "Read a bounded page of your system-bound actor tree, work items and live sessions. Read memory explicitly with actor_read_memory.", {
    offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 20 }
  }, []),
  spec("actor_read_memory", "Choose a bounded range of your own persistent memory to load. Default task context contains excerpts; use this to select relevant additional context.", {
    field: { type: "string", enum: ["rolePrompt", "roleSummary", "longTerm", "rolling"] }, offset: { type: "integer", minimum: 0 }, bytes: { type: "integer", minimum: 1, maximum: 8192 }
  }, ["field"]),
  spec("actor_create_sub", "Root actor only: create a direct sub-actor in your own tree. Permissions are system-owned.", {
    name: text, model: text, memory: { type: "object", required: ["rolePrompt", "roleSummary", "longTerm", "rolling"],
      properties: { rolePrompt: text, roleSummary: text, longTerm: { type: "string" }, rolling: { type: "string" } }, additionalProperties: false }
  }, ["name", "model", "memory"]),
  spec("actor_update_sub", "Root actor only: update a direct sub-actor name or default execution model.", {
    actorId: text, name: text, model: text
  }, ["actorId"]),
  spec("actor_assign", "Root actor only: assign your existing work item to yourself or a direct sub-actor; preserve the same work identity. Choose model by what the assigned work needs (an explicit user model requirement first); an allowed model is final, otherwise Decision selects one.", {
    workItemId: text, executorActorId: text, model: text, requestId: { ...text, maxLength: 100, description: "Stable ID for this delegation. Reuse when retrying the same assignment." }
  }, ["workItemId", "executorActorId", "requestId"]),
  spec("actor_assign_many", "Ask other workspace actors to execute scoped portions of your current task concurrently, while your task continues. Requires explicit user intent, checked against saved user messages by the server. Creates independent child work; retry the exact same request ID and tasks after an uncertain result. Returns pending when another request is in progress; assigned means reserved, inspect dispatchError for launch failures.", {
    requestId: { ...text, maxLength: 100 },
    tasks: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", required: ["executorActorId", "task"],
      properties: { executorActorId: text, task: { ...text, maxLength: 6000 } }, additionalProperties: false } }
  }, ["requestId", "tasks"]),
  spec("actor_handoff", "Create follow-up work for another workspace actor when your task needs a change in that actor's domain (for example UI for a new backend event). The server records your session as the source, checks that the follow-up stays inside the user's request, selects the model and dispatches it through the actor's normal task flow. Use actor_list for the actor ID. Write a self-contained task: what changed, the contract or files involved and what the actor must do. Do not make the change yourself or only mention it in your reply. If refused, propose it to the user or report a blocker. Retry an uncertain result with the same request ID and input.", {
    requestId: { ...text, maxLength: 100 }, executorActorId: text, task: { ...text, maxLength: 6000 }
  }, ["requestId", "executorActorId", "task"]),
  spec("actor_report_blocker", "Report what blocks your current task so its owner actor must act on it. Same task and cause are deduplicated. Optionally include your proposed solution; mark requiresApproval when it needs user approval, exceeds the original authorization or is irreversible.", {
    kind: { type: "string", enum: [...ACTOR_BLOCKER_KINDS] }, description: { ...text, maxLength: 4000 }, evidence: { type: "string", maxLength: 4000 },
    proposal: { type: "string", maxLength: 4000 }, requiresApproval: { type: "boolean" }
  }, ["kind", "description"]),
  spec("actor_blocker_update", "Work a blocker you own or execute: propose a solution, report attempting/succeeded/failed, declare it unresolvable (escalates to every workspace actor) or mark it resolved. Any actor may propose for an escalated blocker. Proposals requiring approval cannot be attempted.", {
    blockerId: text, update: { type: "string", enum: ["propose", "attempting", "succeeded", "failed", "unresolvable", "resolved"] },
    text: { type: "string", maxLength: 4000 }, requiresApproval: { type: "boolean" }
  }, ["blockerId", "update"]),
  spec("actor_steer","Send context to a running session in your actor tree or a related authorized parallel task through the collaboration messenger. Never creates a new assignment.", {
    sessionId: text, message: { ...text, maxLength: 6000 }, requestId: text
  }, ["sessionId", "message", "requestId"])
];
