import { CONSULTANT_TOOLS } from "./consultantTools";
import { ACTOR_BLOCKER_KINDS } from "../actorBlockers";
import { ACTOR_MODEL_TIERS } from "../modelCatalog";
const text = { type: "string", minLength: 1 };
const actorModelTierInput = { type: ["array", "null"], items: { type: "string", enum: ACTOR_MODEL_TIERS }, description: "Allowed model tiers. null allows all tiers." };
/** Delegation stays with the host session: a sub-agent reports the actor it needs instead. */
export const ACTOR_DELEGATION_TOOLS: readonly string[] = ["actor_handoff", "actor_assign_many"];
export const NATIVE_CHILD_DELEGATION_ERROR = "Sub-agents cannot call actor_handoff or actor_assign_many. State in your result which actor is needed, what it must do and why; the host session decides.";
const spec = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({
  name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }
});
const actorMemoryInput = { type: "object", required: ["rolePrompt", "roleSummary", "longTerm", "rolling"],
  properties: { rolePrompt: text, roleSummary: text, longTerm: { type: "string" }, rolling: { type: "string" } }, additionalProperties: false };
const actorListInput = { offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 20 }, workspaceId: text, allWorkspaces: { type: "boolean" } };
const actorMemoryRangeInput = { field: { type: "string", enum: ["rolePrompt", "roleSummary", "longTerm", "rolling"] }, offset: { type: "integer", minimum: 0 },
  bytes: { type: "integer", minimum: 1, maximum: 8192 }, actorId: text, workspaceId: text };
const OTHER_WORKSPACE_RULE = "one of the user's own messages in this task names that workspace";

/** Registry tools for an ordinary task without an actor binding: read the roster and memory, and create a root as the user asks. */
export const ACTOR_REGISTRY_TOOLS = [
  spec("actor_list", `List a bounded page of workspace actors and their domains. This workspace is always readable; another workspace (workspaceId, or allWorkspaces to find a named actor) is listed only when ${OTHER_WORKSPACE_RULE} or actor.`, actorListInput, []),
  spec("actor_read_memory", `Read a bounded range of one actor's persistent memory by actorId, for example to copy relevant memory into a new actor at the user's request. An actor of another workspace (workspaceId) is readable only when ${OTHER_WORKSPACE_RULE} or actor.`, actorMemoryRangeInput, ["field", "actorId"]),
  spec("actor_create_root", `Create a root actor when requested by the user, in this workspace or in another workspace (workspaceId) only when ${OTHER_WORKSPACE_RULE}. The new actor may run only its chosen model until the user changes it in Settings; creation does not start work. List actors before creating and after an uncertain result.`, {
    name: text, model: text, memory: actorMemoryInput, workspaceId: text
  }, ["name", "model", "memory"])
];

export const DOMAIN_ACTOR_TOOLS = [
  ...CONSULTANT_TOOLS,
  spec("actor_create_root", `Create a root actor when requested by the user, in the current workspace or in another workspace (workspaceId) only when ${OTHER_WORKSPACE_RULE}. Inherits caller model permissions; does not start work. List actors before creating and after an uncertain result.`, {
    name: text, model: text, memory: actorMemoryInput, workspaceId: text
  }, ["name", "model", "memory"]),
  spec("actor_list", `List a bounded page of workspace actors and their domains to choose collaborators. This does not authorize execution. Another workspace (workspaceId, or allWorkspaces to find a named actor) is listed only when ${OTHER_WORKSPACE_RULE} or actor.`, actorListInput, []),
  spec("actor_tree_status", "Read a bounded page of your system-bound actor tree, work items and live sessions. Read memory explicitly with actor_read_memory.", {
    offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 20 }
  }, []),
  spec("actor_read_memory", `Choose a bounded range of persistent memory to load: your own by default, or another actor's with actorId when the user's request needs it (for example to prepare actor_reorganize or copy memory into a new actor). An actor of another workspace (workspaceId) is readable only when ${OTHER_WORKSPACE_RULE} or actor. Default task context contains excerpts; use this to select relevant additional context.`, actorMemoryRangeInput, ["field"]),
  spec("actor_reorganize", "Reorganize this workspace's actor registry in one atomic request, only when the user's own messages explicitly ask for that reorganization. Operations apply in order and the final registry is validated as a whole: create, update (name, model, effort, allowedModelTiers; projectIds on a root), move (parentActorId null promotes; otherwise the destination must be a root), memory (replace only the named rolePrompt, roleSummary, longTerm or rolling fields at expectedVersion) and archive (keeps history and reserves the ID). Submit with dryRun true first and report the preview; then apply exactly the previewed operations. The server checks an apply against the user's own messages and denies it when not explicitly requested or uncertain. Read actor_list for parent IDs and actor_read_memory with actorId for memory text and version. IDs, history, memory and existing work stay attached; work keeps its recorded owner and executor. A move fails while an affected tree has another running session or pending task operation; your current task is exempt. Retry an uncertain result with the same requestId and operations. Sub-agents cannot call it.", {
    requestId: { ...text, maxLength: 100 }, reason: { ...text, maxLength: 4000 }, dryRun: { type: "boolean" },
    operations: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", required: ["op"], properties: {
      op: { type: "string", enum: ["create", "update", "move", "memory", "archive"] }, actorId: text,
      actor: { type: "object", required: ["name", "model", "memory"], properties: { id: text, name: text, model: text, effort: text,
        parentActorId: { type: ["string", "null"], minLength: 1 }, allowedModelTiers: actorModelTierInput, allowedModels: { type: "array", items: text }, projectIds: { type: "array", items: text },
        memory: { type: "object", required: ["rolePrompt", "roleSummary", "longTerm", "rolling"], additionalProperties: false,
          properties: { rolePrompt: { type: "string" }, roleSummary: { type: "string" }, longTerm: { type: "string" }, rolling: { type: "string" } } } }, additionalProperties: false },
      changes: { type: "object", properties: { name: text, model: text, effort: text, allowedModelTiers: actorModelTierInput, allowedModels: { type: "array", items: text }, projectIds: { type: "array", items: text } }, additionalProperties: false },
      parentActorId: { type: ["string", "null"], minLength: 1 }, expectedParentActorId: { type: ["string", "null"], minLength: 1 },
      expectedVersion: { type: "integer", minimum: 0 },
      memory: { type: "object", properties: { rolePrompt: { type: "string" }, roleSummary: { type: "string" }, longTerm: { type: "string" }, rolling: { type: "string" } }, additionalProperties: false }
    }, additionalProperties: false } }
  }, ["requestId", "reason", "operations"]),
  spec("actor_create_sub", "Root actor only: create a direct sub-actor in your own tree. Permissions are system-owned.", {
    name: text, model: text, memory: actorMemoryInput
  }, ["name", "model", "memory"]),
  spec("actor_update_sub", "Root actor only: update a direct sub-actor name or default execution model.", {
    actorId: text, name: text, model: text
  }, ["actorId"]),
  spec("actor_reparent", "Root actor only: move a direct child under another root, or promote it with parentActorId null. IDs and memory are preserved. The current management work is exempt for a direct child; other active source or destination work conflicts. Project and model permissions cannot change or expand. Read actor_list for current parent and root IDs before submitting. To demote your own root, use signed-in settings when its tree is idle.", {
    actorId: text, parentActorId: { type: ["string", "null"], minLength: 1 },
    expectedParentActorId: { type: ["string", "null"], minLength: 1 }, expectedRootActorId: text
  }, ["actorId", "parentActorId", "expectedParentActorId", "expectedRootActorId"]),
  spec("actor_assign", "Root actor only: assign your existing work item to yourself or a direct sub-actor; preserve the same work identity. Choose model by what the assigned work needs (an explicit user model requirement first); an allowed model is final, otherwise Decision selects one.", {
    workItemId: text, executorActorId: text, model: text, requestId: { ...text, maxLength: 100, description: "Stable ID for this delegation. Reuse when retrying the same assignment." }
  }, ["workItemId", "executorActorId", "requestId"]),
  spec("actor_assign_many", "Ask other workspace actors to execute scoped portions of your current task concurrently, while your task continues. Requires explicit user intent or server-assigned whole-request ownership; the server checks every task against canonical user scope. Creates independent child work; retry the exact same request ID and tasks after an uncertain result. Sub-agents cannot call it. Returns pending when another request is in progress; assigned means reserved, inspect dispatchError for launch failures.", {
    requestId: { ...text, maxLength: 100 },
    tasks: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", required: ["executorActorId", "task"],
      properties: { executorActorId: text, task: { ...text, maxLength: 6000 } }, additionalProperties: false } }
  }, ["requestId", "tasks"]),
  spec("actor_handoff", "Hand follow-up work to another workspace actor when your task needs a change in that actor's domain (for example UI for a new backend event). Use actor_list for the actor ID. mode \"hosted\" (default) runs the actor as a native sub-agent of your session: start it now, in this turn, exactly as the result's start says (spawn_agent in Codex, the Agent tool in Claude). A result without start says it runs in a follow-up turn of this session instead. Either way you integrate its result. Use mode \"session\" (a separate task session) only for long-running or independently tracked work, an actor without an allowed model of your session's provider, work that must continue after your session ends, or when the user asks for it. The server records your session as the source, checks that the follow-up stays inside the user's request and selects the model. Write a self-contained task: what changed, the contract or files involved and what the actor must do. Respect the server-assigned ownership: a whole-request owner may make cross-domain changes directly and may delegate for expertise, context isolation, parallel progress or verification. Otherwise do not perform another actor's assigned portion yourself or only mention it in your reply. Sub-agents cannot call it. If refused, propose it to the user or report a blocker. Retry an uncertain result with the same request ID and input. For an actor of another workspace, pass its workspaceId from actor_list: allowed only when one of the user's own messages in this task names that workspace or actor; it runs as a separate request in that workspace with its own project, cwd and approvals.", {
    requestId: { ...text, maxLength: 100 }, executorActorId: text, task: { ...text, maxLength: 6000 }, mode: { type: "string", enum: ["hosted", "session"] }, workspaceId: text
  }, ["requestId", "executorActorId", "task"]),
  spec("actor_prompt_session", "Send a real prompt to another Threadex session when the user asks you to (for example \"tell the original thread to redo it\"). Do not prompt other sessions on your own initiative. Write a self-contained prompt with the context the target needs. Pass model and modelReasoningEffort when the user names them. This starts or queues a normal runner turn in the target and does not assign work through the actor system, so prefer actor_handoff for actors and actor_steer for running tasks in your tree. Sub-agents cannot call it.", {
    sessionId: text, message: { ...text, maxLength: 20000 }, model: text, modelReasoningEffort: text
  }, ["sessionId", "message"]),
  spec("actor_report_blocker", "Report what blocks your current task and a user answer cannot resolve (a repair, another actor's work or owner coordination), so its owner actor acts on it. Not for a user choice or clarification: after checking your brief, attachments and captures, ask that in this turn with your native ask-user-input tool and keep working. Same task and cause are deduplicated. Optionally include your proposed solution; mark requiresApproval when it needs user approval, exceeds the original authorization or is irreversible.", {
    kind: { type: "string", enum: [...ACTOR_BLOCKER_KINDS] }, description: { ...text, maxLength: 4000 }, evidence: { type: "string", maxLength: 4000 },
    proposal: { type: "string", maxLength: 4000 }, requiresApproval: { type: "boolean" }
  }, ["kind", "description"]),
  spec("actor_blocker_update", "Assess a blocker you own or execute by meaning: needs_user withdraws escalation and asks in the original task for a user choice or coordination it has not already asked (provide question, two or three options with impacts, and reason in text). Real defects requiring repair stay escalated; propose their concrete repair, report attempting/succeeded/failed, or explain unresolvable. A Git conflict alone does not determine classification. A pending user question is a reminder and does not stop repair or resolution. Any actor may propose for an escalated repair; approval requirements still apply.", {
    blockerId: text, update: { type: "string", enum: ["needs_user", "propose", "attempting", "succeeded", "failed", "unresolvable", "resolved"] },
    text: { type: "string", maxLength: 4000 }, requiresApproval: { type: "boolean" }, question: { type: "string", maxLength: 2000 },
    options: { type: "array", minItems: 2, maxItems: 3, items: { type: "object", additionalProperties: false, required: ["label", "description"], properties: { label: { type: "string", maxLength: 100 }, description: { type: "string", maxLength: 1000 } } } }
  }, ["blockerId", "update"]),
  spec("actor_steer","Send context to a running session in your actor tree or a related authorized parallel task through the collaboration messenger. Never creates a new assignment.", {
    sessionId: text, message: { ...text, maxLength: 6000 }, requestId: text
  }, ["sessionId", "message", "requestId"])
];
