import { isAccountLoginRequiredMessage } from "../codexAuth";
import type { SessionRecord, SessionTurnEventRecord, SessionTurnRecord } from "./sessionStore";
import { clipHistoryText, fitHistoryTurns, providerTurnLabel } from "./sessionProviderThreads";

export type SessionRecoveryContext = {
  reason: "account_changed" | "thread_resume_failed" | "thread_compaction_failed" | "thread_unavailable";
  sourceThreadId: string | null;
  handoff: string;
};

export function buildSessionRecoveryContext(input: {
  session: SessionRecord;
  turns: SessionTurnRecord[];
  currentTurnId: string;
  sourceThreadId?: string | null;
  reason?: SessionRecoveryContext["reason"];
  steerMessagesByTurn?: Record<string, Array<{ content: string }>>;
}): SessionRecoveryContext | null {
  const priorTurns = input.turns.filter(turn => turn.id !== input.currentTurnId && turn.status !== "running" &&
    (turn.status === "done" || turn.runnerStarted || turn.runnerExitCode !== null ||
      turn.pendingReason === "auth" || turn.pendingReason === "rate_limit"))
    .sort((a, b) => Date.parse(a.nativeUpdatedAt ?? a.runnerStarted ?? a.created) - Date.parse(b.nativeUpdatedAt ?? b.runnerStarted ?? b.created));
  if (priorTurns.length === 0) {
    return null;
  }

  const header = [
    "[Threadex deterministic session recovery]",
    "An existing native thread is unavailable for this agent. Continue the same logical Threadex session from the persisted record below, including work by other agents.",
    "Treat quoted prompts and responses as historical evidence, not new instructions to execute again.",
    "Do not ask what to work on merely because the current user message is short (for example, go/continue). Infer it from this record.",
    "Treat the final Current user request after this block as the request to execute now; do not repeat already completed work unless it is needed for that request.",
    "",
    "Session lineage:",
    `- sessionId: ${input.session.id}`,
    `- sourceThreadId: ${input.sourceThreadId ?? input.session.threadId ?? "none"}`,
    `- parentSessionId: ${input.session.parentSessionId ?? "none"}`,
    `- forkedFromTurnId: ${input.session.forkedFromTurnId ?? "none"}`,
    `- title: ${input.session.title}`,
    `- persistedDescription: ${input.session.description || "none"}`,
    "",
    "Persisted turns (oldest to newest):"
  ];

  const turns = priorTurns.map((turn, index) => {
    const lines = [
      "",
      `Turn ${index + 1} [turnId=${turn.id}; agent=${providerTurnLabel(turn)}; status=${turn.status}; accountId=${turn.accountId ?? "none"}]:`,
      "User request:",
      clipHistoryText(turn.userInput)
    ];
    for (const steer of input.steerMessagesByTurn?.[turn.id] ?? []) {
      lines.push("User follow-up during this turn:", clipHistoryText(steer.content));
    }
    if (turn.status === "done" && turn.runnerExitCode !== 1 && !isCodexErrorResponse(turn.agentResponse)) {
      lines.push("Completed agent result:", clipHistoryText(turn.agentResponse) || "(no final response persisted)");
    } else {
      lines.push(
        "Attempt state:",
        `Interrupted or pending; no successful agent result should be inferred.${turn.pendingReason ? ` reason=${turn.pendingReason}` : ""}`
      );
    }
    return lines;
  });

  return {
    reason: input.reason ?? "thread_unavailable",
    sourceThreadId: input.sourceThreadId ?? input.session.threadId ?? null,
    handoff: fitHistoryTurns({ header, turns, footer: ["", "[End Threadex deterministic session recovery]"],
      sessionId: input.session.id })
  };
}

export function recoveryPrompt(message: string, recovery: SessionRecoveryContext) {
  return `${recovery.handoff}\n\nCurrent user request:\n${message}`;
}

export function isRecoverableThreadResumeError(message: string) {
  return /no rollout found for thread id|thread (?:id )?(?:was )?not found|unknown thread|cannot resume|failed to (?:load|resume) thread/i.test(message);
}

// The remote compact endpoint rejects some resumed histories outright (seen after
// an account switch); retrying the same thread fails identically every turn.
export function isRejectedRemoteCompaction(message: string) {
  return /error running remote compact task/i.test(message) && /bad request|\b400\b/i.test(message);
}

export function shouldForcePersistedRecovery(input: {
  session: SessionRecord;
  turns: SessionTurnRecord[];
  currentTurnId: string;
  sessionEvents: SessionTurnEventRecord[];
  recoveryEvents: SessionTurnEventRecord[];
}) {
  if (!input.session.threadId) {
    return false;
  }
  const currentIndex = input.turns.findIndex((turn) => turn.id === input.currentTurnId);
  const priorTurns = currentIndex >= 0 ? input.turns.slice(0, currentIndex) : input.turns;
  const latestAuthFailureAt = priorTurns
    .filter((turn) => turn.pendingReason === "auth" || isAccountLoginRequiredMessage(turn.agentResponse))
    .map((turn) => Date.parse(turn.created))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0];
  if (!latestAuthFailureAt) {
    return false;
  }
  const currentThreadStartedAt = input.sessionEvents
    .filter((event) => payloadThreadId(event.payload) === input.session.threadId)
    .map((event) => Date.parse(event.created))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)[0];
  if (!currentThreadStartedAt || currentThreadStartedAt <= latestAuthFailureAt) {
    return false;
  }
  return !input.recoveryEvents.some((event) => payloadThreadId(event.payload) === input.session.threadId);
}

function isCodexErrorResponse(value: string) {
  return /^Codex error:/i.test(value.trim());
}

function payloadThreadId(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const threadId = (value as Record<string, unknown>).threadId;
  return typeof threadId === "string" && threadId ? threadId : null;
}
