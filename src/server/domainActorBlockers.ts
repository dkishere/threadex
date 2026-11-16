import type { ActorRoom, ActorWorkItem } from "../domainActors";
import { actorBlockerActive, actorBlockerAwaitingUser, actorBlockerDedupeKey, openActorBlocker, resolveActorBlockersWhere, type ActorBlocker, type ActorBlockerKind, type ActorBlockerSource } from "../actorBlockers";
import { actorSessionWork } from "./actorNativeAgents";
import { USER_INPUT_METHOD, inputQuestions, inputResponse } from "../userInputRequest";

type RunnerEvent = { type: string; sessionId: string | null; turnId: string | null; payload: unknown; timestamp: string };

const readObject = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const readText = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
const approvalWaitDescription = (method?: string) => `Waiting for user approval${method ? ` (${method})` : ""}.`;

/** The task session already shows the user an open native question (its approval wait is still active). */
export function taskAskingUserNatively(room: ActorRoom, sessionId: string) {
  const description = approvalWaitDescription(USER_INPUT_METHOD);
  return (room.blockers ?? []).some(blocker => blocker.taskSessionId === sessionId && blocker.source === "approval"
    && actorBlockerActive(blocker) && blocker.description === description);
}

/** The work item and execution bound to a task session, or undefined for sessions outside the actor room. */
export function blockerTarget(room: ActorRoom, sessionId: string, turnId?: string | null) {
  const work = actorSessionWork(room, sessionId, turnId);
  if (!work) return undefined;
  const execution = work.taskSessionId === sessionId ? work : work.executionHistory.find(item => item.taskSessionId === sessionId);
  return execution ? { work, executorActorId: execution.executorActorId } : undefined;
}

export function openWorkBlocker(room: ActorRoom, work: ActorWorkItem, sessionId: string, executorActorId: string, input: {
  kind: ActorBlockerKind; source: ActorBlockerSource; description: string; evidence?: string; cause?: string; selfClearing?: boolean; by: string }, at: string) {
  return openActorBlocker(room, { workItemId: work.id, roundId: work.roundId, taskSessionId: sessionId,
    ownerActorId: work.ownerActorId, executorActorId, ...input }, at);
}

/** Converts the runner's existing wait/failure/commentary signals into blocker records inside one room write.
 * Returns the newly opened blockers that need an owner proposal (self-clearing waits never do). */
export function applyRunnerBlockerEvent(room: ActorRoom, event: RunnerEvent): ActorBlocker[] {
  if (!event.sessionId) return [];
  const sessionId = event.sessionId;
  const target = blockerTarget(room, sessionId, event.turnId);
  if (!target) return [];
  const { work, executorActorId } = target;
  const at = event.timestamp;
  const payload = readObject(event.payload);
  const opened: ActorBlocker[] = [];
  const ownDecision = (blocker: ActorBlocker) => blocker.workItemId === work.id && blocker.taskSessionId === sessionId
    && blocker.executorActorId === executorActorId
    && (blocker.userDecision?.executionRevision === undefined || blocker.userDecision.executionRevision === work.executionRevision);
  const open = (input: Parameters<typeof openWorkBlocker>[4]) => {
    const result = openWorkBlocker(room, work, sessionId, executorActorId, input, at);
    if (result.created && !result.blocker.selfClearing) opened.push(result.blocker);
  };
  const resolve = (match: (blocker: ActorBlocker) => boolean, note: string) =>
    resolveActorBlockersWhere(room, blocker => blocker.taskSessionId === sessionId && match(blocker), "system", at, note);
  // A question delivered into this turn that the task never asked natively ends with the turn, like an unanswered native question.
  const endUnaskedDecisions = () => {
    for (const blocker of room.blockers ?? []) {
      const decision = blocker.userDecision;
      if (!decision || !ownDecision(blocker) || !actorBlockerAwaitingUser(blocker) || decision.retryable || decision.approvalId) continue;
      if (decision.delivery !== "delivered" && decision.delivery !== "uncertain") continue;
      if (!event.turnId || (decision.continuationTurnId ?? decision.turnId) !== event.turnId || decision.created > at) continue;
      decision.error = "The task turn ended without asking this question natively. Await a user follow-up in the original task; do not infer approval or resume dependent operations.";
      decision.retryable = true; blocker.updated = at;
    }
  };
  switch (event.type) {
    case "runner.approval.requested": {
      const approvalId = readText(payload?.approvalId);
      if (approvalId && payload?.method === USER_INPUT_METHOD) {
        const questions = inputQuestions(payload.params);
        for (const blocker of room.blockers ?? []) {
          const decision = blocker.userDecision;
          if (!ownDecision(blocker) || !actorBlockerAwaitingUser(blocker) || !decision || decision.approvalId) continue;
          if (decision.turnId && decision.turnId !== event.turnId && decision.continuationTurnId !== event.turnId) continue;
          if (questions.some(question => question.id === decision.id || question.question.includes(decision.id))) {
            decision.approvalId = approvalId; decision.turnId = event.turnId ?? undefined; decision.delivery = "delivered";
          }
        }
      }
      if (approvalId) open({ kind: "approval", source: "approval", cause: approvalId, by: "system",
        description: approvalWaitDescription(readText(payload?.method)), evidence: `approval ${approvalId}` });
      break;
    }
    case "runner.approval.resolved": {
      const approvalId = readText(payload?.approvalId);
      if (approvalId) {
        const key = actorBlockerDedupeKey(sessionId, "approval", approvalId);
        resolve(blocker => blocker.dedupeKey === key, payload?.expired === true ? "Approval expired." : "Approval resolved.");
        if (payload?.method === USER_INPUT_METHOD && payload.expired !== true && inputResponse(payload.decision, payload.params)) {
          for (const blocker of room.blockers ?? []) {
            const decision = blocker.userDecision;
            if (!ownDecision(blocker) || !actorBlockerAwaitingUser(blocker) || decision?.approvalId !== approvalId || decision.turnId !== (event.turnId ?? undefined)) continue;
            decision.state = "answered"; decision.answeredAt = at;
            delete decision.retryable; delete decision.error;
            blocker.updated = at;
            blocker.history.push({ status: blocker.status, by: "user", at, note: "User answered the decision in the original task. The task must still resolve the underlying blocker; no extra authorization is granted." });
          }
        }
        for (const blocker of room.blockers ?? []) if (ownDecision(blocker) && actorBlockerAwaitingUser(blocker) && blocker.userDecision?.approvalId === approvalId && blocker.userDecision.turnId === (event.turnId ?? undefined)) {
          blocker.userDecision.error = "The native question ended without a valid answer. Await a user follow-up in the original task; do not infer approval or resume dependent operations.";
          blocker.userDecision.retryable = true; blocker.updated = at;
        }
      }
      break;
    }
    case "runner.pending":
      // Stop parks the turn without a wait; only a usage-limit retry is a blocker.
      if (payload?.stopped !== true) open({ kind: "rate-limit", source: "rate_limit", cause: "usage-limit", by: "system",
        description: readText(payload?.message) ?? "Queued for retry after the usage limit resets." });
      break;
    case "runner.runner.started":
      resolve(blocker => blocker.kind === "rate-limit", "Task turn started again.");
      break;
    case "runner.error":
      endUnaskedDecisions();
      open({ kind: "error", source: "task_error", cause: `turn:${event.turnId ?? "unknown"}`, by: "system",
        description: `Task turn failed: ${(readText(payload?.message) ?? readText(payload?.error) ?? "unknown error").slice(0, 2000)}`,
        ...(event.turnId ? { evidence: `turn ${event.turnId}` } : {}) });
      break;
    case "runner.result":
      // A later completed turn overcame earlier turn failures of the same session.
      resolve(blocker => blocker.kind === "error" && blocker.source === "task_error", "A later task turn completed.");
      endUnaskedDecisions();
      break;
    case "runner.item": {
      // The commentary summariser's issue ledger: explicit blockers open records, a later solution resolves them.
      const comment = readObject(payload?.comment);
      if (!comment) break;
      const cause = (issueKey: unknown) => `commentary:${event.turnId ?? "unknown"}:issue:${String(issueKey)}`;
      for (const entry of Array.isArray(comment.blockers) ? comment.blockers : []) {
        const item = readObject(entry), text = readText(item?.blocker);
        if (!text || !Number.isInteger(item?.issueKey)) continue;
        open({ kind: "other", source: "commentary", cause: cause(item!.issueKey), by: executorActorId, description: text,
          evidence: `commentary issue #${String(item!.issueKey)}${event.turnId ? ` in turn ${event.turnId}` : ""}` });
      }
      for (const entry of Array.isArray(comment.solutions) ? comment.solutions : []) {
        const item = readObject(entry);
        if (!Number.isInteger(item?.issueKey)) continue;
        const key = actorBlockerDedupeKey(sessionId, "other", cause(item!.issueKey));
        resolve(blocker => blocker.dedupeKey === key, `Commentary reported a solution: ${readText(item?.solution) ?? ""}`.trim());
      }
      break;
    }
  }
  return opened;
}

/** A signed-in user's own follow-up prompt in the original task answers the decisions the user can no longer answer natively:
 * one whose question already ended unanswered (retryable), or one pinned to a turn that is no longer running (its question was
 * never asked, or its card ended without a recorded outcome). A question of the still-running turn keeps waiting for its own
 * answer. Marking answered grants nothing; the task interprets the reply. Returns the answered blocker ids. */
export function answerDecisionsFromUserFollowUp(room: ActorRoom, input: { sessionId: string; turnId: string; message: string; at: string; runningTurnId?: string | null }): string[] {
  const target = blockerTarget(room, input.sessionId, input.turnId);
  if (!target || !input.message.trim()) return [];
  const { work, executorActorId } = target;
  const answered: string[] = [];
  for (const blocker of room.blockers ?? []) {
    const decision = blocker.userDecision;
    const pinnedTurnId = decision?.continuationTurnId ?? decision?.turnId;
    const endedQuestion = decision?.retryable || (pinnedTurnId !== undefined && pinnedTurnId !== input.turnId && pinnedTurnId !== input.runningTurnId);
    if (!decision || !actorBlockerAwaitingUser(blocker) || !endedQuestion || decision.created > input.at
      || blocker.workItemId !== work.id || blocker.taskSessionId !== input.sessionId || blocker.executorActorId !== executorActorId
      || (decision.executionRevision !== undefined && decision.executionRevision !== work.executionRevision)) continue;
    decision.state = "answered"; decision.answeredAt = input.at; decision.answerTurnId = input.turnId;
    delete decision.retryable; delete decision.error;
    blocker.updated = input.at;
    blocker.history.push({ status: blocker.status, by: "user", at: input.at,
      note: `User answered ${decision.id} with a follow-up prompt in the original task (turn ${input.turnId}): ${input.message.replace(/\s+/g, " ").trim().slice(0, 400)}. The task interprets this reply and must still resolve the underlying blocker; no extra authorization is granted.` });
    answered.push(blocker.id);
  }
  return answered;
}

/** Allocation dependency waits mirror work.blockedBy; they clear when the work dispatches. */
export function syncDependencyBlocker(room: ActorRoom, work: ActorWorkItem, at: string) {
  const sessionId = work.taskSessionId;
  if (work.blockedBy?.length) {
    openWorkBlocker(room, work, sessionId, work.executorActorId, { kind: "dependency-task", source: "allocation", cause: "allocation-dependencies", by: "system",
      description: `Waiting for ${work.blockedBy.length} dependency task(s) to end before starting.`, evidence: work.blockedBy.join(", ") }, at);
    return;
  }
  const key = actorBlockerDedupeKey(sessionId, "dependency-task", "allocation-dependencies");
  resolveActorBlockersWhere(room, blocker => blocker.dedupeKey === key, "system", at, "Dependencies ended; the task was dispatched.");
}
