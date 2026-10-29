import type { SessionStore, SessionTurnRecord, WaitEventRecord } from "./sessionStore";
import type { WaitEventService } from "./waitEvent";
import { normalizePromptOrigin, type PromptOrigin } from "./promptOrigin";

/** Durable wait topic fired when one task turn ends; any session may subscribe to it. */
export const TASK_ENDED_TOPIC = "task.turn_ended";

type TaskEndStore = Pick<SessionStore, "getSession" | "getSessionTurn" | "getLatestRunningTurn" | "getWaitEvent" | "listWaitEvents" | "listWaitSubscriptions">;
type TaskEndWaits = Pick<WaitEventService, "ensureEvent" | "subscribe" | "fire">;

/** Completion, failure and Stop end a turn. A rate-limit, auth or queue wait resumes the same turn later. */
export function taskTurnEnded(turn: Pick<SessionTurnRecord, "status" | "pendingReason"> | null) {
  return !turn || turn.status === "done" || turn.status === "todo" && turn.pendingReason === "stopped";
}

const eventId = (turnId: string) => `task_end:${turnId}`;

function endPayload(sessionId: string, turnId: string, turn: Pick<SessionTurnRecord, "status" | "pendingReason" | "runnerExitCode"> | null) {
  const outcome = !turn ? "deleted" : turn.status === "todo" ? "stopped" : turn.runnerExitCode === 0 ? "completed" : "failed";
  return { sessionId, turnId, outcome };
}

/**
 * Subscribe a waiting session to the end of another task's turn. The subscription is written
 * before the target is re-read, so an end that races the call still wakes the waiter.
 */
export async function subscribeTaskEnd(store: TaskEndStore, waits: TaskEndWaits, input: {
  workspaceId: string; waiterSessionId: string; targetSessionId: string; targetTurnId?: string;
  message: string; approvalPolicy?: string;
}) {
  if (input.waiterSessionId === input.targetSessionId) throw new Error("A task cannot wait for its own end.");
  const target = await store.getSession(input.targetSessionId);
  if (!target || target.workspaceId !== input.workspaceId) throw new Error("Target task not found in this workspace.");
  const turn = input.targetTurnId ? await store.getSessionTurn(input.targetTurnId) : await store.getLatestRunningTurn(target.id);
  if (input.targetTurnId && turn?.sessionId !== target.id) throw new Error("Target turn does not belong to the target task.");
  // The caller is still running, so an already ended blocker needs no wake-up: continue now.
  if (!turn || taskTurnEnded(turn)) return { status: "already_ended" as const, targetSessionId: target.id, targetTurnId: turn?.id ?? null,
    end: turn ? endPayload(target.id, turn.id, turn) : null };
  const chain = await waitChain(store, input.workspaceId, target.id, input.waiterSessionId);
  if (chain) throw new Error(`Deadlock: ${chain.join(" -> ")} already waits for ${input.waiterSessionId}. Resolve the dependency instead of waiting.`);
  const event = await waits.ensureEvent({ id: eventId(turn.id), workspaceId: input.workspaceId, topic: TASK_ENDED_TOPIC,
    subjectKey: `${target.id}:${turn.id}`, payload: { sessionId: target.id, turnId: turn.id } });
  const subscription = await waits.subscribe({ id: `${eventId(turn.id)}:${input.waiterSessionId}`, eventId: event.id,
    workspaceId: input.workspaceId, sessionId: input.waiterSessionId, actionType: "enqueue_prompt",
    actionPayload: { message: input.message, ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}) } });
  await fireTaskEnd(store, waits, turn.id);
  return { status: "subscribed" as const, targetSessionId: target.id, targetTurnId: turn.id, eventId: event.id, subscriptionId: subscription.id };
}

/** Fire the end event of a turn once it has ended. Repeated calls are harmless. */
export async function fireTaskEnd(store: Pick<TaskEndStore, "getWaitEvent" | "getSessionTurn">, waits: Pick<TaskEndWaits, "fire">, turnId: string) {
  const event = await store.getWaitEvent(eventId(turnId));
  if (event?.status !== "pending") return false;
  const turn = await store.getSessionTurn(turnId);
  if (!taskTurnEnded(turn)) return false;
  await waits.fire(event.id, endPayload(String((event.payload as { sessionId?: unknown } | null)?.sessionId ?? turn?.sessionId ?? ""), turnId, turn));
  return true;
}

/** Recover end events missed by an offline API or a runner that died without a terminal update. */
export async function recoverTaskEndWaits(store: Pick<TaskEndStore, "getWaitEvent" | "getSessionTurn" | "listWaitEvents">, waits: Pick<TaskEndWaits, "fire">) {
  let fired = 0;
  for (const event of await store.listWaitEvents({ status: "pending" })) {
    const turnId = (event.payload as { turnId?: unknown } | null)?.turnId;
    if (event.topic === TASK_ENDED_TOPIC && typeof turnId === "string" && await fireTaskEnd(store, waits, turnId)) fired++;
  }
  return fired;
}

/** Wake-up text: the waiter's own resume instruction plus how the blocker ended. */
export function taskEndWakeMessage(message: string, event: WaitEventRecord) {
  const end = event.payload as { sessionId?: string; turnId?: string; outcome?: string } | null;
  return `${message}\n\n[Threadex] Blocking task ${end?.sessionId ?? "unknown"} turn ${end?.turnId ?? "unknown"} ended (${end?.outcome ?? "ended"}). Re-check for other running blockers before continuing.`;
}

/** The blocking task whose end wrote the wake-up prompt; its actor is resolved when the turn is recorded. */
export function taskEndWakeOrigin(event: WaitEventRecord): PromptOrigin | undefined {
  const end = event.payload as { sessionId?: unknown; turnId?: unknown } | null;
  return normalizePromptOrigin({ kind: "inter-actor", trigger: "task-wake", sourceSessionId: end?.sessionId, sourceTurnId: end?.turnId });
}

/** Follow waiting task-end subscriptions from the target; return the chain if it reaches the waiter. */
async function waitChain(store: Pick<TaskEndStore, "listWaitEvents" | "listWaitSubscriptions">, workspaceId: string, from: string, waiter: string) {
  const events = new Map((await store.listWaitEvents({ workspaceId, status: "pending" }))
    .filter(event => event.topic === TASK_ENDED_TOPIC).map(event => [event.id, event]));
  const edges = new Map<string, Set<string>>();
  for (const subscription of await store.listWaitSubscriptions({ workspaceId, status: "waiting" })) {
    const target = (events.get(subscription.eventId)?.payload as { sessionId?: unknown } | null)?.sessionId;
    if (typeof target === "string") (edges.get(subscription.sessionId) ?? edges.set(subscription.sessionId, new Set()).get(subscription.sessionId)!).add(target);
  }
  const seen = new Set<string>();
  const visit = (session: string, path: string[]): string[] | null => {
    if (session === waiter) return path;
    if (seen.has(session)) return null;
    seen.add(session);
    for (const next of edges.get(session) ?? []) {
      const found = visit(next, [...path, next]);
      if (found) return found;
    }
    return null;
  };
  const found = visit(from, [from]);
  return found ? found.slice(0, -1) : null;
}
