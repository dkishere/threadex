import { Router } from "express";
import { actorAllowedModels, actorAllowedModelTiers } from "../modelCatalog";
import type { DomainActorService } from "./domainActorService";
import { ActorDeletionConflict, ActorHierarchyConflict, ActorMemoryConflict, type DomainActorStore } from "./domainActorStore";
import type { SessionStore, SessionTurnRecord } from "./sessionStore";
import type { CollaborationService } from "./collaborationService";
import { ACTOR_COORDINATION_GROUP_PREFIX, type CollaborationGroup } from "../collaboration";
import type { DomainActorAuth } from "./domainActorAuth";
import { createHash } from "node:crypto";
import { actorInputBudget, actorMemorySlice, actorModelContextWindow } from "./domainActorContext";
import { actorSummary, actorSummaryBlockers } from "./domainActorSummary";
import { actorRoomForChat } from "../domainActors";
import { sharedActorAllocation } from "./domainActorAllocation";
import type { ConsultantService } from "./consultantService";
import { actorClaudeAgentModel, actorModelPermitted, actorSessionWork, actorSplitHostContext } from "./actorNativeAgents";
import { sessionMentionUserPrompt } from "./sessionActorMentions";
import { ACTOR_DELEGATION_TOOLS, ACTOR_REGISTRY_TOOLS, NATIVE_CHILD_DELEGATION_ERROR } from "./domainActorTools";
import { actorReorganizationDelta } from "./domainActorReorganization";
import { actorRoutingMetrics } from "./domainActorRoutingMetrics";
import { CROSS_WORKSPACE_ACTOR_DENIED, taskUserMessages, userMessageNamesActor, userMessageNamesWorkspace } from "./crossWorkspaceActors";
import type { ActorRoom, DomainActor } from "../domainActors";
import { userMidTurnMessages } from "./turnGrill";

function actorPermissionView(actor: DomainActor) {
  return { ...actor, allowedModelTiers: actorAllowedModelTiers(actor), allowedModels: actorAllowedModels(actor) };
}

/** The polled room as the client reads it. Every round keeps full actor and candidate snapshots (memory, avatar)
 * for its runner, which made the room tens of MB per 2.5s poll. The client only falls back to a snapshot's
 * identity when the actor no longer exists, so ship that identity, and the avatar only for removed actors.
 * The reorganization audit holds full actor snapshots; it has its own endpoint. */
export function actorRoomClientView(room: ActorRoom): ActorRoom {
  const { reorganizations: _audit, ...view } = room;
  const currentActorIds = new Set(room.actors.map(actor => actor.id));
  const identityOf = (actor: DomainActor) => ({ id: actor.id, name: actor.name, parentActorId: actor.parentActorId, rootActorId: actor.rootActorId,
    ...(currentActorIds.has(actor.id) || actor.avatar === undefined ? {} : { avatar: actor.avatar }) }) as DomainActor;
  return { ...view, actors: room.actors.map(actorPermissionView),
    rounds: room.rounds.map(round => ({ ...round, candidateSnapshots: [], actorSnapshots: (round.actorSnapshots ?? []).map(identityOf) })) } as ActorRoom;
}

/** Bounds the earlier same-session user follow-ups sent to the delegation authorization check. */
const MAX_PRIOR_USER_PROMPTS = 20;
const NATIVE_CHILD_ACTIONS =new Set(["actor_list", "actor_tree_status", "actor_read_memory", "consultant_list", "consultant_ask", "consultant_round_table", "consultant_status", "consultant_cancel"]);

export function actorTreeGroupId(workspaceId: string, rootActorId: string) {
  return `${ACTOR_COORDINATION_GROUP_PREFIX}${createHash("sha256").update(JSON.stringify([workspaceId, rootActorId])).digest("hex")}`;
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
    catch (error) { res.status(error instanceof ActorMemoryConflict || error instanceof ActorDeletionConflict || error instanceof ActorHierarchyConflict ? 409 : 400).json({ error: error instanceof Error ? error.message : String(error) }); }
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
    return actorRoomClientView(typeof req.query.chat === "string" && req.query.chat ? actorRoomForChat(room, req.query.chat) : room);
  }));
  router.get("/:workspaceId/actors", route(async req => ({ actors: (await service.listActors(req.params.workspaceId)).map(actorPermissionView) })));
  router.get("/:workspaceId/actors/summary", route(async req => {
    // getRoom applies overdue blocker escalation before the summary lists active blockers.
    const room = await service.getRoom(req.params.workspaceId);
    const runningSessions = await service.runningSessions(req.params.workspaceId);
    const sessionIds = new Set([
      ...actorSummaryBlockers(room).map(blocker => blocker.taskSessionId),
      ...runningSessions.map(session => session.sessionId)
    ]);
    const titles = new Map<string, string | undefined>();
    for (const sessionId of sessionIds) titles.set(sessionId, (await sessions.getSession(sessionId))?.title);
    return actorSummary(room, runningSessions, titles, await service.listProjects(req.params.workspaceId));
  }));
  router.post("/:workspaceId/actors/:actorId/conclusions/:conclusionId/ack", route(async req =>
    actorRoomClientView(await actors.acknowledgeConclusion(req.params.workspaceId, req.params.actorId, req.params.conclusionId))));
  router.post("/:workspaceId/actors/:actorId/memory-errors/:eventId/dismiss", route(async req =>
    actorRoomClientView(await actors.dismissMemoryError(req.params.workspaceId, req.params.actorId, req.params.eventId))));
  router.post("/:workspaceId/actors", route(async req => actorPermissionView(await service.createActor(req.params.workspaceId, req.body))));
  router.patch("/:workspaceId/actors/:actorId", route(async req => actorPermissionView(await service.updateActor(req.params.workspaceId, req.params.actorId, req.body))));
  router.post("/:workspaceId/actors/:actorId/hierarchy", route(req => service.reparentActor(req.params.workspaceId, req.params.actorId, {
    parentActorId: req.body.parentActorId, expectedParentActorId: req.body.expectedParentActorId, expectedRootActorId: req.body.expectedRootActorId
  })));
  router.get("/:workspaceId/actors/routing-metrics", route(async req => actorRoutingMetrics(await service.getRoom(req.params.workspaceId), {
    since: typeof req.query.since === "string" ? req.query.since : undefined, until: typeof req.query.until === "string" ? req.query.until : undefined })));
  router.get("/:workspaceId/reorganizations", route(req => service.listReorganizations(req.params.workspaceId)));
  router.post("/:workspaceId/reorganizations", route(req => service.reorganizeActors(req.params.workspaceId, req.body)));
  router.delete("/:workspaceId/actors/:actorId", route(req => service.deleteActor(req.params.workspaceId, req.params.actorId)));
  router.patch("/:workspaceId/actors/:actorId/memory", route(req => actors.updateMemory({ workspaceId: req.params.workspaceId,
    actorId: req.params.actorId, baseVersion: req.body.expectedVersion, sourceEventId: req.body.sourceEventId, memory: req.body.memory })));
  // A cross-workspace origin is set only by the server-checked actor_handoff, and a session target only by the
  // server-validated @mention and Pick owner routes; never by a request body.
  router.post("/:workspaceId/requests", route(req => service.submit({ ...req.body, crossWorkspaceOrigin: undefined, sessionOrigin: undefined, sessionTarget: undefined, workspaceId: req.params.workspaceId })));
  router.post("/:workspaceId/requests/:requestId/stop", route(async req => ({ round: await service.stopRequest(req.params.workspaceId, req.params.requestId) })));
  router.post("/:workspaceId/rounds/:roundId/replies/:actorId/stop", route(req =>
    service.stopReply(req.params.workspaceId, req.params.roundId, req.params.actorId)));
  router.post("/:workspaceId/rounds/:roundId/replies/:actorId/retry", route(req =>
    service.retryReply(req.params.workspaceId, req.params.roundId, req.params.actorId, req.body?.responseProfile)));
  router.post("/:workspaceId/work-items/:workItemId/cancel", route(req =>
    service.cancelWork(req.params.workspaceId, req.params.workItemId)));
  // User decision on a blocker: approve the pending proposal, reject the latest proposal (noted and dismissed, no follow-up), resolve or dismiss (withdraws it from every actor context).
  router.post("/:workspaceId/blockers/:blockerId/action", route(req => service.userBlockerAction({ workspaceId: req.params.workspaceId,
    blockerId: req.params.blockerId, action: req.body?.action, note: req.body?.note, proposalId: req.body?.proposalId })));
  /** The caller of a registry action: an actor task, or an ordinary task without an actor binding. */
  type RegistryCaller = { workspaceId: string; room: ActorRoom; model?: string | null; self?: DomainActor;
    /** Every user message of this task; only these open another workspace. */
    userMessage: () => Promise<string> };
  /** Another workspace chosen with workspaceId; undefined means the caller's own. */
  const requestedOtherWorkspace = async (caller: RegistryCaller, workspaceId: unknown) => {
    if (workspaceId !== undefined && typeof workspaceId !== "string") throw new Error("Choose a workspace ID.");
    if (workspaceId === undefined || workspaceId === caller.workspaceId) return undefined;
    const workspace = await sessions.getWorkspace(workspaceId);
    if (!workspace) throw new Error(CROSS_WORKSPACE_ACTOR_DENIED);
    return workspace;
  };
  const listActors = async (caller: RegistryCaller, body: any) => {
    if (body.workspaceId !== undefined && typeof body.workspaceId !== "string" || body.allWorkspaces !== undefined && typeof body.allWorkspaces !== "boolean")
      throw new Error("Choose a workspace ID, or allWorkspaces true.");
    const crossWorkspaceId = typeof body.workspaceId === "string" && body.workspaceId !== caller.workspaceId ? body.workspaceId : undefined;
    const offset = body.offset ?? 0, limit = body.limit ?? 10;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Choose a bounded actor page.");
    let roster: Array<{ actor: DomainActor; workspace?: { id: string; name: string } }> = caller.room.actors.map(actor => ({ actor }));
    if (crossWorkspaceId || body.allWorkspaces === true) {
      if (crossWorkspaceId && body.allWorkspaces === true) throw new Error("Choose a workspace ID or allWorkspaces, not both.");
      const message = await caller.userMessage();
      const workspaces = (await sessions.listWorkspaces()).filter(workspace => crossWorkspaceId ? workspace.id === crossWorkspaceId : workspace.id !== caller.workspaceId);
      roster = [];
      for (const workspace of workspaces) {
        const named = userMessageNamesWorkspace(message, workspace);
        for (const actor of (await actors.getRoom(workspace.id)).actors)
          if (named || userMessageNamesActor(message, actor)) roster.push({ actor, workspace: { id: workspace.id, name: workspace.name } });
      }
      if (!roster.length) throw new Error(CROSS_WORKSPACE_ACTOR_DENIED);
    }
    const page = { actors: roster.slice(offset, offset + limit).map(({ actor: candidate, workspace }) => ({ type: "worker", id: candidate.id, name: candidate.name,
      parentActorId: candidate.parentActorId, rootActorId: candidate.rootActorId, roleSummary: actorMemorySlice(candidate.memory.roleSummary, 0, 256).text,
      ...(workspace ? { workspaceId: workspace.id, workspaceName: workspace.name, crossWorkspace: true } : {}) })),
      nextOffset: offset + limit < roster.length ? offset + limit : null };
    const budget = actorInputBudget(await actorModelContextWindow(sessions, caller.model ?? undefined));
    while (Buffer.byteLength(JSON.stringify(page)) > budget && page.actors.length > 0) {
      page.actors.pop(); page.nextOffset = offset + page.actors.length;
    }
    if (offset < roster.length && !page.actors.length) throw new Error("Actor roster exceeds the model context admission budget.");
    return page;
  };
  const readActorMemory = async (caller: RegistryCaller, body: any, ownMemoryOnly: boolean) => {
    const field = body.field;
    if (!["rolePrompt", "roleSummary", "longTerm", "rolling"].includes(field) || !Number.isSafeInteger(body.offset ?? 0) || (body.offset ?? 0) < 0 ||
      !Number.isSafeInteger(body.bytes ?? 4096) || (body.bytes ?? 4096) < 1 || (body.bytes ?? 4096) > 8192) throw new Error("Choose a memory field and a bounded range (1–8192 bytes).");
    // Another actor's memory serves a user-requested registry change, which native sub-agents cannot make.
    if (body.actorId !== undefined && ownMemoryOnly) throw new Error("Sub-agents may read only their own memory.");
    const workspace = await requestedOtherWorkspace(caller, body.workspaceId);
    if (body.actorId === undefined && (workspace || !caller.self)) throw new Error("Choose an actor with actorId.");
    const target = body.actorId === undefined ? caller.self : (workspace ? await actors.getRoom(workspace.id) : caller.room).actors.find(candidate => candidate.id === body.actorId);
    if (!target) throw new Error(workspace ? "Actor not found in that workspace." : "Actor not found in this workspace.");
    if (workspace) {
      const message = await caller.userMessage();
      if (!userMessageNamesWorkspace(message, workspace) && !userMessageNamesActor(message, target)) throw new Error(CROSS_WORKSPACE_ACTOR_DENIED);
    }
    const budget = actorInputBudget(await actorModelContextWindow(sessions, caller.model ?? undefined));
    let bytes = Math.min(body.bytes ?? 4096, budget - 512);
    if (bytes < 1) throw new Error("No context admission budget remains for memory reads.");
    const slice = () => ({ ...(target === caller.self ? {} : { actorId: target.id }), ...(workspace ? { workspaceId: workspace.id } : {}),
      version: target.memory.version, field, ...actorMemorySlice(target.memory[field as keyof typeof target.memory] as string, body.offset ?? 0, bytes) });
    let result = slice();
    while (Buffer.byteLength(JSON.stringify(result)) > budget && bytes > 1) {
      bytes = Math.floor(bytes / 2);
      result = slice();
    }
    if (Buffer.byteLength(JSON.stringify(result)) > budget) throw new Error("Memory metadata exceeds the model context admission budget.");
    return result;
  };
  const createRootActor = async (caller: RegistryCaller, body: any) => {
    const workspace = await requestedOtherWorkspace(caller, body.workspaceId);
    // Creating in another workspace needs the user to name that workspace itself; naming one of its actors is not enough.
    if (workspace && !userMessageNamesWorkspace(await caller.userMessage(), workspace)) throw new Error(CROSS_WORKSPACE_ACTOR_DENIED);
    // An actor inherits its creator's model permissions; a task without an actor gives only the chosen model.
    return service.createActor(workspace?.id ?? caller.workspaceId, { name: body.name, model: body.model, parentActorId: null, memory: body.memory,
      allowedModelTiers: caller.self ? actorAllowedModelTiers(caller.self) : null });
  };
  const registryAction = (caller: RegistryCaller, body: any, ownMemoryOnly = false) => body.action === "actor_list" ? listActors(caller, body)
    : body.action === "actor_read_memory" ? readActorMemory(caller, body, ownMemoryOnly) : createRootActor(caller, body);

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
    if (child && ACTOR_DELEGATION_TOOLS.includes(req.body.action)) throw new Error(NATIVE_CHILD_DELEGATION_ERROR);
    if (child && !NATIVE_CHILD_ACTIONS.has(req.body.action)) throw new Error("Native split sub-agents may read their own memory, actor tree and consultants only; the host session coordinates assignments and steering.");
    const binding = child ?? host;
    const execution = child ?? (binding?.taskSessionId === session.id ? binding : binding?.executionHistory?.find(execution => execution.taskSessionId === session.id));
    const actor = room.actors.find(actor => actor.id === execution?.executorActorId);
    // Initial actor turns contain a system-built envelope with actor-written text; wait/resume
    // turns carry actor-written instructions. Only turns the user sent from the client composer
    // (marked with clientLayout) are canonical user messages, including earlier follow-ups in this session;
    // so is a round table prompt the server recorded as a signed-in user's own (never a Next round).
    const userPrompt = (item: SessionTurnRecord) => item.id === execution?.taskTurnId ? undefined
      // A Composer @mention in this session runs as a dispatched turn; its user message is the round's saved prompt.
      : sessionMentionUserPrompt(room, session.id, item)
      ?? (!["mobile", "tablet", "desktop"].includes(item.requestMetadata?.clientLayout as string)
        && !(item.requestMetadata?.roundtable === true && item.requestMetadata?.fromUser === true) ? undefined
      : typeof item.requestMetadata?.message === "string" ? item.requestMetadata.message : item.userInput);
    const readUserMessageHistory = async () => {
      const currentTurnCreated = Date.parse(turn.created);
      const priorTurns = (await sessions.listSessionTurns(session.id))
        .filter(item => item.id !== turn.id && item.status !== "todo" && Date.parse(item.created) <= currentTurnCreated);
      const turnIds = [...priorTurns.map(item => item.id), turn.id];
      const [approvals, steers] = await Promise.all([sessions.listSessionApprovalLiveItems(session.id, turnIds),
        sessions.listSessionSteerMessages(session.id, turnIds)]);
      return { priorTurns, approvals, steers };
    };
    const sessionUserMessages = async () => {
      const { priorTurns, approvals, steers } = await readUserMessageHistory();
      // The user's steers and question answers during a turn are their own follow-ups too.
      const midTurnUserMessages = (turnId: string) => userMidTurnMessages(approvals[turnId] ?? [], steers[turnId] ?? []);
      return { priorUserPrompts: priorTurns.flatMap(item => [userPrompt(item), ...midTurnUserMessages(item.id)])
        .filter((prompt): prompt is string => !!prompt).slice(-MAX_PRIOR_USER_PROMPTS),
        currentTurnUserMessages: midTurnUserMessages(turn.id).slice(-MAX_PRIOR_USER_PROMPTS) };
    };
    if (!binding || !execution || !actor) {
      if (host || childWorkItemId || !ACTOR_REGISTRY_TOOLS.some(tool => tool.name === req.body.action)) throw new Error("Session has no system-owned actor binding.");
      // An ordinary task reads the registry, and reaches another workspace only as its own user messages name it.
      return registryAction({ workspaceId: session.workspaceId, room, model: turn.model, userMessage: async () => {
        const { priorUserPrompts, currentTurnUserMessages } = await sessionUserMessages();
        const current = userPrompt(turn);
        return [...priorUserPrompts, ...currentTurnUserMessages, ...(current ? [current] : [])].join("\n\n");
      } }, req.body);
    }
    if (typeof req.body.action === "string" && req.body.action.startsWith("consultant_")) {
      if (!consultants) throw new Error("Consultant service is unavailable.");
      if (req.body.action === "consultant_list") {
        const library = consultants.list();
        const offset = req.body.offset ?? 0, limit = req.body.limit ?? 10;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Choose a bounded consultant page.");
        const available = library.actors.filter(candidate => actorAllowedModels(actor).includes(candidate.model));
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
      }, actorAllowedModels(actor));
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
    const workspaceScoped = req.body.action === "actor_list" || req.body.action === "actor_handoff";
    if (workspaceScoped && (req.body.workspaceId !== undefined && typeof req.body.workspaceId !== "string" || req.body.allWorkspaces !== undefined && typeof req.body.allWorkspaces !== "boolean"))
      throw new Error("Choose a workspace ID, or allWorkspaces true.");
    const crossWorkspaceId = workspaceScoped && typeof req.body.workspaceId === "string" && req.body.workspaceId !== session.workspaceId ? req.body.workspaceId : undefined;
    // Another workspace's actors are reachable only for the actors or workspaces the user named in one of this task's own messages.
    const crossWorkspaceMessages = async () => {
      const { priorTurns, approvals, steers } = await readUserMessageHistory();
      return taskUserMessages(room, binding, execution, session.id, [...priorTurns, turn], approvals, steers);
    };
    const crossWorkspaceMessage = async () => (await crossWorkspaceMessages()).map(message => message.text).join("\n\n");
    if (["actor_list", "actor_read_memory", "actor_create_root"].includes(req.body.action)) return registryAction({ workspaceId: session.workspaceId, room,
      model: execution.model, self: actor, userMessage: crossWorkspaceMessage }, req.body, Boolean(child));
    if (req.body.action === "actor_reorganize") {
      const { reorganization, dryRun } = await service.reorganizeActorsAsActor({ workspaceId: session.workspaceId, workItemId: binding.id, actorId: actor.id,
        sessionId: session.id, turnId: turn.id, body: req.body, ...await sessionUserMessages(), currentUserPrompt: userPrompt(turn) });
      // Keep the result within the caller's context: names and changed fields, never full memory snapshots.
      return { dryRun, reorganizationId: reorganization.id, requestId: reorganization.requestId, applied: !dryRun && reorganization.changes.length > 0,
        changes: reorganization.changes.map(change => ({ actorId: change.actorId, ...actorReorganizationDelta(change.before, change.after) })) };
    }
    if (req.body.action === "actor_prompt_session") {
      if (typeof req.body.sessionId !== "string" || typeof req.body.message !== "string" || !req.body.message.trim()) throw new Error("Choose a target session and a prompt.");
      if (req.body.sessionId === session.id) throw new Error("Prompt another session; use the final response for this one.");
      const target = await sessions.getSession(req.body.sessionId);
      if (!target) throw new Error("Target session not found.");
      // Another workspace's session is reachable only when one of the user's own messages in this task names it.
      if (target.workspaceId !== session.workspaceId && !(await crossWorkspaceMessage()).includes(target.id)) throw new Error(CROSS_WORKSPACE_ACTOR_DENIED);
      // No Decision gate: the tool description asks the actor to prompt another session only on the user's instruction.
      return { authorized: true, sessionId: target.id, workspaceId: target.workspaceId };
    }
    if (req.body.action === "actor_assign_many" || req.body.action === "actor_handoff") {
      if (crossWorkspaceId) {
        if (req.body.mode !== undefined && req.body.mode !== "session") throw new Error("A cross-workspace handoff runs as a separate task in the target workspace; omit mode or use \"session\".");
        const workspace = await sessions.getWorkspace(crossWorkspaceId);
        const target = workspace ? (await actors.getRoom(workspace.id)).actors.find(candidate => candidate.id === req.body.executorActorId) : undefined;
        const userMessages = await crossWorkspaceMessages();
        if (!workspace || !target || !userMessages.some(({ text }) => userMessageNamesWorkspace(text, workspace) || userMessageNamesActor(text, target))) throw new Error(CROSS_WORKSPACE_ACTOR_DENIED);
        const sourceWorkspace = await sessions.getWorkspace(session.workspaceId);
        return service.handoffAcrossWorkspaces({ workspaceId: session.workspaceId, workspaceName: sourceWorkspace?.name ?? session.workspaceId,
          workItemId: binding.id, sourceActorId: actor.id, sourceSessionId: session.id, sourceTurnId: turn.id, userMessages,
          requestId: req.body.requestId, targetWorkspaceId: workspace.id, targetWorkspaceName: workspace.name, targetActorId: target.id, task: req.body.task });
      }
      const { priorUserPrompts, currentTurnUserMessages } = await sessionUserMessages();
      const result = await service.delegateParallel({ workspaceId: session.workspaceId,
        workItemId: binding.id, sourceActorId: actor.id, sourceSessionId: session.id, sourceTurnId: turn.id,
        priorUserPrompts, currentUserPrompt: userPrompt(turn), currentTurnUserMessages, requestId: req.body.requestId,
        ...(req.body.action === "actor_handoff"
          ? { tasks: [{ executorActorId: req.body.executorActorId, task: req.body.task }], kind: "handoff" as const, mode: req.body.mode }
          : { tasks: req.body.tasks }) });
      if (result.inPlaceTurnId !== turn.id) return result;
      // An in-place hosted child is started by this turn now: hand back its canonical brief, as a split host's context would.
      // The runner's agent definitions and credentials are fixed for this turn, so the child carries no credential.
      const current = await service.getRoom(session.workspaceId);
      const host = current.workItems.find(item => item.id === binding.id)!;
      const split = await actorSplitHostContext({ room: current, host, hostActor: actor, turnId: turn.id,
        runningSessions: await service.runningSessions(session.workspaceId), contextWindow: model => actorModelContextWindow(sessions, model) });
      const briefs = (split?.briefs ?? []).filter(child => result.workItems.some(work => work.id === child.workItemId) && child.brief);
      if (!briefs.length) return { ...result, note: "The sub-agent could not be prepared for this turn; report it as not started." };
      if (split!.provider === "claude") return { ...result,
        start: briefs.map(child => ({ subagent_type: "general-purpose", description: `${child.actorName} handoff`, model: actorClaudeAgentModel(child.model),
          effort: child.effort, run_in_background: false, promptPrefix: child.brief })),
        note: `${result.note} Call the Agent tool with exactly subagent_type, description, model, effort and run_in_background from start, and a prompt that begins with promptPrefix verbatim followed by your coordination notes.` };
      const start = briefs.map(child => ({ task_name: child.name, model: child.model, reasoning_effort: child.effort, fork_turns: "none", messagePrefix: child.brief }));
      return { ...result, start, note: `${result.note} spawn_agent with exactly task_name, model, reasoning_effort and fork_turns from start, and a message that begins with messagePrefix verbatim followed by your coordination notes; record each spawn with record_subagent_prompt.` };
    }
    if (req.body.action === "actor_tree_status") {
      const offset = req.body.offset ?? 0, limit = req.body.limit ?? 10;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Choose a bounded actor tree status page.");
      const items = room.workItems.filter(item => tree.some(a => a.id === item.executorActorId) || sharedActorAllocation(room, binding, item));
      const running = await service.runningSessions(session.workspaceId);
      const live = running.filter(item => tree.some(a => a.id === item.actorId) || items.some(work => work.id === item.workItemId));
      const page = { actors: tree.slice(offset, offset + limit).map(a => ({ type: "worker", id: a.id, name: a.name, rootActorId: a.rootActorId,
        parentActorId: a.parentActorId, model: a.model, allowedModelTiers: actorAllowedModelTiers(a), allowedModels: actorAllowedModels(a),
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
        action: req.body.update, text: req.body.text, requiresApproval: req.body.requiresApproval, question: req.body.question, options: req.body.options });
    }
    if (actor.parentActorId) throw new Error("Only a root actor may manage or assign its own tree.");
    if (req.body.action === "actor_reparent") return service.reparentActor(session.workspaceId, req.body.actorId, {
      parentActorId: req.body.parentActorId, expectedParentActorId: req.body.expectedParentActorId, expectedRootActorId: req.body.expectedRootActorId
    }, actor.id, binding.id);
    if (req.body.action === "actor_create_sub") return service.createActor(session.workspaceId, {
      name: req.body.name, model: req.body.model, parentActorId: actor.id, memory: req.body.memory,
      allowedModelTiers: actorAllowedModelTiers(actor)
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
