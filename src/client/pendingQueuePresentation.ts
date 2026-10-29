import type { ChatMessage } from "./appTypes";

export function partitionPendingQueueMessages(messages: ChatMessage[]) {
  // A round table turn is written as queued while it is created and again while
  // its host response starts. It belongs in the queue only behind another turn.
  let earlierTurnActive = false;
  const queuedResponses = new Map(messages.flatMap((message) => {
    if (message.role !== "assistant" || !message.turnId) return [];
    const queued = message.turnStatus === "todo" && message.pendingReason === "queued" &&
      (!message.turnId.startsWith("rt_") || earlierTurnActive);
    if (message.turnStatus === "running" || message.turnStatus === "todo") earlierTurnActive = true;
    return queued ? [[message.turnId, message] as const] : [];
  }));
  const queued = messages.flatMap((message) => {
    if (message.role !== "user" || !message.turnId) return [];
    const response = queuedResponses.get(message.turnId);
    return response ? [{ prompt: message, response }] : [];
  });
  const queuedTurnIds = new Set(queued.map(({ prompt }) => prompt.turnId));
  return {
    queued,
    transcript: messages.filter((message) => !message.turnId || !queuedTurnIds.has(message.turnId))
  };
}
