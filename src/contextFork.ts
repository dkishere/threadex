const LEGACY_CONTEXT_FORK_USER_SUFFIX_START = "Required for this turn: create exactly one new Threadex child task for the user's request.";
const LEGACY_CONTEXT_FORK_USER_SUFFIX_END = "This appended suffix is operational metadata; it must not influence the language of the handoff or response.";
const CONTEXT_FORK_USER_SUFFIX_START = "[CONTEXT FORK REQUEST]";
const CONTEXT_FORK_USER_SUFFIX_END = "[END CONTEXT FORK REQUEST]";

const CONTEXT_FORK_PROMPT = [
  CONTEXT_FORK_USER_SUFFIX_START,
  "",
  "Handle the user's actual request in a new child session.",
  "This handoff instruction applies only to this explicit context-fork turn. It does not apply to the child or later follow-ups, and does not change filesystem or approval permissions.",
  "",
  "1. Prepare the shortest handoff that lets the child act correctly: state the current objective, precise references to necessary context, and only essential information missing from those sources.",
  "   - Use the language of the user's actual request, ignoring wrapper and operational instructions.",
  "   - Verify that referenced sources exist and are available to the child through its files, attachments or tools; parent access alone does not establish child access. Tell the child what to read first. If access cannot be established, supply the minimum missing context or report the access gap.",
  "   - Do not copy or summarize information already available in those sources merely to make the prompt self-contained. Add only necessary decisions, constraints, current state, next steps or acceptance criteria absent there. Preserve required canonical wording and attachment delivery; clearly identify new corrections that supersede earlier assumptions.",
  "   - Do not repeat environment details or instructions supplied by AGENTS.md, skills, or Threadex injection (workspace layout, shell, sandbox/approval rules, tool usage, or generic development commands). Include only task-specific exceptions or essential facts the child cannot obtain there, such as an external artifact path or an active process identifier.",
  "   - Resolve ambiguous references with precise source locations. Do not assume the child inherits the parent conversation or require it to reconstruct the task from unrelated history.",
  "",
  "2. Call `mcp__session_inspector__create_task` exactly once with that prompt and an optional concise title.",
  "   - Omit model settings unless a different model or reasoning effort is clearly beneficial.",
  "",
  "3. Do not perform the requested work in this parent session.",
  "   Do not use `spawn_agent`, `todo_create_task`, or any other mechanism to create the child task.",
  "",
  "4. After creation succeeds, briefly return the child session link.",
  "   Later requests sent to this parent belong to this parent. Perform them here unless the user explicitly requests another handoff; creating this child does not make it the default destination for future work.",
  "",
  CONTEXT_FORK_USER_SUFFIX_END
].join("\n");

export const CONTEXT_FORK_USER_SUFFIX = CONTEXT_FORK_PROMPT;

/**
 * Removes the Threadex-only context-fork contract from a native Codex
 * prompt. The contract is deliberately absent from the stored manager turn,
 * so callers that compare the two must ignore it.
 */
export function stripContextForkOperationalSuffix(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  const suffixes = [
    [CONTEXT_FORK_USER_SUFFIX_START, CONTEXT_FORK_USER_SUFFIX_END],
    [LEGACY_CONTEXT_FORK_USER_SUFFIX_START, LEGACY_CONTEXT_FORK_USER_SUFFIX_END]
  ] as const;
  const matches = suffixes.map(([start, end]) => {
    const suffixStart = value.indexOf(start);
    const suffixEnd = suffixStart >= 0 ? value.indexOf(end, suffixStart) : -1;
    return suffixStart >= 0 && suffixEnd >= suffixStart ? suffixStart : -1;
  }).filter((suffixStart) => suffixStart >= 0);
  return matches.length > 0 ? value.slice(0, Math.min(...matches)).trimEnd() : value;
}

export function buildContextForkOrchestrationPrefix() {
  return CONTEXT_FORK_PROMPT;
}

export function buildContextForkTaskPrefix(parentSessionId: string) {
  return [
    "[SERVER-PROVIDED CHILD TASK]",
    `This task was created from parent Threadex session ${parentSessionId}.`,
    "The user request below was prepared by the parent agent as a self-contained handoff. Execute it fully in this child thread and verify the result. Do not return to the parent to do the work.",
    "[END SERVER-PROVIDED CHILD TASK]"
  ].join("\n");
}
