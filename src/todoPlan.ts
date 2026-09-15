export const TODO_PLAN_CLARIFICATION_PAUSE_REASON = "Todo MCP plan needs clarification before it can be created.";

type TodoPlanClarificationSnapshot = {
  items?: unknown[] | null;
  control?: {
    pauseReason?: string | null;
  } | null;
} | null | undefined;

export function isTodoPlanAwaitingClarification(todo: TodoPlanClarificationSnapshot) {
  return Boolean(
    todo &&
    Array.isArray(todo.items) &&
    todo.items.length === 0 &&
    todo.control?.pauseReason === TODO_PLAN_CLARIFICATION_PAUSE_REASON
  );
}
