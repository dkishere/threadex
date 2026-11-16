export type PromptOrigin = {
  kind: "inter-actor";
  sourceActorId?: string;
  sourceActorName?: string;
  sourceSessionId?: string;
  sourceTurnId?: string;
  sourceRoundId?: string;
  trigger?: string;
  /** Decision dispatch: the claiming actor when it differs from the executor in sourceActorId. */
  dispatcherActorId?: string;
};

const TRIGGER_LABELS: Record<string, string> = {
  "decision-dispatch": "Dispatch", "fast-track": "Fast-track", "task-update": "Task update", handoff: "Handoff", assignment: "Assigned",
  recovery: "Recovery", "session-tool": "Session msg", manager: "Manager", concurrent: "Concurrent", "task-wake": "Task wake"
};

/** Short visible text for how Threadex delivered a prompt, so the highlight never relies on colour alone. */
export function promptOriginTriggerLabel(trigger?: string): string {
  return (trigger && TRIGGER_LABELS[trigger]) || "Threadex";
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Reads the backend-recorded prompt origin (turn.promptOrigin, or requestMetadata.promptOrigin).
 * Returns null for user prompts and for records with neither an actor nor a session id; never infers from prompt text.
 */
export function readPromptOrigin(turn: { promptOrigin?: unknown; requestMetadata?: { promptOrigin?: unknown } } | null | undefined): PromptOrigin | null {
  const raw = (turn?.promptOrigin ?? turn?.requestMetadata?.promptOrigin) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object" || raw.kind !== "inter-actor") return null;
  const sourceActorId = text(raw.sourceActorId);
  const sourceSessionId = text(raw.sourceSessionId);
  if (!sourceActorId && !sourceSessionId) return null;
  return { kind: "inter-actor", sourceActorId, sourceSessionId,
    sourceActorName: text(raw.sourceActorName), sourceTurnId: text(raw.sourceTurnId), sourceRoundId: text(raw.sourceRoundId), trigger: text(raw.trigger),
    dispatcherActorId: text(raw.dispatcherActorId) };
}
