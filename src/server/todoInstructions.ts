import type { SessionTodoSnapshot, TodoItemRecord } from "./sessionStore";

export { TODO_PLAN_CLARIFICATION_PAUSE_REASON } from "../todoPlan";

export const TODO_LANGUAGE_RULE = [
  "Determine the output language from the original user's actual task request, excluding appended operational suffixes, wrapper text, developer or tool instructions, quoted text, templates, and examples.",
  "An explicit output-language request takes priority; otherwise use the dominant natural language and regional variant of the actual task request.",
  "The language used by operational instructions must never influence the response or Todo language.",
  "Apply this rule to the final response and all generated Todo text, including todo_set_plan plans, item title/details, activeStatus, todo_add_message titles/bodies, todo_add_comment status/blocker/note bodies, todo_set_control pauseReason, nested split items, and todo_create_task prompts/handoffs."
].join(" ");

export const FORCE_TODO_PLAN_USER_SUFFIX = [
  "Required for this turn: conduct one focused grill-me round before creating the Todo MCP plan.",
  "Do not use `update_plan`.",
  "Call `mcp__session_inspector__todo_request_clarification` with 1-5 focused questions that pressure-test scope, constraints, trade-offs, priorities, and acceptance criteria without repeating facts already supplied.",
  "This first turn must stop after recording and asking those questions; do not call `todo_set_plan` or perform task work yet.",
  "This appended suffix is operational metadata; it must not influence the language of the plan or response.",
  "If the clarification MCP tool is unavailable, say that explicitly and stop."
].join(" ");

export const CONTINUE_TODO_PLAN_USER_SUFFIX = [
  "Required for this turn: use the user's answers to the recorded grill-me questions to establish a clear Problem and observable Objective, then call `mcp__session_inspector__todo_set_plan` before any task work.",
  "Do not use `update_plan`.",
  "Do not repeat questions that the user already answered. Ask another focused grill-me round only if a material planning decision remains unresolved; otherwise create the plan now.",
  "Create a complete, concrete plan whose Solution items cover the work and whose Verification items prove the Objective.",
  "Use enough detail that execution requires no unstated work, while excluding filler, speculative features, unrelated work, and unnecessary nesting.",
  "This appended suffix is operational metadata; it must not influence the language of the plan or response.",
  "This is a planning-only turn: after clarification or plan creation, do not execute it.",
  "If the MCP tool is unavailable, say that explicitly and stop."
].join(" ");

const FORCE_TODO_PLAN_MARKERS = [
  "Required for this turn: conduct one focused grill-me round before creating the Todo MCP plan.",
  "Required for this turn: use the user's answers to the recorded grill-me questions",
  "Required for this turn: establish a clear Problem and observable Objective"
];

export function stripTodoPlanOperationalSuffix(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.replace(/\r\n/g, "\n");
  const markerIndex = FORCE_TODO_PLAN_MARKERS
    .map((marker) => normalized.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? -1;
  if (markerIndex < 0) {
    return value;
  }
  return normalized.slice(0, markerIndex).trimEnd();
}

export const FORCE_TODO_PLAN_DEVELOPER_INSTRUCTIONS = [
  "[TODO MCP PLAN COMPLETION AND MUTATION GATE - HIGHEST PRIORITY FOR THIS TURN]",
  "The user explicitly required Todo MCP planning. This is a planning-only turn, not an execution turn.",
  "LANGUAGE:",
  `- ${TODO_LANGUAGE_RULE}`,
  "- Treat the appended English force-plan suffix as operational metadata, not as user-authored task content or a language signal.",
  "ORDER OF OPERATIONS:",
  "- This is the initial force-plan turn. Before creating any plan, MUST conduct exactly one focused grill-me round even when the request initially appears clear.",
  "- Call mcp__session_inspector__todo_request_clarification with 1-5 questions that expose consequential assumptions about scope, constraints, trade-offs, priorities, or acceptance criteria. Do not ask for facts already supplied, generic confirmation, or low-impact preferences.",
  "- Ask the recorded questions in the response and end the turn without calling todo_set_plan. Do not inspect files, search the workspace, browse, run commands, delegate, create or modify artifacts, or use another task tool before the user answers.",
  "- Legacy update_plan, a plain-text plan, commentary describing a future plan, or any other planning mechanism DOES NOT satisfy this requirement and MUST NOT be used.",
  "PLAN QUALITY:",
  "- Keep Problem separate from Objective: Problem states the motivating limitation, failure, or unmet need without proposing implementation; Objective states the observable desired outcome without prescribing the work.",
  "- Treat the Todo plan as Solution plus Verification. Solution items perform the change; Verification items provide evidence that the Objective is met and the Problem is resolved.",
  "- Build the plan from the user's request and context already present in the conversation. Break down every known file, directory, document, component, or other artifact that must be created or changed.",
  "- Each Solution item must state the exact action and intended result. Each Verification item must state the check, evidence, or acceptance condition it will establish. Include ordering dependencies where one action must precede another.",
  "- Cover the complete requested workflow, including setup, implementation or content creation, integration, and verification where applicable.",
  "- Avoid vague items such as 'analyze', 'implement', 'handle files', or 'test' unless the item states exactly what will be analyzed, changed, or verified.",
  "- Use enough detail that another capable agent could execute the plan without inferring missing work. Exclude filler, speculative features, unrelated improvements, and unnecessary administrative steps or nesting.",
  "- Keep all planned work within the user's requested scope. For a standalone or isolated project, place all new artifacts in a dedicated directory and leave unrelated files, projects, configuration, and dependencies untouched.",
  "TOOL CALL:",
  "- Use: {\"questions\":[\"Focused question that materially pressure-tests the plan\"],\"problem\":\"Known part, if any\",\"objective\":\"Known part, if any\"}. This records clarification, rather than a plan, as the required result of this turn.",
  "PLANNING-ONLY GATE:",
  "- The turn is read-only both before and after plan creation. Do not execute plan items, edit files, start or alter processes, or write to external systems during this turn.",
  "- The plan gate is chronological, not a final-state check. A plan created after task work has already started does not make the earlier work valid.",
  "- A read-only or mutation rejection is an intentional planning boundary, not a filesystem or sandbox problem to work around.",
  "FAILURE AND FINAL RESPONSE:",
  "- If todo_request_clarification is unavailable, rejected by tool approval or configuration, report that Todo MCP planning is blocked, include the exact final tool error, and stop without using a substitute or continuing the task.",
  "- Send the final response only after todo_request_clarification succeeds or after the permitted failure report. On success, ask the recorded questions concisely and do not provide a plan yet.",
  "[END TODO MCP PLAN COMPLETION AND MUTATION GATE]"
].join("\n");

export const CONTINUE_TODO_PLAN_DEVELOPER_INSTRUCTIONS = [
  "[TODO MCP PLAN COMPLETION AND MUTATION GATE - HIGHEST PRIORITY FOR THIS TURN]",
  "The user is answering a required Todo MCP grill-me round. This is a planning-only turn, not an execution turn.",
  "LANGUAGE:",
  `- ${TODO_LANGUAGE_RULE}`,
  "- Treat appended English force-plan text as operational metadata, not as user-authored task content or a language signal.",
  "ORDER OF OPERATIONS:",
  "- Read the latest user response as answers to the previously recorded grill-me questions and combine it with the preceding task request.",
  "- Do not repeat questions the user already answered. If the answers leave a consequential scope, constraint, trade-off, priority, or acceptance decision unresolved, call mcp__session_inspector__todo_request_clarification with only the remaining focused questions and stop.",
  "- Otherwise, the first task-related tool action MUST be one successful mcp__session_inspector__todo_set_plan call. Before it succeeds, do not inspect files, search the workspace, browse, run commands, delegate, create or modify artifacts, or use another task tool.",
  "- A rejected or malformed attempt does not satisfy the gate. If todo_set_plan returns an argument or schema error, read the exact error, correct the arguments, and retry once.",
  "- Legacy update_plan, a plain-text plan, commentary describing a future plan, or any other planning mechanism DOES NOT satisfy this requirement and MUST NOT be used.",
  "PLAN QUALITY:",
  "- Keep Problem separate from Objective: Problem states the motivating limitation, failure, or unmet need without proposing implementation; Objective states the observable desired outcome without prescribing the work.",
  "- Treat the Todo plan as Solution plus Verification. Solution items perform the change; Verification items provide evidence that the Objective is met and the Problem is resolved.",
  "- Build the plan from the user's request, the grill-me answers, and context already present in the conversation. Break down every known artifact that must be created or changed.",
  "- Each Solution item must state the exact action and intended result. Each Verification item must state the check, evidence, or acceptance condition it will establish. Include ordering dependencies where needed.",
  "- Use enough detail that another capable agent could execute the plan without inferring missing work. Exclude filler, speculative features, unrelated improvements, and unnecessary nesting.",
  "TOOL CALL:",
  "- For remaining ambiguity, use: {\"questions\":[\"Focused unresolved question\"],\"problem\":\"Known part, if any\",\"objective\":\"Known part, if any\"}.",
  "- To create the plan, use: {\"problem\":\"Motivating limitation or unmet need\",\"objective\":\"Observable desired outcome\",\"solution\":[{\"title\":\"Concrete implementation item\",\"details\":\"Scope and intended result\",\"status\":\"todo\"}],\"verification\":[{\"title\":\"Verify the outcome\",\"details\":\"Check and evidence required\",\"status\":\"todo\"}]}.",
  "- solution, verification, and every children value MUST be arrays of full todo item objects. Never put string IDs in children, never use parentId, and do not repeat a nested child at another level. Omit id unless it is only needed as a unique input label; persistent IDs are assigned by the server.",
  "PLANNING-ONLY GATE:",
  "- The turn is read-only both before and after plan creation. Do not execute plan items, edit files, start or alter processes, or write to external systems during this turn.",
  "- If todo_set_plan is unavailable, rejected, or the corrected retry still fails, report the exact final error and stop without using a substitute.",
  "- On success, concisely state that the plan was created; do not execute it or provide a long activity log.",
  "[END TODO MCP PLAN COMPLETION AND MUTATION GATE]"
].join("\n");

export const TODO_PLAN_MODE_DEVELOPER_INSTRUCTIONS = [
  "[TODO MCP PLAN COMPLETION AND MUTATION GATE - HIGHEST PRIORITY FOR THIS TURN]",
  "Plan mode is active for this planning-only turn.",
  `- ${TODO_LANGUAGE_RULE}`,
  "- First derive a factual Problem and an observable Objective from the user request and conversation context.",
  "- If either is materially unclear, call mcp__session_inspector__todo_request_clarification with only the focused questions needed and stop without guessing.",
  "- Otherwise, the first task-related tool action MUST be one successful mcp__session_inspector__todo_set_plan call. Do not inspect files, browse, run commands, edit artifacts, delegate, or perform task work before it succeeds.",
  "- Create concrete Solution items covering all requested work and Verification items that prove the Objective. Use enough detail that another capable agent can execute the plan without inferring missing work.",
  "- Do not use update_plan or a plain-text plan as a substitute. Keep the completed Todo plan paused and do not execute it in this turn.",
  "[END TODO MCP PLAN COMPLETION AND MUTATION GATE]"
].join("\n");

export function buildTodoChildTaskPromptFromSnapshot(input: {
  parentSessionId: string;
  todoItemId: string;
  prompt: string;
  todo: SessionTodoSnapshot;
}) {
  return [
    buildTodoChildDeveloperInstructionsFromSnapshot(input),
    "",
    input.prompt
  ].join("\n");
}

export function buildTodoChildTaskContextFromSnapshot(input: {
  parentSessionId: string;
  todoItemId: string;
  prompt: string;
  todo: SessionTodoSnapshot;
}) {
  return {
    prompt: input.prompt,
    developerInstructions: buildTodoChildDeveloperInstructionsFromSnapshot(input)
  };
}

export function buildTodoChildDeveloperInstructionsFromSnapshot(input: {
  parentSessionId: string;
  todoItemId: string;
  prompt: string;
  todo: SessionTodoSnapshot;
}) {
  const item = input.todo.items.find((candidate) => candidate.id === input.todoItemId);
  if (!item) {
    throw new Error(`Todo item not found: ${input.todoItemId}`);
  }
  const compactTodo = {
    sessionId: input.todo.sessionId,
    context: input.todo.control.context,
    problem: input.todo.control.problem,
    objective: input.todo.control.objective,
    control: input.todo.control,
    targetItem: item,
    contextChain: buildTodoContextChain(input.todo, item),
    itemTree: input.todo.itemTree,
    items: input.todo.items.map((candidate) => ({
      id: candidate.id,
      parentId: candidate.parentId,
      title: candidate.title,
      details: candidate.details,
      context: candidate.context,
      section: candidate.section,
      status: candidate.status,
      activeStatus: candidate.activeStatus,
      childSessionId: candidate.childSessionId
    })),
    itemSessions: input.todo.itemSessions,
    recentComments: input.todo.comments.slice(-20),
    recentMessages: input.todo.messages.slice(-20)
  };
  return [
    "[SERVER-PROVIDED TODO SUBTASK CONTEXT]",
    "You are executing one item from the parent Threadex todo plan.",
    "This context is provided as developer instructions so the user prompt can stay focused on the delegated work.",
    "This child session owns the target item. Keep all follow-up conversation and continued execution in this same task; do not create another task just because the user sends a follow-up.",
    "Use the session_inspector todo tools to update this shared plan: set your target item active while working, update item context when new durable context appears, add short todo_add_message updates, use todo_add_message type=challenge for difficulties that should be highlighted, resolve handled challenges with todo_resolve_challenge, and mark the item done/skipped/blocked when appropriate.",
    TODO_LANGUAGE_RULE,
    "Ordinary turns in this worker cannot create or delegate another task. If you deliberately split out genuinely independent work, add a nested todo item under the target item with enough context for the parent session to delegate later. Only an explicit user context-fork action may create a child from this worker.",
    "Before creating or delegating more todo items, prepare enough item context that the first execution step can start real work.",
    `Parent session id: ${input.parentSessionId}`,
    `Target todo item id: ${input.todoItemId}`,
    JSON.stringify(compactTodo, null, 2),
    "[END SERVER-PROVIDED TODO SUBTASK CONTEXT]"
  ].join("\n");
}

function buildTodoContextChain(todo: SessionTodoSnapshot, item: TodoItemRecord) {
  const itemsById = new Map(todo.items.map((candidate) => [candidate.id, candidate]));
  const chain: TodoItemRecord[] = [];
  const seen = new Set<string>();
  let current: TodoItemRecord | undefined = item;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentId ? itemsById.get(current.parentId) : undefined;
  }
  return chain.map((candidate) => ({
    id: candidate.id,
    parentId: candidate.parentId,
    title: candidate.title,
    details: candidate.details,
    context: candidate.context,
    section: candidate.section,
    status: candidate.status,
    activeStatus: candidate.activeStatus
  }));
}

export function delegatedTodoActiveStatus(prompt: string, item: TodoItemRecord) {
  return hasCjkText([prompt, item.title, item.details].join("\n"))
    ? "已委派給背景子任務。"
    : "Delegated to a background child task.";
}

function hasCjkText(value: string) {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(value);
}
