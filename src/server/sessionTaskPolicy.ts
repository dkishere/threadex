export type SessionTaskCreationPolicyInput = {
  sourceSessionId: string | null;
  parentSessionId: string;
  todoItemId: string | null;
  contextFork: boolean;
  workerAssignment: {
    parentSessionId: string;
    itemId: string;
  } | null;
  existingTodoWorkerSessionId: string | null;
};

export type SessionTaskCreationPolicy =
  | { allowed: true }
  | {
      allowed: false;
      reason: "worker_followup";
      sessionId: string;
      parentSessionId: string;
      todoItemId: string;
    }
  | {
      allowed: false;
      reason: "todo_item_already_assigned";
      sessionId: string;
      parentSessionId: string;
      todoItemId: string;
    };

/**
 * Keep task creation an explicit boundary. A Todo worker continues every
 * ordinary follow-up in its current session; only the UI's explicit context
 * fork may create a child from that worker. A Todo item also owns at most one
 * worker task, so later delegation must resume the existing worker.
 */
export function decideSessionTaskCreation(
  input: SessionTaskCreationPolicyInput
): SessionTaskCreationPolicy {
  const isExplicitContextFork =
    input.contextFork &&
    input.todoItemId === null &&
    input.sourceSessionId !== null &&
    input.sourceSessionId === input.parentSessionId;

  if (input.workerAssignment && input.sourceSessionId && !isExplicitContextFork) {
    return {
      allowed: false,
      reason: "worker_followup",
      sessionId: input.sourceSessionId,
      parentSessionId: input.workerAssignment.parentSessionId,
      todoItemId: input.workerAssignment.itemId
    };
  }

  if (input.todoItemId && input.existingTodoWorkerSessionId) {
    return {
      allowed: false,
      reason: "todo_item_already_assigned",
      sessionId: input.existingTodoWorkerSessionId,
      parentSessionId: input.parentSessionId,
      todoItemId: input.todoItemId
    };
  }

  return { allowed: true };
}
