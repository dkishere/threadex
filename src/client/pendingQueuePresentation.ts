import type { ChatMessage } from "./appTypes";

export function partitionPendingQueueMessages(messages: ChatMessage[]) {
  const queuedResponses = new Map(messages
    .filter((message) => message.role === "assistant" && message.turnStatus === "todo" &&
      message.pendingReason === "queued" && message.turnId)
    .map((message) => [message.turnId!, message]));
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
