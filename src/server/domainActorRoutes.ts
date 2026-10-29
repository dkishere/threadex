import { Router } from "express";
import type { DomainActorService } from "./domainActorService";
import { ActorDeletionConflict, ActorMemoryConflict, type DomainActorStore } from "./domainActorStore";
import type { SessionStore, SessionTurnRecord } from "./sessionStore";
import type { CollaborationService } from "./collaborationService";
import type { CollaborationGroup } from "../collaboration";
import type { DomainActorAuth } from "./domainActorAuth";
import { createHash } from "node:crypto";
import { actorInputBudget, actorMemorySlice, actorModelContextWindow } from "./domainActorContext";
import { actorSummary, actorSummaryBlockers } from "./domainActorSummary";
import { actorRoomForChat } from "../domainActors";
import { sharedActorAllocation } from "./domainActorAllocation";
import type { ConsultantService } from "./consultantService";
import { actorModelPermitted, actorSessionWork } from "./actorNativeAgents";

/** Bounds the earlier same-session user follow-ups sent to the delegation authorization check. */
const MAX_PRIOR_USER_PROMPTS = 20;
const NATIVE_CHILD_ACTIONS =new Set(["actor_list", "actor_tree_status", "actor_read_memory", "consultant_list", "consultant_ask", "consultant_round_table", "consultant_status", "consultant_cancel"]);

export function actorTreeGroupId(workspaceId: string, rootActorId: string) {
  return `actor_tree_${createHash("sha256").update(JSON.stringify([workspaceId, rootActorId])).digest("hex")}`;
}

export function createDomainActorRouter(service: DomainActorService, actors: DomainActorStore, sessions: SessionStore, collaboration: CollaborationService, auth: Pick<DomainActorAuth, "verify">, consultants?: ConsultantService) {
  const router = Router();
  router.use((req, res, next) => {
    if (req.path.startsWith("/sessions/")) { next(); return; }
    if (res.locals.threadexUserAuthenticated !== true) { res.status(403).json({ error: "Actor registry and requests require a signed-in user.", code: "AUTH_REQUIRED" }); return; }
    next();
  });
  const route = (fn: (req: any) => Promise<unknown>) => async (req: any, res: any) => {
    try { res.json(await fn(req)); }
    catch (error) { res.status(error instanceof ActorMemoryConflict || error instanceof ActorDeletionConflict ? 409 : 400).json({ error: error instanceof Error ? error.message : String(error) }); }
  };
  // Cross-workspace "needs you" list: blockers whose latest proposal waits for user approval. Registered before the
  // "/:workspaceId/..." routes so the literal segment is never read as a workspace ID.
  router.get("/blockers/pending", route(async () => {
    const workspaces = await sessions.listWorkspaces();
    const pending = await service.pendingBlockerDecisions(workspaces.map(workspace => workspace.id));
    const titles = new Map<string, string | undefined>();
    for (const blocker of pending) if (!titles.has(blocker.taskSessionId)) titles.set(blocker.taskSessionId, (await sessions.getSession(blocker.taskSessionId))?.title);
    return { blockers: pending.map(blocker => {
      const taskSessionTitle = titles.get(blocker.taskSessionId);
      return taskSessionTitle ? { ...blocker, taskSessionTitle } : blocker;
    }) };
  }));
  router.get("/:workspaceId/room", route(async req => {
    const room = await service.getRoom(req.params.workspaceId);
    // A group chat is partitioned here, never by filtering the full room in the client.
    return typeof req.query.chat === "string" && req.query.chat ? actorRoomForChat(room, req.query.chat) : room;
  }));
  router.get("/:workspaceId/actors", route(async req => ({ actors: await service.listActors(req.params.workspaceId) })));
  router.get("/:workspaceId/actors/summary", route(async req => {
    // getRoom applies overdue blocker escalation before the summary lists active blockers.
    const room = await service.getRoom(req.params.workspaceId);
    const titles = new Map<string, string | undefined>();
    for (const blocker of actorSummaryBlockers(room)) if (!titles.has(blocker.taskSessionId)) titles.set(blocker.taskSessionId, (await sessions.getSession(blocker.taskSessionId))?.title);
    return actorSummary(room, await service.runningSessions(req.params.workspaceId), titles, await service.listProjects(req.params.workspaceId));
  }));
  router.post("/:workspaceId/actors/:actorId/conclusions/:conclusionId/ack", route(req =>
    actors.acknowledgeConclusion(req.params.workspaceId, req.params.actorId, req.params.conclusionId)));
  router.post("/:workspaceId/actors/:actorId/memory-errors/:eventId/dismiss", route(req =>
    actors.dismissMemoryError(req.params.workspaceId, req.params.actorId, req.params.eventId)));
  router.post("/:workspaceId/actors", route(req => service.createActor(req.params.workspaceId, req.body)));
  router.patch("/:workspaceId/actors/:actorId", route(req => service.updateActor(req.params.workspaceId, req.params.actorId, req.body)));
  router.delete("/:workspaceId/actors/:actorId", route(req => service.deleteActor(req.params.workspaceId, req.params.actorId)));
  router.patch("/:workspaceId/actors/:actorId/memory", route(req => actors.updateMemory({ workspaceId: req.params.workspaceId,
    actorId: req.params.actorId, baseVersion: req.body.expectedVersion, sourceEventId: req.body.sourceEventId, memory: req.body.memory })));
  router.post("/:workspaceId/requests", route(req => service.submit({ ...req.body, workspaceId: req.params.workspaceId })));
  router.post("/:workspaceId/requests/:requestId/stop", route(async req => ({ round: await service.stopRequest(req.params.workspaceId, req.params.requestId) })));
  router.post("/:workspaceId/rounds/:roundId/replies/:actorId/stop", route(req =>
    service.stopReply(req.params.workspaceId, req.params.roundId, req.params.actorId)));
  router.post("/:workspaceId/rounds/:roundId/replies/:actorId/retry", route(req =>
    service.retryReply(req.params.workspaceId, req.params.roundId, req.params.actorId)));
  router.post("/:workspaceId/work-items/:workItemId/cancel", route(req =>
    service.cancelWork(req.params.workspaceId, req.params.workItemId)));
  // User decision on a blocker: approve the pending proposal, reject the latest proposal (escalates), resolve or dismiss (withdraws it from every actor context).
  router.post("/:workspaceId/blockers/:blockerId/action", route(req => service.userBlockerAction({ workspaceId: req.params.workspaceId,
    blockerId: req.params.blockerId, action: req.body?.action, note: req.body?.note, proposalId: req.body?.proposalId })));
  router.post("/sessions/:sessionId/action", route(async req => {
    const session = await sessions.getSession(req.params.sessionId);
    const turn = typeof req.body.sourceTurnId === "string" ? await sessions.getSessionTurn(req.body.sourceTurnId) : null;
    if (!session || !turn || turn.sessionId !== session.id || turn.status !== "running") throw new Error("Actor tools require their bound running task turn.");
    // A native child of this host turn presents its own capability with its work item; never a forged actor or session.
    const childHeader = req.headers["x-threadex-actor-work-item"];
    const childWorkItemId = typeof childHeader === "string" && childHeader.trim() ? childHeader.trim() : undefined;
    if (!await auth.verify(req.headers["x-threadex-actor-capability"], session.workspaceId, session.id, turn.id, childWorkItemId)) throw new Error("Actor tool capability is missing or does not belong to this running turn.");
    const room = await service.getRoom(session.workspaceId);
    const host = actorSessionWork(room, session.id, turn.id);
    const child = childWorkItemId ? room.workItems.find(item => item.id === childWorkItemId) : undefined;
    if (childWorkItemId && (!host || host.taskSessionId !== session.id || child?.hostWorkItemId !== host.id)) throw new Error("Native child capability does not belong to this host session.");
    if (child && !actorModelPermitted(room, child)) throw new Error("This native sub-agent's actor no longer permits its model; its actor tools are closed.");
    if (child && !NATIVE_CHILD_ACTIONS.has(req.body.action)) throw new Error("Native split sub-agents may read their own memory, actor tree and consultants only; the host session coordinates assignments and steering.");
    const binding = child ?? host;
    const execution = child ?? (binding?.taskSessionId === session.id ? binding : binding?.executionHistory?.find(execution => execution.taskSessionId === session.id));
    const actor = room.actors.find(actor => actor.id === execution?.executorActorId);
    if (!binding || !execution || !actor) throw new Error("Session has no system-owned actor binding.");
    if (typeof req.body.action === "string" && req.body.action.startsWith("consultant_")) {
      if (!consultants) throw new Error("Consultant service is unavailable.");
      if (req.body.action === "consultant_list") {
        const library = consultants.list();
        const offset = req.body.offset ?? 0, limit = req.body.limit ?? 10;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Choose a bounded consultant page.");
        const available = library.actors.filter(candidate => actor.allowedModels.includes(candidate.model));
        return { revision: library.revision, actors: available.slice(offset, offset + limit).map(candidate => ({
          id: candidate.id, type: "consultant", name: candidate.name, model: candidate.model, effort: candidate.effort,
          roleSummary: actorMemorySlice(candidate.rolePrompt, 0, 256).text
        })), nextOffset: offset + limit < available.length ? offset + limit : null };
      }
      if (req.body.action === "consultant_status") return consultants.get(session.id, req.body.requestId);
      if (req.body.action === "consultant_cancel") return consultants.cancel(session.id, req.body.requestId);
      if (["consultant_ask", "consultant_round_table"].includes(req.body.action)) return consultants.start(session.id, {
        requestId: req.body.requestId, mode: req.body.action === "consultant_ask" ? "question" : "round_table",
        consultantIds: req.body.action === "consultant_ask" ? [req.body.consultantId] : req.body.consultantIds,
        question: req.body.question, context: req.body.context, trigger: req.body.trigger, sourceTurnId: turn.id
      }, actor.allowedModels);
      throw new Error("Unknown consultant action.");
    }
    const tree = room.actors.filter(candidate => candidate.rootActorId === actor.rootActorId);
    /** Steers a running target through a coordination group; delivery never assigns work. */
    const steer = async (groupKey: string, target: { taskSessionId: string; executorActorId: string; model: string }, requestId: unknown, message: unknown, reason: string) => {
      const id = actorTreeGroupId(session.workspaceId, groupKey);
      const now = new Date().toISOString();
      const group: CollaborationGroup = { id, workspaceId: session.workspaceId, mainSessionId: session.id,
        revision: 0, created: now, updated: now, lease: null, members: [], messages: [], results: [] };
      const targetLocalId = await sessions.changeCollaboration(id, group, current => {
        if (current.workspaceId !== session.workspaceId) throw new Error("Actor collaboration workspace mismatch.");
        for (const item of [execution, target]) if (!current.members.some(member => member.sessionId === item.taskSessionId)) {
          const owner = room.actors.find(a => a.id === item.executorActorId)!;
          current.members.push({ localId: item.taskSessionId === current.mainSessionId ? "main" : item.taskSessionId,
            sessionId: item.taskSessionId, sourceSessionId: item.taskSessionId, sourceTurnId: null, fork: null,
            model: item.model, effort: owner.effort, task: owner.name, stopped: false, observed: {} });
        }
        return current.members.find(member => member.sessionId === target.taskSessionId)!.localId;
      });
      return collaboration.send(session.id, { to: targetLocalId, requestId, message, reason, turnId: turn.id }, id);
    };
    if (req.body.action === "actor_list") {
      const offset = req.body.offset ?? 0, limit = req.body.limit ?? 10;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Choose a bounded actor page.");
      const page = { actors: room.actors.slice(offset, offset + limit).map(candidate => ({ type: "worker", id: candidate.id, name: candidate.name,
        parentActorId: candidate.parentActorId, roleSummary: actorMemorySlice(candidate.memory.roleSummary, 0, 256).text })),
        nextOffset: offset + limit < room.actors.length ? offset + limit : null };
      const budget = actorInputBudget(await actorModelContextWindow(sessions, execution.model));
      while (Buffer.byteLength(JSON.stringify(page)) > budget && page.actors.length > 0) {
        page.actors.pop(); page.nextOffset = offset + page.actors.length;
      }
      if (offset < room.actors.length && !page.actors.length) throw new Error("Actor roster exceeds the model context admission budget.");
      return page;
    }
    if (req.body.action === "actor_assign_many" || req.body.action === "actor_handoff") {
      // Initial actor turns contain a system-built envelope with actor-written text; wait/resume
      // turns carry actor-written instructions. Only turns the user sent from the client composer
      // (marked with clientLayout) are canonical user messages, including earlier follow-ups in this session.
      const userPrompt = (item: SessionTurnRecord) => item.id === execution.taskTurnId
        || !["mobile", "tablet", "desktop"].includes(item.requestMetadata?.clientLayout as string) ? undefined
        : typeof item.requestMetadata?.message === "string" ? item.requestMetadata.message : item.userInput;
      const priorUserPrompts = (await sessions.listSessionTurns(session.id))
        .filter(item => item.id !== turn.id && item.status !== "todo" && item.created <= turn.created)
        .map(userPrompt).filter((prompt): prompt is string => !!prompt).slice(-MAX_PRIOR_USER_PROMPTS);
      return service.delegateParallel({ workspaceId: session.workspaceId,
        workItemId: binding.id, sourceActorId: actor.id, sourceSessionId: session.id,
        priorUserPrompts, currentUserPrompt: userPrompt(turn), requestId: req.body.requestId,
        ...(req.body.action === "actor_handoff"
          ? { tasks: [{ executorActorId: req.body.executorActorId, task: req.body.task }], kind: "handoff" as const }
          : { tasks: req.body.tasks }) });
    }
    if (req.body.action === "actor_read_memory") {
      const field = req.body.field;
      if (!["rolePrompt", "roleSummary", "longTerm", "rolling"].includes(field) || !Number.isSafeInteger(req.body.offset ?? 0) || (req.body.offset ?? 0) < 0 ||
        !Number.isSafeInteger(req.body.bytes ?? 4096) || (req.body.bytes ?? 4096) < 1 || (req.body.bytes ?? 4096) > 8192) throw new Error("Choose a memory field and a bounded range (1–8192 bytes).");
      const budget = actorInputBudget(await actorModelContextWindow(sessions, execution.model));
      let bytes = Math.min(req.body.bytes ?? 4096, budget - 512);
      if (bytes < 1) throw new Error("No context admission budget remains for memory reads.");
      let result = { version: actor.memory.version, field, ...actorMemorySlice(actor.memory[field as keyof typeof actor.memory] as string, req.body.offset ?? 0, bytes) };
      while (Buffer.byteLength(JSON.stringify(result)) > budget && bytes > 1) {
        bytes = Math.floor(bytes / 2);
        result = { version: actor.memory.version, field, ...actorMemorySlice(actor.memory[field as keyof typeof actor.memory] as string, req.body.offset ?? 0, bytes) };
      }
      if (Buffer.byteLength(JSON.stringify(result)) > budget) throw new Error("Memory metadata exceeds the model context admission budget.");
      return result;
    }
    if (req.body.action === "actor_tree_status") {
      const offset = req.body.offset ?? 0, limit = req.body.limit ?? 10;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Choose a bounded actor tree status page.");
      const items = room.workItems.filter(item => tree.some(a => a.id === item.executorActorId) || sharedActorAllocation(room, binding, item));
      const running = await service.runningSessions(session.workspaceId);
      const live = running.filter(item => tree.some(a => a.id === item.actorId) || items.some(work => work.id === item.workItemId));
      const page = { actors: tree.slice(offset, offset + limit).map(a => ({ type: "worker", id: a.id, name: a.name, rootActorId: a.rootActorId,
        parentActorId: a.parentActorId, model: a.model, allowedModels: a.allowedModels,
        roleSummary: actorMemorySlice(a.memory.roleSummary, 0, 256).text })),
        workItems: items.slice(offset, offset + limit).map(item => ({ id: item.id, ownerActorId: item.ownerActorId,
          executorActorId: item.executorActorId, model: item.model, status: item.status, taskSessionId: item.taskSessionId, taskTurnId: item.taskTurnId })),
        runningSessions: live.slice(offset, offset + limit), offset,
        nextOffset: offset + limit < Math.max(tree.length, items.length, live.length) ? offset + limit : null };
      const budget = actorInputBudget(await actorModelContextWindow(sessions, execution.model));
      let loaded = limit;
      while (Buffer.byteLength(JSON.stringify(page)) > budget && loaded > 0) {
        loaded--; page.actors = page.actors.slice(0, loaded); page.workItems = page.workItems.slice(0, loaded);
        page.runningSessions = page.runningSessions.slice(0, loaded); page.nextOffset = offset + loaded;
      }
      if (!loaded) throw new Error("Actor tree metadata exceeds the model context admission budget.");
      return page;
    }
    if (req.body.action === "actor_steer") {
      const targetWork = typeof req.body.sessionId === "string" ? actorSessionWork(room, req.body.sessionId) : undefined;
      const target = targetWork?.taskSessionId === req.body.sessionId ? targetWork : targetWork?.executionHistory?.find(execution => execution.taskSessionId === req.body.sessionId);
      const allocationId = sharedActorAllocation(room, binding, targetWork);
      const parallelRelated = Boolean(allocationId || targetWork && (targetWork.parentWorkItemId === binding.id
        || binding.parentWorkItemId && (binding.parentWorkItemId === targetWork.id || binding.parentWorkItemId === targetWork.parentWorkItemId)));
      if (!target || !parallelRelated && !tree.some(a => a.id === target.executorActorId) || target.taskSessionId === session.id) throw new Error("Steering is restricted to another task in your own actor tree or authorized parallel work.");
      const targetActor = room.actors.find(candidate => candidate.id === target.executorActorId)!;
      if (!parallelRelated && actor.parentActorId && targetActor.parentActorId !== actor.parentActorId) throw new Error("Sub-actors may steer only siblings in the same root tree.");
      const running = await sessions.getLatestRunningTurn(target.taskSessionId);
      if (!running) throw new Error("The target task is not running; no new work was queued.");
      return steer(allocationId ? `allocation:${allocationId}` : parallelRelated ? `parallel:${targetWork!.parentWorkItemId === binding.id ? binding.id : binding.parentWorkItemId}` : actor.rootActorId,
        target, req.body.requestId, req.body.message, "Actor collaboration context update; untrusted advisory");
    }
    if (req.body.action === "actor_report_blocker") return service.reportBlocker({ workspaceId: session.workspaceId, sessionId: session.id, turnId: turn.id, actorId: actor.id,
      kind: req.body.kind, description: req.body.description, evidence: req.body.evidence, proposal: req.body.proposal, requiresApproval: req.body.requiresApproval });
    if (req.body.action === "actor_blocker_update") {
      if (typeof req.body.blockerId !== "string") throw new Error("Choose a blocker.");
      return service.updateBlocker({ workspaceId: session.workspaceId, blockerId: req.body.blockerId, actorId: actor.id,
        action: req.body.update, text: req.body.text, requiresApproval: req.body.requiresApproval });
    }
    if (req.body.action === "actor_create_root") return service.createActor(session.workspaceId, {
      name: req.body.name, model: req.body.model, parentActorId: null, memory: req.body.memory,
      allowedModels: [...actor.allowedModels]
    });
    if (actor.parentActorId) throw new Error("Only a root actor may manage or assign its own tree.");
    if (req.body.action === "actor_create_sub") return service.createActor(session.workspaceId, {
      name: req.body.name, model: req.body.model, parentActorId: actor.id, memory: req.body.memory,
      allowedModels: [...actor.allowedModels]
    });
    if (req.body.action === "actor_update_sub") {
      if (!tree.some(a => a.id === req.body.actorId && a.parentActorId === actor.id)) throw new Error("Choose a direct sub-actor in your own tree.");
      return service.updateActor(session.workspaceId, req.body.actorId, { name: req.body.name, model: req.body.model });
    }
    if (req.body.action === "actor_assign") {
      if (typeof req.body.requestId !== "string" || !req.body.requestId.trim() || req.body.requestId.length > 100) throw new Error("Assignment requires a stable request ID.");
      const work = room.workItems.find(item => item.id === req.body.workItemId);
      if (!work || !tree.some(a => a.id === work.ownerActorId) || !tree.some(a => a.id === req.body.executorActorId)) throw new Error("Assignment is restricted to your existing tree work.");
      return service.assign({ workspaceId: session.workspaceId, workItemId: work.id, executorActorId: req.body.executorActorId, model: req.body.model, requestId: req.body.requestId });
    }
    throw new Error("Unknown actor action.");
  }));
  return router;
}
