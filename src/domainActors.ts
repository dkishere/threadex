import type { DecisionRequest, DecisionResult, PurposePolicy } from "./server/decision/types";
import type { ApprovalPolicy } from "./server/codexConfig";
import type { ActorRoundtable } from "./actorRoundtables";
import type { ActorBlocker, ActorBlockerNotice } from "./actorBlockers";

export type ActorMemoryContent = { rolePrompt: string; roleSummary: string; longTerm: string; rolling: string };
export type ActorMemory = ActorMemoryContent & { version: number; sourceEventIds: string[] };
export type DomainActor = {
  /** Missing only in legacy snapshots; the domain registry always means worker. */
  type?: "worker";
  id: string; workspaceId: string; rootActorId: string; parentActorId: string | null;
  name: string; model: string; effort: string; allowedModels: string[]; avatar?: string;
  /** Root workers only: Codex project IDs of this workspace's CODEX_HOME the worker belongs to.
   * Absent or empty means Unassigned; sub-actors belong to their root's projects. */
  projectIds?: string[];
  memory: ActorMemory; created: string; updated: string;
};
/** Group key of the workspace's Unassigned workers and of the legacy workspace-wide group chat. */
export const UNASSIGNED_ACTOR_PROJECT = "unassigned";
export type ActorProject = { id: string; name: string };
/** One Workers list group and its group chat. See docs/actor-project-chats.md. */
export type ActorProjectGroup = {
  /** Project ID, or UNASSIGNED_ACTOR_PROJECT. Also the `chat` key of the room and request APIs. */
  key: string; projectId: string | null; name: string;
  /** False for a project ID a worker still names but the workspace no longer registers. */
  registered: boolean;
  /** Root worker IDs in registry order; each root's sub-actors belong to the same group. */
  actorIds: string[];
  /** Latest group-chat activity (ISO): newest round, or newest update of work from its rounds. Absent without rounds. Set by the summary only. */
  lastActivityAt?: string;
};
/** The project of a worker tree: always read from its root. */
export function actorProjectIds(actors: readonly Pick<DomainActor, "id" | "rootActorId" | "projectIds">[], actorId: string): string[] {
  const actor = actors.find(item => item.id === actorId);
  const root = actors.find(item => item.id === actor?.rootActorId) ?? actor;
  return [...new Set(root?.projectIds ?? [])];
}
/** Whether a worker tree takes part in a project's group chat (null: the Unassigned chat). */
export function actorInProjectChat(actors: readonly Pick<DomainActor, "id" | "rootActorId" | "projectIds">[], actorId: string, projectId: string | null) {
  const projects = actorProjectIds(actors, actorId);
  return projectId === null ? !projects.length : projects.includes(projectId);
}
/** Registered projects in registry order, then still-referenced unregistered projects by ID, then Unassigned.
 * Every registered project is listed even without workers; a multi-project worker appears in each of its groups. */
export function actorProjectGroups(actors: readonly Pick<DomainActor, "id" | "parentActorId" | "rootActorId" | "projectIds">[], projects: readonly ActorProject[]): ActorProjectGroup[] {
  const roots = actors.filter(actor => !actor.parentActorId);
  const registered = new Set(projects.map(project => project.id));
  const unknown = [...new Set(roots.flatMap(actor => actor.projectIds ?? []))].filter(id => !registered.has(id)).sort();
  const members = (projectId: string | null) => roots.filter(actor => actorInProjectChat(actors, actor.id, projectId)).map(actor => actor.id);
  return [
    ...projects.map(project => ({ key: project.id, projectId: project.id, name: project.name, registered: true, actorIds: members(project.id) })),
    ...unknown.map(id => ({ key: id, projectId: id, name: id, registered: false, actorIds: members(id) })),
    { key: UNASSIGNED_ACTOR_PROJECT, projectId: null, name: "Unassigned", registered: true, actorIds: members(null) }
  ];
}
/** Group-chat partition of a round: a project ID, or null for the Unassigned (legacy workspace) chat.
 * Rounds saved before project chats keep their data; one bound to a registered project by its
 * explicit or message-resolved taskBinding reads as that project's chat, all others stay Unassigned.
 * Individual (single named actor) rounds belong to that actor's private chat, not a group chat. */
export function actorRoundChatKey(round: Pick<ActorRound, "chatProjectId" | "taskBinding">): string | null {
  if (round.chatProjectId !== undefined) return round.chatProjectId;
  return round.taskBinding?.source !== "workspace" && round.taskBinding?.projectId || null;
}
/** Group chat key (project ID or UNASSIGNED_ACTOR_PROJECT) to the round partition value. */
export function actorChatProjectId(key: string): string | null {
  return key === UNASSIGNED_ACTOR_PROJECT ? null : key;
}
/** Whether a round is a group round of the given chat (project ID, or null for Unassigned). */
export function actorRoundInGroupChat(round: Pick<ActorRound, "namedActorIds" | "chatProjectId" | "taskBinding">, projectId: string | null) {
  return (round.namedActorIds ?? []).length !== 1 && actorRoundChatKey(round) === projectId;
}
/** Server-side partition of one group chat: only its group rounds; everything else is unchanged. */
export function actorRoomForChat(room: ActorRoom, key: string): ActorRoom {
  const projectId = actorChatProjectId(key);
  return { ...room, rounds: room.rounds.filter(round => actorRoundInGroupChat(round, projectId)) };
}
export type ActorRunningSession = { actorId: string; sessionId: string; turnId: string; workItemId: string; status: string };
export type ActorReply = { actorId: string; status: "opinion" | "claimed" | "error" | "timeout" | "stopped"; text: string; model?: string;
  intent?: "work" | "discussion"; inRole?: boolean;
  claimKind?: "full" | "partial"; claimScope?: string;
  preparedPrompt?: string;
  /** Claim-time task session title; short, without an actor prefix. */
  title?: string;
  /** Prior visible rounds whose user messages the claimed work depends on. */
  contextRoundIds?: string[];
  proposedModel?: string;
  /** "actor" when the claiming actor explicitly chose the model; Decision selects only as a fallback. */
  modelSource?: "actor" | "decision";
  modelDecision?: DecisionResult; modelDecisionAudit?: DecisionRequest["audit"]; executorActorId?: string; error?: string };
export type ActorCandidateSnapshot = { actorId: string; memoryVersion: number; actor: DomainActor };
export type ActorResponseProfile = { model: string; effort: string };
export type ActorAttachment = { id: string; name: string; type: string; size: number; dataUrl?: string; path?: string; sha256?: string };
export type ActorTaskSelection = { newSessionProjectId?: string; newSessionCwd?: string };
/** Server-resolved once; client input and actor memory cannot supply this binding. */
export type ActorTaskBinding = { workspaceId: string; cwd: string; projectId?: string; source: "explicit" | "message" | "actor" | "workspace" | "session" };
/** An @mention from an ordinary session's Composer: the named actors execute in that session, never in a new task. */
export type ActorSessionTarget = { sessionId: string; projectId: string;
  /** The session's selected model when the mention was sent: it sets the execution provider group, as a reply gear does. */
  model: string };
export type ActorRound = {
  /** Set for a Composer @mention: candidates are the named actors only and work runs as turn-scoped bindings of this session. */
  sessionTarget?: ActorSessionTarget;
  /** Group chat this round was sent in: a project ID or null (Unassigned). Absent on legacy rounds; read via actorRoundChatKey. */
  chatProjectId?: string | null;
  taskSelection?: ActorTaskSelection;
  taskBinding?: ActorTaskBinding;
  attachments?: ActorAttachment[];
  approvalPolicy?: ApprovalPolicy;
  id: string; requestId: string; userPrompt: string; namedActorIds: string[];
  responseProfile?: ActorResponseProfile;
  candidateSnapshots: ActorCandidateSnapshot[]; stakeholderIds: string[]; replies: ActorReply[];
  /** Failed replies replaced by a manual retry, oldest first; kept for history only. */
  retriedReplies?: Array<ActorReply & { retriedAt: string }>;
  actorSnapshots: DomainActor[];
  contextRoundIds?: string[];
  selection?: { actorIds: string[]; probabilities: Record<string, number>; threshold: number; previousOwnerId?: string;
    /** Earlier claimants added because the Decision judged this message a continuation of the directly preceding request. */
    continuation?: { probability: number; actorIds: string[] } };
  /** Completed all-unrelated picking passes; replies remain intact for display and replay. */
  pickingHistory?: Array<{ stakeholderIds: string[]; selection?: ActorRound["selection"]; decision?: DecisionResult }>;
  routingDecisions: { fastTrack?: DecisionResult; selection?: DecisionResult; owner?: DecisionResult; coverage?: DecisionResult; models?: Record<string, DecisionResult> };
  /** A sole partial claim judged to leave work outside its scope. repicked: stakeholders were added once for the rest;
   * uncovered: nobody else claimed it, so the claimant executes only its scope and the rest stays unpicked. */
  coverageGap?: { actorId: string; claimScope: string; repicked?: boolean; uncovered?: boolean };
  /** Frozen session choice and delivery snapshot, retained across retries. */
  continuation?: { decision: DecisionResult; queue?: boolean; workItem?: ActorWorkItem; userPrompt?: string;
    /** Frozen Actors-chat source note sent as a developer note, never as user text. */
    sourceNote?: string; delivered?: boolean; error?: string;
    /** Turns ahead of the delivered follow-up in the task session's queue when it was queued; 0 means it starts next. */
    queuedBehind?: number };
  policies: { shPick: PurposePolicy; claimTiebreak: PurposePolicy };
  previousOwnerId?: string;
  ownerActorId: string | null; workItemId: string | null;
  allocation?: ActorAllocation;
  workItemIds?: string[];
  status: "queued" | "responding" | "routing_failed" | "no_claims" | "awaiting_pickup" | "assigned";
  /** Set when the user stopped the round before it reserved work; the worker loses its lease and saves nothing more. */
  stoppedAt?: string;
  error: string | null; created: string; deadline: string;
  lease: { owner: string; until: number } | null;
};
export type ActorAllocation = {
  requirements: Array<{ id: string; messageIndex: number; start: number; end: number; description: string }>;
  assignments: Array<{ id: string; actorId: string; requirementIds: string[]; brief: string; dependsOn: string[] }>;
  review: { overlaps: string[]; conflicts: string[]; uncovered: string[] };
  /** The assignment whose actor session hosts the split: it coordinates the other assignments and verifies the integrated result. Absent only in legacy plans. */
  integrationAssignmentId?: string;
};
export type ActorWorkItem = {
  /** Planning recommendation only; never a mode setting or delegation permission. */
  workflowAssessment?: "small_direct" | "substantial_managed" | "substantial_direct";
  /** Per-execution completion reviews. Only passed reviews contain a conclusion. */
  completionReviews?: ActorCompletionReview[];
  id: string; roundId: string; ownerActorId: string; executorActorId: string; model: string;
  executionEffort?: string;
  requirementIds?: string[]; allocationId?: string; pickedUpAt?: string;
  dispatchKey: string; taskSessionId: string; taskTurnId: string;
  /** "turn": the session is an ordinary user session (Composer @mention). The actor binding covers only this
   * work item's own turns (taskTurnId/activeTurnId); other turns of the session run without an actor binding. */
  sessionScope?: "turn";
  status: "claimed" | "assigned" | "started" | "completed" | "failed" | "needs_user";
  dispatchError: string | null; created: string; updated: string;
  dispatched: boolean; dispatchLease: { owner: string; until: number } | null;
  lastEventAt?: string; activeTurnId?: string;
  /** Approval requests of the current task session not yet resolved; resolved or cancelled ones never keep it at needs_user. */
  pendingApprovalIds?: string[];
  /** Latest explicit Stop of the active task turn; it ends the work unless a later event supersedes it. */
  stoppedAt?: string;
  /** Explicit user cancel of a failed task: final, so no retry, dependency wake-up, continuation or recovery dispatches it again. History is kept. */
  cancelledAt?: string;
  /** Allocation dependencies whose tasks had not ended at the last dispatch attempt. */
  blockedBy?: string[];
  executionRevision: number;
  /** Set on a split assignment executed as a native sub-agent of this host work item's session; it shares the host's session and turn identities. */
  hostWorkItemId?: string;
  /** Native sub-agent execution of a hosted assignment, projected from the host session's subagent items. */
  nativeAgent?: { name: string; provider: "claude" | "codex"; agentId?: string; model?: string; startedAt?: string; endedAt?: string; result?: string;
    /** The host turn that ended before this child reported; a late result of that turn still completes it. */
    unfinishedTurnId?: string;
    /** Durable host recovery turn for a restored child: the same request and prompt are resent until its queue receipt is confirmed. */
    recovery?: { requestId: string; userPrompt: string; status: "pending" | "queued";
      /** The idempotent host turn this recovery queues: only that turn defines, confirms and settles the child. */
      turnId: string };
    /** Runs started so far. Codex rework reuses one child thread, so neither the thread nor the result text identifies a run. */
    runSeq?: number;
    /** Agent IDs (Claude tool-use or Codex thread) that ran this child, oldest first: an unseen ID is always a new run. */
    agentIds?: string[];
    /** The current run's start was never observed: its startedAt is its terminal signal's time, not a real start. */
    startMissed?: boolean;
    /** Current run (`run-<runSeq>`): event IDs, completion reviews and the publication gate are keyed by it. */
    runId?: string;
    /** The current run completed without a result; the next result-bearing completion of the same agent attaches to it. */
    resultPending?: boolean };
  parentWorkItemId?: string;
  delegatedTask?: string;
  /** Follow-up an actor handed to another actor's domain; the parent is the source task. */
  handoff?: { sourceActorId: string; sourceSessionId: string };
  preparedPrompt?: string;
  /** Session title decided when the actor claimed the job; the summariser never replaces it. */
  title?: string;
  parentPreparedPrompt?: string;
  canonicalUserMessages?: string[];
  parallelRequests?: Array<{
    requestId: string; sourceActorId: string; sourceSessionId: string;
    /** "handoff": a follow-up in another actor's domain, authorized by the user's request scope rather than an explicit concurrency request. */
    kind?: "handoff";
    tasks: Array<{ executorActorId: string; task: string }>;
    sourceSnapshot: DomainActor; executorSnapshots: DomainActor[]; userMessages: string[];
    status: "pending" | "assigned" | "failed"; workItemIds: string[];
    decision?: DecisionResult; error?: string; lease: { owner: string; until: number } | null;
  }>;
  executionHistory: Array<{ executorActorId: string; model: string; taskSessionId: string; taskTurnId: string; dispatchKey: string; dispatched: boolean; status: ActorWorkItem["status"] }>;
  assignmentRequests: Array<{ requestId: string; executorActorId: string; model: string; proposedModel?: string;
    status?: "pending" | "assigned" | "failed"; modelDecision?: DecisionResult; modelDecisionAudit?: DecisionRequest["audit"];
    ownerSnapshot?: DomainActor; executorSnapshot?: DomainActor; userPrompt?: string; baseDispatchKey?: string;
    lease?: { owner: string; until: number } | null; error?: string }>;
};
export type ActorCompletionReview = {
  id: string; workItemId: string; actorId: string; ownerActorId: string; roundId: string;
  taskSessionId: string; taskTurnId: string; executionRevision: number;
  /** Native sub-agent run this review judged; a rerun inside the same host turn supersedes it. */
  nativeRunId?: string;
  status: "pending" | "passed" | "issues_found" | "error";
  issues: string[]; error?: string; created: string; completed?: string;
  lease?: { owner: string; until: number } | null;
  conclusion?: { id: string; reviewId: string; actorId: string; workItemId: string; taskSessionId: string; taskTurnId: string; text: string; created: string };
};
/** The single publication gate; historical or superseded reviews never announce a new conclusion. */
export function actorPublishableConclusions(work: ActorWorkItem) {
  return (work.completionReviews ?? []).filter(review => review.status === "passed" && !review.issues.length
    && review.executionRevision === work.executionRevision && review.taskSessionId === work.taskSessionId
    && review.taskTurnId === (work.activeTurnId ?? work.taskTurnId) && work.status === "completed"
    && (!work.nativeAgent || review.nativeRunId === work.nativeAgent.runId)
    && review.conclusion?.reviewId === review.id).flatMap(review => review.conclusion ? [review.conclusion] : []);
}
/** A consumed publication is retained in the actor's dialog, including after a later task turn. */
export type ActorDialogConclusion = NonNullable<ActorCompletionReview["conclusion"]> & { acknowledgedAt?: string };
export type ActorRoomEvent = {
  id: string; workspaceId: string; actorIds: string[]; roundId?: string; workItemId?: string;
  type: "sh.completed" | "task.started" | "task.turn_completed" | "task.failed" | "task.needs_user";
  summary: string; created: string;
  taskTurnId?: string;
  taskSessionId?: string;
};
export type ActorRoom = {
  /** Deleted registry entries remain available for history and reserve their IDs permanently. */
  deletedActors?: Array<DomainActor & { deletedAt: string }>;
  conclusions?: ActorDialogConclusion[];
  workspaceId: string; revision: number; actors: DomainActor[]; rounds: ActorRound[];
  workItems: ActorWorkItem[]; events: ActorRoomEvent[];
  memoryErrors: Array<{ actorId: string; eventId: string; error: string; created: string; dismissedAt?: string }>;
  costBaseline?: { capturedAt: string; usage: Array<Record<string, unknown>> };
  /** Archived task sessions stay in work history but leave every actor's session list. */
  archivedSessionIds?: string[];
  taskUpdates?: Array<{ requestId: string; workItemId: string; workItem: ActorWorkItem; userPrompt: string; namedActorIds: string[]; status: "pending" | "delivered"; lease: { owner: string; until: number } | null }>;
  /** Task blockers with their lifecycle; closed ones stay as history. */
  blockers?: ActorBlocker[];
  /** Group-chat announcements of workspace-level blocker escalations and their closing. */
  blockerNotices?: ActorBlockerNotice[];
  /** Per task session: digest of the blocker state last delivered to it, so unchanged state is never resent. */
  blockerDeliveries?: Record<string, string>;
  /** Group chat round tables, each held by its own session; see docs/actor-roundtable-sessions.md. */
  roundtables?: ActorRoundtable[];
};
export type CreateDomainActor = {
  type?: "worker";
  id?: string; name: string; parentActorId?: string | null; model: string; effort?: string;
  allowedModels?: string[]; avatar?: string; memory: ActorMemoryContent;
};
export type ActorWorkloadCounts = { open: number; attention: number };
export type ActorSummaryEntry = Pick<DomainActor, "type" | "id" | "name" | "rootActorId" | "parentActorId" | "model" | "projectIds" | "avatar"> & {
  counts: ActorWorkloadCounts; running: number; unreadConclusions?: number;
};
/** Active (actorBlockerActive), non-self-clearing blockers of the workspace after overdue escalation, newest
 * `updated` first, capped at ACTOR_SUMMARY_BLOCKER_LIMIT; see docs/actor-blockers.md. */
export type ActorSummaryBlocker = ActorBlocker & { taskSessionTitle?: string };
export type ActorSummary = { workspaceId: string; revision: number; actors: ActorSummaryEntry[]; blockers: ActorSummaryBlocker[];
  /** Workers grouped by project; absent only when the project registry could not be read. */
  groups?: ActorProjectGroup[] };
export type UpdateDomainActor = { type?: "worker"; name?: string; model?: string; effort?: string; allowedModels?: string[]; projectIds?: string[]; avatar?: string | null };
export type SubmitActorRequest = ActorTaskSelection & { workspaceId: string; requestId: string;
  /** Group chat of the request: a project ID or null/absent for the Unassigned chat. Ignored for individual (single named actor) requests. */
  chatProjectId?: string | null; userPrompt: string; attachments?: ActorAttachment[]; namedActorIds?: string[]; taskReference?: string; responseProfile?: ActorResponseProfile; approvalPolicy?: ApprovalPolicy;
  /** Composer @mention target, set only by the server after validating the session, its project and every named actor. */
  sessionTarget?: ActorSessionTarget };
export type ActorPromptPageContext = { url: string; title?: string; selector?: string };
/** A pasted Browser Bridge JSON object at the start of a prompt is page context, not the request itself. */
export function splitActorPromptPageContext(prompt: string): { page: ActorPromptPageContext | null; text: string } {
  const start = prompt.length - prompt.trimStart().length;
  if (prompt[start] !== "{") return { page: null, text: prompt };
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < prompt.length; index++) {
    const char = prompt[index];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === "\"") quoted = false; continue; }
    if (char === "\"") quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try {
        const value = JSON.parse(prompt.slice(start, index + 1)) as Record<string, unknown>;
        if (value?.kind !== "browser-bridge-context" || typeof value.url !== "string") return { page: null, text: prompt };
        const optional = (key: string) => typeof value[key] === "string" && (value[key] as string).trim() ? (value[key] as string).trim() : undefined;
        const title = optional("title"), selector = optional("selector");
        return { page: { url: value.url, ...(title ? { title } : {}), ...(selector ? { selector } : {}) }, text: prompt.slice(index + 1).trim() };
      } catch { return { page: null, text: prompt }; }
    }
  }
  return { page: null, text: prompt };
}
/** Routing judges the user's words; attached page context only says where, never which domain. */
export function actorRoutingPrompt(prompt: string): string {
  const { page, text } = splitActorPromptPageContext(prompt);
  return page ? `${text}\n\n[Attached page context only, not the request topic: ${page.title ? `${page.title} · ` : ""}${page.url}${page.selector ? ` · ${page.selector}` : ""}]` : prompt;
}
export function emptyActorRoom(workspaceId: string): ActorRoom {
  return { workspaceId, revision: 0, actors: [], rounds: [], workItems: [], events: [], memoryErrors: [] };
}
/** Group chat key with the newest `lastActivityAt`; ties keep the earlier group in list order. Null when no group has activity. */
export function mostRecentlyActiveGroupChatKey(groups: readonly Pick<ActorProjectGroup, "key" | "lastActivityAt">[] | undefined): string | null {
  let best: { key: string; at: number } | null = null;
  for (const group of groups ?? []) {
    const at = group.lastActivityAt ? Date.parse(group.lastActivityAt) : NaN;
    if (Number.isFinite(at) && (!best || at > best.at)) best = { key: group.key, at };
  }
  return best?.key ?? null;
}
