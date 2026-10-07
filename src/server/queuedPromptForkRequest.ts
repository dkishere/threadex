import { createHash } from "node:crypto";

export function sessionTaskRequestSessionId(sourceSessionId: string | null, requestId: string) {
  return `tx_${createHash("sha256").update(`${sourceSessionId}:${requestId}`).digest("hex").slice(0, 32)}`;
}

/** Keep request routing and lost-response recovery tied to the same source. */
export function queuedPromptForkRequestTarget(input: {
  parentSessionId: string;
  managerSessionId: string;
  requestId: string;
  cwd: string;
}, workspaceManagerSessionId: string | null) {
  const managerOwned = workspaceManagerSessionId === input.managerSessionId &&
    input.parentSessionId === input.managerSessionId;
  const sourceSessionId = input.parentSessionId;
  const sessionId = sessionTaskRequestSessionId(sourceSessionId, input.requestId);
  return {
    request: {
      parentSessionId: input.parentSessionId,
      sourceSessionId,
      ...(managerOwned
        ? { managerRequestId: input.requestId, cwd: input.cwd }
        // Ordinary forks inherit the source cwd; explicit cwd is Manager-only.
        : { queueForkRequestId: input.requestId, contextFork: true as const })
    },
    sessionId,
    turnId: `manager_task_${sessionId}`
  };
}
