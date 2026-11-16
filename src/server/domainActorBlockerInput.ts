import { actorBlockerAwaitingUser, actorBlockerUserDecisionPrompt } from "../actorBlockers";
import type { ActorRoom } from "../domainActors";
import type { SessionStore, SessionTurnRecord } from "./sessionStore";
import { actorSessionWork } from "./actorNativeAgents";

type Receipt = "pending" | "delivered" | "not_sent" | "uncertain";
type Input = { workspaceId: string; blockerId: string; decisionId: string };
type Store = Pick<SessionStore, "getDomainActorRoom" | "getSession" | "getLatestRunningTurn" | "changeDomainActorRoom" | "getSessionTurn" | "collaborationSteerReceipt" | "recordSessionTurnEvent">;
type Control = {
  alive: (pid: number) => boolean;
  result: (commandId: string) => { ok: boolean; notSent?: boolean } | null;
  send: (turn: SessionTurnRecord, commandId: string, message: string) => Promise<{ ok: boolean; notSent?: boolean }>;
};

/** The caller supplies an identity only. All content, recipients and authority come from saved state. */
export async function deliverActorBlockerInput(store: Store, input: Input, control: Control, remainingRetargets = 3): Promise<{ delivery: Receipt; error?: string }> {
  const { workspaceId, blockerId, decisionId } = input;
  if (![workspaceId, blockerId, decisionId].every(value => typeof value === "string" && value.length > 0)) throw new Error("Invalid blocker decision identity.");
  const boundDecision = (room: ActorRoom) => {
    const blocker = room.blockers?.find(item => item.id === blockerId);
    const work = room.workItems.find(item => item.id === blocker?.workItemId);
    if (!blocker || !blocker.userDecision || blocker.userDecision.id !== decisionId || !actorBlockerAwaitingUser(blocker)
      || !work || work.cancelledAt || work.taskSessionId !== blocker.taskSessionId || work.executorActorId !== blocker.executorActorId
      || (blocker.userDecision.executionRevision !== undefined && blocker.userDecision.executionRevision !== work.executionRevision)) throw new Error("Blocker decision or original task binding changed.");
    return { blocker, work, decision: blocker.userDecision };
  };
  const room = await store.getDomainActorRoom(workspaceId);
  const { blocker, work, decision } = boundDecision(room);
  const session = await store.getSession(blocker.taskSessionId);
  const binding = room.rounds.find(round => round.id === work.roundId)?.taskBinding;
  if (!session || session.workspaceId !== workspaceId || (binding && session.cwd !== binding.cwd)) throw new Error("Original task project binding changed.");
  if (decision.approvalId) return { delivery: "delivered" };
  // Pin before I/O: a retry must inspect this turn's receipt, never steer a different turn.
  let turnId = decision.turnId;
  if (!turnId) {
    const running = await store.getLatestRunningTurn(session.id);
    if (!running) return { delivery: "not_sent" };
    if (actorSessionWork(room, session.id, running.id)?.id !== work.id) return { delivery: "pending", error: "The original session is busy with another task; wait before asking this blocker question." };
    turnId = await store.changeDomainActorRoom(workspaceId, current => {
      const saved = boundDecision(current);
      if (actorSessionWork(current, session.id, running.id)?.id !== saved.work.id) throw new Error("The running turn's actor binding changed.");
      return saved.decision.turnId ??= running.id;
    });
  }
  const turn = await store.getSessionTurn(turnId);
  if (!turn || turn.sessionId !== session.id) throw new Error("Invalid original task turn.");
  // Each confirmed-unsent target gets its own durable command receipt. Uncertain targets are never repinned.
  const commandId = `collab_blocker_${decision.id}_${turnId}_steer`;
  const confirmedUnsent = async (): Promise<{ delivery: Receipt; error?: string }> => {
    const running = await store.getLatestRunningTurn(session.id);
    if (!running || running.id === turnId) return { delivery: "not_sent" };
    if (!remainingRetargets) return { delivery: "pending", error: "Original task turns changed repeatedly; retry the saved decision." };
    await store.changeDomainActorRoom(workspaceId, current => {
      const saved = boundDecision(current);
      if (actorSessionWork(current, session.id, running.id)?.id !== saved.work.id) throw new Error("The original session is running another task; its turn cannot receive this decision.");
      if (saved.decision.approvalId || saved.decision.turnId !== turnId) return;
      saved.decision.turnId = running.id;
    });
    return deliverActorBlockerInput(store, input, control, remainingRetargets - 1);
  };
  const receipt = await store.collaborationSteerReceipt(commandId, turnId, turn.runnerLogPath);
  if (receipt === "not_sent") return confirmedUnsent();
  if (receipt === "delivered" || receipt === "uncertain") return { delivery: receipt };
  const result = control.result(commandId);
  if (result) return result.notSent && !result.ok ? confirmedUnsent() : { delivery: result.ok ? "delivered" : "uncertain" };
  if (turn.status !== "running" || !turn.runnerPid || !control.alive(turn.runnerPid)) return receipt === "new" ? confirmedUnsent() : { delivery: "uncertain" };
  if (receipt === "new") await store.recordSessionTurnEvent({ id: `collaboration-dispatch:${commandId}`, sessionId: session.id, turnId,
    eventName: "collaboration.steer_dispatch", payload: { commandId, runnerLogPath: turn.runnerLogPath } });
  // Recheck after awaits: cancellation, reassignment or a received answer wins over delivery.
  const currentRoom = await store.getDomainActorRoom(workspaceId), current = boundDecision(currentRoom);
  if (current.decision.approvalId) return { delivery: "delivered" };
  if (actorSessionWork(currentRoom, session.id, turn.id)?.id !== current.work.id) throw new Error("The target turn now belongs to another task.");
  try {
    const sent = await control.send(turn, commandId, actorBlockerUserDecisionPrompt(current.blocker));
    return sent.notSent && !sent.ok ? confirmedUnsent() : { delivery: sent.ok ? "delivered" : "uncertain" };
  } catch { return { delivery: "pending" }; }
}
