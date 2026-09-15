import type { SessionInspectInput } from "./sessionStore";

export function createTurnGrillHistoryReader(sessionId: string, targetTurnId: string) {
  let reads = 0;
  return (args: Record<string, unknown>): SessionInspectInput => {
    if (reads >= 2) throw new Error("Grill me history budget exhausted. Use the available evidence and state any remaining uncertainty.");
    const requestedSessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
    if (requestedSessionId && requestedSessionId !== sessionId) {
      throw new Error("Grill me may inspect only its source session.");
    }
    if (typeof args.threadId === "string" && args.threadId.trim()) {
      throw new Error("Grill me may inspect only its source session.");
    }
    const requestedTurnId = typeof args.turnId === "string" ? args.turnId.trim() : "";
    if (requestedTurnId && requestedTurnId !== targetTurnId) {
      throw new Error("Grill me may inspect only its target turn.");
    }
    reads++;
    const integer = (value: unknown, fallback: number, min: number, max: number) =>
      typeof value === "number" && Number.isSafeInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
    return {
      sessionId,
      q: typeof args.q === "string" ? args.q.slice(0, 200) : undefined,
      turnId: targetTurnId,
      status: "done",
      order: args.order === "asc" ? "asc" : "desc",
      turnLimit: 1,
      turnOffset: 0,
      maxTextChars: integer(args.maxTextChars, 20_000, 200, 250_000),
      includeEvents: false,
      includeLiveItems: args.includeLiveItems === true,
      includeSideChats: false
    };
  };
}
