import type { ActorRoom, ActorWorkItem } from "../domainActors";
import { actorBlockerDedupeKey, openActorBlocker, resolveActorBlockersWhere, type ActorBlocker, type ActorBlockerKind, type ActorBlockerSource } from "../actorBlockers";
import { actorSessionWork } from "./actorNativeAgents";

type RunnerEvent = { type: string; sessionId: string | null; turnId: string | null; payload: unknown; timestamp: string };

const readObject = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const readText = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

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
  const open = (input: Parameters<typeof openWorkBlocker>[4]) => {
    const result = openWorkBlocker(room, work, sessionId, executorActorId, input, at);
    if (result.created && !result.blocker.selfClearing) opened.push(result.blocker);
  };
  const resolve = (match: (blocker: ActorBlocker) => boolean, note: string) =>
    resolveActorBlockersWhere(room, blocker => blocker.taskSessionId === sessionId && match(blocker), "system", at, note);
  switch (event.type) {
    case "runner.approval.requested": {
      const approvalId = readText(payload?.approvalId);
      if (approvalId) open({ kind: "approval", source: "approval", cause: approvalId, by: "system",
        description: `Waiting for user approval${readText(payload?.method) ? ` (${readText(payload?.method)})` : ""}.`, evidence: `approval ${approvalId}` });
      break;
    }
    case "runner.approval.resolved": {
      const approvalId = readText(payload?.approvalId);
      if (approvalId) {
        const key = actorBlockerDedupeKey(sessionId, "approval", approvalId);
        resolve(blocker => blocker.dedupeKey === key, payload?.expired === true ? "Approval expired." : "Approval resolved.");
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
      open({ kind: "error", source: "task_error", cause: `turn:${event.turnId ?? "unknown"}`, by: "system",
        description: `Task turn failed: ${(readText(payload?.message) ?? readText(payload?.error) ?? "unknown error").slice(0, 2000)}`,
        ...(event.turnId ? { evidence: `turn ${event.turnId}` } : {}) });
      break;
    case "runner.result":
      // A later completed turn overcame earlier turn failures of the same session.
      resolve(blocker => blocker.kind === "error" && blocker.source === "task_error", "A later task turn completed.");
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
