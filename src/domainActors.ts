import type { DecisionRequest, DecisionResult, PurposePolicy } from "./server/decision/types";
import type { ApprovalPolicy } from "./server/codexConfig";
import type { ActorRoundtable } from "./actorRoundtables";
import type { ActorBlocker, ActorBlockerNotice } from "./actorBlockers";
import type { ActorModelTier } from "./modelCatalog";

export type ActorMemoryContent = { rolePrompt: string; roleSummary: string; longTerm: string; rolling: string };
export type ActorMemory = ActorMemoryContent & { version: number; sourceEventIds: string[] };
export type DomainActor = {
  /** Missing only in legacy snapshots; the domain registry always means worker. */
  type?: "worker";
  id: string; workspaceId: string; rootActorId: string; parentActorId: string | null;
  name: string; model: string; effort: string; avatar?: string;
  /** Null lets the worker use all platform tiers. Missing on legacy records. */
  allowedModelTiers?: ActorModelTier[] | null;
  /** Legacy input or API projection; new records store only the tier policy. */
  allowedModels?: string[];
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
/** Actor chat: the user talking to one actor directly. Its reply is an opinion or a task the actor opens, never a group-chat claim.
 * Session @mentions and cross-workspace handoffs also name one actor but keep their own contracts. */
export function isActorDirectChatRound(round: Pick<ActorRound, "namedActorIds" | "sessionTarget" | "crossWorkspaceOrigin">) {
  return (round.namedActorIds ?? []).length === 1 && !round.sessionTarget && !round.crossWorkspaceOrigin;
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
  /** Source rounds seen while preparing this brief, including references excluded from canonical instructions. */
  briefContextRoundIds?: string[];
  proposedModel?: string;
  /** Execution effort the claiming actor asked for; it can only raise the policy floor, never lower it. */
  proposedEffort?: string;
  /** "actor" when the claiming actor explicitly chose the model; Decision selects only as a fallback. */
  modelSource?: "actor" | "decision";
  /** Why a model directive inherited from a selected earlier round was ignored instead of blocking the current request. */
  inheritedExecutionIgnored?: string;
  /** Why a permitted fallback model replaced a failed or invalid model Decision; never blocks dispatch. */
  modelFallback?: "decision_failed" | "invalid_choice";
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
  model: string;
  /** The session's selected effort when the mention was sent: an actor task session's host turn runs with it, as with the model. */
  effort?: string;
  /** Set when the session is an actor task session: its bound work item. That actor keeps the session and hosts a turn
   * in which every mentioned actor runs as its native sub-agent; the mentioned actors never take over the session. */
  hostWorkItemId?: string;
  /** Pick owner of an unowned session (docs/session-pick-owner.md): no actor is named, the session's project group chat
   * picks as usual, and the claimant becomes the owner of this same session instead of a turn-scoped guest. */
  takeover?: true };
export type ActorRound = {
  /** Set only by the server for a handoff an actor of another workspace sent at the user's explicit request. */
  crossWorkspaceOrigin?: ActorCrossWorkspaceOrigin;
  /** Set only by the server for a message an agent posted through session-inspector post_group_chat. */
  sessionOrigin?: ActorSessionOrigin;
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
  /** Latest manual retry gear per speaker; the original request gear remains intact. */
  replyResponseProfiles?: Record<string, ActorResponseProfile>;
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
  /** Why claim arbitration used a deterministic owner instead of a confident Decision; never blocks dispatch. */
  ownerFallback?: "low_confidence" | "decision_failed";
  /** A sole partial claim judged to leave work outside its scope. repicked: stakeholders were added once for the rest;
   * uncovered: nobody else claimed it, so the claimant executes only its scope and the rest stays unpicked. */
  coverageGap?: { actorId: string; claimScope: string; repicked?: boolean; uncovered?: boolean };
  /** Why the partial-claim planner failed; the claims then route owner-led instead of blocking. */
  allocationFallback?: string;
  /** Owner-led claims whose selected context is private to some trees: only eligibleOwnerIds could read all of it
   * (empty when none could); excludedRoundIds were withheld from the owner, as were the briefs of withheldBriefActorIds. */
  privateContextRouting?: { eligibleOwnerIds: string[]; excludedRoundIds: string[]; withheldBriefActorIds: string[] };
  /** Frozen session choice and delivery snapshot, retained across retries.
   * newSessionFallback: a failed or invalid session Decision dispatched a new task session instead of blocking. */
  continuation?: { decision: DecisionResult; newSessionFallback?: "decision_failed" | "invalid_choice"; queue?: boolean; workItem?: ActorWorkItem; userPrompt?: string;
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
  /** Server-assigned ownership of the whole request across stakeholder domains. */
  ownerLed?: boolean;
  /** Workflow inference was deliberately skipped for a single full claim. */
  workflowDecisionSkipped?: boolean;
  /** Planning recommendation only; never a mode setting or delegation permission. */
  workflowAssessment?: "small_direct" | "substantial_managed" | "substantial_direct";
  /** Per-execution completion reviews. Only passed reviews contain a conclusion. */
  completionReviews?: ActorCompletionReview[];
  id: string; roundId: string; ownerActorId: string; executorActorId: string; model: string;
  executionEffort?: string;
  requirementIds?: string[]; allocationId?: string; pickedUpAt?: string;
  dispatchKey: string; taskSessionId: string; taskTurnId: string;
  /** "turn": a Composer @mention in an existing session. The actor binding covers only this work item's own turns
   * (taskTurnId/activeTurnId) and wins over an actor task session's own binding there; other turns keep theirs. */
  sessionScope?: "turn";
  /** The task took over a pre-existing session via Pick owner: that session is never created, retitled or replaced. */
  sessionTakeover?: true;
  status: "claimed" | "assigned" | "started" | "completed" | "failed" | "needs_user";
  dispatchError: string | null; created: string; updated: string;
  dispatched: boolean; dispatchLease: { owner: string; until: number } | null;
  lastEventAt?: string; activeTurnId?: string;
  /** Approval requests of the current task session not yet resolved; resolved or cancelled ones never keep it at needs_user. */
  pendingApprovalIds?: string[];
  /** Latest explicit Stop of the active task turn; it ends the work unless a later event supersedes it. */
  stoppedAt?: string;
  /** Explicit user cancel of a failed or idle task: final, so no retry, dependency wake-up, continuation or recovery dispatches it again. History is kept. */
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
  /** Follow-up an actor handed to another actor's domain; the parent is the source task (and its host when hosted). */
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
    /** Hosted handoff: the work runs as a native sub-agent of the source session's host work item, started in a queued host turn. */
    hosted?: true;
    /** Codex host: the calling turn in which the host spawns the hosted child in place; no follow-up turn is queued. */
    inPlaceTurnId?: string;
    /** Every executor is an actor the user @mentioned in this task's request or its follow-ups: Decision only selects models. */
    userNamedExecutors?: true;
    tasks: Array<{ executorActorId: string; task: string }>;
    sourceSnapshot: DomainActor; executorSnapshots: DomainActor[]; userMessages: string[];
    status: "pending" | "assigned" | "failed"; workItemIds: string[];
    decision?: DecisionResult; error?: string; lease: { owner: string; until: number } | null;
  }>;
  /** Handoffs this task sent to an actor of another workspace; each runs as a round of that workspace's own room. */
  crossWorkspaceHandoffs?: Array<{
    requestId: string; sourceActorId: string; sourceSessionId: string; sourceTurnId: string;
    targetWorkspaceId: string; targetActorId: string; targetActorName: string; targetRequestId: string; task: string;
    status: "pending" | "submitted" | "failed"; targetRoundId?: string; decision?: DecisionResult; error?: string; created: string;
    authorizationEvidenceDigest?: string;
    forwardedUserMessages?: string[];
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
  /** Append-only audit of applied registry reorganizations; see docs/actor-reorganization.md. */
  reorganizations?: ActorReorganization[];
  /** Collective memory digest watermarks and saved memory diffs; see docs/domain-actors.md#collective-memory-digest. */
  memoryDigests?: ActorMemoryDigests;
};
/** Short summary of one finished session turn, the input of a collective memory digest. */
export type ActorMemoryDigestTurnSummary = { sessionId: string; turnId: string; completedAt: string; summary: string; changedFiles: string[] };
/** Digest progress of one project (a project ID or UNASSIGNED_ACTOR_PROJECT). */
export type ActorMemoryDigestProject = {
  /** Last activity time (ISO) of the newest turn already digested, or when the project was first observed. */
  watermark: string;
  /** The batch being digested: its new watermark and the turn summaries made so far. Cleared when the batch ends. */
  pending?: { watermark: string; started: string; summaries: ActorMemoryDigestTurnSummary[] };
  lastDigestAt?: string;
};
/** One digest write of an actor's memory: the fields before and after, and the turns it read. */
export type ActorMemoryDigestRecord = {
  id: string; actorId: string; projectKey: string; watermark: string; sourceEventId: string; created: string;
  sources: Array<{ sessionId: string; turnId: string }>;
  before: Pick<ActorMemoryContent, "longTerm" | "rolling">; after: Pick<ActorMemoryContent, "longTerm" | "rolling">;
};
export type ActorMemoryDigests = { projects: Record<string, ActorMemoryDigestProject>; records: ActorMemoryDigestRecord[] };
/** One step of an atomic registry reorganization, applied in order; the final registry is validated as a whole. */
export type ActorReorganizationOperation =
  | { op: "create"; actor: CreateDomainActor & { projectIds?: string[] } }
  | { op: "update"; actorId: string; changes: Omit<UpdateDomainActor, "type" | "avatar"> }
  | { op: "move"; actorId: string; parentActorId: string | null; expectedParentActorId: string | null }
  | { op: "memory"; actorId: string; expectedVersion: number; memory: Partial<ActorMemoryContent> }
  | { op: "archive"; actorId: string };
export type ActorReorganizationInitiator = { kind: "user" }
  | { kind: "actor"; actorId: string; workItemId: string; sessionId: string; turnId: string };
export type ActorReorganizationRequest = { requestId: string; reason: string; operations: ActorReorganizationOperation[]; dryRun?: boolean };
export type ActorReorganization = {
  id: string; requestId: string; reason: string; initiator: ActorReorganizationInitiator; created: string;
  operations: ActorReorganizationOperation[];
  /** Full registry entries of every touched actor; null before creation or after archiving. */
  changes: Array<{ actorId: string; before: DomainActor | null; after: DomainActor | null }>;
};
export type CreateDomainActor = {
  type?: "worker";
  id?: string; name: string; parentActorId?: string | null; model: string; effort?: string;
  allowedModelTiers?: ActorModelTier[] | null; allowedModels?: string[]; avatar?: string; memory: ActorMemoryContent;
};
export type ActorWorkloadCounts = { open: number; attention: number };
export type ActorSummaryEntry = Pick<DomainActor, "type" | "id" | "name" | "rootActorId" | "parentActorId" | "model" | "projectIds" | "avatar"> & {
  counts: ActorWorkloadCounts; running: number; unreadConclusions?: number;
  runningSessions?: Array<{ sessionId: string; title: string }>;
};
/** Active (actorBlockerActive), non-self-clearing blockers of the workspace after overdue escalation, newest
 * `updated` first, capped at ACTOR_SUMMARY_BLOCKER_LIMIT; see docs/actor-blockers.md. */
export type ActorSummaryBlocker = ActorBlocker & { taskSessionTitle?: string };
export type ActorSummary = { workspaceId: string; revision: number; actors: ActorSummaryEntry[]; blockers: ActorSummaryBlocker[];
  /** Workers grouped by project; absent only when the project registry could not be read. */
  groups?: ActorProjectGroup[] };
export type UpdateDomainActor = { type?: "worker"; name?: string; model?: string; effort?: string; allowedModelTiers?: ActorModelTier[] | null; allowedModels?: string[]; projectIds?: string[]; avatar?: string | null };
export type SubmitActorRequest = ActorTaskSelection & { workspaceId: string; requestId: string;
  /** Group chat of the request: a project ID or null/absent for the Unassigned chat. Ignored for individual (single named actor) requests. */
  chatProjectId?: string | null; userPrompt: string; attachments?: ActorAttachment[]; namedActorIds?: string[]; taskReference?: string; responseProfile?: ActorResponseProfile; approvalPolicy?: ApprovalPolicy;
  /** Composer @mention target, set only by the server after validating the session, its project and every named actor. */
  sessionTarget?: ActorSessionTarget;
  /** Cross-workspace handoff source, set only by the server after checking the user's explicit request. */
  crossWorkspaceOrigin?: ActorCrossWorkspaceOrigin;
  /** Agent group chat post source, set only by the server's post_group_chat endpoint. */
  sessionOrigin?: ActorSessionOrigin };
/** Where an agent-posted group chat message came from: a task session turn or that session's side chat.
 * The message text is agent-written; it is not the user's own words. */
export type ActorSessionOrigin = { sourceSessionId: string; sourceSessionTitle: string; sourceTurnId?: string; sideChat: boolean;
  sourceActorId?: string; sourceActorName?: string; sourceRequestId: string };
/** Where a cross-workspace handoff came from. userPrompt of its round is the user's own message;
 * task is the source actor's description: untrusted context, never authorization. */
export type ActorCrossWorkspaceOrigin = { sourceWorkspaceId: string; sourceWorkspaceName: string; sourceSessionId: string; sourceTurnId: string;
  sourceActorId: string; sourceActorName: string; sourceRequestId: string; task: string;
  /** The individually verified messages composing the round prompt. Legacy imports lack this provenance. */
  userMessages?: string[] };
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
