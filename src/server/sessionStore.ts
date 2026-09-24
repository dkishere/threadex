import { DEFAULT_MODEL, defaultGearProfiles } from "../modelCatalog";
import type { LightweightTodo } from "../lightweightTodo";
import type { ProcessCommandParameter, ProcessCommandValues } from "../processCommandParameters";
import { AUTO_MODEL_CHOICES, AUTO_EFFORT_CHOICES, isAutoModel, isAutoEffort, normalizeAutoModel } from "../autoModelCatalog";
import { acknowledgeGrill, grillAwaitingAck, type GrillSummary, type TurnGrill } from "../turnGrill";
import { openPostgresSessionConnection, postgresSchemaFromStoreId, type SessionDbConnection, type SessionDbValue } from "./sessionDb";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import { PENDING_CODEX_SESSION_TITLE_PREFIX } from "./codexSessionTitles";
import { stripTodoPlanOperationalSuffix } from "./todoInstructions";
import { fileChangesFromTurnDiff, normalizeStructuredAgentComment } from "./codexEvents";
import { changedFilePaths } from "./changedFilePaths";
import { canonicalSessionId, isThreadexSessionId, sessionIdAliases } from "../codexReference";
import { stripContextForkOperationalSuffix } from "../contextFork";
import { managerActivityPrompt, WORKSPACE_MANAGER_MODEL, WORKSPACE_MANAGER_EFFORT,
  type WorkspaceManagerRecord, type WorkspaceManagerEvent, type WorkspaceManagerSnapshot } from "../workspaceManager";

export type KeywordWeights = Record<string, number>;

// The file poller can discover a native rollout before its managed session
// adopts the thread ID. Keep the resulting empty import out of navigation.
const emptyNativeSessionAliasSql = `(
  sessions.thread_id IS NOT NULL
  AND sessions.id IN ('local_' || sessions.thread_id, 'tx_' || sessions.thread_id)
  AND sessions.parent_session_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM session_turn WHERE session_id = sessions.id)
  AND EXISTS (
    SELECT 1 FROM sessions AS owner
    WHERE owner.thread_id = sessions.thread_id
      AND owner.workspace_id = sessions.workspace_id
      AND owner.id <> sessions.id
      AND EXISTS (SELECT 1 FROM session_turn WHERE session_id = owner.id)
  )
)`;
export type SessionTitleSource = "initial" | "summarizer" | "user";

export type ComposerSuggestionKeywordRecord = {
  workspaceId: string;
  keyword: string;
  position: number;
  created: string;
  updated: string;
};

export type SessionModelTokenUsage = {
  model: string;
  tokenCount: number;
  inputTokenCount: number;
  cachedInputTokenCount: number;
  outputTokenCount: number;
};

export type SessionRecord = {
  id: string;
  threadId: string | null;
  workspaceId: string;
  cwd: string;
  accountId: string | null;
  keywordWeights: KeywordWeights;
  title: string;
  titleSource: SessionTitleSource;
  description: string;
  parentSessionId: string | null;
  forkedFromTurnId: string | null;
  achievedAt?: string | null;
  created: string;
  updated: string;
  turnCount?: number;
  tokenCount?: number;
  modelTokenUsage?: SessionModelTokenUsage[];
  matchedTurn?: string | null;
};

export type SessionListPage = {
  sessions: SessionRecord[];
  hasMore: boolean;
  total: number;
  nextOffset: number | null;
};

export type SessionProjectPage = SessionListPage & {
  cwd: string;
  offset: number;
  limit: number;
};

export type SessionProjectsPage = {
  sessions: SessionRecord[];
  projects: SessionProjectPage[];
};

export type SessionAutoModelConfig = {
  sessionId: string;
  enabled: boolean;
  model: string;
  effort: string;
  revision: number;
  updated: string;
};

export type SessionModelProfile = {
  model: string;
  effort: string;
};

export type SessionModelPreferences = {
  sessionId: string;
  selectedModel: string;
  selectedEffort: string;
  gearProfiles: SessionModelProfile[];
  activeGearIndex: number;
  updated: string;
};

export type SessionModelPreferencesInput = {
  selectedModel?: string;
  selectedEffort?: string;
  gearProfiles?: SessionModelProfile[];
  activeGearIndex?: number;
};

export type WorkspaceModelPreferences = {
  workspaceId: string;
  selectedModel: string;
  selectedEffort: string;
  gearProfiles: SessionModelProfile[];
  activeGearIndex: number;
  updated: string;
};

export type WorkspaceMonitorSessionRecord = {
  workspaceId: string;
  sessionId: string;
  sessionName: string;
};

export type ProcessMonitorStatus = "available" | "starting" | "running" | "exited" | "stopped" | "error";
export type ProcessMonitorWakeStatus = "none" | "pending" | "sent" | "done" | "error";
export type ProcessMetricStatus = "idle" | "ok" | "error";

/** A small command probe used when a process's own output is unavailable. */
export type ProcessMetricMonitor = {
  name: string;
  command: string;
  /** Append the latest successful value to the monitor name in the sidebar. */
  nameSuffix?: boolean;
};

export type ProcessMetricReading = ProcessMetricMonitor & {
  value: string | null;
  status: ProcessMetricStatus;
  updatedAt: string | null;
  error: string | null;
};

export type WaitEventStatus = "pending" | "fired" | "cancelled";
export type WaitSubscriptionStatus = "waiting" | "dispatching" | "done" | "error" | "cancelled";
export type WaitSubscriptionActionType = "retry_turn" | "enqueue_prompt" | "notify";

export type WaitEventRecord = {
  id: string;
  workspaceId: string;
  topic: string;
  subjectKey: string;
  status: WaitEventStatus;
  expectedAt: string | null;
  payload: unknown;
  firedAt: string | null;
  created: string;
  updated: string;
};

export type WaitSubscriptionRecord = {
  id: string;
  eventId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string | null;
  actionType: WaitSubscriptionActionType;
  actionPayload: unknown;
  status: WaitSubscriptionStatus;
  attempts: number;
  error: string | null;
  deliveredAt: string | null;
  created: string;
  updated: string;
};

export type TodoItemStatus = "todo" | "active" | "paused" | "hold" | "skipped" | "done" | "blocked";
export type TodoPlanSection = "solution" | "verification";
export type TodoCommentType = "status" | "blocker" | "note";
export type TodoMessageType = "update" | "challenge";
export type TodoActor = "agent" | "user" | "system";

export type TodoItemRecord = {
  id: string;
  sessionId: string;
  parentId: string | null;
  title: string;
  details: string;
  context: string;
  section: TodoPlanSection | null;
  status: TodoItemStatus;
  position: number;
  createdBy: TodoActor;
  updatedBy: TodoActor;
  lockedByTurnId: string | null;
  lockReason: string | null;
  activeStatus: string | null;
  childSessionId: string | null;
  childTurnId: string | null;
  changedFileCount: number;
  changedFiles: string[];
  created: string;
  updated: string;
};

export type TodoItemSessionRecord = {
  id: string;
  sessionId: string;
  itemId: string;
  childSessionId: string;
  childTurnId: string | null;
  title: string;
  role: string;
  created: string;
  updated: string;
};

export type TodoWorkerAssignment = {
  parentSessionId: string;
  itemId: string;
};

export type TodoCommentRecord = {
  id: string;
  sessionId: string;
  itemId: string | null;
  turnId: string | null;
  type: TodoCommentType;
  author: TodoActor;
  body: string;
  created: string;
};

export type TodoMessageRecord = {
  id: number;
  sessionId: string;
  itemId: string;
  turnId: string | null;
  type: TodoMessageType;
  author: TodoActor;
  title: string;
  body: string;
  challengeId: number | null;
  resolved: boolean;
  resolvedBy: TodoActor | null;
  resolvedAt: string | null;
  created: string;
};

export type TodoControlRecord = {
  sessionId: string;
  paused: boolean;
  pauseReason: string | null;
  pausedBy: TodoActor | null;
  context: string;
  problem: string;
  objective: string;
  updated: string;
};

export type TodoSnapshotItem = {
  id: string;
  parentId: string | null;
  title: string;
  details: string;
  context: string;
  section: TodoPlanSection | null;
  status: TodoItemStatus;
  activeStatus: string | null;
  latestProgressMessage: TodoMessageRecord | null;
  sessions: TodoItemSessionRecord[];
  children: TodoSnapshotItem[];
};

export type SessionTodoSnapshot = {
  lightweight?: LightweightTodo | null;
  sessionId: string;
  control: TodoControlRecord;
  items: TodoItemRecord[];
  itemSessions: TodoItemSessionRecord[];
  itemTree: TodoSnapshotItem[];
  comments: TodoCommentRecord[];
  messages: TodoMessageRecord[];
};

export type UpsertTodoItemInput = {
  id?: string;
  sessionId: string;
  parentId?: string | null;
  title: string;
  details?: string | null;
  context?: string | null;
  section?: TodoPlanSection | null;
  status?: TodoItemStatus;
  position?: number | null;
  actor?: TodoActor;
  turnId?: string | null;
  activeStatus?: string | null;
};

export type UpdateTodoItemInput = {
  id: string;
  sessionId: string;
  parentId?: string | null;
  title?: string | null;
  details?: string | null;
  context?: string | null;
  section?: TodoPlanSection | null;
  status?: TodoItemStatus | null;
  position?: number | null;
  actor?: TodoActor;
  turnId?: string | null;
  activeStatus?: string | null;
  lockReason?: string | null;
  childSessionId?: string | null;
  childTurnId?: string | null;
};

export type AddTodoCommentInput = {
  id?: string;
  sessionId: string;
  itemId?: string | null;
  turnId?: string | null;
  type?: TodoCommentType;
  author?: TodoActor;
  body: string;
};

export type AddTodoMessageInput = {
  sessionId: string;
  itemId: string;
  turnId?: string | null;
  type?: TodoMessageType;
  author?: TodoActor;
  title: string;
  body?: string | null;
};

export type TodoMessageMutationResult = SessionTodoSnapshot & {
  message: TodoMessageRecord;
  challengeId?: number;
};

export type TodoChallengeResolutionResult = SessionTodoSnapshot & {
  resolvedChallengeId: number;
};

export type CreateWaitEventInput = {
  id?: string;
  workspaceId: string;
  topic: string;
  subjectKey: string;
  expectedAt?: string | null;
  payload?: unknown;
};

export type CreateWaitSubscriptionInput = {
  id?: string;
  eventId: string;
  workspaceId: string;
  sessionId: string;
  turnId?: string | null;
  actionType: WaitSubscriptionActionType;
  actionPayload?: unknown;
};

export type ProcessMonitorRecord = {
  id: string;
  workspaceId: string;
  label: string;
  command: string | null;
  executable: string | null;
  dockerImage: string | null;
  dockerRunArgs: string[];
  args: string[];
  logFile: string | null;
  entryPoints: string[];
  metricMonitors: ProcessMetricMonitor[];
  metricReadings: ProcessMetricReading[];
  cwd: string;
  pid: number | null;
  status: ProcessMonitorStatus;
  /** The registered command that created this run, when applicable. */
  sourceCommandId: string | null;
  parameters?: ProcessCommandParameter[];
  parameterValues?: ProcessCommandValues;
  managed: boolean;
  /** Virtual status records such as the API server health monitor cannot be mutated. */
  readOnly?: boolean;
  /** A read-only record may expose a narrowly scoped restart through its supervisor. */
  restartable?: boolean;
  removeOnExit: boolean;
  
  wakePrompt: string | null;
  wakeSessionId: string | null;
  wakeThreadId: string | null;
  timeoutAt: string | null;
  wakeStatus: ProcessMonitorWakeStatus;
  wakeError: string | null;
  wokenAt: string | null;
  startedAt: string | null;
  lastExitCode: number | null;
  lastSignal: string | null;
  error: string | null;
  created: string;
  updated: string;
};

export type CreateProcessMonitorInput = {
  id?: string;
  workspaceId: string;
  label: string;
  command?: string | null;
  executable?: string | null;
  dockerImage?: string | null;
  dockerRunArgs?: string[];
  args?: string[];
  logFile?: string | null;
  entryPoints?: string[];
  metricMonitors?: ProcessMetricMonitor[];
  metricReadings?: ProcessMetricReading[];
  cwd: string;
  pid?: number | null;
  status?: ProcessMonitorStatus;
  sourceCommandId?: string | null;
  parameters?: ProcessCommandParameter[];
  parameterValues?: ProcessCommandValues;
  managed?: boolean;
  removeOnExit?: boolean;
  wakePrompt?: string | null;
  wakeSessionId?: string | null;
  wakeThreadId?: string | null;
  timeoutAt?: string | null;
  wakeStatus?: ProcessMonitorWakeStatus;
  wakeError?: string | null;
  wokenAt?: string | null;
  startedAt?: string | null;
  lastExitCode?: number | null;
  lastSignal?: string | null;
  error?: string | null;
};

export type UpdateProcessMonitorInput = Partial<Omit<CreateProcessMonitorInput, "id" | "workspaceId">> & {
  id: string;
};

export type SessionTitleSyncInput = {
  threadId: string;
  title: string;
};

export type SessionTitleSyncResult = SessionTitleSyncInput & {
  sessionId: string;
};

export type SessionTurnRecord = {
  id: string;
  sessionId: string;
  loopMode?: boolean;
  accountId: string | null;
  userInput: string;
  agentResponse: string;
  /** The model recorded when this turn began, if it is available. */
  model?: string | null;
  /** The reasoning effort recorded when this turn began, if it is available. */
  reasoningEffort?: string | null;
  tokenIn: number;
  tokenOut: number;
  usageSample: SessionTurnTokenUsageSampleRecord | null;
  status: SessionTurnStatus;
  runnerPid: number | null;
  runnerStarted: string | null;
  runnerHeartbeat: string | null;
  /** Exact elapsed time reported in the runner's final result, when available. */
  executionDurationMs?: number;
  runnerLogPath: string | null;
  runnerExitCode: number | null;
  lastEventName: string | null;
  pendingReason: "queued" | "rate_limit" | "auth" | "stopped" | null;
  pendingLoadBalance: boolean | null;
  /** Original request options retained for durable pending-turn retries. */
  requestMetadata?: Record<string, unknown>;
  created: string;
};

export type SessionTurnClaimResult = {
  disposition: "started" | "reconnected" | "queued" | "existing";
  turn: SessionTurnRecord;
};

export type PendingSessionTurnClaimResult = {
  disposition: "started" | "already_running" | "blocked" | "completed" | "missing";
  turn: SessionTurnRecord | null;
  runningTurn: SessionTurnRecord | null;
};

export type SessionTurnStatus = "done" | "todo" | "running";
export type ActiveSessionExecutionStatus = Extract<SessionTurnStatus, "running">;

export type SessionTurnEventRecord = {
  id: string;
  turnId: string;
  sessionId: string;
  eventName: string;
  payload: unknown;
  created: string;
};

export type SessionAutoModelProvider = "typesafe" | "fallback";

export type SessionSideChatRecord = {
  id: string;
  sessionId: string;
  workspaceId: string;
  sourceSessionId: string | null;
  sourceThreadId: string | null;
  sourceTurnId: string | null;
  question: string;
  answer: string;
  model: string;
  contextTurnCount: number;
  contextFilter: string | null;
  mode: string;
  created: string;
};

export type SessionSqlQueryInput = {
  sql: string;
  params?: Record<string, unknown>;
  limit?: number;
};

export type SessionSqlQueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  limit: number;
  truncated: boolean;
};

export type SessionUpdatedBackfillResult = {
  totalSessions: number;
  fromLastTurn: number;
  fromCreated: number;
  changed: number;
};

const storedJsonPayloadLimitBytes = Number(process.env.SESSION_EVENT_JSON_LIMIT_BYTES ?? 10 * 1024 * 1024);
const storedJsonPayloadMinStringChars = 1024;

export type SessionInspectorLookup = {
  sessionId?: string | null;
  threadId?: string | null;
  workspaceId?: string | null;
};

export type SessionInspectInput = SessionInspectorLookup & {
  view?: "full" | "file_changes" | "turn_summary" | null;
  includeEvents?: boolean;
  includeLiveItems?: boolean;
  includeSideChats?: boolean;
  turnId?: string | null;
  status?: SessionTurnStatus | null;
  eventName?: string | null;
  q?: string | null;
  turnLimit?: number;
  turnOffset?: number;
  eventLimit?: number;
  eventOffset?: number;
  sideChatLimit?: number;
  sideChatOffset?: number;
  order?: "asc" | "desc";
  maxTextChars?: number | null;
};

type SessionInspectPage = {
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
};

type SessionInspectTurnRecord = SessionTurnRecord & {
  userInputOmittedChars?: number;
  agentResponseOmittedChars?: number;
  liveItems?: unknown[];
  developerInstructions?: SessionDeveloperInstructionsRecord[];
};

export type SessionDeveloperInstructionsRecord = {
  target: string;
  phase: number | null;
  developerInstructions: string;
  created: string;
};

export type SessionSteerMessageRecord = {
  id: string;
  content: string;
  attachments: unknown[];
  forcePlan: boolean;
  created: string;
};

type SessionInspectFileChange = {
  path: string;
  kind: string;
  additions: number;
  deletions: number;
  movePath?: string;
};

type SessionInspectFileChangeWithTurns = SessionInspectFileChange & {
  turnIds: string[];
};

type SessionInspectFileChangeTotals = {
  files: number;
  additions: number;
  deletions: number;
};

export type SessionFullInspection = {
  session: SessionRecord;
  turns: SessionInspectTurnRecord[];
  turnPage: SessionInspectPage;
  sideChats?: SessionSideChatRecord[];
  sideChatPage?: SessionInspectPage;
  events?: SessionTurnEventRecord[];
  eventPage?: SessionInspectPage;
};

export type SessionFileChangesInspection = {
  session: SessionRecord;
  view: "file_changes";
  fileChanges: SessionInspectFileChangeWithTurns[];
  totals: SessionInspectFileChangeTotals;
  turnPage: SessionInspectPage;
};

export type SessionTurnSummaryInspection = {
  session: SessionRecord;
  view: "turn_summary";
  turns: Array<{
    id: string;
    status: SessionTurnStatus;
    created: string;
    userPrompt: string;
    conclusion: string;
    fileChanges: SessionInspectFileChange[];
    totals: SessionInspectFileChangeTotals;
  }>;
  turnPage: SessionInspectPage;
};

export type SessionSearchInput = {
  query?: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
  threadId?: string | null;
  status?: SessionTurnStatus | null;
  limit?: number;
  offset?: number;
  maxTextChars?: number | null;
};

export type SessionVectorSearchInput = {
  embedding: number[];
  workspaceId?: string | null;
  sessionId?: string | null;
  threadId?: string | null;
  limit?: number;
  offset?: number;
  maxTextChars?: number | null;
};

export type SessionKeywordVocabularyInput = {
  workspaceId?: string | null;
  limit?: number;
};

export type SessionKeywordSearchInput = {
  keywords: string[];
  workspaceId?: string | null;
  limit?: number;
  offset?: number;
  maxTextChars?: number | null;
};

export type WorkspaceRecord = {
  id: string;
  name: string;
  codexHome: string;
  cwd: string;
  created: string;
  updated: string;
};

export type AccountRecord = {
  id: string;
  name: string;
  externalAccountId: string | null;
  externalUserId: string | null;
  email: string | null;
  hasAuth: boolean;
  authVersion: number;
  quotaSnapshot: unknown;
  quotaUpdatedAt: string | null;
  quotaError: string | null;
  created: string;
  updated: string;
  lastUsed: string | null;
};

export type AccountAuthRecord = {
  authRaw: string;
  configRaw: string | null;
  version: number;
};

export type AccountAuthWriteResult = "updated" | "unchanged" | "conflict";

export type LegacyAccountAuthSource = {
  accountId: string;
  snapshotPath: string;
};

export type SessionSummaryStateRecord = {
  sessionId: string;
  sourceHash: string;
  sourceTurnCount: number;
  sourceUpdated: string;
  summarizerModel: string;
  summarizedAt: string;
  updated: string;
};

export type KeywordAppearanceRecord = {
  workspaceId: string;
  keyword: string;
  sessionCount: number;
  created: string;
  updated: string;
};

export type SessionKeywordCandidate = {
  session: SessionRecord;
  score: number;
  keywordScore: number;
  recencyScore: number;
  matchedKeywords: string[];
};

export type SessionMetadataInput = {
  keywordWeights?: unknown;
  title?: unknown;
  description?: unknown;
  desc?: unknown;
  parentSessionId?: unknown;
  parent_session_id?: unknown;
};

type UpsertSessionInput = {
  id: string;
  threadId?: string | null;
  workspaceId?: string;
  cwd?: string;
  accountId?: string | null;
  keywordWeights?: KeywordWeights;
  title?: string;
  titleSource?: SessionTitleSource;
  description?: string;
  parentSessionId?: string | null;
  forkedFromTurnId?: string | null;
};

type ForkSessionInput = {
  id: string;
  parentSessionId: string;
  targetTurnId: string;
  title?: string;
  titleSource?: SessionTitleSource;
  description?: string;
};

type RecordSessionTurnInput = {
  id?: string;
  sessionId: string;
  accountId?: string | null;
  accountName?: string | null;
  accountEmail?: string | null;
  accountExternalAccountId?: string | null;
  accountExternalUserId?: string | null;
  userInput: string;
  agentResponse: string;
  tokenIn: number;
  tokenOut: number;
  status?: SessionTurnStatus;
  pendingReason?: "queued" | "rate_limit" | "auth" | "stopped" | null;
  pendingLoadBalance?: boolean | null;
  requestMetadata?: Record<string, unknown> | null;
};

type RecordSessionSideChatInput = {
  id?: string;
  sessionId: string;
  workspaceId: string;
  sourceSessionId?: string | null;
  sourceThreadId?: string | null;
  sourceTurnId?: string | null;
  question: string;
  answer: string;
  model: string;
  contextTurnCount?: number;
  contextFilter?: string | null;
  mode?: string;
};

type SessionTurnAccountInput = {
  accountId: string | null;
  accountName?: string | null;
  accountEmail?: string | null;
  accountExternalAccountId?: string | null;
  accountExternalUserId?: string | null;
};

type UpdateSessionTurnInput = {
  id: string;
  agentResponse: string;
  tokenIn: number;
  tokenOut: number;
  status: SessionTurnStatus;
  runnerExitCode?: number | null;
  pendingReason?: "queued" | "rate_limit" | "auth" | "stopped" | null;
  pendingLoadBalance?: boolean | null;
  expectedStatus?: SessionTurnStatus;
  expectedRunnerPid?: number | null;
  expectedRunnerLogPath?: string | null;
};

type UpdatePendingSessionTurnInput = {
  id: string;
  sessionId: string;
  userInput: string;
  message?: string;
};

type RecordSessionTurnEventInput = {
  id?: string;
  turnId: string;
  sessionId: string;
  eventName: string;
  payload: unknown;
  jsonlIndex?: number | null;
  sequence?: number | null;
  refreshRunnerHeartbeat?: boolean;
};

type LinkManagedRunnerNativeTurnInput = {
  sessionId: string;
  managerTurnId: string;
  nativeSessionId?: string | null;
  nativeTurnId: string;
  transcriptPath?: string | null;
  /** The runner update already persisted the provenance event. */
  eventAlreadyRecorded?: boolean;
};

export type ImportLocalCodexSessionFileResult = {
  path: string;
  sessionId: string | null;
  threadId: string | null;
  turns: number;
  events: number;
  skipped: boolean;
};

export type SessionTurnTokenUsageSampleRecord = {
  id: string;
  sessionId: string;
  turnId: string;
  source: string;
  sourceIndex: number | null;
  sourceTimestamp: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  cumulativeInputTokens: number;
  cumulativeCachedInputTokens: number;
  cumulativeOutputTokens: number;
  cumulativeReasoningOutputTokens: number;
  cumulativeTotalTokens: number;
  modelContextWindow: number | null;
  primaryUsedPercent: number | null;
  secondaryUsedPercent: number | null;
  primaryResetsAt: number | null;
  secondaryResetsAt: number | null;
  planType: string | null;
  created: string;
  updated: string;
};

export type SessionTurnTokenUsageSampleInput = Omit<SessionTurnTokenUsageSampleRecord, "id" | "created" | "updated"> & {
  id?: string;
};

export type TokenUsageInput = {
  id: string;
  usageType: "agent" | "summarizer" | "background" | "account";
  source: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  accountId?: string | null;
  model?: string | null;
  sourceIndex?: number | null;
  sourceTimestamp?: string | null;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  cumulativeInputTokens?: number;
  cumulativeCachedInputTokens?: number;
  cumulativeOutputTokens?: number;
  cumulativeReasoningOutputTokens?: number;
  cumulativeTotalTokens?: number;
  modelContextWindow?: number | null;
  primaryUsedPercent?: number | null;
  secondaryUsedPercent?: number | null;
  primaryResetsAt?: number | null;
  secondaryResetsAt?: number | null;
  planType?: string | null;
  windowKey?: string | null;
  usedPercentBefore?: number | null;
  usedPercentAfter?: number | null;
  usedPercentDelta?: number | null;
  tokensPerUsedPercent?: number | null;
  metadata?: unknown;
};

type RecordCodexCommandCallInput = {
  sessionId: string;
  turnId: string;
  itemId: string;
  eventId?: string | null;
  jsonlIndex?: number | null;
  command: string;
  responseLength: number;
  status: string;
  exitCode?: number | null;
};

const sessionLiveItemOutputTailBytes = 64 * 1024;
const latestUsageSampleJoinSql = `
  LEFT JOIN token_usage AS latest_usage
    ON latest_usage.id = (
      SELECT id
      FROM token_usage
      WHERE turn_id = session_turn.id
        AND usage_type = 'agent'
      ORDER BY
        CASE WHEN primary_used_percent IS NOT NULL OR secondary_used_percent IS NOT NULL THEN 1 ELSE 0 END DESC,
        source_timestamp DESC NULLS LAST,
        source_index DESC NULLS LAST,
        created DESC
      LIMIT 1
    )
  LEFT JOIN token_usage AS latest_effort_usage
    ON latest_effort_usage.id = (
      SELECT id
      FROM token_usage
      WHERE turn_id = session_turn.id
        AND usage_type = 'agent'
        AND json_extract_string(metadata, '$.reasoningEffort') IS NOT NULL
      ORDER BY
        source_timestamp DESC NULLS LAST,
        source_index DESC NULLS LAST,
        created DESC
      LIMIT 1
    )
`;
const latestUsageSampleSelectSql = `
  COALESCE(
    (
      SELECT model
      FROM token_usage
      WHERE turn_id = session_turn.id
        AND usage_type = 'agent'
        AND source = 'native_token_count'
        AND model IS NOT NULL
        AND model <> 'auto'
      ORDER BY source_timestamp DESC NULLS LAST, source_index DESC NULLS LAST, created DESC
      LIMIT 1
    ),
    NULLIF(latest_usage.model, 'auto'),
    (
      SELECT model
      FROM token_usage
      WHERE turn_id = session_turn.id
        AND usage_type = 'agent'
        AND model IS NOT NULL
        AND model <> 'auto'
      ORDER BY source_timestamp DESC NULLS LAST, source_index DESC NULLS LAST, created DESC
      LIMIT 1
    )
  ) AS turn_model,
  COALESCE(
    json_extract_string(latest_usage.metadata, '$.reasoningEffort'),
    json_extract_string(latest_effort_usage.metadata, '$.reasoningEffort')
  ) AS turn_reasoning_effort,
  latest_usage.id AS usage_sample_id,
  latest_usage.source AS usage_sample_source,
  latest_usage.source_index AS usage_sample_source_index,
  CAST(latest_usage.source_timestamp AS VARCHAR) AS usage_sample_source_timestamp,
  latest_usage.input_tokens AS usage_sample_input_tokens,
  latest_usage.cached_input_tokens AS usage_sample_cached_input_tokens,
  latest_usage.output_tokens AS usage_sample_output_tokens,
  latest_usage.reasoning_output_tokens AS usage_sample_reasoning_output_tokens,
  latest_usage.total_tokens AS usage_sample_total_tokens,
  latest_usage.cumulative_input_tokens AS usage_sample_cumulative_input_tokens,
  latest_usage.cumulative_cached_input_tokens AS usage_sample_cumulative_cached_input_tokens,
  latest_usage.cumulative_output_tokens AS usage_sample_cumulative_output_tokens,
  latest_usage.cumulative_reasoning_output_tokens AS usage_sample_cumulative_reasoning_output_tokens,
  latest_usage.cumulative_total_tokens AS usage_sample_cumulative_total_tokens,
  latest_usage.model_context_window AS usage_sample_model_context_window,
  latest_usage.primary_used_percent AS usage_sample_primary_used_percent,
  latest_usage.secondary_used_percent AS usage_sample_secondary_used_percent,
  latest_usage.primary_resets_at AS usage_sample_primary_resets_at,
  latest_usage.secondary_resets_at AS usage_sample_secondary_resets_at,
  latest_usage.plan_type AS usage_sample_plan_type,
  CAST(latest_usage.created AS VARCHAR) AS usage_sample_created,
  CAST(latest_usage.updated AS VARCHAR) AS usage_sample_updated
`;
const resultExecutionDurationSelectSql = `
  (
    SELECT max(
      CASE
        WHEN json_extract_string(result_event.payload, '$.elapsedMs') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN CAST(json_extract_string(result_event.payload, '$.elapsedMs') AS DOUBLE PRECISION)
        ELSE NULL
      END
    )
    FROM session_turn_event AS result_event
    WHERE result_event.turn_id = session_turn.id
      AND result_event.event_name = 'result'
  ) AS execution_duration_ms
`;

type MarkSessionTurnRunningInput = {
  id: string;
  runnerPid: number;
  runnerLogPath: string;
};

type AccountTokenUsageRatioInput = {
  accountId: string;
  turnId: string;
  windowKey: string;
  tokenIn: number;
  tokenOut: number;
  tokenTotal: number;
  usedPercentBefore: number | null;
  usedPercentAfter: number | null;
  usedPercentDelta: number | null;
  tokensPerUsedPercent: number | null;
  quotaUpdatedAt: string;
};

type SessionRow = {
  id?: unknown;
  thread_id?: unknown;
  workspace_id?: unknown;
  cwd?: unknown;
  account_id?: unknown;
  keyword_weights?: unknown;
  title?: unknown;
  title_source?: unknown;
  description?: unknown;
  parent_session_id?: unknown;
  forked_from_turn_id?: unknown;
  achieved_at?: unknown;
  created?: unknown;
  updated?: unknown;
  turn_count?: unknown;
  token_count?: unknown;
  model_token_usage?: unknown;
  matched_turn?: unknown;
};

type WorkspaceRow = {
  id?: unknown;
  name?: unknown;
  codex_home?: unknown;
  cwd?: unknown;
  created?: unknown;
  updated?: unknown;
};

type AccountRow = {
  id?: unknown;
  name?: unknown;
  external_account_id?: unknown;
  external_user_id?: unknown;
  email?: unknown;
  has_auth?: unknown;
  auth_version?: unknown;
  quota_snapshot?: unknown;
  quota_updated_at?: unknown;
  quota_error?: unknown;
  created?: unknown;
  updated?: unknown;
  last_used?: unknown;
};

type SessionTurnRow = {
  id?: unknown;
  session_id?: unknown;
  loop_mode?: unknown;
  account_id?: unknown;
  user_input?: unknown;
  agent_response?: unknown;
  turn_model?: unknown;
  turn_reasoning_effort?: unknown;
  token_in?: unknown;
  token_out?: unknown;
  status?: unknown;
  runner_pid?: unknown;
  runner_started?: unknown;
  runner_heartbeat?: unknown;
  execution_duration_ms?: unknown;
  runner_log_path?: unknown;
  runner_exit_code?: unknown;
  last_event_name?: unknown;
  pending_reason?: unknown;
  pending_load_balance?: unknown;
  request_metadata?: unknown;
  created?: unknown;
  usage_sample_id?: unknown;
  usage_sample_source?: unknown;
  usage_sample_source_index?: unknown;
  usage_sample_source_timestamp?: unknown;
  usage_sample_input_tokens?: unknown;
  usage_sample_cached_input_tokens?: unknown;
  usage_sample_output_tokens?: unknown;
  usage_sample_reasoning_output_tokens?: unknown;
  usage_sample_total_tokens?: unknown;
  usage_sample_cumulative_input_tokens?: unknown;
  usage_sample_cumulative_cached_input_tokens?: unknown;
  usage_sample_cumulative_output_tokens?: unknown;
  usage_sample_cumulative_reasoning_output_tokens?: unknown;
  usage_sample_cumulative_total_tokens?: unknown;
  usage_sample_model_context_window?: unknown;
  usage_sample_primary_used_percent?: unknown;
  usage_sample_secondary_used_percent?: unknown;
  usage_sample_primary_resets_at?: unknown;
  usage_sample_secondary_resets_at?: unknown;
  usage_sample_plan_type?: unknown;
  usage_sample_created?: unknown;
  usage_sample_updated?: unknown;
};

type SessionSideChatRow = {
  id?: unknown;
  session_id?: unknown;
  workspace_id?: unknown;
  source_session_id?: unknown;
  source_thread_id?: unknown;
  source_turn_id?: unknown;
  question?: unknown;
  answer?: unknown;
  model?: unknown;
  context_turn_count?: unknown;
  context_filter?: unknown;
  mode?: unknown;
  created?: unknown;
};

type SessionTurnEventRow = {
  id?: unknown;
  turn_id?: unknown;
  session_id?: unknown;
  event_name?: unknown;
  payload_json?: unknown;
  created?: unknown;
};

type LocalCodexSessionFile = {
  path: string;
  source: string;
  codexHome: string | null;
};

type LocalCodexSessionIndexRecord = {
  title: string | null;
  updated: string | null;
};

type ParsedLocalCodexSessionFile = {
  path: string;
  source: string;
  stat: Stats;
  sessionId: string | null;
  threadId: string | null;
  workspaceId: string;
  cwd: string;
  title: string;
  description: string;
  parentSessionId: string | null;
  created: string;
  updated: string;
  events: LocalCodexSessionEvent[];
  turns: LocalCodexSessionTurn[];
  liveItems: LocalCodexLiveItem[];
  incompleteTurnIds: string[];
  openTurnIds: string[];
  ignored: boolean;
  parseErrors: string[];
};

type LocalCodexLiveItem = {
  turnId: string;
  jsonlIndex: number;
  created: string | null;
  item: Record<string, unknown>;
};

type LocalCodexPendingCommandCall = {
  turnId: string;
  itemId: string;
  command: string;
};

type LocalCodexSessionTurn = {
  id: string;
  created: string;
  userInput: string;
  assistantMessages: string[];
  finalResponses: string[];
  model: string | null;
  tokenIn: number;
  tokenOut: number;
  status: SessionTurnStatus;
  interrupted: boolean;
  ignored: boolean;
};

type LocalCodexSessionEvent = {
  index: number;
  timestamp: string | null;
  raw: unknown;
  payload: unknown;
  turnId: string | null;
  eventType: string;
  payloadType: string | null;
};

type SessionSearchRow = SessionTurnRow & {
  thread_id?: unknown;
  workspace_id?: unknown;
  cwd?: unknown;
  title?: unknown;
  description?: unknown;
  session_created?: unknown;
  session_updated?: unknown;
  score?: unknown;
};

type SessionDescriptionEmbeddingRow = SessionRow & {
  workspace_id?: unknown;
  cwd?: unknown;
  embedding?: unknown;
  model?: unknown;
  embedding_updated?: unknown;
};

type SessionSummaryStateRow = {
  session_id?: unknown;
  source_hash?: unknown;
  source_turn_count?: unknown;
  source_updated?: unknown;
  summarizer_model?: unknown;
  summarized_at?: unknown;
  updated?: unknown;
};

type KeywordAppearanceRow = {
  workspace_id?: unknown;
  keyword?: unknown;
  session_count?: unknown;
  created?: unknown;
  updated?: unknown;
};

type ProcessMonitorRow = {
  id?: unknown;
  workspace_id?: unknown;
  label?: unknown;
  command?: unknown;
  executable?: unknown;
  docker_image?: unknown;
  docker_run_args_json?: unknown;
  args_json?: unknown;
  log_file?: unknown;
  entry_points_json?: unknown;
  metric_monitors_json?: unknown;
  metric_readings_json?: unknown;
  entry_point?: unknown;
  cwd?: unknown;
  pid?: unknown;
  status?: unknown;
  source_command_id?: unknown;
  parameters_json?: unknown;
  parameter_values_json?: unknown;
  managed?: unknown;
  remove_on_exit?: unknown;
  wake_prompt?: unknown;
  wake_session_id?: unknown;
  wake_thread_id?: unknown;
  timeout_at?: unknown;
  wake_status?: unknown;
  wake_error?: unknown;
  woken_at?: unknown;
  started_at?: unknown;
  last_exit_code?: unknown;
  last_signal?: unknown;
  error?: unknown;
  created?: unknown;
  updated?: unknown;
};

type WaitEventRow = {
  id?: unknown;
  workspace_id?: unknown;
  topic?: unknown;
  subject_key?: unknown;
  status?: unknown;
  expected_at?: unknown;
  payload_json?: unknown;
  fired_at?: unknown;
  created?: unknown;
  updated?: unknown;
};

type WaitSubscriptionRow = {
  id?: unknown;
  event_id?: unknown;
  workspace_id?: unknown;
  session_id?: unknown;
  turn_id?: unknown;
  action_type?: unknown;
  action_payload_json?: unknown;
  status?: unknown;
  attempts?: unknown;
  error?: unknown;
  delivered_at?: unknown;
  created?: unknown;
  updated?: unknown;
};

type TodoItemRow = {
  id?: unknown;
  session_id?: unknown;
  parent_id?: unknown;
  title?: unknown;
  details?: unknown;
  context?: unknown;
  section?: unknown;
  status?: unknown;
  position?: unknown;
  created_by?: unknown;
  updated_by?: unknown;
  locked_by_turn_id?: unknown;
  lock_reason?: unknown;
  active_status?: unknown;
  child_session_id?: unknown;
  child_turn_id?: unknown;
  changed_file_count?: unknown;
  changed_files_json?: unknown;
  created?: unknown;
  updated?: unknown;
};

type TodoItemSessionRow = {
  id?: unknown;
  session_id?: unknown;
  item_id?: unknown;
  child_session_id?: unknown;
  child_turn_id?: unknown;
  title?: unknown;
  role?: unknown;
  created?: unknown;
  updated?: unknown;
};

type TodoCommentRow = {
  id?: unknown;
  session_id?: unknown;
  item_id?: unknown;
  turn_id?: unknown;
  type?: unknown;
  author?: unknown;
  body?: unknown;
  created?: unknown;
};

type TodoMessageRow = {
  id?: unknown;
  session_id?: unknown;
  item_id?: unknown;
  turn_id?: unknown;
  type?: unknown;
  author?: unknown;
  title?: unknown;
  body?: unknown;
  resolved_by?: unknown;
  resolved_at?: unknown;
  created?: unknown;
};

type TodoControlRow = {
  session_id?: unknown;
  paused?: unknown;
  pause_reason?: unknown;
  paused_by?: unknown;
  context?: unknown;
  problem?: unknown;
  objective?: unknown;
  updated?: unknown;
};

export class SessionStore {
  private connectionPromise: Promise<SessionDbConnection>;
  private queue = Promise.resolve();
  private connection: SessionDbConnection | null = null;
  private duckDbUiStarted = false;
  private closed = false;
  private readonly postgresSchema: string | null;

  constructor(storeId = process.env.SESSION_STORE_ID ?? process.env.SESSION_DB_PATH ?? "default") {
    this.postgresSchema = postgresSchemaFromStoreId(storeId);
    this.connectionPromise = this.open();
  }

  async startDuckDbUi(assetUrl: string, uiPort: number) {
    const connection = await this.connectionPromise;
    await connection.startDuckDbUi(assetUrl, uiPort);
    this.duckDbUiStarted = true;
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;

    await this.queue.catch(() => undefined);
    const connection = await this.connectionPromise.catch(() => this.connection);

    if (connection) {
      if (this.duckDbUiStarted) {
        try {
          await connection.stopDuckDbUi();
        } catch (error) {
          console.warn(`Failed to stop database admin UI cleanly: ${errorMessage(error)}`);
        }
        this.duckDbUiStarted = false;
      }

      try {
        await connection.checkpoint();
      } catch (error) {
        console.warn(`Failed to checkpoint database during shutdown: ${errorMessage(error)}`);
      }

      await connection.close();
      this.connection = null;
    }
  }

  async ready() {
    await this.connectionPromise;
  }

  async dedupeImportedTurnRows(): Promise<number> {
    return this.write(async (connection) => {
      const result = await connection.run(
        `
          SELECT session_id, id, user_input, agent_response, last_event_name, CAST(created AS VARCHAR) AS created
          FROM session_turn
          WHERE last_event_name IN ('local.hook_imported', 'local.imported')
          ORDER BY session_id ASC, created ASC, id ASC
        `
      );
      const importedRows = (await result.getRowObjectsJS()).map((row) => ({
        sessionId: stringValue(row.session_id),
        id: stringValue(row.id),
        userInput: stringValue(row.user_input),
        agentResponse: stringValue(row.agent_response),
        created: nullableString(row.created)
      })).filter((row) => row.sessionId && row.id && row.userInput);
      if (importedRows.length === 0) {
        return 0;
      }

      const removedIds = new Set<string>();
      let removed = 0;
      for (const imported of importedRows) {
        if (removedIds.has(imported.id)) {
          continue;
        }
        const managerRowsResult = await connection.run(
          `
            SELECT id, last_event_name, CAST(created AS VARCHAR) AS created, user_input
            FROM session_turn
            WHERE session_id = $sessionId
              AND id <> $importedId
              AND last_event_name NOT IN ('local.hook_imported', 'local.imported')
            ORDER BY created ASC, id ASC
          `,
          { sessionId: imported.sessionId, importedId: imported.id }
        );
        const managerRow = (await managerRowsResult.getRowObjectsJS())
          .find((row) => importedLocalTurnPromptsMatch(stringValue(row.user_input), imported.userInput));
        if (!managerRow) {
          continue;
        }
        if (imported.agentResponse) {
          await connection.run(
            `
              UPDATE session_turn
              SET agent_response = $agentResponse
              WHERE id = $managerTurnId
                AND session_id = $sessionId
            `,
            {
              managerTurnId: stringValue(managerRow.id),
              sessionId: imported.sessionId,
              agentResponse: imported.agentResponse
            }
          );
        }
        await this.deleteImportedLocalTurnWithConnection(connection, imported.sessionId, imported.id);
        removedIds.add(imported.id);
        removed += 1;
      }
      if (removed > 0) {
        await this.refreshSessionTurnFtsIndex(connection);
      }
      return removed;
    });
  }

  async runSqlQuery(input: SessionSqlQueryInput): Promise<SessionSqlQueryResult> {
    const sql = normalizeSqlQuery(input.sql);
    if (!isReadOnlySql(sql)) {
      throw new Error("Only read-only SQL is allowed. Use SELECT, WITH, SHOW, DESCRIBE, DESC, EXPLAIN, or PRAGMA.");
    }
    if (readsProtectedAccountAuth(sql)) {
      throw new Error("The accounts table is protected; use the account APIs, which never return stored auth.");
    }

    const params = normalizeSqlParams(input.params);
    const limit = normalizePageLimit(input.limit, 200, 1000);
    return this.read(async (connection) => {
      const result = await connection.run(sql, params);
      const rows = (await result.getRowObjectsJS()).map(normalizeSqlRow);
      const page = rows.slice(0, limit);
      return {
        columns: page.length > 0 ? Object.keys(page[0]) : [],
        rows: page,
        rowCount: rows.length,
        limit,
        truncated: rows.length > page.length
      };
    });
  }

  async backfillSessionUpdatedFromLastTurn(): Promise<SessionUpdatedBackfillResult> {
    return this.write(async (connection) => {
      const summaryResult = await connection.run(`
        WITH session_times AS (
          SELECT
            sessions.id,
            sessions.created,
            sessions.updated,
            max(session_turn.created) AS last_turn
          FROM sessions
          LEFT JOIN session_turn ON session_turn.session_id = sessions.id
          GROUP BY sessions.id, sessions.created, sessions.updated
        )
        SELECT
          count(*) AS total_sessions,
          count(last_turn) AS from_last_turn,
          count(*) - count(last_turn) AS from_created,
          count(*) FILTER (
            WHERE updated IS DISTINCT FROM coalesce(last_turn, created)
          ) AS changed
        FROM session_times
      `);
      const summary = (await summaryResult.getRowObjectsJS())[0] ?? {};

      await connection.run(`
        WITH session_times AS (
          SELECT
            sessions.id,
            coalesce(max(session_turn.created), sessions.created) AS target_updated
          FROM sessions
          LEFT JOIN session_turn ON session_turn.session_id = sessions.id
          GROUP BY sessions.id, sessions.created
        )
        UPDATE sessions
        SET updated = session_times.target_updated
        FROM session_times
        WHERE sessions.id = session_times.id
          AND sessions.updated IS DISTINCT FROM session_times.target_updated
      `);

      return {
        totalSessions: numberValue(summary.total_sessions),
        fromLastTurn: numberValue(summary.from_last_turn),
        fromCreated: numberValue(summary.from_created),
        changed: numberValue(summary.changed)
      };
    });
  }

  async listSessions(workspaceId?: string | null): Promise<SessionRecord[]> {
    return this.read(async (connection) => {
      const result = workspaceId
        ? await connection.run(
            `
        SELECT
          id,
          thread_id,
          workspace_id,
          cwd,
          account_id,
          CAST(keyword_weights AS VARCHAR) AS keyword_weights,
          title,
          title_source,
          description,
          parent_session_id,
          forked_from_turn_id,
          CAST(achieved_at AS VARCHAR) AS achieved_at,
          CAST(created AS VARCHAR) AS created,
          CAST(updated AS VARCHAR) AS updated
        FROM sessions
        WHERE workspace_id = $workspaceId
          AND NOT EXISTS (SELECT 1 FROM workspace_manager_archive a WHERE a.session_id = sessions.id)
        ORDER BY updated DESC, created DESC
      `,
            { workspaceId }
          )
        : await connection.run(`
        SELECT
          id,
          thread_id,
          workspace_id,
          cwd,
          account_id,
          CAST(keyword_weights AS VARCHAR) AS keyword_weights,
          title,
          title_source,
          description,
          parent_session_id,
          forked_from_turn_id,
          CAST(achieved_at AS VARCHAR) AS achieved_at,
          CAST(created AS VARCHAR) AS created,
          CAST(updated AS VARCHAR) AS updated
        FROM sessions
        WHERE NOT EXISTS (SELECT 1 FROM workspace_manager_archive a WHERE a.session_id = sessions.id)
        ORDER BY updated DESC, created DESC
      `);
      return (await result.getRowObjectsJS()).map(toSessionRecord);
    });
  }

  async listSessionsPage(
    workspaceId: string,
    offset = 0,
    limit = 20,
    query?: string | null,
    cwd?: string | null
  ): Promise<SessionListPage> {
    const pageOffset = Math.max(0, Math.floor(offset));
    const pageLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const normalizedQuery = query?.trim() || null;
    const projectCwd = typeof cwd === "string" ? cwd : null;
    const searchTerms = normalizedQuery ? parseSessionListSearchTerms(normalizedQuery) : [];
    const termPredicates = searchTerms.map((_, index) => `(
              contains(lower(sessions.id), lower($query${index}))
              OR contains(lower(sessions.cwd), lower($query${index}))
              OR contains(lower(sessions.title), lower($query${index}))
              OR contains(lower(sessions.description), lower($query${index}))
              OR contains(lower(CAST(sessions.keyword_weights AS VARCHAR)), lower($query${index}))
              OR EXISTS (
                SELECT 1
                FROM session_turn
                WHERE session_turn.session_id = sessions.id
                  AND (
                    contains(lower(session_turn.user_input), lower($query${index}))
                    OR contains(lower(session_turn.agent_response), lower($query${index}))
                  )
              )
              OR EXISTS (
                SELECT 1
                FROM session_turn_event
                WHERE session_turn_event.session_id = sessions.id
                  AND (
                    contains(lower(session_turn_event.event_name), lower($query${index}))
                    OR contains(lower(CAST(session_turn_event.payload AS VARCHAR)), lower($query${index}))
                  )
              )
            )`);
    const searchSql = termPredicates.length > 0 ? `AND (${termPredicates.join(" OR ")})` : "";
    const projectSql = projectCwd !== null ? "AND sessions.cwd = $cwd" : "";
    const matchCount = (expressionForTerm: (index: number) => string) =>
      searchTerms.length > 0
        ? searchTerms.map((_, index) => `CASE WHEN ${expressionForTerm(index)} THEN 1 ELSE 0 END`).join(" + ")
        : "0";
    const keywordMatchCount = matchCount(
      (index) => `contains(lower(CAST(sessions.keyword_weights AS VARCHAR)), lower($query${index}))`
    );
    const titleMatchCount = matchCount(
      (index) => `contains(lower(sessions.title), lower($query${index}))`
    );
    const userPromptMatchCount = matchCount(
      (index) => `EXISTS (
        SELECT 1
        FROM session_turn AS prompt_turn
        WHERE prompt_turn.session_id = sessions.id
          AND contains(lower(prompt_turn.user_input), lower($query${index}))
      )`
    );
    const agentTextMatchCount = matchCount(
      (index) => `EXISTS (
        SELECT 1
        FROM session_turn AS agent_turn
        WHERE agent_turn.session_id = sessions.id
          AND contains(lower(agent_turn.agent_response), lower($query${index}))
      )`
    );
    const matchedTurnUserPredicate = searchTerms
      .map((_, index) => `contains(lower(matched_turn.user_input), lower($query${index}))`)
      .join(" OR ");
    const matchedTurnPredicate = searchTerms
      .map(
        (_, index) => `(contains(lower(matched_turn.user_input), lower($query${index})) OR contains(lower(matched_turn.agent_response), lower($query${index})))`
      )
      .join(" OR ");
    const matchedTurnSql = searchTerms.length > 0
      ? `(
          SELECT CASE
            WHEN (${matchedTurnUserPredicate}) THEN matched_turn.user_input
            ELSE matched_turn.agent_response
          END
          FROM session_turn AS matched_turn
          WHERE matched_turn.session_id = sessions.id
            AND (${matchedTurnPredicate})
          ORDER BY matched_turn.created DESC, matched_turn.id DESC
          LIMIT 1
        ) AS matched_turn`
      : "NULL AS matched_turn";
    const otherMatchCount = matchCount(
      (index) => `(
        contains(lower(sessions.id), lower($query${index}))
        OR contains(lower(sessions.cwd), lower($query${index}))
        OR contains(lower(sessions.description), lower($query${index}))
        OR EXISTS (
          SELECT 1
          FROM session_turn_event AS other_event
          WHERE other_event.session_id = sessions.id
            AND (
              contains(lower(other_event.event_name), lower($query${index}))
              OR contains(lower(CAST(other_event.payload AS VARCHAR)), lower($query${index}))
            )
        )
      )`
    );
    const relevanceSql = termPredicates.length > 0
      ? `${keywordMatchCount} DESC, ${titleMatchCount} DESC, ${userPromptMatchCount} DESC, ${agentTextMatchCount} DESC, ${otherMatchCount} DESC, updated DESC,`
      : "updated DESC,";
    return this.read(async (connection) => {
      const result = await connection.run(
        `
          SELECT
            id,
            thread_id,
            workspace_id,
            cwd,
            account_id,
            CAST(keyword_weights AS VARCHAR) AS keyword_weights,
            title,
            title_source,
            description,
            parent_session_id,
            forked_from_turn_id,
            CAST(achieved_at AS VARCHAR) AS achieved_at,
            CAST(created AS VARCHAR) AS created,
            CAST(updated AS VARCHAR) AS updated,
            (SELECT count(*) FROM session_turn WHERE session_turn.session_id = sessions.id) AS turn_count,
            COALESCE((SELECT CAST(sum(token_in + token_out) AS BIGINT) FROM session_turn WHERE session_turn.session_id = sessions.id), 0) AS token_count,
            CAST(COALESCE((
              SELECT json_agg(
                json_build_object(
                  'model', session_model_usage.model,
                  'tokenCount', session_model_usage.token_count,
                  'inputTokenCount', session_model_usage.input_token_count,
                  'cachedInputTokenCount', session_model_usage.cached_input_token_count,
                  'outputTokenCount', session_model_usage.output_token_count
                )
                ORDER BY session_model_usage.token_count DESC, session_model_usage.model ASC
              )
              FROM (
                SELECT
                  COALESCE(NULLIF(agent_usage.model, ''), 'Unknown') AS model,
                  CAST(sum(session_turn.token_in + session_turn.token_out) AS BIGINT) AS token_count,
                  CAST(sum(session_turn.token_in) AS BIGINT) AS input_token_count,
                  CAST(sum(coalesce((
                    SELECT coalesce(
                      max(cached_usage.cached_input_tokens) FILTER (WHERE cached_usage.source = 'app_server'),
                      max(cached_usage.cached_input_tokens) FILTER (WHERE cached_usage.source = 'codex_exec'),
                      max(cached_usage.cached_input_tokens) FILTER (WHERE cached_usage.source = 'native_token_count'),
                      max(cached_usage.cached_input_tokens) FILTER (WHERE cached_usage.source = 'turn_final'),
                      max(cached_usage.cached_input_tokens),
                      0
                    )
                    FROM token_usage AS cached_usage
                    WHERE cached_usage.turn_id = session_turn.id
                      AND cached_usage.usage_type = 'agent'
                  ), 0)) AS BIGINT) AS cached_input_token_count,
                  CAST(sum(session_turn.token_out) AS BIGINT) AS output_token_count
                FROM session_turn
                LEFT JOIN token_usage AS agent_usage ON agent_usage.id = 'agent:turn:' || session_turn.id
                WHERE session_turn.session_id = sessions.id
                GROUP BY COALESCE(NULLIF(agent_usage.model, ''), 'Unknown')
              ) AS session_model_usage
            ), '[]'::json) AS VARCHAR) AS model_token_usage,
            ${matchedTurnSql}
          FROM sessions
          WHERE workspace_id = $workspaceId
            AND achieved_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM workspace_manager_archive a WHERE a.session_id = sessions.id)
            ${projectSql}
            ${searchSql}
            AND NOT ${emptyNativeSessionAliasSql}
          ORDER BY ${relevanceSql} created DESC, id DESC
          LIMIT $limitPlusOne OFFSET $offset
        `,
        {
          workspaceId,
          ...(projectCwd !== null ? { cwd: projectCwd } : {}),
          offset: pageOffset,
          limitPlusOne: pageLimit + 1,
          ...Object.fromEntries(searchTerms.map((term, index) => [`query${index}`, term]))
        }
      );
      const totalResult = await connection.run(
        `
          SELECT count(*) AS total
          FROM sessions
          WHERE workspace_id = $workspaceId
            AND achieved_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM workspace_manager_archive a WHERE a.session_id = sessions.id)
            ${projectSql}
            ${searchSql}
            AND NOT ${emptyNativeSessionAliasSql}
        `,
        {
          workspaceId,
          ...(projectCwd !== null ? { cwd: projectCwd } : {}),
          ...Object.fromEntries(searchTerms.map((term, index) => [`query${index}`, term]))
        }
      );
      const records = (await result.getRowObjectsJS()).map(toSessionRecord);
      return {
        sessions: records.slice(0, pageLimit),
        hasMore: records.length > pageLimit,
        total: numberValue((await totalResult.getRowObjectsJS())[0]?.total),
        nextOffset: records.length > pageLimit ? pageOffset + records.slice(0, pageLimit).length : null
      };
    });
  }

  async listSessionsByProjectPage(workspaceId: string, limit = 20): Promise<SessionProjectsPage> {
    const pageLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const projects = await this.read(async (connection) => {
      const result = await connection.run(
        `
          SELECT cwd, max(updated) AS latest_updated
          FROM sessions
          WHERE workspace_id = $workspaceId
            AND achieved_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM workspace_manager_archive a WHERE a.session_id = sessions.id)
            AND NOT ${emptyNativeSessionAliasSql}
          GROUP BY cwd
          ORDER BY latest_updated DESC, cwd ASC
        `,
        { workspaceId }
      );
      return (await result.getRowObjectsJS()).map((row) => stringValue(row.cwd));
    });
    const pages: SessionProjectPage[] = [];
    for (const cwd of projects) {
      const page = await this.listSessionsPage(workspaceId, 0, pageLimit, null, cwd);
      pages.push({ cwd, offset: 0, limit: pageLimit, ...page });
    }
    return {
      sessions: pages.flatMap((page) => page.sessions),
      projects: pages
    };
  }

  async syncSessionTitles(_workspaceId: string, _titles: SessionTitleSyncInput[]): Promise<SessionTitleSyncResult[]> {
    return [];
  }

  async updateSessionTitle(input: {
    sessionId: string;
    threadId: string;
    title: string;
    source?: SessionTitleSource | "codex";
  }): Promise<void> {
    await this.write(async (connection) => {
      const session = await this.getSessionWithConnection(connection, input.sessionId);
      if (!session) {
        return;
      }
      const source = input.source === "user" || input.source === "summarizer" ? input.source : "initial";
      const canUpdateTitle = input.source !== "codex" && canUpdateSessionTitle(session.titleSource, source);
      await connection.run(
        `
          UPDATE sessions
          SET
            thread_id = $threadId,
            title = CASE WHEN $canUpdateTitle THEN $title ELSE title END,
            title_source = CASE WHEN $canUpdateTitle THEN $source ELSE title_source END
          WHERE id = $sessionId
            AND (
              thread_id IS DISTINCT FROM $threadId
              OR ($canUpdateTitle AND title IS DISTINCT FROM $title)
            )
        `,
        {
          ...input,
          source,
          canUpdateTitle
        }
      );
    });
  }

  async listPendingSessionTitleThreadIds(workspaceId: string): Promise<string[]> {
    return this.read(async (connection) => {
      const result = await connection.run(
        `
          SELECT DISTINCT thread_id
          FROM sessions
          WHERE workspace_id = $workspaceId
            AND thread_id IS NOT NULL
            AND starts_with(title, $prefix)
          ORDER BY thread_id
        `,
        { workspaceId, prefix: PENDING_CODEX_SESSION_TITLE_PREFIX }
      );
      return (await result.getRowObjectsJS())
        .map((row) => nullableString(row.thread_id))
        .filter((threadId): threadId is string => Boolean(threadId));
    });
  }

  async markUnsyncedSessionTitlesPending(_workspaceId: string, _syncedThreadIds: string[]): Promise<void> {
    return;
  }

  async listActiveSessionExecutionStatuses(workspaceId?: string | null): Promise<Record<string, ActiveSessionExecutionStatus>> {
    return this.read(async (connection) => {
      const result = workspaceId
        ? await connection.run(
            `
              SELECT DISTINCT session_turn.session_id
              FROM session_turn
              INNER JOIN sessions ON sessions.id = session_turn.session_id
              WHERE sessions.workspace_id = $workspaceId
                AND session_turn.status = 'running'
            `,
            { workspaceId }
          )
        : await connection.run(`
            SELECT DISTINCT session_id
            FROM session_turn
            WHERE status = 'running'
          `);
      const rows = await result.getRowObjectsJS();
      return Object.fromEntries(
        rows.flatMap((row) => {
          const sessionId = typeof row.session_id === "string" ? row.session_id : null;
          if (!sessionId) {
            return [];
          }
          return [[sessionId, "running"] as const];
        })
      );
    });
  }

  async listWorkspaceMonitorSessions(): Promise<WorkspaceMonitorSessionRecord[]> {
    return this.read(async (connection) => {
      const result = await connection.run(`
        SELECT
          sessions.workspace_id,
          sessions.id AS session_id,
          sessions.title AS session_name
        FROM sessions
        INNER JOIN (
          SELECT DISTINCT session_id
          FROM session_turn
          WHERE status = 'running'
        ) AS running_turn ON running_turn.session_id = sessions.id
        ORDER BY sessions.updated DESC, sessions.id ASC
      `);
      return (await result.getRowObjectsJS()).flatMap((row) => {
        const workspaceId = typeof row.workspace_id === "string" ? row.workspace_id : null;
        const sessionId = typeof row.session_id === "string" ? row.session_id : null;
        const sessionName = typeof row.session_name === "string" ? row.session_name : null;
        if (!workspaceId || !sessionId || !sessionName) {
          return [];
        }
        return [{
          workspaceId,
          sessionId,
          sessionName
        }];
      });
    });
  }

  async listProcessMonitors(workspaceId?: string | null): Promise<ProcessMonitorRecord[]> {
    return this.read(async (connection) => {
      const result = workspaceId
        ? await connection.run(
            `
              SELECT
                id,
                workspace_id,
                label,
                command,
                executable,
                docker_image,
                CAST(docker_run_args AS VARCHAR) AS docker_run_args_json,
                CAST(args AS VARCHAR) AS args_json,
                log_file,
                CAST(entry_points AS VARCHAR) AS entry_points_json,
                CAST(metric_monitors AS VARCHAR) AS metric_monitors_json,
                CAST(metric_readings AS VARCHAR) AS metric_readings_json,
                entry_point,
                cwd,
                pid,
                status,
                source_command_id,
                CAST(parameters AS VARCHAR) AS parameters_json,
                CAST(parameter_values AS VARCHAR) AS parameter_values_json,
                managed,
                remove_on_exit,
                wake_prompt,
                wake_session_id,
                wake_thread_id,
                CAST(timeout_at AS VARCHAR) AS timeout_at,
                wake_status,
                wake_error,
                CAST(woken_at AS VARCHAR) AS woken_at,
                CAST(started_at AS VARCHAR) AS started_at,
                last_exit_code,
                last_signal,
                error,
                CAST(created AS VARCHAR) AS created,
                CAST(updated AS VARCHAR) AS updated
              FROM process_monitor
              WHERE workspace_id = $workspaceId
              ORDER BY updated DESC, created DESC, id ASC
            `,
            { workspaceId }
          )
        : await connection.run(`
            SELECT
              id,
              workspace_id,
              label,
              command,
              executable,
              docker_image,
              CAST(docker_run_args AS VARCHAR) AS docker_run_args_json,
              CAST(args AS VARCHAR) AS args_json,
              log_file,
              CAST(entry_points AS VARCHAR) AS entry_points_json,
              CAST(metric_monitors AS VARCHAR) AS metric_monitors_json,
              CAST(metric_readings AS VARCHAR) AS metric_readings_json,
              entry_point,
              cwd,
              pid,
              status,
              source_command_id,
              CAST(parameters AS VARCHAR) AS parameters_json,
              CAST(parameter_values AS VARCHAR) AS parameter_values_json,
              managed,
              remove_on_exit,
              wake_prompt,
              wake_session_id,
              wake_thread_id,
              CAST(timeout_at AS VARCHAR) AS timeout_at,
              wake_status,
              wake_error,
              CAST(woken_at AS VARCHAR) AS woken_at,
              CAST(started_at AS VARCHAR) AS started_at,
              last_exit_code,
              last_signal,
              error,
              CAST(created AS VARCHAR) AS created,
              CAST(updated AS VARCHAR) AS updated
            FROM process_monitor
            ORDER BY updated DESC, created DESC, id ASC
          `);
      return (await result.getRowObjectsJS()).map((row) => toProcessMonitorRecord(row as ProcessMonitorRow));
    });
  }

  async getProcessMonitor(id: string): Promise<ProcessMonitorRecord | null> {
    const records = await this.listProcessMonitors();
    return records.find((record) => record.id === id) ?? null;
  }

  async createProcessMonitor(input: CreateProcessMonitorInput): Promise<ProcessMonitorRecord> {
    return this.write(async (connection) => {
      const id = input.id ?? `monitor_${crypto.randomUUID()}`;
      await connection.run(
        `
          INSERT INTO process_monitor (
            id, workspace_id, label, command, executable, docker_image, docker_run_args, args, log_file, entry_points, metric_monitors, metric_readings, cwd, pid, status, source_command_id, parameters, parameter_values, managed, remove_on_exit,
            wake_prompt, wake_session_id, wake_thread_id, timeout_at,
            wake_status, wake_error, woken_at, started_at, last_exit_code, last_signal, error, created, updated
          ) VALUES (
            $id, $workspaceId, $label, $command, $executable, $dockerImage, $dockerRunArgs::JSON, $args::JSON, $logFile, $entryPoints::JSON, $metricMonitors::JSON, $metricReadings::JSON, $cwd, $pid, $status, $sourceCommandId, $parameters::JSON, $parameterValues::JSON, $managed, $removeOnExit,
            $wakePrompt, $wakeSessionId, $wakeThreadId, $timeoutAt,
            $wakeStatus, $wakeError, $wokenAt, $startedAt, $lastExitCode, $lastSignal, $error, now(), now()
          )
        `,
        {
          id,
          workspaceId: input.workspaceId,
          label: input.label,
          command: input.command ?? null,
          executable: input.executable ?? null,
          dockerImage: input.dockerImage ?? null,
          dockerRunArgs: JSON.stringify(input.dockerRunArgs ?? []),
          args: JSON.stringify(input.args ?? []),
          logFile: input.logFile ?? null,
          entryPoints: JSON.stringify(input.entryPoints ?? []),
          metricMonitors: JSON.stringify(input.metricMonitors ?? []),
          metricReadings: JSON.stringify(input.metricReadings ?? []),
          cwd: input.cwd,
          pid: input.pid ?? null,
          status: input.status ?? "starting",
          sourceCommandId: input.sourceCommandId ?? null,
          parameters: JSON.stringify(input.parameters ?? []),
          parameterValues: JSON.stringify(input.parameterValues ?? {}),
          managed: input.managed ?? false,
          removeOnExit: input.removeOnExit ?? false,
          wakePrompt: input.wakePrompt ?? null,
          wakeSessionId: input.wakeSessionId ?? null,
          wakeThreadId: input.wakeThreadId ?? null,
          timeoutAt: input.timeoutAt ?? null,
          wakeStatus: input.wakeStatus ?? "none",
          wakeError: input.wakeError ?? null,
          wokenAt: input.wokenAt ?? null,
          startedAt: input.startedAt ?? null,
          lastExitCode: input.lastExitCode ?? null,
          lastSignal: input.lastSignal ?? null,
          error: input.error ?? null
        }
      );
      const result = await connection.run(
        `
          SELECT
            id,
            workspace_id,
            label,
            command,
            executable,
            docker_image,
            CAST(docker_run_args AS VARCHAR) AS docker_run_args_json,
            CAST(args AS VARCHAR) AS args_json,
            log_file,
            CAST(entry_points AS VARCHAR) AS entry_points_json,
            CAST(metric_monitors AS VARCHAR) AS metric_monitors_json,
            CAST(metric_readings AS VARCHAR) AS metric_readings_json,
            entry_point,
            cwd,
            pid,
            status,
            source_command_id,
            CAST(parameters AS VARCHAR) AS parameters_json,
            CAST(parameter_values AS VARCHAR) AS parameter_values_json,
            managed,
            remove_on_exit,
            wake_prompt,
            wake_session_id,
            wake_thread_id,
            CAST(timeout_at AS VARCHAR) AS timeout_at,
            wake_status,
            wake_error,
            CAST(woken_at AS VARCHAR) AS woken_at,
            CAST(started_at AS VARCHAR) AS started_at,
            last_exit_code,
            last_signal,
            error,
            CAST(created AS VARCHAR) AS created,
            CAST(updated AS VARCHAR) AS updated
          FROM process_monitor
          WHERE id = $id
        `,
        { id }
      );
      const row = (await result.getRowObjectsJS())[0];
      if (!row) throw new Error("Failed to create process monitor.");
      return toProcessMonitorRecord(row as ProcessMonitorRow);
    });
  }

  async updateProcessMonitor(input: UpdateProcessMonitorInput): Promise<ProcessMonitorRecord | null> {
    return this.write(async (connection) => {
      const assignments: string[] = [];
      const params: Record<string, SessionDbValue> = { id: input.id };
      const fields: Array<[keyof UpdateProcessMonitorInput, string]> = [
        ["label", "label"],
        ["command", "command"],
        ["executable", "executable"],
        ["dockerImage", "docker_image"],
        ["dockerRunArgs", "docker_run_args"],
        ["args", "args"],
        ["logFile", "log_file"],
        ["entryPoints", "entry_points"],
        ["metricMonitors", "metric_monitors"],
        ["metricReadings", "metric_readings"],
        ["cwd", "cwd"],
        ["pid", "pid"],
        ["status", "status"],
        ["sourceCommandId", "source_command_id"],
        ["parameters", "parameters"],
        ["parameterValues", "parameter_values"],
        ["managed", "managed"],
        ["removeOnExit", "remove_on_exit"],
        ["wakePrompt", "wake_prompt"],
        ["wakeSessionId", "wake_session_id"],
        ["wakeThreadId", "wake_thread_id"],
        ["timeoutAt", "timeout_at"],
        ["wakeStatus", "wake_status"],
        ["wakeError", "wake_error"],
        ["wokenAt", "woken_at"],
        ["startedAt", "started_at"],
        ["lastExitCode", "last_exit_code"],
        ["lastSignal", "last_signal"],
        ["error", "error"]
      ];
      for (const [inputKey, column] of fields) {
        if (inputKey in input) {
          const parameter = `value_${String(inputKey)}`;
          const isJson = inputKey === "args" || inputKey === "entryPoints" || inputKey === "dockerRunArgs" || inputKey === "metricMonitors" || inputKey === "metricReadings" || inputKey === "parameters" || inputKey === "parameterValues";
          assignments.push(`${column} = $${parameter}${isJson ? "::JSON" : ""}`);
          params[parameter] = (isJson ? JSON.stringify(input[inputKey] ?? (inputKey === "parameterValues" ? {} : [])) : input[inputKey]) as SessionDbValue;
        }
      }
      if ("entryPoints" in input) {
        assignments.push("entry_point = NULL");
      }
      if (assignments.length > 0) {
        assignments.push("updated = now()");
        await connection.run(
          `UPDATE process_monitor SET ${assignments.join(", ")} WHERE id = $id`,
          params
        );
      }
      const result = await connection.run(
        `
          SELECT
            id,
            workspace_id,
            label,
            command,
            executable,
            docker_image,
            CAST(docker_run_args AS VARCHAR) AS docker_run_args_json,
            CAST(args AS VARCHAR) AS args_json,
            log_file,
            CAST(entry_points AS VARCHAR) AS entry_points_json,
            CAST(metric_monitors AS VARCHAR) AS metric_monitors_json,
            CAST(metric_readings AS VARCHAR) AS metric_readings_json,
            entry_point,
            cwd,
            pid,
            status,
            source_command_id,
            CAST(parameters AS VARCHAR) AS parameters_json,
            CAST(parameter_values AS VARCHAR) AS parameter_values_json,
            managed,
            remove_on_exit,
            wake_prompt,
            wake_session_id,
            wake_thread_id,
            CAST(timeout_at AS VARCHAR) AS timeout_at,
            wake_status,
            wake_error,
            CAST(woken_at AS VARCHAR) AS woken_at,
            CAST(started_at AS VARCHAR) AS started_at,
            last_exit_code,
            last_signal,
            error,
            CAST(created AS VARCHAR) AS created,
            CAST(updated AS VARCHAR) AS updated
          FROM process_monitor
          WHERE id = $id
        `,
        { id: input.id }
      );
      const row = (await result.getRowObjectsJS())[0];
      return row ? toProcessMonitorRecord(row as ProcessMonitorRow) : null;
    });
  }

  async deleteProcessMonitor(id: string): Promise<boolean> {
    return this.write(async (connection) => {
      const result = await connection.run("DELETE FROM process_monitor WHERE id = $id", { id });
      return result.rowCount > 0;
    });
  }

  async getSessionTodo(sessionId: string): Promise<SessionTodoSnapshot> {
    const snapshot = await this.read((connection) => this.getSessionTodoWithConnection(connection, sessionId));
    return { ...snapshot, lightweight: await this.getOutcomePlan(sessionId) };
  }

  async getOutcomePlan(sessionId: string): Promise<LightweightTodo | null> {
    return this.read(async (connection) => {
      const result = await connection.run("SELECT document FROM session_outcome_plan WHERE session_id = $sessionId", { sessionId });
      const row = (await result.getRowObjectsJS())[0];
      return row ? JSON.parse(String(row.document)) as LightweightTodo : null;
    });
  }

  async getTurnGrill(sessionId: string, turnId: string): Promise<TurnGrill | null> {
    return this.read(async (connection) => {
      const result = await connection.run("SELECT document FROM session_turn_grill WHERE session_id = $sessionId AND turn_id = $turnId", { sessionId, turnId });
      const row = (await result.getRowObjectsJS())[0];
      return row ? JSON.parse(String(row.document)) as TurnGrill : null;
    });
  }

  async listGrilledTurnIds(sessionId: string): Promise<string[]> {
    return this.read(async (connection) => {
      const result = await connection.run("SELECT turn_id FROM session_turn_grill WHERE session_id = $sessionId", { sessionId });
      return (await result.getRowObjectsJS()).map((row) => String(row.turn_id));
    });
  }

  async listGrillSummaries(workspaceId: string): Promise<GrillSummary[]> {
    return this.read(async (connection) => {
      // Parse in JavaScript: PostgreSQL JSON extraction rejects escaped NULs
      // in model-authored content, even when extracting unrelated fields.
      const result = await connection.run(`SELECT g.session_id, g.turn_id, g.revision, g.document
        FROM session_turn_grill g JOIN sessions s ON s.id = g.session_id WHERE s.workspace_id = $workspaceId ORDER BY g.session_id, g.turn_id`, { workspaceId });
      return (await result.getRowObjectsJS()).map((row) => ({ sessionId: String(row.session_id), turnId: String(row.turn_id), revision: Number(row.revision), pending: grillAwaitingAck(JSON.parse(String(row.document)) as TurnGrill) }));
    });
  }

  async acknowledgeTurnGrill(sessionId: string, turnId: string, observed: number, workTurnId?: string): Promise<TurnGrill> {
    return this.transaction(async (connection) => {
      const result = await connection.run("SELECT document FROM session_turn_grill WHERE session_id = $sessionId AND turn_id = $turnId FOR UPDATE", { sessionId, turnId });
      const row = (await result.getRowObjectsJS())[0];
      if (!row) throw new Error("Grill not found.");
      const saved = JSON.parse(String(row.document)) as TurnGrill;
      const next = acknowledgeGrill(saved, observed);
      if (workTurnId) {
        const work = await this.getSessionTurnWithConnection(connection, workTurnId);
        if (!work || work.sessionId !== sessionId || work.id === turnId || !["running", "todo"].includes(work.status)) throw new Error("Invalid Grill work turn.");
        next.workTurns = { ...saved.workTurns, [workTurnId]: saved.workTurns?.[workTurnId] ?? "pending" };
      }
      next.revision = saved.revision + 1;
      await connection.run("UPDATE session_turn_grill SET revision = $revision, document = $document WHERE session_id = $sessionId AND turn_id = $turnId", { sessionId, turnId, revision: next.revision, document: JSON.stringify(next) });
      return next;
    });
  }

  async saveTurnGrill(sessionId: string, turnId: string, expectedRevision: number, document: TurnGrill): Promise<boolean> {
    return this.write(async (connection) => {
      const params = { sessionId, turnId, revision: document.revision, document: JSON.stringify(document) };
      const result = expectedRevision === 0
        ? await connection.run(`INSERT INTO session_turn_grill (session_id, turn_id, revision, document)
            VALUES ($sessionId, $turnId, $revision, $document) ON CONFLICT (session_id, turn_id) DO NOTHING`, params)
        : await connection.run(`UPDATE session_turn_grill SET revision = $revision, document = $document
            WHERE session_id = $sessionId AND turn_id = $turnId AND revision = $expectedRevision`, { ...params, expectedRevision });
      return result.rowCount > 0;
    });
  }

  async saveOutcomePlan(sessionId: string, expectedRevision: number, plan: LightweightTodo): Promise<boolean> {
    return this.write(async (connection) => {
      await this.assertSessionExistsWithConnection(connection, sessionId);
      const params = { sessionId, revision: plan.revision, document: JSON.stringify(plan) };
      const result = expectedRevision === 0
        ? await connection.run(`INSERT INTO session_outcome_plan (session_id, revision, document)
            VALUES ($sessionId, $revision, $document) ON CONFLICT (session_id) DO NOTHING`, params)
        : await connection.run(`UPDATE session_outcome_plan SET revision = $revision, document = $document
            WHERE session_id = $sessionId AND revision = $expectedRevision`, { ...params, expectedRevision });
      return result.rowCount > 0;
    });
  }

  async upsertTodoItem(input: UpsertTodoItemInput): Promise<SessionTodoSnapshot> {
    return this.write(async (connection) => {
      await this.assertSessionExistsWithConnection(connection, input.sessionId);
      const id = input.id ?? `todo_${crypto.randomUUID()}`;
      const actor = todoActorValue(input.actor);
      const position = Number.isFinite(input.position) ? Number(input.position) : await this.nextTodoPosition(connection, input.sessionId, input.parentId ?? null);
      const parent = input.parentId ? await this.getTodoItemWithConnection(connection, input.sessionId, input.parentId) : null;
      const section = input.section ?? parent?.section ?? null;
      await connection.run(
        `
          INSERT INTO session_todo_item (
            id, session_id, parent_id, title, details, context, section, status, position,
            created_by, updated_by, locked_by_turn_id, active_status, created, updated
          ) VALUES (
            $id, $sessionId, $parentId, $title, $details, $context, $section, $status, $position,
            $actor, $actor, $lockedByTurnId, $activeStatus, now(), now()
          )
          ON CONFLICT (id) DO UPDATE SET
            parent_id = excluded.parent_id,
            title = excluded.title,
            details = excluded.details,
            context = COALESCE(excluded.context, session_todo_item.context),
            section = excluded.section,
            status = excluded.status,
            position = excluded.position,
            updated_by = excluded.updated_by,
            locked_by_turn_id = excluded.locked_by_turn_id,
            active_status = excluded.active_status,
            updated = now()
        `,
        {
          id,
          sessionId: input.sessionId,
          parentId: input.parentId ?? null,
          title: input.title.trim(),
          details: input.details ?? "",
          context: input.context ?? "",
          section,
          status: todoItemStatusValue(input.status),
          position,
          actor,
          lockedByTurnId: input.status === "active" ? input.turnId ?? null : null,
          activeStatus: input.activeStatus ?? null
        }
      );
      return this.getSessionTodoWithConnection(connection, input.sessionId);
    });
  }

  async updateTodoItem(input: UpdateTodoItemInput): Promise<SessionTodoSnapshot> {
    return this.write(async (connection) => {
      const existing = await this.getTodoItemWithConnection(connection, input.sessionId, input.id);
      if (!existing) {
        throw new Error(`Todo item not found: ${input.id}`);
      }

      const actor = todoActorValue(input.actor);
      const requestedStatus = input.status ? todoItemStatusValue(input.status) : null;
      const userEditingLockedItem = actor === "user" && Boolean(existing.lockedByTurnId);
      const status = userEditingLockedItem ? "hold" : requestedStatus;
      const assignments = ["updated_by = $actor", "updated = now()"];
      const params: Record<string, SessionDbValue> = {
        id: input.id,
        sessionId: input.sessionId,
        actor
      };
      if (input.parentId !== undefined) {
        assignments.push("parent_id = $parentId");
        params.parentId = input.parentId;
      }
      if (input.title !== undefined && input.title !== null) {
        assignments.push("title = $title");
        params.title = input.title.trim();
      }
      if (input.details !== undefined && input.details !== null) {
        assignments.push("details = $details");
        params.details = input.details;
      }
      if (input.context !== undefined && input.context !== null) {
        assignments.push("context = $context");
        params.context = input.context;
      }
      if (input.section !== undefined) {
        assignments.push("section = $section");
        params.section = input.section;
      }
      if (input.position !== undefined && input.position !== null && Number.isFinite(input.position)) {
        assignments.push("position = $position");
        params.position = input.position;
      }
      if (status) {
        assignments.push("status = $status");
        params.status = status;
      }
      if (input.activeStatus !== undefined) {
        assignments.push("active_status = $activeStatus");
        params.activeStatus = input.activeStatus ?? null;
      }
      if (input.childSessionId !== undefined) {
        assignments.push("child_session_id = $childSessionId");
        params.childSessionId = input.childSessionId ?? null;
      }
      if (input.childTurnId !== undefined) {
        assignments.push("child_turn_id = $childTurnId");
        params.childTurnId = input.childTurnId ?? null;
      }
      if (status === "active") {
        assignments.push("locked_by_turn_id = $lockedByTurnId");
        params.lockedByTurnId = input.turnId ?? existing.lockedByTurnId;
      } else if (status && status !== "hold") {
        assignments.push("locked_by_turn_id = NULL");
      }
      if (input.lockReason !== undefined || userEditingLockedItem) {
        assignments.push("lock_reason = $lockReason");
        params.lockReason = userEditingLockedItem
          ? "User edited this item while the agent was working on it."
          : input.lockReason ?? null;
      }

      await connection.run(
        `UPDATE session_todo_item SET ${assignments.join(", ")} WHERE id = $id AND session_id = $sessionId`,
        params
      );
      return this.getSessionTodoWithConnection(connection, input.sessionId);
    });
  }

  async linkTodoItemSession(input: {
    sessionId: string;
    itemId: string;
    childSessionId: string;
    childTurnId?: string | null;
    title?: string | null;
    role?: string | null;
  }): Promise<SessionTodoSnapshot> {
    return this.write(async (connection) => {
      await this.assertSessionExistsWithConnection(connection, input.sessionId);
      const item = await this.getTodoItemWithConnection(connection, input.sessionId, input.itemId);
      if (!item) {
        throw new Error(`Todo item not found: ${input.itemId}`);
      }
      const id = `${input.sessionId}:${input.itemId}:${input.childSessionId}:${input.childTurnId ?? ""}`;
      await connection.run(
        `
          INSERT INTO session_todo_item_session (
            id, session_id, item_id, child_session_id, child_turn_id, title, role, created, updated
          ) VALUES (
            $id, $sessionId, $itemId, $childSessionId, $childTurnId, $title, $role, now(), now()
          )
          ON CONFLICT (id) DO UPDATE SET
            title = excluded.title,
            role = excluded.role,
            updated = now()
        `,
        {
          id,
          sessionId: input.sessionId,
          itemId: input.itemId,
          childSessionId: input.childSessionId,
          childTurnId: input.childTurnId ?? null,
          title: input.title ?? "",
          role: input.role ?? "worker"
        }
      );
      return this.getSessionTodoWithConnection(connection, input.sessionId);
    });
  }

  async getTodoWorkerAssignment(childSessionId: string): Promise<TodoWorkerAssignment | null> {
    return this.read(async (connection) => {
      const result = await connection.run(
        `
          SELECT session_id, item_id
          FROM session_todo_item_session
          WHERE child_session_id = $childSessionId
            AND role = 'worker'
          ORDER BY created DESC, id DESC
          LIMIT 1
        `,
        { childSessionId }
      );
      const row = (await result.getRowObjectsJS())[0] as { session_id?: unknown; item_id?: unknown } | undefined;
      const parentSessionId = typeof row?.session_id === "string" ? row.session_id : null;
      const itemId = typeof row?.item_id === "string" ? row.item_id : null;
      return parentSessionId && itemId ? { parentSessionId, itemId } : null;
    });
  }

  async addTodoComment(input: AddTodoCommentInput): Promise<SessionTodoSnapshot> {
    return this.write(async (connection) => {
      await this.assertSessionExistsWithConnection(connection, input.sessionId);
      const id = input.id ?? `todo_comment_${crypto.randomUUID()}`;
      await connection.run(
        `
          INSERT INTO session_todo_comment (
            id, session_id, item_id, turn_id, type, author, body, created
          ) VALUES (
            $id, $sessionId, $itemId, $turnId, $type, $author, $body, now()
          )
        `,
        {
          id,
          sessionId: input.sessionId,
          itemId: input.itemId ?? null,
          turnId: input.turnId ?? null,
          type: todoCommentTypeValue(input.type),
          author: todoActorValue(input.author),
          body: input.body.trim()
        }
      );
      return this.getSessionTodoWithConnection(connection, input.sessionId);
    });
  }

  async addTodoMessage(input: AddTodoMessageInput): Promise<TodoMessageMutationResult> {
    return this.write(async (connection) => {
      await this.assertSessionExistsWithConnection(connection, input.sessionId);
      const item = await this.getTodoItemWithConnection(connection, input.sessionId, input.itemId);
      if (!item) {
        throw new Error(`Todo item not found: ${input.itemId}`);
      }
      const title = input.title.trim();
      if (!title) {
        throw new Error("Todo message title is required.");
      }
      const idResult = await connection.run(
        "SELECT coalesce(max(id), 0) + 1 AS next_id FROM session_todo_message WHERE session_id = $sessionId",
        { sessionId: input.sessionId }
      );
      const id = numberValue((await idResult.getRowObjectsJS())[0]?.next_id);
      const type = todoMessageTypeValue(input.type);
      await connection.run(
        `
          INSERT INTO session_todo_message (
            session_id, id, item_id, turn_id, type, author, title, body, created
          ) VALUES (
            $sessionId, $id, $itemId, $turnId, $type, $author, $title, $body, now()
          )
        `,
        {
          sessionId: input.sessionId,
          id,
          itemId: input.itemId,
          turnId: input.turnId ?? null,
          type,
          author: todoActorValue(input.author),
          title,
          body: input.body ?? ""
        }
      );
      const todo = await this.getSessionTodoWithConnection(connection, input.sessionId);
      const message = todo.messages.find((candidate) => candidate.id === id);
      if (!message) {
        throw new Error(`Todo message not found after insert: ${id}`);
      }
      return {
        ...todo,
        message,
        ...(type === "challenge" ? { challengeId: id } : {})
      };
    });
  }

  async resolveTodoChallenge(input: {
    sessionId: string;
    challengeId: number;
    actor?: TodoActor;
  }): Promise<TodoChallengeResolutionResult> {
    return this.write(async (connection) => {
      await this.assertSessionExistsWithConnection(connection, input.sessionId);
      const existingResult = await connection.run(
        `
          SELECT id, resolved_at
          FROM session_todo_message
          WHERE session_id = $sessionId AND id = $challengeId AND type = 'challenge'
        `,
        { sessionId: input.sessionId, challengeId: input.challengeId }
      );
      const existing = (await existingResult.getRowObjectsJS())[0];
      if (!existing) {
        throw new Error(`Todo challenge not found: ${input.challengeId}`);
      }
      if (!nullableString(existing.resolved_at)) {
        await connection.run(
          `
            UPDATE session_todo_message
            SET resolved_by = $actor, resolved_at = now()
            WHERE session_id = $sessionId AND id = $challengeId AND type = 'challenge'
          `,
          {
            sessionId: input.sessionId,
            challengeId: input.challengeId,
            actor: todoActorValue(input.actor)
          }
        );
      }
      const todo = await this.getSessionTodoWithConnection(connection, input.sessionId);
      return { ...todo, resolvedChallengeId: input.challengeId };
    });
  }

  async listUnresolvedTodoChallenges(sessionId: string): Promise<TodoMessageRecord[]> {
    return this.read(async (connection) => {
      await this.assertSessionExistsWithConnection(connection, sessionId);
      const result = await connection.run(
        `
          SELECT
            id,
            session_id,
            item_id,
            turn_id,
            type,
            author,
            title,
            body,
            resolved_by,
            CAST(resolved_at AS VARCHAR) AS resolved_at,
            CAST(created AS VARCHAR) AS created
          FROM session_todo_message
          WHERE session_id = $sessionId AND type = 'challenge' AND resolved_at IS NULL
          ORDER BY id ASC
        `,
        { sessionId }
      );
      return (await result.getRowObjectsJS()).map((row) => toTodoMessageRecord(row as TodoMessageRow));
    });
  }

  async setTodoControl(input: {
    sessionId: string;
    paused?: boolean;
    pauseReason?: string | null;
    actor?: TodoActor;
    context?: string | null;
    problem?: string | null;
    objective?: string | null;
  }): Promise<SessionTodoSnapshot> {
    return this.write(async (connection) => {
      await this.assertSessionExistsWithConnection(connection, input.sessionId);
      await connection.run(
        `
          INSERT INTO session_todo_control (session_id, paused, pause_reason, paused_by, context, problem, objective, updated)
          VALUES ($sessionId, $paused, $pauseReason, $actor, COALESCE($context, ''), COALESCE($problem, ''), COALESCE($objective, ''), now())
          ON CONFLICT (session_id) DO UPDATE SET
            paused = excluded.paused,
            pause_reason = excluded.pause_reason,
            paused_by = excluded.paused_by,
            context = CASE WHEN $contextProvided THEN excluded.context ELSE session_todo_control.context END,
            problem = CASE WHEN $problemProvided THEN excluded.problem ELSE session_todo_control.problem END,
            objective = CASE WHEN $objectiveProvided THEN excluded.objective ELSE session_todo_control.objective END,
            updated = now()
        `,
        {
          sessionId: input.sessionId,
          paused: input.paused === true,
          pauseReason: input.pauseReason ?? null,
          actor: input.paused === true ? todoActorValue(input.actor) : null,
          context: input.context ?? "",
          contextProvided: input.context !== undefined && input.context !== null,
          problem: input.problem ?? "",
          problemProvided: input.problem !== undefined && input.problem !== null,
          objective: input.objective ?? "",
          objectiveProvided: input.objective !== undefined && input.objective !== null
        }
      );
      return this.getSessionTodoWithConnection(connection, input.sessionId);
    });
  }

  async setTodoItemsForChildTurns(input: {
    sessionId: string;
    turnIds: string[];
    status: "active" | "paused";
    actor?: TodoActor;
  }): Promise<SessionTodoSnapshot> {
    return this.write(async (connection) => {
      await this.assertSessionExistsWithConnection(connection, input.sessionId);
      const turnIds = [...new Set(input.turnIds.filter(Boolean))];
      if (turnIds.length === 0) return this.getSessionTodoWithConnection(connection, input.sessionId);
      const params: Record<string, SessionDbValue> = {
        sessionId: input.sessionId,
        status: input.status,
        actor: todoActorValue(input.actor),
        activeStatus: input.status === "paused" ? "Paused by plan control." : "Resumed by plan control."
      };
      const placeholders = turnIds.map((turnId, index) => {
        const key = `turnId${index}`;
        params[key] = turnId;
        return `$${key}`;
      });
      await connection.run(
        `
          UPDATE session_todo_item
          SET status = $status,
              updated_by = $actor,
              active_status = $activeStatus,
              locked_by_turn_id = CASE WHEN $status = 'active' THEN child_turn_id ELSE locked_by_turn_id END,
              updated = now()
          WHERE session_id = $sessionId AND child_turn_id IN (${placeholders.join(", ")})
        `,
        params
      );
      return this.getSessionTodoWithConnection(connection, input.sessionId);
    });
  }

  async getTodoRunnerControl(input: {
    sessionId: string;
    turnId: string;
    itemId?: string | null;
  }): Promise<{ pause: boolean; reason: string; item?: TodoItemRecord | null; control: TodoControlRecord }> {
    return this.read(async (connection) => {
      const snapshot = await this.getSessionTodoWithConnection(connection, input.sessionId);
      if (snapshot.control.paused) {
        return {
          pause: true,
          reason: snapshot.control.pauseReason || "Todo plan is paused by the user.",
          control: snapshot.control
        };
      }
      const item = input.itemId
        ? snapshot.items.find((candidate) => candidate.id === input.itemId) ?? null
        : snapshot.items.find((candidate) => candidate.lockedByTurnId === input.turnId) ?? null;
      if (item && (item.status === "hold" || item.status === "paused")) {
        return {
          pause: true,
          reason: item.lockReason || `Todo item is ${item.status}.`,
          item,
          control: snapshot.control
        };
      }
      return { pause: false, reason: "", item, control: snapshot.control };
    });
  }

  async ensureWaitEvent(input: CreateWaitEventInput): Promise<WaitEventRecord> {
    return this.write(async (connection) => {
      const existingResult = await connection.run(
        `
          SELECT id, workspace_id, topic, subject_key, status,
            CAST(expected_at AS VARCHAR) AS expected_at,
            CAST(payload AS VARCHAR) AS payload_json,
            CAST(fired_at AS VARCHAR) AS fired_at,
            CAST(created AS VARCHAR) AS created,
            CAST(updated AS VARCHAR) AS updated
          FROM wait_event
          WHERE workspace_id = $workspaceId AND topic = $topic AND subject_key = $subjectKey
          LIMIT 1
        `,
        { workspaceId: input.workspaceId, topic: input.topic, subjectKey: input.subjectKey }
      );
      const existing = (await existingResult.getRowObjectsJS())[0];
      if (existing) {
        const record = toWaitEventRecord(existing as WaitEventRow);
        if (record.status === "pending") {
          await connection.run(
            `UPDATE wait_event
             SET expected_at = $expectedAt, payload = $payload::JSON, updated = now()
             WHERE id = $id`,
            {
              id: record.id,
              expectedAt: input.expectedAt ?? null,
              payload: JSON.stringify(input.payload ?? null)
            }
          );
          const refreshed = await this.getWaitEventWithConnection(connection, record.id);
          return refreshed ?? record;
        }
        return record;
      }

      const id = input.id ?? `wait_event_${crypto.randomUUID()}`;
      await connection.run(
        `
          INSERT INTO wait_event (
            id, workspace_id, topic, subject_key, status, expected_at, payload, created, updated
          ) VALUES (
            $id, $workspaceId, $topic, $subjectKey, 'pending', $expectedAt, $payload::JSON, now(), now()
          )
        `,
        {
          id,
          workspaceId: input.workspaceId,
          topic: input.topic,
          subjectKey: input.subjectKey,
          expectedAt: input.expectedAt ?? null,
          payload: JSON.stringify(input.payload ?? null)
        }
      );
      const record = await this.getWaitEventWithConnection(connection, id);
      if (!record) throw new Error("Failed to create wait event.");
      return record;
    });
  }

  async getWaitEvent(id: string): Promise<WaitEventRecord | null> {
    return this.read((connection) => this.getWaitEventWithConnection(connection, id));
  }

  async listWaitEvents(input: { workspaceId?: string | null; status?: WaitEventStatus | null; activeSubscriptionsOnly?: boolean } = {}): Promise<WaitEventRecord[]> {
    return this.read(async (connection) => {
      const conditions: string[] = [];
      const params: Record<string, SessionDbValue> = {};
      if (input.workspaceId) {
        conditions.push("workspace_id = $workspaceId");
        params.workspaceId = input.workspaceId;
      }
      if (input.status) {
        conditions.push("status = $status");
        params.status = input.status;
      }
      if (input.activeSubscriptionsOnly) {
        conditions.push(`EXISTS (
          SELECT 1 FROM wait_subscription
          WHERE wait_subscription.event_id = wait_event.id
            AND wait_subscription.workspace_id = wait_event.workspace_id
            AND wait_subscription.status IN ('waiting', 'dispatching', 'error')
        )`);
      }
      const result = await connection.run(
        `
          SELECT id, workspace_id, topic, subject_key, status,
            CAST(expected_at AS VARCHAR) AS expected_at,
            CAST(payload AS VARCHAR) AS payload_json,
            CAST(fired_at AS VARCHAR) AS fired_at,
            CAST(created AS VARCHAR) AS created,
            CAST(updated AS VARCHAR) AS updated
          FROM wait_event
          ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY created ASC, id ASC
        `,
        params
      );
      return (await result.getRowObjectsJS()).map((row) => toWaitEventRecord(row as WaitEventRow));
    });
  }

  async fireWaitEvent(id: string, payload: unknown): Promise<WaitEventRecord | null> {
    return this.write(async (connection) => {
      await connection.run(
        `
          UPDATE wait_event
          SET status = 'fired', payload = $payload::JSON, fired_at = COALESCE(fired_at, now()), updated = now()
          WHERE id = $id AND status = 'pending'
        `,
        { id, payload: JSON.stringify(payload ?? null) }
      );
      return this.getWaitEventWithConnection(connection, id);
    });
  }

  async cancelWaitEvent(id: string): Promise<WaitEventRecord | null> {
    return this.write(async (connection) => {
      await connection.run(
        `UPDATE wait_event SET status = 'cancelled', updated = now() WHERE id = $id AND status = 'pending'`,
        { id }
      );
      await connection.run(
        `
          UPDATE wait_subscription
          SET status = 'cancelled', updated = now()
          WHERE event_id = $id AND status IN ('waiting', 'dispatching', 'error')
        `,
        { id }
      );
      return this.getWaitEventWithConnection(connection, id);
    });
  }

  async createWaitSubscription(input: CreateWaitSubscriptionInput): Promise<WaitSubscriptionRecord> {
    return this.write(async (connection) => {
      const id = input.id ?? `wait_subscription_${crypto.randomUUID()}`;
      const existing = await this.getWaitSubscriptionWithConnection(connection, id);
      if (existing) return existing;
      const event = await this.getWaitEventWithConnection(connection, input.eventId);
      if (event?.topic === "process.exited" && input.actionType === "enqueue_prompt") {
        const duplicates = await connection.run(
          `SELECT id FROM wait_subscription WHERE event_id = $eventId AND session_id = $sessionId
           AND action_type = 'enqueue_prompt' AND status <> 'cancelled' ORDER BY created, id LIMIT 1`,
          { eventId: input.eventId, sessionId: input.sessionId }
        );
        const duplicate = (await duplicates.getRowObjectsJS())[0];
        if (duplicate) return (await this.getWaitSubscriptionWithConnection(connection, String(duplicate.id)))!;
      }
      await connection.run(
        `
          INSERT INTO wait_subscription (
            id, event_id, workspace_id, session_id, turn_id, action_type, action_payload,
            status, attempts, created, updated
          ) VALUES (
            $id, $eventId, $workspaceId, $sessionId, $turnId, $actionType, $actionPayload::JSON,
            'waiting', 0, now(), now()
          )
        `,
        {
          id,
          eventId: input.eventId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId ?? null,
          actionType: input.actionType,
          actionPayload: JSON.stringify(input.actionPayload ?? null)
        }
      );
      const record = await this.getWaitSubscriptionWithConnection(connection, id);
      if (!record) throw new Error("Failed to create wait subscription.");
      return record;
    });
  }

  async listWaitSubscriptions(input: {
    workspaceId?: string | null;
    eventId?: string | null;
    sessionId?: string | null;
    status?: WaitSubscriptionStatus | null;
    activeOnly?: boolean;
  } = {}): Promise<WaitSubscriptionRecord[]> {
    return this.read(async (connection) => {
      const conditions: string[] = [];
      const params: Record<string, SessionDbValue> = {};
      for (const [key, column] of [
        ["workspaceId", "workspace_id"],
        ["eventId", "event_id"],
        ["sessionId", "session_id"],
        ["status", "status"]
      ] as const) {
        const value = input[key];
        if (value) {
          conditions.push(`${column} = $${key}`);
          params[key] = value;
        }
      }
      if (input.activeOnly) {
        conditions.push("status IN ('waiting', 'dispatching', 'error')");
      }
      const result = await connection.run(
        `
          SELECT id, event_id, workspace_id, session_id, turn_id, action_type,
            CAST(action_payload AS VARCHAR) AS action_payload_json,
            status, attempts, error,
            CAST(delivered_at AS VARCHAR) AS delivered_at,
            CAST(created AS VARCHAR) AS created,
            CAST(updated AS VARCHAR) AS updated
          FROM wait_subscription
          ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY created ASC, id ASC
        `,
        params
      );
      return (await result.getRowObjectsJS()).map((row) => toWaitSubscriptionRecord(row as WaitSubscriptionRow));
    });
  }

  async getWaitSubscription(id: string): Promise<WaitSubscriptionRecord | null> {
    return this.read(async (connection) => this.getWaitSubscriptionWithConnection(connection, id));
  }

  async updateWaitSubscriptionPrompt(id: string, prompt: string): Promise<WaitSubscriptionRecord> {
    return this.write(async (connection) => {
      const existing = await this.getWaitSubscriptionWithConnection(connection, id);
      if (!existing) throw new Error(`Wait subscription not found: ${id}`);
      if (existing.status !== "waiting" && existing.status !== "error") {
        throw new Error("Only waiting or failed subscriptions can be edited.");
      }
      if (existing.actionType === "notify") {
        throw new Error("Notify-only subscriptions do not have an editable prompt.");
      }

      const currentPayload = isPlainObject(existing.actionPayload) ? existing.actionPayload : {};
      const actionPayload = existing.actionType === "enqueue_prompt"
        ? { ...currentPayload, message: prompt }
        : { ...currentPayload, prompt };

      if (existing.actionType === "retry_turn") {
        if (!existing.turnId) throw new Error("Retry subscription does not reference a pending turn.");
        const turn = await this.getSessionTurnWithConnection(connection, existing.turnId);
        if (!turn || turn.sessionId !== existing.sessionId || turn.status !== "todo") {
          throw new Error("Retry subscription no longer references an editable pending turn.");
        }
        await connection.run(
          `UPDATE session_turn SET user_input = $prompt WHERE id = $turnId`,
          { prompt, turnId: existing.turnId }
        );
        await this.syncSessionUpdatedWithLastTurn(connection, existing.sessionId);
        await this.refreshSessionTurnFtsIndex(connection);
      }

      await connection.run(
        `
          UPDATE wait_subscription
          SET action_payload = $actionPayload::JSON,
            status = CASE WHEN status = 'error' THEN 'waiting' ELSE status END,
            error = CASE WHEN status = 'error' THEN NULL ELSE error END,
            updated = now()
          WHERE id = $id
        `,
        { id, actionPayload: JSON.stringify(actionPayload) }
      );
      const updated = await this.getWaitSubscriptionWithConnection(connection, id);
      if (!updated) throw new Error(`Failed to load wait subscription after edit: ${id}`);
      return updated;
    });
  }

  async cancelWaitSubscription(id: string): Promise<WaitSubscriptionRecord> {
    return this.write(async (connection) => {
      const existing = await this.getWaitSubscriptionWithConnection(connection, id);
      if (!existing) throw new Error(`Wait subscription not found: ${id}`);
      if (existing.status === "done" || existing.status === "cancelled") {
        // Cancellation is intentionally idempotent. A client can render a
        // waiting subscription just before the dispatcher claims it.
        return existing;
      }
      await connection.run(
        `
          UPDATE wait_subscription
          SET status = 'cancelled', updated = now()
          WHERE id = $id AND status IN ('waiting', 'error', 'dispatching')
        `,
        { id }
      );
      const updated = await this.getWaitSubscriptionWithConnection(connection, id);
      if (!updated) throw new Error(`Failed to load wait subscription after removal: ${id}`);
      return updated;
    });
  }

  async claimWaitSubscription(id: string): Promise<WaitSubscriptionRecord | null> {
    return this.write(async (connection) => {
      const subscription = await this.getWaitSubscriptionWithConnection(connection, id);
      if (subscription?.actionType === "enqueue_prompt") {
        const event = await this.getWaitEventWithConnection(connection, subscription.eventId);
        if (event?.topic === "process.exited") {
          // Also cover legacy duplicates persisted before creation-time deduplication.
          const peers = await connection.run(
            `SELECT id FROM wait_subscription WHERE event_id = $eventId AND session_id = $sessionId
             AND action_type = 'enqueue_prompt' AND status <> 'cancelled'
             ORDER BY CASE WHEN status IN ('done', 'dispatching', 'error') THEN 0 ELSE 1 END, created, id LIMIT 1`,
            { eventId: subscription.eventId, sessionId: subscription.sessionId }
          );
          const winner = (await peers.getRowObjectsJS())[0];
          if (winner && String(winner.id) !== id) {
            await connection.run("UPDATE wait_subscription SET status = 'cancelled', updated = now() WHERE id = $id AND status = 'waiting'", { id });
            return null;
          }
        }
      }
      const result = await connection.run(
        `
          UPDATE wait_subscription
          SET status = 'dispatching', attempts = attempts + 1, error = NULL, updated = now()
          WHERE id = $id AND status = 'waiting'
          RETURNING id
        `,
        { id }
      );
      if ((await result.getRowObjectsJS()).length === 0) return null;
      return this.getWaitSubscriptionWithConnection(connection, id);
    });
  }

  async completeWaitSubscription(id: string): Promise<WaitSubscriptionRecord | null> {
    return this.updateWaitSubscriptionStatus(id, "done", null, true);
  }

  async failWaitSubscription(id: string, error: string): Promise<WaitSubscriptionRecord | null> {
    return this.updateWaitSubscriptionStatus(id, "error", error, false);
  }

  async retryWaitSubscription(id: string): Promise<WaitSubscriptionRecord | null> {
    return this.updateWaitSubscriptionStatus(id, "waiting", null, false);
  }

  async cancelWaitSubscriptionsForTurn(turnId: string, exceptEventId?: string | null): Promise<number> {
    return this.write(async (connection) => {
      const result = await connection.run(
        `
          UPDATE wait_subscription
          SET status = 'cancelled', updated = now()
          WHERE turn_id = $turnId
            AND status IN ('waiting', 'dispatching', 'error')
            ${exceptEventId ? "AND event_id <> $exceptEventId" : ""}
        `,
        { turnId, ...(exceptEventId ? { exceptEventId } : {}) }
      );
      return result.rowCount;
    });
  }

  private async getWaitEventWithConnection(connection: SessionDbConnection, id: string): Promise<WaitEventRecord | null> {
    const result = await connection.run(
      `
        SELECT id, workspace_id, topic, subject_key, status,
          CAST(expected_at AS VARCHAR) AS expected_at,
          CAST(payload AS VARCHAR) AS payload_json,
          CAST(fired_at AS VARCHAR) AS fired_at,
          CAST(created AS VARCHAR) AS created,
          CAST(updated AS VARCHAR) AS updated
        FROM wait_event WHERE id = $id
      `,
      { id }
    );
    const row = (await result.getRowObjectsJS())[0];
    return row ? toWaitEventRecord(row as WaitEventRow) : null;
  }

  private async getWaitSubscriptionWithConnection(connection: SessionDbConnection, id: string): Promise<WaitSubscriptionRecord | null> {
    const result = await connection.run(
      `
        SELECT id, event_id, workspace_id, session_id, turn_id, action_type,
          CAST(action_payload AS VARCHAR) AS action_payload_json,
          status, attempts, error,
          CAST(delivered_at AS VARCHAR) AS delivered_at,
          CAST(created AS VARCHAR) AS created,
          CAST(updated AS VARCHAR) AS updated
        FROM wait_subscription WHERE id = $id
      `,
      { id }
    );
    const row = (await result.getRowObjectsJS())[0];
    return row ? toWaitSubscriptionRecord(row as WaitSubscriptionRow) : null;
  }

  private async getSessionTodoWithConnection(connection: SessionDbConnection, sessionId: string): Promise<SessionTodoSnapshot> {
    const controlResult = await connection.run(
      `
        SELECT session_id, paused, pause_reason, paused_by, context, problem, objective, CAST(updated AS VARCHAR) AS updated
        FROM session_todo_control
        WHERE session_id = $sessionId
      `,
      { sessionId }
    );
    const itemResult = await connection.run(
      `
        SELECT
          id,
          session_id,
          parent_id,
          title,
          details,
          context,
          section,
          status,
          position,
          created_by,
          updated_by,
          locked_by_turn_id,
          lock_reason,
          active_status,
          child_session_id,
          child_turn_id,
          changed_file_count,
          changed_files_json,
          CAST(created AS VARCHAR) AS created,
          CAST(updated AS VARCHAR) AS updated
        FROM session_todo_item
        WHERE session_id = $sessionId
        ORDER BY coalesce(parent_id, ''), position ASC, created ASC, id ASC
      `,
      { sessionId }
    );
    const itemSessionResult = await connection.run(
      `
        SELECT
          id,
          session_id,
          item_id,
          child_session_id,
          child_turn_id,
          title,
          role,
          CAST(created AS VARCHAR) AS created,
          CAST(updated AS VARCHAR) AS updated
        FROM session_todo_item_session
        WHERE session_id = $sessionId
        ORDER BY created ASC, id ASC
      `,
      { sessionId }
    );
    const messageResult = await connection.run(
      `
        SELECT
          id,
          session_id,
          item_id,
          turn_id,
          type,
          author,
          title,
          body,
          resolved_by,
          CAST(resolved_at AS VARCHAR) AS resolved_at,
          CAST(created AS VARCHAR) AS created
        FROM session_todo_message
        WHERE session_id = $sessionId
        ORDER BY id ASC
      `,
      { sessionId }
    );
    const commentResult = await connection.run(
      `
        SELECT
          id,
          session_id,
          item_id,
          turn_id,
          type,
          author,
          body,
          CAST(created AS VARCHAR) AS created
        FROM session_todo_comment
        WHERE session_id = $sessionId
        ORDER BY created ASC, id ASC
      `,
      { sessionId }
    );
    const controlRow = (await controlResult.getRowObjectsJS())[0];
    const items = (await itemResult.getRowObjectsJS()).map((row) => toTodoItemRecord(row as TodoItemRow));
    const itemSessions = (await itemSessionResult.getRowObjectsJS()).map((row) => toTodoItemSessionRecord(row as TodoItemSessionRow));
    const messages = (await messageResult.getRowObjectsJS()).map((row) => toTodoMessageRecord(row as TodoMessageRow));
    return {
      sessionId,
      control: controlRow ? toTodoControlRecord(controlRow as TodoControlRow) : defaultTodoControl(sessionId),
      items,
      itemSessions,
      itemTree: buildTodoItemTree(items, itemSessions, messages),
      comments: (await commentResult.getRowObjectsJS()).map((row) => toTodoCommentRecord(row as TodoCommentRow)),
      messages
    };
  }

  private async getTodoItemWithConnection(
    connection: SessionDbConnection,
    sessionId: string,
    id: string
  ): Promise<TodoItemRecord | null> {
    const result = await connection.run(
      `
        SELECT
          id,
          session_id,
          parent_id,
          title,
          details,
          context,
          section,
          status,
          position,
          created_by,
          updated_by,
          locked_by_turn_id,
          lock_reason,
          active_status,
          child_session_id,
          child_turn_id,
          changed_file_count,
          changed_files_json,
          CAST(created AS VARCHAR) AS created,
          CAST(updated AS VARCHAR) AS updated
        FROM session_todo_item
        WHERE session_id = $sessionId AND id = $id
      `,
      { sessionId, id }
    );
    const row = (await result.getRowObjectsJS())[0];
    return row ? toTodoItemRecord(row as TodoItemRow) : null;
  }

  private async nextTodoPosition(connection: SessionDbConnection, sessionId: string, parentId: string | null): Promise<number> {
    const result = await connection.run(
      `
        SELECT coalesce(max(position), 0) + 1 AS next_position
        FROM session_todo_item
        WHERE session_id = $sessionId
          AND (($parentId IS NULL AND parent_id IS NULL) OR parent_id = $parentId)
      `,
      { sessionId, parentId }
    );
    const row = (await result.getRowObjectsJS())[0];
    return numberValue(row?.next_position);
  }

  private async assertSessionExistsWithConnection(connection: SessionDbConnection, sessionId: string): Promise<void> {
    if (!(await this.getSessionWithConnection(connection, sessionId))) {
      throw new Error(`Session not found: ${sessionId}`);
    }
  }

  private async updateWaitSubscriptionStatus(
    id: string,
    status: WaitSubscriptionStatus,
    error: string | null,
    delivered: boolean
  ): Promise<WaitSubscriptionRecord | null> {
    return this.write(async (connection) => {
      await connection.run(
        `
          UPDATE wait_subscription
          SET status = $status, error = $error,
            delivered_at = CASE WHEN $delivered THEN now() ELSE delivered_at END,
            updated = now()
          WHERE id = $id AND status <> 'cancelled'
        `,
        { id, status, error, delivered }
      );
      return this.getWaitSubscriptionWithConnection(connection, id);
    });
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    return this.read(async (connection) => this.resolveSessionWithConnection(connection, { sessionId: id }));
  }

  async resolveSessionAlias(id: string): Promise<SessionRecord | null> {
    return this.read(async (connection) => {
      const session = await this.resolveSessionWithConnection(connection, { sessionId: id });
      if (!session?.threadId) return session;
      const aliases = await connection.run(
        `SELECT id FROM sessions WHERE id = $id AND ${emptyNativeSessionAliasSql}`,
        { id: session.id }
      );
      if ((await aliases.getRowObjectsJS()).length === 0) return session;
      return await this.getSessionByThreadIdWithConnection(connection, session.threadId, session.workspaceId) ?? session;
    });
  }

  async getSessionModelPreferences(sessionId: string): Promise<SessionModelPreferences> {
    return this.read(async (connection) => this.getSessionModelPreferencesWithConnection(connection, sessionId));
  }

  async getSessionTurnReferences(input: SessionInspectorLookup): Promise<Array<{ turnId: string; turnNumber: number }>> {
    return this.transaction(async (connection) => {
      const session = await this.resolveSessionWithConnection(connection, input);
      if (!session) return [];
      const params = { sessionId: session.id };
      // Serialize allocation across stores/processes. Retain mappings after turn
      // deletion so published numbers are never reused or shifted by imports.
      await connection.run("SELECT id FROM sessions WHERE id = $sessionId FOR UPDATE", params);
      await connection.run(`INSERT INTO session_turn_reference (session_id, turn_id, turn_number)
        SELECT $sessionId, t.id,
          (SELECT COALESCE(MAX(turn_number), 0) FROM session_turn_reference WHERE session_id = $sessionId)
          + ROW_NUMBER() OVER (ORDER BY t.created, t.id)
        FROM session_turn t WHERE t.session_id = $sessionId
          AND NOT EXISTS (SELECT 1 FROM session_turn_reference r WHERE r.session_id = $sessionId AND r.turn_id = t.id)`, params);
      const result = await connection.run(`SELECT r.turn_id, r.turn_number FROM session_turn_reference r
        JOIN session_turn t ON t.id = r.turn_id AND t.session_id = r.session_id
        WHERE r.session_id = $sessionId ORDER BY r.turn_number`, params);
      return (await result.getRowObjectsJS()).map(row => ({ turnId: String(row.turn_id), turnNumber: Number(row.turn_number) }));
    });
  }

  async getGlobalLoopMode(): Promise<boolean> {
    return this.read(async (connection) => {
      const result = await connection.run("SELECT enabled FROM loop_mode_settings WHERE id = 'global'");
      return (await result.getRowObjectsJS())[0]?.enabled === true;
    });
  }

  async setGlobalLoopMode(enabled: boolean): Promise<void> {
    await this.write(async (connection) => {
      await connection.run(`INSERT INTO loop_mode_settings (id, enabled) VALUES ('global', $enabled)
        ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled`, { enabled });
    });
  }

  async enableTurnLoopMode(turnId: string): Promise<void> {
    await this.write(async (connection) => {
      await connection.run("INSERT INTO turn_loop_mode (turn_id) VALUES ($turnId) ON CONFLICT (turn_id) DO NOTHING", { turnId });
    });
  }

  async isTurnLoopModeEnabled(turnId: string): Promise<boolean> {
    return this.read(async (connection) => {
      const result = await connection.run("SELECT turn_id FROM turn_loop_mode WHERE turn_id = $turnId", { turnId });
      return (await result.getRowObjectsJS()).length > 0;
    });
  }

  async recordLoopWorkTurn(turnId: string, rootTurnId: string, workCycle: number): Promise<void> {
    await this.write(async (connection) => {
      await connection.run(`INSERT INTO loop_work_turn (turn_id, root_turn_id, work_cycle)
        VALUES ($turnId, $rootTurnId, $workCycle) ON CONFLICT (turn_id) DO NOTHING`, { turnId, rootTurnId, workCycle });
    });
  }

  async getLoopWorkTurn(turnId: string): Promise<{ rootTurnId: string; workCycle: number } | null> {
    return this.read(async (connection) => {
      const result = await connection.run("SELECT root_turn_id, work_cycle FROM loop_work_turn WHERE turn_id = $turnId", { turnId });
      const row = (await result.getRowObjectsJS())[0];
      return row ? { rootTurnId: String(row.root_turn_id), workCycle: Number(row.work_cycle) } : null;
    });
  }

  async resolveApprovalPolicy(sessionId: string, turnId?: string, explicit?: string): Promise<string | undefined> {
    return this.write(async (connection) => {
      const sessionKey = `session:${sessionId}`;
      const turnKey = turnId ? `turn:${sessionId}:${turnId}` : sessionKey;
      const rows = await connection.run(
        `SELECT owner_id, policy FROM execution_approval_policy WHERE owner_id IN ($sessionKey, $turnKey)`,
        { sessionKey, turnKey }
      );
      const policies = await rows.getRowObjectsJS();
      const savedTurn = policies.find((row) => row.owner_id === turnKey);
      const savedSession = policies.find((row) => row.owner_id === sessionKey);
      const policy = explicit ?? (savedTurn ? String(savedTurn.policy) : savedSession ? String(savedSession.policy) : undefined);
      if (policy) {
        for (const ownerId of new Set([...(explicit ? [sessionKey] : []), ...(turnId ? [turnKey] : [])])) {
          await connection.run(
            `INSERT INTO execution_approval_policy (owner_id, policy) VALUES ($ownerId, $policy)
             ON CONFLICT (owner_id) DO UPDATE SET policy = excluded.policy`, { ownerId, policy }
          );
        }
      }
      return policy;
    });
  }

  async setSessionModelPreferences(
    sessionId: string,
    input: SessionModelPreferencesInput
  ): Promise<SessionModelPreferences> {
    return this.write(async (connection) => {
      const session = await this.getSessionWithConnection(connection, sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const current = await this.getSessionModelPreferencesWithConnection(connection, sessionId);
      const next = normalizeSessionModelPreferences(sessionId, input, current);
      await connection.run(
        `
          INSERT INTO session_model_preferences (
            session_id,
            selected_model,
            selected_effort,
            gear_profiles,
            active_gear_index,
            updated
          )
          VALUES (
            $sessionId,
            $selectedModel,
            $selectedEffort,
            $gearProfiles::JSON,
            $activeGearIndex,
            now()
          )
          ON CONFLICT (session_id) DO UPDATE SET
            selected_model = excluded.selected_model,
            selected_effort = excluded.selected_effort,
            gear_profiles = excluded.gear_profiles,
            active_gear_index = excluded.active_gear_index,
            updated = now()
        `,
        {
          sessionId,
          selectedModel: next.selectedModel,
          selectedEffort: next.selectedEffort,
          gearProfiles: JSON.stringify(next.gearProfiles),
          activeGearIndex: next.activeGearIndex
        }
      );
      return this.getSessionModelPreferencesWithConnection(connection, sessionId);
    });
  }

  async getWorkspaceModelPreferences(workspaceId: string): Promise<WorkspaceModelPreferences> {
    return this.write(async (connection) => {
      const preferences = await this.getWorkspaceModelPreferencesWithConnection(connection, workspaceId);
      // Materialize either the defaults or the legacy-session migration so all
      // later reads use one stable workspace setting.
      await connection.run(
        `
          INSERT INTO workspace_model_preferences (
            workspace_id,
            selected_model,
            selected_effort,
            gear_profiles,
            active_gear_index,
            updated
          )
          VALUES ($workspaceId, $selectedModel, $selectedEffort, $gearProfiles::JSON, $activeGearIndex, now())
          ON CONFLICT (workspace_id) DO NOTHING
        `,
        {
          workspaceId,
          selectedModel: preferences.selectedModel,
          selectedEffort: preferences.selectedEffort,
          gearProfiles: JSON.stringify(preferences.gearProfiles),
          activeGearIndex: preferences.activeGearIndex
        }
      );
      return this.getWorkspaceModelPreferencesWithConnection(connection, workspaceId);
    });
  }

  async setWorkspaceModelPreferences(
    workspaceId: string,
    input: SessionModelPreferencesInput
  ): Promise<WorkspaceModelPreferences> {
    return this.write(async (connection) => {
      if (!(await this.getWorkspaceWithConnection(connection, workspaceId))) {
        throw new Error(`Workspace not found: ${workspaceId}`);
      }
      const current = await this.getWorkspaceModelPreferencesWithConnection(connection, workspaceId);
      const next = normalizeWorkspaceModelPreferences(workspaceId, input, current);
      await connection.run(
        `
          INSERT INTO workspace_model_preferences (
            workspace_id,
            selected_model,
            selected_effort,
            gear_profiles,
            active_gear_index,
            updated
          )
          VALUES (
            $workspaceId,
            $selectedModel,
            $selectedEffort,
            $gearProfiles::JSON,
            $activeGearIndex,
            now()
          )
          ON CONFLICT (workspace_id) DO UPDATE SET
            selected_model = excluded.selected_model,
            selected_effort = excluded.selected_effort,
            gear_profiles = excluded.gear_profiles,
            active_gear_index = excluded.active_gear_index,
            updated = now()
        `,
        {
          workspaceId,
          selectedModel: next.selectedModel,
          selectedEffort: next.selectedEffort,
          gearProfiles: JSON.stringify(next.gearProfiles),
          activeGearIndex: next.activeGearIndex
        }
      );
      return this.getWorkspaceModelPreferencesWithConnection(connection, workspaceId);
    });
  }

  async markSessionAchieved(sessionId: string): Promise<SessionRecord | null> {
    return this.write(async (connection) => {
      await connection.run(
        `
          UPDATE sessions
          SET achieved_at = coalesce(achieved_at, now())
          WHERE id = $sessionId
        `,
        { sessionId }
      );
      return this.getSessionWithConnection(connection, sessionId);
    });
  }

  async getSessionAutoModel(sessionId: string): Promise<SessionAutoModelConfig> {
    return this.read(async (connection) => this.getSessionAutoModelWithConnection(connection, sessionId));
  }

  async setSessionAutoModelEnabled(sessionId: string, enabled: boolean): Promise<SessionAutoModelConfig> {
    return this.write(async (connection) => {
      const session = await this.getSessionWithConnection(connection, sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const current = await this.getSessionAutoModelWithConnection(connection, sessionId);
      const shouldReset = enabled && !current.enabled;
      await connection.run(
        `
        INSERT INTO session_auto_model (session_id, enabled, model, effort, revision, updated)
          VALUES ($sessionId, $enabled, '${DEFAULT_MODEL}', 'high', 0, now())
          ON CONFLICT (session_id) DO UPDATE SET
            enabled = excluded.enabled,
            model = CASE WHEN $shouldReset THEN '${DEFAULT_MODEL}' ELSE session_auto_model.model END,
            effort = CASE WHEN $shouldReset THEN 'high' ELSE session_auto_model.effort END,
            revision = CASE WHEN $shouldReset THEN 0 ELSE session_auto_model.revision END,
            full_prompt_shown = CASE WHEN $shouldReset THEN false ELSE session_auto_model.full_prompt_shown END,
            updated = now()
        `,
        { sessionId, enabled, shouldReset }
      );
      return this.getSessionAutoModelWithConnection(connection, sessionId);
    });
  }

  async claimSessionAutoModelPrompt(sessionId: string): Promise<boolean> {
    return this.write(async (connection) => {
      const result = await connection.run(
        `
          UPDATE session_auto_model
          SET full_prompt_shown = true, updated = now()
          WHERE session_id = $sessionId
            AND enabled = true
            AND coalesce(full_prompt_shown, false) = false
          RETURNING session_id
        `,
        { sessionId }
      );
      return result.rowCount > 0;
    });
  }

  /** A fresh turn may choose a cheaper model; within-turn upgrades remain monotonic. */
  async selectSessionAutoModel(input: { sessionId: string; model: string; effort: string }): Promise<SessionAutoModelConfig> {
    if (!isAutoModel(input.model) || !isAutoEffort(input.effort)) throw new Error("Invalid Auto model selection.");
    return this.write(async (connection) => {
      const current = await this.getSessionAutoModelWithConnection(connection, input.sessionId);
      if (!current.enabled) throw new Error("Auto model is not enabled for this session.");
      await connection.run(
        `UPDATE session_auto_model
         SET model = $model, effort = $effort, revision = revision + 1, updated = now()
         WHERE session_id = $sessionId AND enabled = true`,
        input
      );
      return this.getSessionAutoModelWithConnection(connection, input.sessionId);
    });
  }

  async upgradeSessionAutoModel(input: {
    sessionId: string;
    model: string;
    effort: string;
  }): Promise<SessionAutoModelConfig> {
    return this.write(async (connection) => {
      const current = await this.getSessionAutoModelWithConnection(connection, input.sessionId);
      if (!current.enabled) {
        throw new Error("Auto model is not enabled for this session.");
      }
      const modelOrder = Object.keys(AUTO_MODEL_CHOICES);
      const effortOrder = Object.keys(AUTO_EFFORT_CHOICES);
      const currentModelRank = modelOrder.indexOf(current.model);
      const requestedModelRank = modelOrder.indexOf(input.model);
      const currentEffortRank = effortOrder.indexOf(current.effort);
      const requestedEffortRank = effortOrder.indexOf(input.effort);
      if (requestedModelRank < 0 || requestedEffortRank < 0) {
        throw new Error("Auto model upgrades support GPT-6 Luna, Sol, or Astra with low through ultra effort.");
      }
      if (requestedModelRank < currentModelRank || requestedEffortRank < currentEffortRank) {
        throw new Error(`Auto model cannot downgrade from ${current.model} ${current.effort}.`);
      }
      if (requestedModelRank === currentModelRank && requestedEffortRank === currentEffortRank) {
        throw new Error(`Auto model is already ${current.model} ${current.effort}.`);
      }
      await connection.run(
        `
          UPDATE session_auto_model
          SET model = $model, effort = $effort, revision = revision + 1, updated = now()
          WHERE session_id = $sessionId AND enabled = true
        `,
        { sessionId: input.sessionId, model: input.model, effort: input.effort }
      );
      return this.getSessionAutoModelWithConnection(connection, input.sessionId);
    });
  }

  async getSessionByThreadId(threadId: string, workspaceId?: string | null): Promise<SessionRecord | null> {
    return this.read(async (connection) => this.getSessionByThreadIdWithConnection(connection, threadId, workspaceId));
  }

  async listSessionTurns(sessionId: string): Promise<SessionTurnRecord[]> {
    return this.read(async (connection) => {
      const result = await connection.run(
        `
          SELECT
            session_turn.id,
            session_turn.session_id,
            EXISTS (SELECT 1 FROM turn_loop_mode WHERE turn_id = session_turn.id) AS loop_mode,
            session_turn.account_id,
            session_turn.account_name,
            session_turn.account_email,
            session_turn.account_external_account_id,
            session_turn.account_external_user_id,
            session_turn.user_input,
            session_turn.agent_response,
            session_turn.token_in,
            session_turn.token_out,
            session_turn.status,
            session_turn.runner_pid,
            CAST(session_turn.runner_started AS VARCHAR) AS runner_started,
            CAST(session_turn.runner_heartbeat AS VARCHAR) AS runner_heartbeat,
            session_turn.runner_log_path,
            session_turn.runner_exit_code,
            session_turn.last_event_name,
            session_turn.pending_reason,
            session_turn.pending_load_balance,
            CAST(session_turn.request_metadata AS VARCHAR) AS request_metadata,
            CAST(session_turn.created AS VARCHAR) AS created,
            ${resultExecutionDurationSelectSql},
            ${latestUsageSampleSelectSql}
          FROM session_turn
          ${latestUsageSampleJoinSql}
          WHERE session_turn.session_id = $sessionId
          ORDER BY session_turn.created ASC, session_turn.id ASC
        `,
        { sessionId }
      );
      return (await result.getRowObjectsJS()).map(toSessionTurnRecord);
    });
  }

  async inspectSession(input: SessionInspectInput & { view: "file_changes" }): Promise<SessionFileChangesInspection | null>;
  async inspectSession(input: SessionInspectInput & { view: "turn_summary" }): Promise<SessionTurnSummaryInspection | null>;
  async inspectSession(input: SessionInspectInput & { view?: "full" | null | undefined }): Promise<SessionFullInspection | null>;
  async inspectSession(input: SessionInspectInput): Promise<SessionFullInspection | SessionFileChangesInspection | SessionTurnSummaryInspection | null>;
  async inspectSession(
    input: SessionInspectInput
  ): Promise<SessionFullInspection | SessionFileChangesInspection | SessionTurnSummaryInspection | null> {
    return this.read(async (connection) => {
      const session = await this.resolveSessionWithConnection(connection, input);
      if (!session) {
        return null;
      }

      const turnLimit = normalizePageLimit(input.turnLimit, 50, 500);
      const turnOffset = normalizePageOffset(input.turnOffset);
      const eventLimit = normalizePageLimit(input.eventLimit, 100, 1000);
      const eventOffset = normalizePageOffset(input.eventOffset);
      const maxTextChars = normalizeMaxTextChars(input.maxTextChars);
      const order = input.order === "desc" ? "DESC" : "ASC";
      const turnWhere = ["session_turn.session_id = $sessionId"];
      const turnFilterParams: Record<string, SessionDbValue> = {
        sessionId: session.id
      };
      const status = normalizeSessionTurnStatus(input.status);
      if (status) {
        turnWhere.push("session_turn.status = $status");
        turnFilterParams.status = status;
      }
      const turnId = normalizeText(input.turnId);
      if (turnId) {
        turnWhere.push("session_turn.id = $turnId");
        turnFilterParams.turnId = turnId;
      }
      const query = normalizeText(input.q);
      if (query) {
        turnWhere.push("(contains(lower(session_turn.user_input), lower($query)) OR contains(lower(session_turn.agent_response), lower($query)))");
        turnFilterParams.query = query;
      }

      const turnCountResult = await connection.run(
        `SELECT count(*) AS total FROM session_turn WHERE ${turnWhere.join(" AND ")}`,
        turnFilterParams
      );
      const turnTotal = numberValue((await turnCountResult.getRowObjectsJS())[0]?.total);
      const turnPageParams = { ...turnFilterParams, limit: turnLimit, offset: turnOffset };
      const turnsResult = await connection.run(
        `
          SELECT
            session_turn.id,
            session_turn.session_id,
            session_turn.account_id,
            session_turn.account_name,
            session_turn.account_email,
            session_turn.account_external_account_id,
            session_turn.account_external_user_id,
            session_turn.user_input,
            session_turn.agent_response,
            session_turn.token_in,
            session_turn.token_out,
            session_turn.status,
            session_turn.runner_pid,
            CAST(session_turn.runner_started AS VARCHAR) AS runner_started,
            CAST(session_turn.runner_heartbeat AS VARCHAR) AS runner_heartbeat,
            session_turn.runner_log_path,
            session_turn.runner_exit_code,
            session_turn.last_event_name,
            session_turn.pending_reason,
            session_turn.pending_load_balance,
            CAST(session_turn.request_metadata AS VARCHAR) AS request_metadata,
            CAST(session_turn.created AS VARCHAR) AS created,
            ${resultExecutionDurationSelectSql},
            ${latestUsageSampleSelectSql}
          FROM session_turn
          ${latestUsageSampleJoinSql}
          WHERE ${turnWhere.join(" AND ")}
          ORDER BY session_turn.created ${order}, session_turn.id ${order}
          LIMIT $limit OFFSET $offset
        `,
        turnPageParams
      );
      const turns = (await turnsResult.getRowObjectsJS())
        .map(toSessionTurnRecord)
        .map((turn) => truncateSessionTurnRecord(turn, maxTextChars));

      const view = normalizeSessionInspectView(input.view);
      const needsFileChanges = view === "file_changes" || view === "turn_summary";
      const liveItemsByTurn =
        input.includeLiveItems === true || needsFileChanges
          ? await this.listSessionLiveItemsWithConnection(connection, session.id)
          : {};
      const approvalLiveItemsByTurn =
        input.includeLiveItems === true
          ? await this.listSessionApprovalLiveItemsWithConnection(connection, session.id)
          : {};

      const events = input.includeEvents === true
        ? await this.listSessionTurnEventsWithConnection(connection, {
            sessionId: session.id,
            turnId: turnId ?? null,
            eventName: normalizeText(input.eventName) ?? null,
            query: query ?? null,
            limit: eventLimit,
            offset: eventOffset,
            order
          })
        : null;
      const sideChatLimit = normalizePageLimit(input.sideChatLimit, 50, 200);
      const sideChatOffset = normalizePageOffset(input.sideChatOffset);
      const sideChats = input.includeSideChats === true
        ? await this.listSessionSideChatsWithConnection(connection, {
            sessionId: session.id,
            limit: sideChatLimit,
            offset: sideChatOffset,
            order
          })
        : null;

      if (view === "file_changes") {
        const fileChanges = summarizeSessionFileChanges(turns, liveItemsByTurn);
        return {
          session,
          view,
          fileChanges: fileChanges.files,
          totals: fileChanges.totals,
          turnPage: {
            limit: turnLimit,
            offset: turnOffset,
            total: turnTotal,
            hasMore: turnOffset + turns.length < turnTotal
          }
        };
      }

      if (view === "turn_summary") {
        return {
          session,
          view,
          turns: turns.map((turn) => {
            const fileChanges = summarizeFileChangeItems(liveItemsByTurn[turn.id] ?? []);
            return {
              id: turn.id,
              status: turn.status,
              created: turn.created,
              userPrompt: turn.userInput,
              conclusion: turn.agentResponse,
              fileChanges: fileChanges.files,
              totals: fileChanges.totals
            };
          }),
          turnPage: {
            limit: turnLimit,
            offset: turnOffset,
            total: turnTotal,
            hasMore: turnOffset + turns.length < turnTotal
          }
        };
      }

      return {
        session,
        turns: turns.map((turn) => ({
          ...turn,
          ...(input.includeLiveItems === true
            ? {
                liveItems: [
                  ...(liveItemsByTurn[turn.id] ?? []),
                  ...(approvalLiveItemsByTurn[turn.id] ?? [])
                ]
              }
            : {})
        })),
        turnPage: {
          limit: turnLimit,
          offset: turnOffset,
          total: turnTotal,
          hasMore: turnOffset + turns.length < turnTotal
        },
        ...(events
          ? {
              events: events.records,
              eventPage: {
                limit: eventLimit,
                offset: eventOffset,
                total: events.total,
                hasMore: eventOffset + events.records.length < events.total
              }
            }
          : {}),
        ...(sideChats
          ? {
              sideChats: sideChats.records,
              sideChatPage: {
                limit: sideChatLimit,
                offset: sideChatOffset,
                total: sideChats.total,
                hasMore: sideChatOffset + sideChats.records.length < sideChats.total
              }
            }
          : {})
      };
    });
  }

  async resolveSession(input: SessionInspectorLookup) {
    return this.read((connection) => this.resolveSessionWithConnection(connection, input));
  }

  async searchSessions(input: SessionSearchInput) {
    const query = normalizeText(input.query);
    const limit = normalizePageLimit(input.limit, 20, 200);
    const offset = normalizePageOffset(input.offset);
    const maxTextChars = normalizeMaxTextChars(input.maxTextChars);

    return this.read(async (connection) => {
      if (query) {
        try {
          const ftsResult = await this.searchSessionsWithFts(connection, input, query, limit, offset, maxTextChars);
          return { ...ftsResult, mode: "fts" as const };
        } catch {
          const fallback = await this.searchSessionsWithContains(connection, input, query, limit, offset, maxTextChars);
          return { ...fallback, mode: "contains" as const };
        }
      }

      const recent = await this.searchSessionsWithContains(connection, input, null, limit, offset, maxTextChars);
      return { ...recent, mode: "recent" as const };
    });
  }

  async listSessionKeywordVocabulary(input: SessionKeywordVocabularyInput = {}) {
    const limit = normalizePageLimit(input.limit, 200, 500);
    const workspaceId = normalizeText(input.workspaceId);
    const appearance = await this.getKeywordAppearanceWeights(workspaceId);
    const counts = await this.getKeywordAppearanceSessionCounts(workspaceId);
    const scores = new Map<string, { keyword: string; score: number; sessions: number }>();

    for (const [keyword, weight] of Object.entries(appearance)) {
      const normalized = normalizeKeywordToken(keyword);
      if (!normalized || isGenericKeywordToken(normalized)) {
        continue;
      }
      scores.set(normalized, {
        keyword: normalized,
        score: weight,
        sessions: counts.get(normalized) ?? 0
      });
    }

    return [...scores.values()]
      .sort((first, second) => second.score - first.score || second.sessions - first.sessions || first.keyword.localeCompare(second.keyword))
      .slice(0, limit);
  }

  async searchSessionsByKeywords(input: SessionKeywordSearchInput) {
    const keywords = normalizeKeywordList(input.keywords);
    const limit = normalizePageLimit(input.limit, 20, 200);
    const offset = normalizePageOffset(input.offset);
    const maxTextChars = normalizeMaxTextChars(input.maxTextChars);
    const workspaceId = normalizeText(input.workspaceId);
    const sessions = await this.listSessions(workspaceId);
    const appearance = await this.getKeywordAppearanceWeights(workspaceId);
    const contentMatches = await this.getSessionKeywordContentMatches(keywords, workspaceId);
    const now = Date.now();

    const scored = sessions
      .map((session) => scoreSessionKeywordCandidate(session, keywords, now, appearance, contentMatches.get(session.id)))
      .filter((candidate): candidate is SessionKeywordCandidate => candidate !== null)
      .sort((first, second) => second.score - first.score || second.session.updated.localeCompare(first.session.updated));
    const page = scored.slice(offset, offset + limit).map((candidate) => ({
      ...candidate,
      session: truncateSessionRecord(candidate.session, maxTextChars)
    }));

    return {
      mode: "keyword" as const,
      keywords,
      results: page,
      page: {
        limit,
        offset,
        total: scored.length,
        hasMore: offset + page.length < scored.length
      }
    };
  }

  private async getSessionKeywordContentMatches(keywords: string[], workspaceId?: string) {
    if (keywords.length === 0) {
      return new Map<string, Set<string>>();
    }

    return this.read(async (connection) => {
      const keywordColumns = keywords
        .map(
          (_, index) =>
            `max(CASE WHEN contains(lower(content), lower($keyword${index})) THEN 1 ELSE 0 END) AS keyword_${index}`
        )
        .join(",\n          ");
      const params: Record<string, SessionDbValue> = Object.fromEntries(
        keywords.map((keyword, index) => [`keyword${index}`, keyword])
      );
      const workspaceFilter = workspaceId ? "WHERE sessions.workspace_id = $workspaceId" : "";
      if (workspaceId) {
        params.workspaceId = workspaceId;
      }

      const result = await connection.run(
        `
          SELECT
            session_id,
            ${keywordColumns}
          FROM (
            SELECT session_turn.session_id, session_turn.user_input AS content
            FROM session_turn
            JOIN sessions ON sessions.id = session_turn.session_id
            ${workspaceFilter}
            UNION ALL
            SELECT session_turn.session_id, session_turn.agent_response AS content
            FROM session_turn
            JOIN sessions ON sessions.id = session_turn.session_id
            ${workspaceFilter}
            UNION ALL
            SELECT session_turn_event.session_id, CAST(session_turn_event.payload AS VARCHAR) AS content
            FROM session_turn_event
            JOIN sessions ON sessions.id = session_turn_event.session_id
            ${workspaceFilter}
          ) AS searchable_content
          WHERE content IS NOT NULL AND content <> ''
          GROUP BY session_id
        `,
        params
      );
      const matches = new Map<string, Set<string>>();
      for (const row of await result.getRowObjectsJS()) {
        const record = row as Record<string, unknown>;
        const sessionId = stringValue(record.session_id);
        if (!sessionId) {
          continue;
        }
        const matchedKeywords = new Set<string>();
        keywords.forEach((keyword, index) => {
          if (numberValue(record[`keyword_${index}`]) > 0) {
            matchedKeywords.add(keyword);
          }
        });
        if (matchedKeywords.size > 0) {
          matches.set(sessionId, matchedKeywords);
        }
      }
      return matches;
    });
  }

  async getSessionVectorStatus() {
    return this.read(async (connection) => {
      const tableReady = await this.tableExists(connection, "session_description_embedding");
      const vssAvailable = await this.tryLoadVss(connection);
      const count = tableReady
        ? numberValue((await (await connection.run("SELECT count(*) AS total FROM session_description_embedding")).getRowObjectsJS())[0]?.total)
        : 0;

      return {
        available: tableReady && count > 0,
        vssAvailable,
        embeddingTableReady: tableReady,
        embeddingCount: count,
        target: "sessions.description",
        note:
          tableReady && count > 0
            ? "Vector search can run over existing session_description_embedding rows."
            : "Vector search needs description embeddings in session_description_embedding; no embedding generation is built into the database."
      };
    });
  }

  async searchSessionVectors(input: SessionVectorSearchInput) {
    const embedding = normalizeEmbedding(input.embedding);
    if (!embedding) {
      throw new Error("embedding must be a non-empty numeric array.");
    }
    const limit = normalizePageLimit(input.limit, 20, 200);
    const offset = normalizePageOffset(input.offset);
    const maxTextChars = normalizeMaxTextChars(input.maxTextChars);

    return this.read(async (connection) => {
      if (!(await this.tableExists(connection, "session_description_embedding"))) {
        throw new Error("session_description_embedding table is not available.");
      }

      await this.tryLoadVss(connection);
      const where = ["1 = 1"];
      const params: Record<string, SessionDbValue> = {};
      const workspaceId = normalizeText(input.workspaceId);
      if (workspaceId) {
        where.push("sessions.workspace_id = $workspaceId");
        params.workspaceId = workspaceId;
      }
      const session = await this.resolveOptionalSessionFilterWithConnection(connection, input);
      if (session) {
        where.push("sessions.id = $sessionId");
        params.sessionId = session.id;
      }

      const rowsResult = await connection.run(
        `
          SELECT
            sessions.id,
            sessions.thread_id,
            sessions.workspace_id,
            sessions.cwd,
            sessions.account_id,
            CAST(sessions.keyword_weights AS VARCHAR) AS keyword_weights,
            sessions.title,
            sessions.title_source,
            sessions.description,
            sessions.parent_session_id,
            sessions.forked_from_turn_id,
            CAST(sessions.created AS VARCHAR) AS created,
            CAST(sessions.updated AS VARCHAR) AS updated,
            session_description_embedding.embedding,
            session_description_embedding.model,
            CAST(session_description_embedding.updated AS VARCHAR) AS embedding_updated
          FROM session_description_embedding
          JOIN sessions ON sessions.id = session_description_embedding.session_id
          WHERE ${where.join(" AND ")}
        `,
        params
      );
      const scored = (await rowsResult.getRowObjectsJS())
        .map((row) => sessionDescriptionVectorResultFromRow(row as SessionDescriptionEmbeddingRow, embedding, maxTextChars))
        .filter((row): row is NonNullable<typeof row> => row !== null)
        .sort((first, second) => first.distance - second.distance);
      const page = scored.slice(offset, offset + limit);
      return {
        mode: "vector" as const,
        results: page,
        page: {
          limit,
          offset,
          total: scored.length,
          hasMore: offset + page.length < scored.length
        }
      };
    });
  }

  async listSessionLiveItems(sessionId: string): Promise<Record<string, unknown[]>> {
    return this.read(async (connection) => this.listSessionLiveItemsWithConnection(connection, sessionId));
  }

  async listSessionTurnLiveItems(sessionId: string, turnId: string): Promise<unknown[]> {
    return this.read(async (connection) => (
      (await this.listSessionLiveItemsWithConnection(connection, sessionId, turnId))[turnId] ?? []
    ));
  }

  async listSessionApprovalLiveItems(sessionId: string): Promise<Record<string, unknown[]>> {
    return this.read(async (connection) => this.listSessionApprovalLiveItemsWithConnection(connection, sessionId));
  }

  async listSessionDeveloperInstructions(sessionId: string): Promise<Record<string, SessionDeveloperInstructionsRecord[]>> {
    return this.read(async (connection) => this.listSessionDeveloperInstructionsWithConnection(connection, sessionId));
  }

  async listSessionSteerMessages(sessionId: string): Promise<Record<string, SessionSteerMessageRecord[]>> {
    return this.read(async (connection) => this.listSessionSteerMessagesWithConnection(connection, sessionId));
  }

  async listSessionAutoModelProviders(sessionId: string): Promise<Record<string, { provider: SessionAutoModelProvider; confidence?: number }>> {
    return this.read(async (connection) => this.listSessionAutoModelProvidersWithConnection(connection, sessionId));
  }

  async getNextTodoTurn(sessionId: string): Promise<SessionTurnRecord | null> {
    return this.read(async (connection) => {
      const result = await connection.run(
        `
          SELECT
            id,
            session_id,
            account_id,
            user_input,
            agent_response,
            token_in,
            token_out,
            status,
            runner_pid,
            CAST(runner_started AS VARCHAR) AS runner_started,
            CAST(runner_heartbeat AS VARCHAR) AS runner_heartbeat,
            runner_log_path,
            runner_exit_code,
            last_event_name,
            pending_reason,
            CAST(request_metadata AS VARCHAR) AS request_metadata,
            CAST(created AS VARCHAR) AS created
          FROM session_turn
          WHERE session_id = $sessionId
            AND status = 'todo'
            AND coalesce(pending_reason, 'queued') <> 'stopped'
            AND last_event_name IS DISTINCT FROM 'queue.steer_reserved'
          ORDER BY created ASC, id ASC
          LIMIT 1
        `,
        { sessionId }
      );
      const rows = await result.getRowObjectsJS();
      return rows.length > 0 ? toSessionTurnRecord(rows[0] as SessionTurnRow) : null;
    });
  }

  async listPendingSessionTurns(): Promise<Array<{
    turn: SessionTurnRecord;
    session: SessionRecord;
    account: AccountRecord | null;
  }>> {
    return this.read(async (connection) => {
      const result = await connection.run(`
        SELECT
          session_turn.id AS turn_id,
          session_turn.session_id AS turn_session_id,
          session_turn.account_id AS turn_account_id,
          session_turn.user_input AS turn_user_input,
          session_turn.agent_response AS turn_agent_response,
          session_turn.token_in AS turn_token_in,
          session_turn.token_out AS turn_token_out,
          session_turn.status AS turn_status,
          session_turn.runner_pid AS turn_runner_pid,
          CAST(session_turn.runner_started AS VARCHAR) AS turn_runner_started,
          CAST(session_turn.runner_heartbeat AS VARCHAR) AS turn_runner_heartbeat,
          session_turn.runner_log_path AS turn_runner_log_path,
          session_turn.runner_exit_code AS turn_runner_exit_code,
          session_turn.last_event_name AS turn_last_event_name,
          session_turn.pending_reason AS turn_pending_reason,
          session_turn.pending_load_balance AS turn_pending_load_balance,
          CAST(session_turn.request_metadata AS VARCHAR) AS turn_request_metadata,
          CAST(session_turn.created AS VARCHAR) AS turn_created,
          sessions.id AS session_id,
          sessions.thread_id,
          sessions.workspace_id,
          sessions.cwd,
          sessions.account_id AS session_account_id,
          CAST(sessions.keyword_weights AS VARCHAR) AS keyword_weights,
          sessions.title,
          sessions.title_source,
          sessions.description,
          sessions.parent_session_id,
          sessions.forked_from_turn_id,
          CAST(sessions.created AS VARCHAR) AS session_created,
          CAST(sessions.updated AS VARCHAR) AS session_updated,
          accounts.id AS account_id,
          accounts.name AS account_name,
          accounts.external_account_id,
          accounts.external_user_id,
          accounts.email,
          CASE WHEN accounts.auth_json IS NOT NULL AND accounts.auth_json <> '' THEN true ELSE false END AS has_auth,
          accounts.auth_version,
          CAST(accounts.quota_snapshot AS VARCHAR) AS quota_snapshot,
          CAST(accounts.quota_updated_at AS VARCHAR) AS quota_updated_at,
          accounts.quota_error,
          CAST(accounts.created AS VARCHAR) AS account_created,
          CAST(accounts.updated AS VARCHAR) AS account_updated,
          CAST(accounts.last_used AS VARCHAR) AS account_last_used
        FROM session_turn
        INNER JOIN sessions ON sessions.id = session_turn.session_id
        LEFT JOIN accounts ON accounts.id = session_turn.account_id
        WHERE session_turn.status = 'todo'
          AND session_turn.last_event_name IS DISTINCT FROM 'queue.steer_reserved'
        ORDER BY session_turn.created ASC, session_turn.id ASC
      `);
      return (await result.getRowObjectsJS()).map((row) => ({
        turn: toSessionTurnRecord({
          id: row.turn_id,
          session_id: row.turn_session_id,
          account_id: row.turn_account_id,
          user_input: row.turn_user_input,
          agent_response: row.turn_agent_response,
          token_in: row.turn_token_in,
          token_out: row.turn_token_out,
          status: row.turn_status,
          runner_pid: row.turn_runner_pid,
          runner_started: row.turn_runner_started,
          runner_heartbeat: row.turn_runner_heartbeat,
          runner_log_path: row.turn_runner_log_path,
          runner_exit_code: row.turn_runner_exit_code,
          last_event_name: row.turn_last_event_name,
          pending_reason: row.turn_pending_reason,
          pending_load_balance: row.turn_pending_load_balance,
          request_metadata: row.turn_request_metadata,
          created: row.turn_created
        }),
        session: toSessionRecord({
          id: row.session_id,
          thread_id: row.thread_id,
          workspace_id: row.workspace_id,
          cwd: row.cwd,
          account_id: row.session_account_id,
          keyword_weights: row.keyword_weights,
          title: row.title,
          title_source: row.title_source,
          description: row.description,
          parent_session_id: row.parent_session_id,
          forked_from_turn_id: row.forked_from_turn_id,
          created: row.session_created,
          updated: row.session_updated
        }),
        account: typeof row.account_id === "string"
          ? toAccountRecord({
              id: row.account_id,
              name: row.account_name,
              external_account_id: row.external_account_id,
              external_user_id: row.external_user_id,
              email: row.email,
              has_auth: row.has_auth,
              auth_version: row.auth_version,
              quota_snapshot: row.quota_snapshot,
              quota_updated_at: row.quota_updated_at,
              quota_error: row.quota_error,
              created: row.account_created,
              updated: row.account_updated,
              last_used: row.account_last_used
            })
          : null
      }));
    });
  }

  async getSessionTurn(turnId: string): Promise<SessionTurnRecord | null> {
    return this.read(async (connection) => {
      const result = await connection.run(
        `
          SELECT
            id,
            session_id,
            EXISTS (SELECT 1 FROM turn_loop_mode WHERE turn_id = session_turn.id) AS loop_mode,
            account_id,
            user_input,
            agent_response,
            token_in,
            token_out,
            status,
            runner_pid,
            CAST(runner_started AS VARCHAR) AS runner_started,
            CAST(runner_heartbeat AS VARCHAR) AS runner_heartbeat,
            runner_log_path,
            runner_exit_code,
            last_event_name,
            pending_reason,
            pending_load_balance,
            CAST(request_metadata AS VARCHAR) AS request_metadata,
            CAST(created AS VARCHAR) AS created,
            ${resultExecutionDurationSelectSql}
          FROM session_turn AS session_turn
          WHERE id = $turnId
        `,
        { turnId }
      );
      const rows = await result.getRowObjectsJS();
      return rows.length > 0 ? toSessionTurnRecord(rows[0] as SessionTurnRow) : null;
    });
  }

  async getLatestRunningTurn(sessionId: string): Promise<SessionTurnRecord | null> {
    return this.read((connection) => this.getLatestRunningTurnWithConnection(connection, sessionId));
  }

  async getSessionSummaryState(sessionId: string): Promise<SessionSummaryStateRecord | null> {
    return this.read(async (connection) => {
      const result = await connection.run(
        `
          SELECT
            session_id,
            source_hash,
            source_turn_count,
            CAST(source_updated AS VARCHAR) AS source_updated,
            summarizer_model,
            CAST(summarized_at AS VARCHAR) AS summarized_at,
            CAST(updated AS VARCHAR) AS updated
          FROM session_summary_state
          WHERE session_id = $sessionId
        `,
        { sessionId }
      );
      const rows = await result.getRowObjectsJS();
      return rows.length > 0 ? toSessionSummaryStateRecord(rows[0] as SessionSummaryStateRow) : null;
    });
  }

  async upsertSession(input: UpsertSessionInput, options: { createOnly?: boolean } = {}): Promise<SessionRecord> {
    return this.write(async (connection) => {
      const existing = await this.getSessionWithConnection(connection, input.id);
      if (existing && options.createOnly) return existing;
      if (!existing && input.threadId) {
        // Client-generated local ids can race with a stale resumeThreadId.
        // Coalesce that request onto the existing local session while still
        // inside the serialized write queue.
        const matchingThreadSession = await this.getSessionByThreadIdWithConnection(
          connection,
          input.threadId,
          input.workspaceId
        );
        if (matchingThreadSession) {
          return matchingThreadSession;
        }
      }
      const keywordWeights = input.keywordWeights ?? existing?.keywordWeights ?? {};
      const inputTitleSource = input.titleSource ?? (existing ? "user" : "initial");
      const canApplyInputTitle =
        input.title !== undefined && (!existing || canUpdateSessionTitle(existing.titleSource, inputTitleSource));
      const title = canApplyInputTitle ? input.title! : existing?.title ?? input.title ?? "Untitled session";
      const titleSource = canApplyInputTitle ? inputTitleSource : existing?.titleSource ?? inputTitleSource;
      const description = input.description ?? existing?.description ?? "";
      const parentSessionId =
        input.parentSessionId !== undefined ? input.parentSessionId : existing?.parentSessionId ?? null;
      const forkedFromTurnId =
        input.forkedFromTurnId !== undefined ? input.forkedFromTurnId : existing?.forkedFromTurnId ?? null;
      const threadId = input.threadId !== undefined ? input.threadId : existing?.threadId ?? null;
      const workspaceId = input.workspaceId ?? existing?.workspaceId ?? "default";
      const cwd = input.cwd ?? existing?.cwd ?? defaultCwd();
      const accountId = input.accountId !== undefined ? input.accountId : existing?.accountId ?? null;

      if (existing) {
        await connection.run(
          `
            UPDATE sessions
            SET
              thread_id = $threadId,
              workspace_id = $workspaceId,
              cwd = $cwd,
              account_id = $accountId,
              keyword_weights = $keywordWeights::JSON,
              title = $title,
              title_source = $titleSource,
              description = $description,
              parent_session_id = $parentSessionId,
              forked_from_turn_id = $forkedFromTurnId
            WHERE id = $id
          `,
          {
            id: input.id,
            threadId,
            workspaceId,
            cwd,
            accountId,
            keywordWeights: JSON.stringify(keywordWeights),
            title,
            titleSource,
            description,
            parentSessionId,
            forkedFromTurnId
          }
        );
      } else {
        await connection.run(
          `
            INSERT INTO sessions (
              id,
              thread_id,
              workspace_id,
              cwd,
              account_id,
              keyword_weights,
              title,
              title_source,
              description,
              parent_session_id,
              forked_from_turn_id,
              created,
              updated
            )
            VALUES (
              $id,
              $threadId,
              $workspaceId,
              $cwd,
              $accountId,
              $keywordWeights::JSON,
              $title,
              $titleSource,
              $description,
              $parentSessionId,
              $forkedFromTurnId,
              now(),
              now()
            )
          `,
          {
            id: input.id,
            threadId,
            workspaceId,
            cwd,
            accountId,
            keywordWeights: JSON.stringify(keywordWeights),
            title,
            titleSource,
            description,
            parentSessionId,
            forkedFromTurnId
          }
        );
      }

      const session = await this.getSessionWithConnection(connection, input.id);
      if (!session) {
        throw new Error(`Failed to load session after upsert: ${input.id}`);
      }
      return session;
    });
  }

  async forkSessionAtTurn(input: ForkSessionInput): Promise<{ session: SessionRecord; turns: SessionTurnRecord[] }> {
    return this.write(async (connection) => {
      const parentSession = await this.getSessionWithConnection(connection, input.parentSessionId);
      if (!parentSession) {
        throw new Error(`Session not found: ${input.parentSessionId}`);
      }

      const existingSession = await this.getSessionWithConnection(connection, input.id);
      if (existingSession) {
        throw new Error(`Session already exists: ${input.id}`);
      }

      const targetTurn = await this.getSessionTurnWithConnection(connection, input.targetTurnId);
      if (!targetTurn || targetTurn.sessionId !== parentSession.id) {
        throw new Error(`Turn not found in session: ${input.targetTurnId}`);
      }

      if (targetTurn.status !== "done") {
        throw new Error("Only completed agent messages can be forked.");
      }

      const turnsResult = await connection.run(
        `
          SELECT
            id,
            session_id,
            account_id,
            user_input,
            agent_response,
            token_in,
            token_out,
            status,
            runner_pid,
            CAST(runner_started AS VARCHAR) AS runner_started,
            CAST(runner_heartbeat AS VARCHAR) AS runner_heartbeat,
            runner_log_path,
            runner_exit_code,
            last_event_name,
            CAST(created AS VARCHAR) AS created
          FROM session_turn
          WHERE session_id = $parentSessionId
            AND (
              created < (SELECT created FROM session_turn WHERE id = $targetTurnId)
              OR (created = (SELECT created FROM session_turn WHERE id = $targetTurnId) AND id <= $targetTurnId)
            )
          ORDER BY created ASC, id ASC
        `,
        { parentSessionId: parentSession.id, targetTurnId: targetTurn.id }
      );
      const turnsToCopy = (await turnsResult.getRowObjectsJS()).map(toSessionTurnRecord);
      const title = input.title ?? `Fork: ${parentSession.title}`;
      const titleSource = input.titleSource ?? (input.title ? "user" : "initial");
      const description = input.description ?? `Forked from ${parentSession.title}`;

      await connection.run(
        `
          INSERT INTO sessions (
            id,
            thread_id,
            workspace_id,
            cwd,
            account_id,
            keyword_weights,
            title,
            title_source,
            description,
            parent_session_id,
            forked_from_turn_id,
            created,
            updated
          )
          VALUES (
            $id,
            $threadId,
            $workspaceId,
            $cwd,
            $accountId,
            $keywordWeights::JSON,
            $title,
            $titleSource,
            $description,
            $parentSessionId,
            $forkedFromTurnId,
            now(),
            now()
          )
        `,
        {
          id: input.id,
          threadId: parentSession.threadId,
          workspaceId: parentSession.workspaceId,
          cwd: parentSession.cwd,
          accountId: parentSession.accountId,
          keywordWeights: JSON.stringify(parentSession.keywordWeights),
          title,
          titleSource,
          description,
          parentSessionId: parentSession.id,
          forkedFromTurnId: targetTurn.id
        }
      );

      await connection.run(
        `
          INSERT INTO session_model_preferences (
            session_id,
            selected_model,
            selected_effort,
            gear_profiles,
            active_gear_index,
            updated
          )
          SELECT
            $id,
            selected_model,
            selected_effort,
            gear_profiles,
            active_gear_index,
            now()
          FROM session_model_preferences
          WHERE session_id = $parentSessionId
        `,
        { id: input.id, parentSessionId: parentSession.id }
      );

      for (const turn of turnsToCopy) {
        await connection.run(
          `
            INSERT INTO session_turn (
              id,
              session_id,
              account_id,
              user_input,
              agent_response,
              token_in,
              token_out,
              status,
              created
            )
            VALUES (
              $id,
              $sessionId,
              $accountId,
              $userInput,
              $agentResponse,
              $tokenIn,
              $tokenOut,
              $status,
              $created::TIMESTAMPTZ
            )
          `,
          {
            id: crypto.randomUUID(),
            sessionId: input.id,
            accountId: turn.accountId,
            userInput: turn.userInput,
            agentResponse: turn.agentResponse,
            tokenIn: turn.tokenIn,
            tokenOut: turn.tokenOut,
            status: "done",
            created: turn.created
          }
        );
      }

      await this.refreshSessionTurnFtsIndex(connection);

      const session = await this.getSessionWithConnection(connection, input.id);
      if (!session) {
        throw new Error(`Failed to load forked session: ${input.id}`);
      }

      return {
        session,
        turns: await this.listSessionTurnsWithConnection(connection, input.id)
      };
    });
  }

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    return this.read(async (connection) => {
      const result = await connection.run(`
        SELECT
          id,
          name,
          codex_home,
          cwd,
          CAST(created AS VARCHAR) AS created,
          CAST(updated AS VARCHAR) AS updated
        FROM workspaces
        ORDER BY (id = 'default') DESC, updated DESC, name ASC
      `);
      return (await result.getRowObjectsJS()).map(toWorkspaceRecord);
    });
  }

  async getWorkspace(id: string): Promise<WorkspaceRecord | null> {
    return this.read(async (connection) => this.getWorkspaceWithConnection(connection, id));
  }

  async getWorkspaceManager(workspaceId: string): Promise<WorkspaceManagerRecord | null> {
    return this.read(async (connection) => {
      const rows = await (await connection.run(`SELECT * FROM workspace_manager WHERE workspace_id = $workspaceId`, { workspaceId })).getRowObjectsJS();
      return rows[0] ? toWorkspaceManager(rows[0]) : null;
    });
  }

  async getSessionWorkspaceManager(sessionId: string): Promise<WorkspaceManagerRecord | null> {
    return this.read(async (connection) => {
      const rows = await (await connection.run(`SELECT * FROM workspace_manager WHERE session_id = $sessionId`, { sessionId })).getRowObjectsJS();
      return rows[0] ? toWorkspaceManager(rows[0]) : null;
    });
  }

  async setSessionTaskManager(sessionId: string, managerSessionId: string) {
    return this.write(async connection => {
      const result = await connection.run(`UPDATE sessions s SET created_by_manager_session_id = m.session_id
        FROM workspace_manager m WHERE s.id = $sessionId AND m.session_id = $managerSessionId
        AND s.workspace_id = m.workspace_id AND s.id <> m.session_id
        AND (s.created_by_manager_session_id IS NULL OR s.created_by_manager_session_id = m.session_id)`, { sessionId, managerSessionId });
      if (!result.rowCount) throw new Error("Task and originating manager must belong to the same workspace.");
    });
  }

  async getSessionTaskManager(sessionId: string): Promise<WorkspaceManagerRecord | null> {
    return this.read(async connection => {
      const rows = await (await connection.run(`SELECT m.* FROM sessions s JOIN workspace_manager m
        ON m.session_id = COALESCE(s.created_by_manager_session_id, s.parent_session_id)
        AND m.workspace_id = s.workspace_id WHERE s.id = $sessionId`, { sessionId })).getRowObjectsJS();
      return rows[0] ? toWorkspaceManager(rows[0]) : null;
    });
  }

  async ensureWorkspaceManager(workspaceId: string): Promise<WorkspaceManagerRecord> {
    return this.transaction(async (connection) => {
      const workspace = await this.getWorkspaceWithConnection(connection, workspaceId);
      if (!workspace) throw new Error("Workspace not found.");
      const current = (await (await connection.run(`SELECT * FROM workspace_manager
        WHERE workspace_id = $workspaceId FOR UPDATE`, { workspaceId })).getRowObjectsJS())[0];
      if (current) return toWorkspaceManager(current);
      const originalId = `tx_manager_${createHash("sha256").update(workspaceId).digest("hex").slice(0, 24)}`;
      const archived = (await (await connection.run(`SELECT 1 FROM workspace_manager_archive
        WHERE session_id = $sessionId`, { sessionId: originalId })).getRowObjectsJS()).length > 0;
      const sessionId = archived ? `tx_manager_${randomUUID()}` : originalId;
      await connection.run(`INSERT INTO sessions (id, workspace_id, cwd, title, title_source, description)
        VALUES ($sessionId, $workspaceId, $cwd, $title, 'user', 'Workspace communication, task coordination and follow-up.')
        ON CONFLICT (id) DO NOTHING`, { sessionId, workspaceId, cwd: workspace.cwd, title: `${workspace.name} · Manager` });
      await connection.run(`INSERT INTO workspace_manager (workspace_id, session_id) VALUES ($workspaceId, $sessionId)
        ON CONFLICT (workspace_id) DO NOTHING`, { workspaceId, sessionId });
      const rows = await (await connection.run(`SELECT * FROM workspace_manager WHERE workspace_id = $workspaceId`, { workspaceId })).getRowObjectsJS();
      return toWorkspaceManager(rows[0]);
    });
  }

  async rotateWorkspaceManager(workspaceId: string, expectedSessionId: string) {
    return this.transaction(async connection => {
      const rows = await (await connection.run(`SELECT * FROM workspace_manager
        WHERE workspace_id = $workspaceId FOR UPDATE`, { workspaceId })).getRowObjectsJS();
      if (!rows[0]) throw new Error("Workspace manager has not been created.");
      const previous = toWorkspaceManager(rows[0]);
      if (previous.sessionId !== expectedSessionId) throw new Error("Workspace manager changed. Reload before clearing it.");
      const active = await (await connection.run(`SELECT 1 FROM session_turn WHERE session_id = $sessionId
        AND (status = 'running' OR (status = 'todo' AND pending_reason IS DISTINCT FROM 'stopped')) LIMIT 1`,
        { sessionId: previous.sessionId })).getRowObjectsJS();
      if (active.length) throw new Error("Wait for the current manager turn to finish or stop it before clearing.");
      const workspace = await this.getWorkspaceWithConnection(connection, workspaceId);
      const previousSession = await this.getSessionWithConnection(connection, previous.sessionId);
      if (!workspace || !previousSession) throw new Error("Workspace manager session is missing.");
      const sessionId = `tx_manager_${randomUUID()}`;
      await connection.run(`INSERT INTO sessions (id, workspace_id, cwd, account_id, title, title_source, description)
        VALUES ($sessionId, $workspaceId, $cwd, $accountId, $title, 'user',
          'Workspace communication, task coordination and follow-up.')`, {
        sessionId, workspaceId, cwd: workspace.cwd, accountId: previousSession.accountId,
        title: `${workspace.name} · Manager`
      });
      await connection.run(`INSERT INTO session_model_preferences (session_id, selected_model, selected_effort)
        VALUES ($sessionId, $model, $effort)`, {
        sessionId, model: WORKSPACE_MANAGER_MODEL, effort: WORKSPACE_MANAGER_EFFORT
      });
      await connection.run(`INSERT INTO session_auto_model (session_id, enabled) VALUES ($sessionId, false)`, { sessionId });
      await connection.run(`INSERT INTO execution_approval_policy (owner_id, policy)
        SELECT $newOwner, policy FROM execution_approval_policy WHERE owner_id = $oldOwner`, {
        newOwner: `session:${sessionId}`, oldOwner: `session:${previous.sessionId}`
      });
      // Keep task ancestry intact while transferring manager ownership/routing.
      await connection.run(`UPDATE sessions SET created_by_manager_session_id = $sessionId
        WHERE workspace_id = $workspaceId AND
          (created_by_manager_session_id = $previousSessionId OR
            (created_by_manager_session_id IS NULL AND parent_session_id = $previousSessionId))`, {
        workspaceId, sessionId, previousSessionId: previous.sessionId
      });
      await connection.run(`INSERT INTO workspace_manager_archive
        (session_id, workspace_id, replaced_by_session_id) VALUES ($previousSessionId, $workspaceId, $sessionId)`, {
        previousSessionId: previous.sessionId, workspaceId, sessionId
      });
      const current = await (await connection.run(`UPDATE workspace_manager
        SET session_id = $sessionId, created = now(), updated = now()
        WHERE workspace_id = $workspaceId RETURNING *`, { workspaceId, sessionId })).getRowObjectsJS();
      await connection.run(`UPDATE active_session SET session_id = $sessionId, updated = now()
        WHERE key = $workspaceId AND session_id = $previousSessionId`, {
        workspaceId, sessionId, previousSessionId: previous.sessionId
      });
      return { manager: toWorkspaceManager(current[0]), archivedSessionId: previous.sessionId };
    });
  }

  async isArchivedWorkspaceManagerSession(sessionId: string): Promise<boolean> {
    return this.read(async connection => (await (await connection.run(
      `SELECT 1 FROM workspace_manager_archive WHERE session_id = $sessionId`, { sessionId }
    )).getRowObjectsJS()).length > 0);
  }

  async listWorkspaceManagerArchives(workspaceId: string) {
    return this.read(async connection => (await (await connection.run(`SELECT session_id, replaced_by_session_id,
      CAST(archived_at AS VARCHAR) AS archived_at FROM workspace_manager_archive
      WHERE workspace_id = $workspaceId ORDER BY archived_at DESC`, { workspaceId })).getRowObjectsJS())
      .map(row => ({ sessionId: String(row.session_id), replacedBySessionId: String(row.replaced_by_session_id),
        archivedAt: managerTimestamp(row.archived_at) })));
  }

  async updateWorkspaceManager(workspaceId: string, input: { notificationsEnabled: boolean }) {
    return this.write(async (connection) => {
      const updated = await (await connection.run(`UPDATE workspace_manager SET notifications_enabled = $enabled,
        updated = now() WHERE workspace_id = $workspaceId RETURNING *`, { workspaceId, enabled: input.notificationsEnabled })).getRowObjectsJS();
      if (!updated[0]) throw new Error("Workspace manager has not been created.");
      return toWorkspaceManager(updated[0]);
    });
  }

  async recordWorkspaceManagerEvent(event: WorkspaceManagerEvent) {
    return this.transaction(async (connection) => {
      if (event.type === "platform.restarted") {
        // Only the latest undelivered restart matters. Preserve old rows for
        // audit while preventing dev restarts from filling the manager inbox.
        await connection.run(`UPDATE workspace_manager_event SET dismissed_at = now(),
          dismissed_reason = 'superseded by a later platform restart'
          WHERE workspace_id = $workspaceId AND type = 'platform.restarted'
            AND delivery_turn_id IS NULL AND dismissed_at IS NULL AND created < $created::timestamptz`,
          { workspaceId: event.workspaceId, created: event.created });
      }
      await connection.run(`INSERT INTO workspace_manager_event
        (id, workspace_id, session_id, turn_id, type, summary, created, dismissed_at, dismissed_reason)
        SELECT $id, m.workspace_id, $sessionId, $turnId, $type, $summary, $created::timestamptz,
          CASE WHEN $type = 'platform.restarted' AND EXISTS (
            SELECT 1 FROM workspace_manager_event newer WHERE newer.workspace_id = m.workspace_id
              AND newer.type = 'platform.restarted' AND newer.delivery_turn_id IS NULL
              AND newer.dismissed_at IS NULL AND newer.created > $created::timestamptz
          ) THEN now() ELSE NULL END,
          CASE WHEN $type = 'platform.restarted' AND EXISTS (
            SELECT 1 FROM workspace_manager_event newer WHERE newer.workspace_id = m.workspace_id
              AND newer.type = 'platform.restarted' AND newer.delivery_turn_id IS NULL
              AND newer.dismissed_at IS NULL AND newer.created > $created::timestamptz
          ) THEN 'superseded by a later platform restart' ELSE NULL END
        FROM workspace_manager m
        WHERE m.workspace_id = $workspaceId AND ($sessionId::varchar IS NULL OR (m.session_id <> $sessionId AND
          EXISTS (SELECT 1 FROM sessions s WHERE s.id = $sessionId AND s.workspace_id = m.workspace_id)))
          AND m.created <= $created::timestamptz
        ON CONFLICT (id) DO NOTHING`, { ...event, summary: event.summary.slice(0, 1800) });
    });
  }

  async listWorkspaceManagerEvents(workspaceId: string, pendingOnly = true): Promise<Array<WorkspaceManagerEvent & {
    deliveryTurnId: string | null;
    dismissedAt: string | null;
    dismissedReason: string | null;
    taskStatus: string | null;
    taskPendingReason: string | null;
    taskRunnerExitCode: number | null;
  }>> {
    return this.read(async connection => {
      const rows = await (await connection.run(`SELECT e.*, t.status AS task_status,
        t.pending_reason AS task_pending_reason, t.runner_exit_code AS task_runner_exit_code
        FROM workspace_manager_event e LEFT JOIN session_turn t ON t.id = e.turn_id
        WHERE e.workspace_id = $workspaceId AND ($pendingOnly = false OR
          (e.delivery_turn_id IS NULL AND e.dismissed_at IS NULL))
        ORDER BY e.created, e.id LIMIT 500`, { workspaceId, pendingOnly })).getRowObjectsJS();
      return rows.map(row => ({ id: String(row.id), workspaceId,
        sessionId: nullableString(row.session_id), turnId: nullableString(row.turn_id),
        type: String(row.type), summary: String(row.summary), created: managerTimestamp(row.created),
        deliveryTurnId: nullableString(row.delivery_turn_id), taskStatus: nullableString(row.task_status),
        dismissedAt: row.dismissed_at == null ? null : managerTimestamp(row.dismissed_at),
        dismissedReason: nullableString(row.dismissed_reason),
        taskPendingReason: nullableString(row.task_pending_reason),
        taskRunnerExitCode: row.task_runner_exit_code == null ? null : Number(row.task_runner_exit_code) }));
    });
  }

  async dismissWorkspaceManagerEvents(workspaceId: string, eventIds: string[], reason: string): Promise<string[]> {
    return this.transaction(async connection => {
      const dismissed: string[] = [];
      for (const id of new Set(eventIds)) {
        const rows = await (await connection.run(`UPDATE workspace_manager_event SET dismissed_at = now(), dismissed_reason = $reason
          WHERE workspace_id = $workspaceId AND id = $id AND delivery_turn_id IS NULL AND dismissed_at IS NULL
          RETURNING id`, { workspaceId, id, reason })).getRowObjectsJS();
        if (rows[0]) dismissed.push(String(rows[0].id));
      }
      return dismissed;
    });
  }

  async listWorkspaceManagers(): Promise<WorkspaceManagerRecord[]> {
    return this.read(async (connection) => (await (await connection.run(`SELECT * FROM workspace_manager`)).getRowObjectsJS()).map(toWorkspaceManager));
  }

  async workspaceManagerActivityTurns(sessionId: string): Promise<string[]> {
    return this.read(async (connection) => {
      const rows = await (await connection.run(`SELECT DISTINCT e.delivery_turn_id FROM workspace_manager_event e
        JOIN workspace_manager m ON m.workspace_id = e.workspace_id
        WHERE m.session_id = $sessionId AND e.delivery_turn_id IS NOT NULL`, { sessionId })).getRowObjectsJS();
      return rows.map(row => String(row.delivery_turn_id));
    });
  }

  async workspaceManagerSnapshot(workspaceId: string): Promise<WorkspaceManagerSnapshot> {
    const manager = await this.getWorkspaceManager(workspaceId);
    return this.read(async (connection) => {
      const rows = await (await connection.run(`SELECT s.id, s.title, s.cwd, s.description, s.parent_session_id, s.updated,
        t.id AS turn_id, t.status, t.pending_reason, t.runner_exit_code,
        CAST(t.runner_started AS VARCHAR) AS runner_started, CAST(t.created AS VARCHAR) AS turn_created,
        metrics.turn_number, metrics.queued_turns, metrics.updated_files,
        left(t.user_input, 600) AS latest_request, left(t.agent_response, 1200) AS latest_response,
        count(*) OVER () AS total_count,
        count(*) FILTER (WHERE t.status = 'running') OVER () AS running_count,
        count(*) FILTER (WHERE t.status = 'todo' AND t.pending_reason IS DISTINCT FROM 'stopped') OVER () AS pending_count
        FROM sessions s LEFT JOIN LATERAL (
          SELECT id, status, pending_reason, runner_exit_code, runner_started, created, user_input, agent_response FROM session_turn
          WHERE session_id = s.id ORDER BY (status = 'running') DESC,
            (status = 'todo' AND pending_reason IS DISTINCT FROM 'stopped') DESC, created DESC, id DESC LIMIT 1
        ) t ON true
        LEFT JOIN LATERAL (
          SELECT count(*) FILTER (WHERE st.created < t.created OR (st.created = t.created AND st.id <= t.id)) AS turn_number,
            count(*) FILTER (WHERE st.status = 'todo' AND st.pending_reason IS DISTINCT FROM 'stopped') AS queued_turns,
            (SELECT count(DISTINCT path) FROM session_turn edits
              CROSS JOIN LATERAL unnest(edits.changed_files) AS changed(path)
              WHERE edits.session_id = s.id AND t.status = 'running') AS updated_files
          FROM session_turn st WHERE st.session_id = s.id AND t.status = 'running'
        ) metrics ON true
        WHERE s.workspace_id = $workspaceId AND s.id <> $managerSessionId
          AND NOT EXISTS (SELECT 1 FROM workspace_manager_archive a WHERE a.session_id = s.id)
        ORDER BY (t.status = 'running') DESC NULLS LAST,
          (t.status = 'todo' AND t.pending_reason IS DISTINCT FROM 'stopped') DESC NULLS LAST, s.updated DESC
        LIMIT 100`, { workspaceId, managerSessionId: manager?.sessionId ?? "" })).getRowObjectsJS();
      const pending = await (await connection.run(`SELECT count(*) AS count FROM workspace_manager_event
        WHERE workspace_id = $workspaceId AND delivery_turn_id IS NULL AND dismissed_at IS NULL`, { workspaceId })).getRowObjectsJS();
      const runningModels = new Map<string, string | null>();
      for (const row of rows) {
        if (row.status !== "running" || !row.turn_id) continue;
        const turnId = String(row.turn_id);
        const turn = await this.getSessionTurnWithConnection(connection, turnId);
        const requestedModel = turn?.requestMetadata?.model;
        runningModels.set(turnId,
          turn?.model ?? (typeof requestedModel === "string" && requestedModel !== "auto" ? `${requestedModel} (requested)` : null));
      }
      return {
        manager, capturedAt: new Date().toISOString(), totalTasks: Number(rows[0]?.total_count ?? 0),
        runningTasks: Number(rows[0]?.running_count ?? 0), pendingTasks: Number(rows[0]?.pending_count ?? 0),
        pendingEvents: Number(pending[0]?.count ?? 0),
        tasks: rows.map(row => ({ sessionId: String(row.id), title: String(row.title), cwd: String(row.cwd),
          description: String(row.description).slice(0, 600), parentSessionId: nullableString(row.parent_session_id),
          updated: managerTimestamp(row.updated), turnId: nullableString(row.turn_id),
          status: row.status === "running" ? "running" : row.status === "todo" ? String(row.pending_reason ?? "queued")
            : row.runner_exit_code ? "failed" : "idle",
          pendingReason: nullableString(row.pending_reason), latestRequest: String(row.latest_request ?? ""),
          latestResponse: String(row.latest_response ?? ""),
          ...(row.status === "running" ? {
            runningSince: nullableString(row.runner_started),
            turnNumber: numberValue(row.turn_number), queuedTurns: numberValue(row.queued_turns),
            updatedFiles: numberValue(row.updated_files),
            runningModel: runningModels.get(String(row.turn_id)) ?? null
          } : {}) }))
      };
    });
  }

  /** A batch and its pending turn commit together, so restarts cannot lose or double-deliver a wake-up. */
  async queueWorkspaceManagerEvents(workspaceId: string): Promise<{ sessionId: string; turnId: string } | null> {
    return this.transaction(async (connection) => {
      const managers = await (await connection.run(`SELECT * FROM workspace_manager WHERE workspace_id = $workspaceId FOR UPDATE`, { workspaceId })).getRowObjectsJS();
      if (!managers[0] || managers[0].notifications_enabled !== true) return null;
      const manager = toWorkspaceManager(managers[0]);
      const active = await (await connection.run(`SELECT 1 FROM session_turn WHERE session_id = $sessionId
        AND (status = 'running' OR (status = 'todo' AND pending_reason IS DISTINCT FROM 'stopped')) LIMIT 1`, { sessionId: manager.sessionId })).getRowObjectsJS();
      if (active.length) return null;
      const rows = await (await connection.run(`SELECT * FROM workspace_manager_event
        WHERE workspace_id = $workspaceId AND delivery_turn_id IS NULL AND dismissed_at IS NULL
        ORDER BY created, id LIMIT 40 FOR UPDATE`, { workspaceId })).getRowObjectsJS();
      if (!rows.length) return null;
      const events: WorkspaceManagerEvent[] = rows.map(row => ({ id: String(row.id), workspaceId,
        sessionId: nullableString(row.session_id), turnId: nullableString(row.turn_id), type: String(row.type),
        summary: String(row.summary), created: managerTimestamp(row.created) }));
      const turnId = `manager_${createHash("sha256").update(events[0].id).digest("hex").slice(0, 32)}`;
      await this.insertSessionTurnWithConnection(connection, {
        id: turnId, sessionId: manager.sessionId, userInput: managerActivityPrompt(events),
        agentResponse: "Workspace activity awaiting review.", tokenIn: 0, tokenOut: 0,
        status: "todo", pendingReason: "queued"
      }, true);
      for (const event of events) await connection.run(`UPDATE workspace_manager_event SET delivery_turn_id = $turnId WHERE id = $id`, { turnId, id: event.id });
      return { sessionId: manager.sessionId, turnId };
    });
  }

  async getActiveWorkspace(): Promise<WorkspaceRecord> {
    return this.read(async (connection) => {
      const activeId = await this.getActiveWorkspaceIdWithConnection(connection);
      const workspace = activeId ? await this.getWorkspaceWithConnection(connection, activeId) : null;
      return workspace ?? (await this.ensureDefaultWorkspaceWithConnection(connection));
    });
  }

  async upsertWorkspace(input: { id?: string; name: string; codexHome: string; cwd: string }): Promise<WorkspaceRecord> {
    return this.write(async (connection) => {
      const id = input.id ?? createSlugId(input.name, "workspace");
      await connection.run(
        `
          INSERT INTO workspaces (id, name, codex_home, cwd, created, updated)
          VALUES ($id, $name, $codexHome, $cwd, now(), now())
          ON CONFLICT (id) DO UPDATE SET
            name = excluded.name,
            codex_home = excluded.codex_home,
            cwd = excluded.cwd,
            updated = now()
        `,
        {
          id,
          name: input.name,
          codexHome: input.codexHome,
          cwd: input.cwd
        }
      );
      const workspace = await this.getWorkspaceWithConnection(connection, id);
      if (!workspace) {
        throw new Error(`Failed to load workspace after upsert: ${id}`);
      }
      return workspace;
    });
  }

  async listComposerSuggestionKeywords(workspaceId: string): Promise<string[]> {
    return this.read(async (connection) => {
      const entries = await this.listComposerSuggestionKeywordsWithConnection(connection, workspaceId);
      return entries.map((entry) => entry.keyword);
    });
  }

  async addComposerSuggestionKeywords(workspaceId: string, values: unknown): Promise<string[]> {
    const keywords = normalizeComposerSuggestionKeywords(values);
    return this.write(async (connection) => {
      const existing = await this.listComposerSuggestionKeywordsWithConnection(connection, workspaceId);
      const seen = new Set(existing.map((entry) => entry.keyword.toLocaleLowerCase()));
      let position = existing.length;
      for (const keyword of keywords) {
        if (seen.has(keyword.toLocaleLowerCase()) || position >= 100) continue;
        await connection.run(
          `
            INSERT INTO composer_suggestion_keyword (workspace_id, keyword, position, created, updated)
            VALUES ($workspaceId, $keyword, $position, now(), now())
          `,
          { workspaceId, keyword, position }
        );
        seen.add(keyword.toLocaleLowerCase());
        position += 1;
      }
      const entries = await this.listComposerSuggestionKeywordsWithConnection(connection, workspaceId);
      return entries.map((entry) => entry.keyword);
    });
  }

  async replaceComposerSuggestionKeywords(workspaceId: string, values: unknown): Promise<string[]> {
    const keywords = normalizeComposerSuggestionKeywords(values);
    return this.write(async (connection) => {
      await connection.run(`DELETE FROM composer_suggestion_keyword WHERE workspace_id = $workspaceId`, { workspaceId });
      for (const [position, keyword] of keywords.entries()) {
        await connection.run(
          `
            INSERT INTO composer_suggestion_keyword (workspace_id, keyword, position, created, updated)
            VALUES ($workspaceId, $keyword, $position, now(), now())
          `,
          { workspaceId, keyword, position }
        );
      }
      return keywords;
    });
  }

  async removeComposerSuggestionKeyword(workspaceId: string, keyword: string): Promise<string[]> {
    const normalized = normalizeComposerSuggestionKeywords([keyword])[0];
    if (!normalized) return this.listComposerSuggestionKeywords(workspaceId);
    return this.write(async (connection) => {
      await connection.run(
        `DELETE FROM composer_suggestion_keyword WHERE workspace_id = $workspaceId AND lower(keyword) = lower($keyword)`,
        { workspaceId, keyword: normalized }
      );
      const entries = await this.listComposerSuggestionKeywordsWithConnection(connection, workspaceId);
      for (const [position, entry] of entries.entries()) {
        if (entry.position === position) continue;
        await connection.run(
          `UPDATE composer_suggestion_keyword SET position = $position, updated = now() WHERE workspace_id = $workspaceId AND keyword = $keyword`,
          { workspaceId, keyword: entry.keyword, position }
        );
      }
      return entries.map((entry) => entry.keyword);
    });
  }

  async switchWorkspace(id: string): Promise<WorkspaceRecord> {
    return this.write(async (connection) => {
      const workspace = await this.getWorkspaceWithConnection(connection, id);
      if (!workspace) {
        throw new Error(`Workspace not found: ${id}`);
      }
      await connection.run(
        `
          INSERT INTO active_workspace (key, workspace_id, updated)
          VALUES ('active', $id, now())
          ON CONFLICT (key) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            updated = now()
        `,
        { id }
      );
      return workspace;
    });
  }

  async listAccounts(): Promise<AccountRecord[]> {
    return this.read(async (connection) => {
      const result = await connection.run(`
        SELECT
          id,
          name,
          external_account_id,
          external_user_id,
          email,
          CASE WHEN auth_json IS NOT NULL AND auth_json <> '' THEN true ELSE false END AS has_auth,
          auth_version,
          CAST(quota_snapshot AS VARCHAR) AS quota_snapshot,
          CAST(quota_updated_at AS VARCHAR) AS quota_updated_at,
          quota_error,
          CAST(created AS VARCHAR) AS created,
          CAST(updated AS VARCHAR) AS updated,
          CAST(last_used AS VARCHAR) AS last_used
        FROM accounts
        ORDER BY lower(coalesce(nullif(name, ''), nullif(email, ''), nullif(external_account_id, ''), id)), id
      `);
      return (await result.getRowObjectsJS()).map(toAccountRecord);
    });
  }

  async listWorkspaceAccountIds(workspaceId: string): Promise<string[]> {
    return this.read(async (connection) => {
      const result = await connection.run(
        `
          SELECT account_id
          FROM workspace_account
          WHERE workspace_id = $workspaceId
          ORDER BY created ASC, account_id ASC
        `,
        { workspaceId }
      );
      const rows = await result.getRowObjectsJS();
      return rows.flatMap((row) => (typeof row.account_id === "string" ? [row.account_id] : []));
    });
  }

  async listAccountsForWorkspace(workspaceId: string): Promise<AccountRecord[]> {
    return this.read(async (connection) => {
      const result = await connection.run(
        `
          SELECT
            accounts.id,
            accounts.name,
            accounts.external_account_id,
            accounts.external_user_id,
            accounts.email,
            CASE WHEN accounts.auth_json IS NOT NULL AND accounts.auth_json <> '' THEN true ELSE false END AS has_auth,
            accounts.auth_version,
            CAST(accounts.quota_snapshot AS VARCHAR) AS quota_snapshot,
            CAST(accounts.quota_updated_at AS VARCHAR) AS quota_updated_at,
            accounts.quota_error,
            CAST(accounts.created AS VARCHAR) AS created,
            CAST(accounts.updated AS VARCHAR) AS updated,
            CAST(accounts.last_used AS VARCHAR) AS last_used
          FROM workspace_account
          JOIN accounts ON accounts.id = workspace_account.account_id
          WHERE workspace_account.workspace_id = $workspaceId
          ORDER BY lower(coalesce(nullif(accounts.name, ''), nullif(accounts.email, ''), nullif(accounts.external_account_id, ''), accounts.id)), accounts.id
        `,
        { workspaceId }
      );
      return (await result.getRowObjectsJS()).map(toAccountRecord);
    });
  }

  async isAccountBoundToWorkspace(workspaceId: string, accountId: string): Promise<boolean> {
    return this.read(async (connection) => {
      const result = await connection.run(
        `
          SELECT 1 AS found
          FROM workspace_account
          WHERE workspace_id = $workspaceId
            AND account_id = $accountId
          LIMIT 1
        `,
        { workspaceId, accountId }
      );
      return (await result.getRowObjectsJS()).length > 0;
    });
  }

  async bindWorkspaceAccount(workspaceId: string, accountId: string): Promise<void> {
    await this.write(async (connection) => {
      const workspace = await this.getWorkspaceWithConnection(connection, workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${workspaceId}`);
      }
      const account = await this.getAccountWithConnection(connection, accountId);
      if (!account) {
        throw new Error(`Account not found: ${accountId}`);
      }

      await connection.run(
        `
          INSERT INTO workspace_account (workspace_id, account_id, created)
          VALUES ($workspaceId, $accountId, now())
          ON CONFLICT (workspace_id, account_id) DO NOTHING
        `,
        { workspaceId, accountId }
      );
    });
  }

  async unbindWorkspaceAccount(workspaceId: string, accountId: string): Promise<void> {
    await this.write(async (connection) => {
      await connection.run(
        `
          DELETE FROM workspace_account
          WHERE workspace_id = $workspaceId
            AND account_id = $accountId
        `,
        { workspaceId, accountId }
      );
    });
  }

  async deleteAccount(accountId: string): Promise<boolean> {
    return this.write(async (connection) => {
      await connection.run("BEGIN TRANSACTION");
      try {
        const existing = await connection.run(
          "SELECT 1 AS found FROM accounts WHERE id = $accountId LIMIT 1",
          { accountId }
        );
        if ((await existing.getRowObjectsJS()).length === 0) {
          await connection.run("ROLLBACK");
          return false;
        }

        await connection.run(
          "UPDATE active_account SET account_id = NULL, updated = now() WHERE account_id = $accountId",
          { accountId }
        );
        await connection.run(
          "DELETE FROM workspace_account WHERE account_id = $accountId",
          { accountId }
        );
        // Sessions retain their transcript history, while future turns must
        // explicitly select another saved account.
        await connection.run(
          "UPDATE sessions SET account_id = NULL, updated = now() WHERE account_id = $accountId",
          { accountId }
        );
        await connection.run(
          `
            UPDATE session_turn
            SET account_id = NULL,
                account_name = NULL,
                account_email = NULL,
                account_external_account_id = NULL,
                account_external_user_id = NULL
            WHERE account_id = $accountId
              AND status = 'todo'
          `,
          { accountId }
        );
        await connection.run(
          "DELETE FROM accounts WHERE id = $accountId",
          { accountId }
        );
        await connection.run("COMMIT");
        return true;
      } catch (error) {
        await connection.run("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  async getFirstWorkspaceAccount(workspaceId: string): Promise<AccountRecord | null> {
    return this.read(async (connection) => {
      const result = await connection.run(
        `
          SELECT
            accounts.id,
            accounts.name,
            accounts.external_account_id,
            accounts.external_user_id,
            accounts.email,
            CASE WHEN accounts.auth_json IS NOT NULL AND accounts.auth_json <> '' THEN true ELSE false END AS has_auth,
            accounts.auth_version,
            CAST(accounts.quota_snapshot AS VARCHAR) AS quota_snapshot,
            CAST(accounts.quota_updated_at AS VARCHAR) AS quota_updated_at,
            accounts.quota_error,
            CAST(accounts.created AS VARCHAR) AS created,
            CAST(accounts.updated AS VARCHAR) AS updated,
            CAST(accounts.last_used AS VARCHAR) AS last_used
          FROM workspace_account
          JOIN accounts ON accounts.id = workspace_account.account_id
          WHERE workspace_account.workspace_id = $workspaceId
          ORDER BY accounts.last_used DESC NULLS LAST, accounts.updated DESC, accounts.name ASC
          LIMIT 1
        `,
        { workspaceId }
      );
      const rows = await result.getRowObjectsJS();
      return rows.length > 0 ? toAccountRecord(rows[0] as AccountRow) : null;
    });
  }

  async getAccount(id: string): Promise<AccountRecord | null> {
    return this.read(async (connection) => this.getAccountWithConnection(connection, id));
  }

  async getAccountAuth(id: string): Promise<AccountAuthRecord | null> {
    return this.read(async (connection) => {
      const result = await connection.run(
        `
          SELECT auth_json, config_toml, auth_version
          FROM accounts
          WHERE id = $id
            AND auth_json IS NOT NULL
            AND auth_json <> ''
        `,
        { id }
      );
      const rows = await result.getRowObjectsJS();
      const row = rows[0];
      if (!row || typeof row.auth_json !== "string") {
        return null;
      }
      return {
        authRaw: row.auth_json,
        configRaw: nullableString(row.config_toml),
        version: numberValue(row.auth_version)
      };
    });
  }

  async setAccountAuth(
    id: string,
    authRaw: string,
    configRaw: string | null
  ): Promise<AccountAuthWriteResult> {
    return this.write(async (connection) => {
      const result = await connection.run(
        "SELECT auth_json, config_toml FROM accounts WHERE id = $id",
        { id }
      );
      const rows = await result.getRowObjectsJS();
      if (rows.length === 0) {
        throw new Error(`Account not found: ${id}`);
      }
      if (rows[0]?.auth_json === authRaw && nullableString(rows[0]?.config_toml) === configRaw) {
        await connection.run("UPDATE accounts SET snapshot_path = NULL WHERE id = $id", { id });
        return "unchanged";
      }
      await connection.run(
        `
          UPDATE accounts
          SET auth_json = $authRaw,
              config_toml = $configRaw,
              auth_version = auth_version + 1,
              snapshot_path = NULL,
              updated = now()
          WHERE id = $id
        `,
        { id, authRaw, configRaw }
      );
      return "updated";
    });
  }

  async compareAndSetAccountAuth(
    id: string,
    expectedVersion: number,
    authRaw: string,
    configRaw: string | null
  ): Promise<AccountAuthWriteResult> {
    return this.write(async (connection) => {
      const result = await connection.run(
        "SELECT auth_json, config_toml, auth_version FROM accounts WHERE id = $id",
        { id }
      );
      const rows = await result.getRowObjectsJS();
      if (rows.length === 0) {
        return "conflict";
      }
      if (rows[0]?.auth_json === authRaw && nullableString(rows[0]?.config_toml) === configRaw) {
        return "unchanged";
      }
      if (numberValue(rows[0]?.auth_version) !== expectedVersion) {
        return "conflict";
      }
      await connection.run(
        `
          UPDATE accounts
          SET auth_json = $authRaw,
              config_toml = $configRaw,
              auth_version = auth_version + 1,
              snapshot_path = NULL,
              updated = now()
          WHERE id = $id
            AND auth_version = $expectedVersion
        `,
        { id, expectedVersion, authRaw, configRaw }
      );
      return "updated";
    });
  }

  async listLegacyAccountAuthSources(): Promise<LegacyAccountAuthSource[]> {
    return this.read(async (connection) => {
      const result = await connection.run(`
        SELECT id, snapshot_path
        FROM accounts
        WHERE (auth_json IS NULL OR auth_json = '')
          AND snapshot_path IS NOT NULL
          AND snapshot_path <> ''
      `);
      const rows = await result.getRowObjectsJS();
      return rows.flatMap((row) =>
        typeof row.id === "string" && typeof row.snapshot_path === "string"
          ? [{ accountId: row.id, snapshotPath: row.snapshot_path }]
          : []
      );
    });
  }

  async clearLegacyAccountAuthSource(id: string): Promise<void> {
    await this.write(async (connection) => {
      await connection.run(
        "UPDATE accounts SET snapshot_path = NULL, updated = now() WHERE id = $id",
        { id }
      );
    });
  }

  async getActiveAccount(workspaceId?: string): Promise<AccountRecord | null> {
    return this.read(async (connection) => {
      const targetWorkspaceId = workspaceId ?? await this.getActiveWorkspaceIdWithConnection(connection);
      if (!targetWorkspaceId) {
        return null;
      }
      const result = await connection.run(
        "SELECT account_id FROM active_account WHERE key = $workspaceId",
        { workspaceId: targetWorkspaceId }
      );
      const rows = await result.getRowObjectsJS();
      const id = typeof rows[0]?.account_id === "string" ? rows[0].account_id : null;
      return id ? await this.getAccountWithConnection(connection, id) : null;
    });
  }

  async listAutoLoadBalanceWorkspaceIds(): Promise<string[]> {
    return this.read(async (connection) => {
      const result = await connection.run(`
        SELECT key
        FROM active_account
        WHERE load_balance = TRUE
        ORDER BY key
      `);
      const rows = await result.getRowObjectsJS();
      return rows.flatMap((row) => typeof row.key === "string" ? [row.key] : []);
    });
  }

  async setWorkspaceAutoLoadBalance(workspaceId: string, enabled: boolean): Promise<void> {
    await this.write(async (connection) => {
      await connection.run(
        `
          INSERT INTO active_account (key, account_id, load_balance, updated)
          VALUES ($workspaceId, NULL, $enabled, now())
          ON CONFLICT (key) DO UPDATE SET
            load_balance = excluded.load_balance,
            updated = now()
        `,
        { workspaceId, enabled }
      );
    });
  }

  async upsertAccount(input: {
    id?: string;
    name: string;
    externalAccountId?: string | null;
    externalUserId?: string | null;
    email?: string | null;
    quotaSnapshot?: unknown;
    quotaUpdatedAt?: string | null;
    quotaError?: string | null;
  }): Promise<AccountRecord> {
    return this.write(async (connection) => {
      const id = input.id ?? createSlugId(input.name, "account");
      await connection.run(
        `
          INSERT INTO accounts (
            id,
            name,
            external_account_id,
            external_user_id,
            email,
            quota_snapshot,
            quota_updated_at,
            quota_error,
            created,
            updated,
            last_used
          )
          VALUES (
            $id,
            $name,
            $externalAccountId,
            $externalUserId,
            $email,
            $quotaSnapshot::JSON,
            $quotaUpdatedAt,
            $quotaError,
            now(),
            now(),
            now()
          )
          ON CONFLICT (id) DO UPDATE SET
            name = excluded.name,
            external_account_id = COALESCE(excluded.external_account_id, accounts.external_account_id),
            external_user_id = COALESCE(excluded.external_user_id, accounts.external_user_id),
            email = COALESCE(excluded.email, accounts.email),
            quota_snapshot = COALESCE(excluded.quota_snapshot, accounts.quota_snapshot),
            quota_updated_at = COALESCE(excluded.quota_updated_at, accounts.quota_updated_at),
            quota_error = excluded.quota_error,
            updated = now()
        `,
        {
          id,
          name: input.name,
          externalAccountId: input.externalAccountId ?? null,
          externalUserId: input.externalUserId ?? null,
          email: input.email ?? null,
          quotaSnapshot: JSON.stringify(input.quotaSnapshot ?? null),
          quotaUpdatedAt: input.quotaUpdatedAt ?? null,
          quotaError: input.quotaError ?? null
        }
      );
      const account = await this.getAccountWithConnection(connection, id);
      if (!account) {
        throw new Error(`Failed to load account after upsert: ${id}`);
      }
      return account;
    });
  }

  async switchAccount(id: string | null, workspaceId?: string): Promise<AccountRecord | null> {
    return this.write(async (connection) => {
      const targetWorkspaceId = workspaceId ?? await this.getActiveWorkspaceIdWithConnection(connection);
      if (!targetWorkspaceId) {
        throw new Error("No active workspace.");
      }
      if (id) {
        const account = await this.getAccountWithConnection(connection, id);
        if (!account) {
          throw new Error(`Account not found: ${id}`);
        }
        await connection.run(
          `
            INSERT INTO active_account (key, account_id, updated)
            VALUES ($workspaceId, $id, now())
            ON CONFLICT (key) DO UPDATE SET
              account_id = excluded.account_id,
              updated = now()
          `,
          { id, workspaceId: targetWorkspaceId }
        );
        await connection.run("UPDATE accounts SET last_used = now(), updated = now() WHERE id = $id", { id });
        return account;
      }

      await connection.run(
        `
        INSERT INTO active_account (key, account_id, updated)
        VALUES ($workspaceId, NULL, now())
        ON CONFLICT (key) DO UPDATE SET
          account_id = NULL,
          updated = now()
        `,
        { workspaceId: targetWorkspaceId }
      );
      return null;
    });
  }

  async recordSessionTurn(input: RecordSessionTurnInput): Promise<string> {
    return this.write(async (connection) => {
      const id = input.id ?? crypto.randomUUID();
      await this.insertSessionTurnWithConnection(connection, { ...input, id });
      await this.syncSessionUpdatedWithLastTurn(connection, input.sessionId);
      await this.refreshSessionTurnFtsIndex(connection);
      return id;
    });
  }

  async claimSessionTurn(input: RecordSessionTurnInput & { id: string }): Promise<SessionTurnClaimResult> {
    return this.write(async (connection) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const inserted = await this.insertSessionTurnWithConnection(
          connection,
          { ...input, status: "running", pendingReason: null },
          true
        );
        if (inserted) {
          await this.syncSessionUpdatedWithLastTurn(connection, input.sessionId);
          await this.refreshSessionTurnFtsIndex(connection);
          const turn = await this.getSessionTurnWithConnection(connection, input.id);
          if (!turn) throw new Error(`Failed to load claimed session turn: ${input.id}`);
          return { disposition: "started", turn };
        }

        const existing = await this.getSessionTurnWithConnection(connection, input.id);
        if (existing) {
          if (existing.sessionId !== input.sessionId) {
            throw new Error(`turnId already belongs to another session: ${input.id}`);
          }
          return {
            disposition: existing.status === "running"
              ? "reconnected"
              : existing.status === "todo"
                ? "queued"
                : "existing",
            turn: existing
          };
        }

        const runningTurn = await this.getLatestRunningTurnWithConnection(connection, input.sessionId);
        if (!runningTurn) continue;
        if (runningTurn.userInput === input.userInput) {
          return { disposition: "reconnected", turn: runningTurn };
        }

        const queued = await this.insertSessionTurnWithConnection(
          connection,
          {
            ...input,
            status: "todo",
            pendingReason: "queued",
            agentResponse: "Queued. Waiting for the current turn to finish."
          },
          true
        );
        const turn = await this.getSessionTurnWithConnection(connection, input.id);
        if (!turn) throw new Error(`Failed to load queued session turn: ${input.id}`);
        if (queued) {
          await this.syncSessionUpdatedWithLastTurn(connection, input.sessionId);
          await this.refreshSessionTurnFtsIndex(connection);
        }
        return { disposition: "queued", turn };
      }

      throw new Error(`Unable to claim a writer for session ${input.sessionId}.`);
    });
  }

  async claimPendingSessionTurn(
    turnId: string,
    sessionId: string,
    runnerLogPath: string | null = null
  ): Promise<PendingSessionTurnClaimResult> {
    return this.write(async (connection) => {
      const existing = await this.getSessionTurnWithConnection(connection, turnId);
      if (!existing || existing.sessionId !== sessionId) {
        return { disposition: "missing", turn: existing, runningTurn: null };
      }
      if (existing.status === "running") {
        return { disposition: "already_running", turn: existing, runningTurn: existing };
      }
      if (existing.status === "done") {
        return { disposition: "completed", turn: existing, runningTurn: null };
      }

      try {
        const result = await connection.run(
          `
            UPDATE session_turn AS pending_turn
            SET
              status = 'running',
              pending_reason = coalesce(pending_reason, 'queued'),
              runner_pid = NULL,
              runner_started = NULL,
              runner_heartbeat = now(),
              runner_log_path = $runnerLogPath,
              runner_exit_code = NULL,
              last_event_name = 'runner.claimed'
            WHERE pending_turn.id = $turnId
              AND pending_turn.session_id = $sessionId
              AND pending_turn.status = 'todo'
              AND pending_turn.pending_reason IS DISTINCT FROM 'stopped'
              AND pending_turn.last_event_name IS DISTINCT FROM 'queue.steer_reserved'
              AND NOT EXISTS (
                SELECT 1
                FROM session_turn AS active_turn
                WHERE active_turn.session_id = pending_turn.session_id
                  AND active_turn.status = 'running'
              )
            RETURNING pending_turn.id
          `,
          { turnId, sessionId, runnerLogPath }
        );
        if ((await result.getRowObjectsJS()).length > 0) {
          const turn = await this.getSessionTurnWithConnection(connection, turnId);
          return { disposition: "started", turn, runningTurn: turn };
        }
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }

      const [turn, runningTurn] = await Promise.all([
        this.getSessionTurnWithConnection(connection, turnId),
        this.getLatestRunningTurnWithConnection(connection, sessionId)
      ]);
      if (turn?.status === "running") {
        return { disposition: "already_running", turn, runningTurn: turn };
      }
      if (turn?.status === "done") {
        return { disposition: "completed", turn, runningTurn };
      }
      return { disposition: "blocked", turn, runningTurn };
    });
  }

  async listSessionSideChats(sessionId: string) {
    return this.read(async (connection) => {
      if (!await this.getSessionWithConnection(connection, sessionId)) return null;
      const page = await this.listSessionSideChatsWithConnection(connection, {
        sessionId, limit: 100, offset: 0, order: "ASC"
      });
      return { sideChats: page.records, sideChatPage: { limit: 100, offset: 0, total: page.total, hasMore: page.total > page.records.length } };
    });
  }

  async recordSessionSideChat(input: RecordSessionSideChatInput): Promise<SessionSideChatRecord> {
    return this.write(async (connection) => {
      const id = input.id ?? `side_chat_${crypto.randomUUID()}`;
      await connection.run(
        `
          INSERT INTO session_side_chat (
            id,
            session_id,
            workspace_id,
            source_session_id,
            source_thread_id,
            source_turn_id,
            question,
            answer,
            model,
            context_turn_count,
            context_filter,
            mode,
            created
          )
          VALUES (
            $id,
            $sessionId,
            $workspaceId,
            $sourceSessionId,
            $sourceThreadId,
            $sourceTurnId,
            $question,
            $answer,
            $model,
            $contextTurnCount,
            $contextFilter,
            $mode,
            now()
          )
        `,
        {
          id,
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          sourceSessionId: input.sourceSessionId ?? null,
          sourceThreadId: input.sourceThreadId ?? null,
          sourceTurnId: input.sourceTurnId ?? null,
          question: input.question,
          answer: input.answer,
          model: input.model,
          contextTurnCount: input.contextTurnCount ?? 0,
          contextFilter: input.contextFilter ?? null,
          mode: input.mode ?? "forked_ephemeral"
        }
      );
      const result = await connection.run(
        `
          SELECT
            id,
            session_id,
            workspace_id,
            source_session_id,
            source_thread_id,
            source_turn_id,
            question,
            answer,
            model,
            context_turn_count,
            context_filter,
            mode,
            CAST(created AS VARCHAR) AS created
          FROM session_side_chat
          WHERE id = $id
        `,
        { id }
      );
      const rows = await result.getRowObjectsJS();
      if (rows.length === 0) {
        throw new Error(`Side chat not found after insert: ${id}`);
      }
      return toSessionSideChatRecord(rows[0] as SessionSideChatRow);
    });
  }

  async importLocalCodexSessionFile(input: {
    path: string;
    codexHome?: string | null;
    workspaceId?: string | null;
    rawEvents?: boolean;
  }): Promise<ImportLocalCodexSessionFileResult> {
    const source = localCodexSessionFile(input.path, input.codexHome);
    const parsed = parseLocalCodexSessionFile(source);
    const workspaceId = normalizeText(input.workspaceId);
    if (workspaceId) {
      parsed.workspaceId = workspaceId;
    }
    if (parsed.ignored) {
      await this.write(async (connection) => {
        await this.deleteImportedLocalIncompleteTurnsForPathWithConnection(connection, parsed);
        parsed.sessionId = null;
        await this.upsertImportedLocalSessionFileWithConnection(connection, parsed);
      });
      return {
        path: parsed.path,
        sessionId: null,
        threadId: parsed.threadId,
        turns: 0,
        events: 0,
        skipped: true
      };
    }
    if (!parsed.sessionId || isLocalMaintenanceSummarizerSession(parsed)) {
      return {
        path: parsed.path,
        sessionId: parsed.sessionId,
        threadId: parsed.threadId,
        turns: 0,
        events: 0,
        skipped: true
      };
    }
    let reconciledManagedTurnCount = 0;
    let importedExternalManagedTurnCount = 0;
    let importedExternalManagedEventCount = 0;
    let skippedManagedSession = false;
    await this.write(async (connection) => {
      let committed = false;
      await connection.run("BEGIN TRANSACTION");
      try {
        if (parsed.threadId) {
          const existingThreadSession = await this.getSessionByThreadIdWithConnection(
            connection,
            parsed.threadId,
            parsed.workspaceId
          );
          if (existingThreadSession) {
            parsed.sessionId = existingThreadSession.id;
          }
        }
        const importedSessionId = parsed.sessionId;
        if (!importedSessionId) {
          throw new Error(`Imported local Codex session has no session id: ${parsed.path}`);
        }

        if (await this.isManagerOwnedSessionWithConnection(connection, importedSessionId)) {
          await this.deleteImportedLocalTurnsForManagedSessionWithConnection(connection, importedSessionId);
          const managedNativeTurnLinks = await this.listManagedRunnerNativeTurnLinksWithConnection(connection, importedSessionId);
          reconciledManagedTurnCount = await this.reconcileRunningManagerOwnedLocalTurnsWithConnection(
            connection,
            parsed,
            managedNativeTurnLinks
          );
          const externalImport = await this.importUnmatchedLocalTurnsForManagedSessionWithConnection(
            connection,
            parsed,
            input.rawEvents !== false,
            managedNativeTurnLinks
          );
          importedExternalManagedTurnCount = externalImport.turns;
          importedExternalManagedEventCount = externalImport.events;
          skippedManagedSession = reconciledManagedTurnCount === 0 && importedExternalManagedTurnCount === 0;
        } else {
          await this.deleteImportedLocalIncompleteTurnsWithConnection(connection, parsed);
          await this.upsertImportedLocalSessionWithConnection(connection, parsed);
          await this.reconcileImportedLocalTurnIdsWithConnection(connection, parsed);
          for (const turn of parsed.turns) {
            await this.upsertImportedLocalTurnWithConnection(connection, parsed, turn);
          }
          const completedTurnIds = new Set(parsed.turns.map((turn) => turn.id));
          await this.deleteImportedLocalLiveItemsWithConnection(connection, importedSessionId);
          for (const liveItem of parsed.liveItems) {
            if (completedTurnIds.has(liveItem.turnId)) {
              await this.upsertImportedLocalLiveItemWithConnection(connection, importedSessionId, liveItem);
            }
          }
          if (input.rawEvents !== false) {
            for (const event of parsed.events) {
              if (event.turnId && completedTurnIds.has(event.turnId) && shouldPersistImportedLocalAuditEvent(event)) {
                await this.upsertImportedLocalEventWithConnection(connection, parsed, event);
              }
            }
          }
        }
        await this.upsertImportedLocalSessionFileWithConnection(connection, parsed);
        await this.syncSessionUpdatedWithLastTurn(connection, importedSessionId);
        await connection.run("COMMIT");
        committed = true;
        await this.refreshSessionTurnFtsIndex(connection);
      } catch (error) {
        if (!committed) {
          await connection.run("ROLLBACK").catch(() => undefined);
        }
        throw error;
      }
    });

    if (skippedManagedSession) {
      return {
        path: parsed.path,
        sessionId: parsed.sessionId,
        threadId: parsed.threadId,
        turns: 0,
        events: 0,
        skipped: true
      };
    }

    return {
      path: parsed.path,
      sessionId: parsed.sessionId,
      threadId: parsed.threadId,
      turns: reconciledManagedTurnCount + importedExternalManagedTurnCount || parsed.turns.length,
      events: importedExternalManagedTurnCount > 0 ? importedExternalManagedEventCount : reconciledManagedTurnCount > 0 ? 0 : parsed.events.length,
      skipped: false
    };
  }

  async hasIncompleteImportedLocalTurns(sessionId: string): Promise<boolean> {
    return this.read(async (connection) => {
      const result = await connection.run(
        `
          SELECT 1 AS found
          FROM local_session_file
          WHERE session_id = $sessionId
            AND open_turn_count > 0
          LIMIT 1
        `,
        { sessionId }
      );
      return (await result.getRowObjectsJS()).length > 0;
    });
  }

  async cleanImportedLocalSessions(): Promise<void> {
    await this.write(async (connection) => {
      let committed = false;
      await connection.run("BEGIN TRANSACTION");
      try {
        await connection.run(`
          CREATE TEMP TABLE imported_session_ids ON COMMIT DROP AS
          SELECT DISTINCT session_id
          FROM local_session_file
          WHERE session_id IS NOT NULL
        `);
        await connection.run("DELETE FROM token_usage WHERE session_id IN (SELECT session_id FROM imported_session_ids)");
        await connection.run("DELETE FROM session_turn_token_usage_sample WHERE session_id IN (SELECT session_id FROM imported_session_ids)");
        await connection.run("DELETE FROM session_summary_state WHERE session_id IN (SELECT session_id FROM imported_session_ids)");
        await connection.run("DELETE FROM session_description_embedding WHERE session_id IN (SELECT session_id FROM imported_session_ids)");
        await connection.run("DELETE FROM codex_command_call WHERE session_id IN (SELECT session_id FROM imported_session_ids)");
        await connection.run("DELETE FROM session_live_item WHERE session_id IN (SELECT session_id FROM imported_session_ids)");
        await connection.run("DELETE FROM session_turn_event WHERE session_id IN (SELECT session_id FROM imported_session_ids)");
        await connection.run("DELETE FROM session_turn WHERE session_id IN (SELECT session_id FROM imported_session_ids)");
        await connection.run("DELETE FROM sessions WHERE id IN (SELECT session_id FROM imported_session_ids)");
        await connection.run("DELETE FROM local_session_event");
        await connection.run("DELETE FROM local_session_file");
        await connection.run("COMMIT");
        committed = true;
      } catch (error) {
        if (!committed) {
          await connection.run("ROLLBACK").catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async isLocalCodexSessionFileStale(path: string, fileMtime: Date): Promise<boolean> {
    const resolvedPath = resolveUserPath(path);
    return this.read(async (connection) => {
      const result = await connection.run(
        `
          SELECT
            CAST(local_session_file.file_mtime AS VARCHAR) AS file_mtime,
            (
              SELECT count(*)
              FROM session_turn AS manager_turn
              WHERE manager_turn.session_id = local_session_file.session_id
                AND manager_turn.runner_log_path IS NOT NULL
                AND (
                  manager_turn.status = 'running'
                  OR manager_turn.agent_response LIKE 'Codex error: thread % already has an active writer%'
                )
            ) AS manager_turn_needs_reconciliation
          FROM local_session_file
          WHERE local_session_file.path = $path
        `,
        { path: resolvedPath }
      );
      const rows = await result.getRowObjectsJS();
      const importedMtime = nullableString(rows[0]?.file_mtime);
      if (!importedMtime) {
        return true;
      }
      if (numberValue(rows[0]?.manager_turn_needs_reconciliation) > 0) {
        return true;
      }
      return Math.abs(Date.parse(importedMtime) - fileMtime.getTime()) >= 1;
    });
  }

  /**
   * Return transcript paths that were previously imported for one workspace.
   *
   * Codex stores a rollout beneath the date it was created, not the date of
   * its most recent turn. Keeping these paths lets the server poll continue to
   * follow an older, long-running thread after it has moved outside the small
   * recent-date discovery window.
   */
  async listImportedLocalCodexSessionFilePaths(workspaceId: string): Promise<string[]> {
    return this.read(async (connection) => {
      const result = await connection.run(
        `
          SELECT DISTINCT local_session_file.path
          FROM local_session_file
          LEFT JOIN sessions ON sessions.id = local_session_file.session_id
          WHERE coalesce(nullif(local_session_file.workspace_id, ''), sessions.workspace_id) = $workspaceId
          ORDER BY local_session_file.path ASC
        `,
        { workspaceId }
      );
      return (await result.getRowObjectsJS())
        .map((row) => nullableString(row.path))
        .filter((path): path is string => Boolean(path));
    });
  }

  async listImportedLocalSessionSyncState(): Promise<Array<{
    path: string;
    sessionId: string | null;
    threadId: string | null;
    allTurnIds: string[];
    importedTurnCount: number;
    storedTurnCount: number;
    fileModifiedAt: string | null;
    lastActionAt: string | null;
  }>> {
    return this.read(async (connection) => {
      const rowsResult = await connection.run(`
        SELECT
          local_session_file.path,
          local_session_file.session_id,
          sessions.thread_id,
          local_session_file.turn_count,
          CAST(local_session_file.file_mtime AS VARCHAR) AS file_modified_at,
          CAST(coalesce(local_session_file.updated, sessions.updated) AS VARCHAR) AS last_action_at,
          count(session_turn.id) AS stored_turn_count
        FROM local_session_file
        LEFT JOIN sessions ON sessions.id = local_session_file.session_id
        LEFT JOIN session_turn ON session_turn.session_id = local_session_file.session_id
        GROUP BY
          local_session_file.path,
          local_session_file.session_id,
          sessions.thread_id,
          local_session_file.turn_count,
          local_session_file.file_mtime,
          local_session_file.updated,
          sessions.updated
      `);
      const turnRowsResult = await connection.run("SELECT id FROM session_turn");
      const allTurnIds = (await turnRowsResult.getRowObjectsJS()).map((row) => stringValue(row.id));
      return (await rowsResult.getRowObjectsJS()).map((row) => ({
        path: stringValue(row.path),
        sessionId: nullableString(row.session_id),
        threadId: nullableString(row.thread_id),
        allTurnIds,
        importedTurnCount: numberValue(row.turn_count),
        storedTurnCount: numberValue(row.stored_turn_count),
        fileModifiedAt: nullableString(row.file_modified_at),
        lastActionAt: nullableString(row.last_action_at)
      }));
    });
  }

  async assignSessionTurnAccount(id: string, account: SessionTurnAccountInput): Promise<void> {
    await this.write(async (connection) => {
      await connection.run(
        `
          UPDATE session_turn
          SET
            account_id = $accountId,
            account_name = $accountName,
            account_email = $accountEmail,
            account_external_account_id = $accountExternalAccountId,
            account_external_user_id = $accountExternalUserId
          WHERE id = $id
        `,
        {
          id,
          accountId: account.accountId,
          accountName: account.accountName ?? null,
          accountEmail: account.accountEmail ?? null,
          accountExternalAccountId: account.accountExternalAccountId ?? null,
          accountExternalUserId: account.accountExternalUserId ?? null
        }
      );
    });
  }

  async recordTokenUsage(entries: TokenUsageInput[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    await this.write(async (connection) => {
      for (const entry of entries) {
        await connection.run(
          `
            INSERT INTO token_usage (
              id, usage_type, source, workspace_id, session_id, turn_id, account_id, model,
              source_index, source_timestamp, input_tokens, cached_input_tokens,
              output_tokens, reasoning_output_tokens, total_tokens,
              cumulative_input_tokens, cumulative_cached_input_tokens, cumulative_output_tokens,
              cumulative_reasoning_output_tokens, cumulative_total_tokens, model_context_window,
              primary_used_percent, secondary_used_percent, primary_resets_at, secondary_resets_at,
              plan_type, window_key, used_percent_before, used_percent_after, used_percent_delta,
              tokens_per_used_percent, metadata, created, updated
            )
            VALUES (
              $id, $usageType, $source,
              COALESCE(
                $workspaceId,
                (SELECT workspace_id FROM sessions WHERE id = $sessionId),
                (SELECT session.workspace_id FROM session_turn AS turn JOIN sessions AS session ON session.id = turn.session_id WHERE turn.id = $turnId)
              ),
              COALESCE($sessionId, (SELECT session_id FROM session_turn WHERE id = $turnId)),
              $turnId,
              COALESCE($accountId, (SELECT account_id FROM session_turn WHERE id = $turnId)),
              COALESCE($model, (SELECT model FROM token_usage WHERE id = 'agent:turn:' || $turnId)),
              $sourceIndex, $sourceTimestamp, $inputTokens, $cachedInputTokens,
              $outputTokens, $reasoningOutputTokens, $totalTokens,
              $cumulativeInputTokens, $cumulativeCachedInputTokens, $cumulativeOutputTokens,
              $cumulativeReasoningOutputTokens, $cumulativeTotalTokens, $modelContextWindow,
              $primaryUsedPercent, $secondaryUsedPercent, $primaryResetsAt, $secondaryResetsAt,
              $planType, $windowKey, $usedPercentBefore, $usedPercentAfter, $usedPercentDelta,
              $tokensPerUsedPercent, $metadata::JSON, now(), now()
            )
            ON CONFLICT (id) DO UPDATE SET
              source = excluded.source,
              workspace_id = COALESCE(excluded.workspace_id, token_usage.workspace_id),
              account_id = COALESCE(excluded.account_id, token_usage.account_id),
              model = COALESCE(excluded.model, token_usage.model),
              source_timestamp = excluded.source_timestamp,
              input_tokens = excluded.input_tokens,
              cached_input_tokens = excluded.cached_input_tokens,
              output_tokens = excluded.output_tokens,
              reasoning_output_tokens = excluded.reasoning_output_tokens,
              total_tokens = excluded.total_tokens,
              cumulative_input_tokens = excluded.cumulative_input_tokens,
              cumulative_cached_input_tokens = excluded.cumulative_cached_input_tokens,
              cumulative_output_tokens = excluded.cumulative_output_tokens,
              cumulative_reasoning_output_tokens = excluded.cumulative_reasoning_output_tokens,
              cumulative_total_tokens = excluded.cumulative_total_tokens,
              model_context_window = excluded.model_context_window,
              primary_used_percent = excluded.primary_used_percent,
              secondary_used_percent = excluded.secondary_used_percent,
              primary_resets_at = excluded.primary_resets_at,
              secondary_resets_at = excluded.secondary_resets_at,
              plan_type = excluded.plan_type,
              window_key = excluded.window_key,
              used_percent_before = excluded.used_percent_before,
              used_percent_after = excluded.used_percent_after,
              used_percent_delta = excluded.used_percent_delta,
              tokens_per_used_percent = excluded.tokens_per_used_percent,
              metadata = excluded.metadata,
              updated = now()
          `,
          {
            id: entry.id,
            usageType: entry.usageType,
            source: entry.source,
            workspaceId: entry.workspaceId ?? null,
            sessionId: entry.sessionId ?? null,
            turnId: entry.turnId ?? null,
            accountId: entry.accountId ?? null,
            model: entry.model ?? null,
            sourceIndex: entry.sourceIndex ?? null,
            sourceTimestamp: entry.sourceTimestamp ?? null,
            inputTokens: entry.inputTokens ?? 0,
            cachedInputTokens: entry.cachedInputTokens ?? 0,
            outputTokens: entry.outputTokens ?? 0,
            reasoningOutputTokens: entry.reasoningOutputTokens ?? 0,
            totalTokens: entry.totalTokens ?? 0,
            cumulativeInputTokens: entry.cumulativeInputTokens ?? 0,
            cumulativeCachedInputTokens: entry.cumulativeCachedInputTokens ?? 0,
            cumulativeOutputTokens: entry.cumulativeOutputTokens ?? 0,
            cumulativeReasoningOutputTokens: entry.cumulativeReasoningOutputTokens ?? 0,
            cumulativeTotalTokens: entry.cumulativeTotalTokens ?? 0,
            modelContextWindow: entry.modelContextWindow ?? null,
            primaryUsedPercent: entry.primaryUsedPercent ?? null,
            secondaryUsedPercent: entry.secondaryUsedPercent ?? null,
            primaryResetsAt: entry.primaryResetsAt ?? null,
            secondaryResetsAt: entry.secondaryResetsAt ?? null,
            planType: entry.planType ?? null,
            windowKey: entry.windowKey ?? null,
            usedPercentBefore: entry.usedPercentBefore ?? null,
            usedPercentAfter: entry.usedPercentAfter ?? null,
            usedPercentDelta: entry.usedPercentDelta ?? null,
            tokensPerUsedPercent: entry.tokensPerUsedPercent ?? null,
            metadata: stringifyStoredJson(entry.metadata ?? null)
          }
        );
      }
    });
  }

  async recordAccountTokenUsageRatios(samples: AccountTokenUsageRatioInput[]): Promise<void> {
    if (samples.length === 0) {
      return;
    }

    await this.recordTokenUsage(samples.map((sample) => ({
      id: `account:ratio:${sample.turnId}:${sample.windowKey}`,
      usageType: "account",
      source: "quota_ratio",
      turnId: sample.turnId,
      accountId: sample.accountId,
      windowKey: sample.windowKey,
      inputTokens: sample.tokenIn,
      outputTokens: sample.tokenOut,
      totalTokens: sample.tokenTotal,
      usedPercentBefore: sample.usedPercentBefore,
      usedPercentAfter: sample.usedPercentAfter,
      usedPercentDelta: sample.usedPercentDelta,
      tokensPerUsedPercent: sample.tokensPerUsedPercent,
      sourceTimestamp: sample.quotaUpdatedAt
    })));
  }

  async updateSessionTurn(input: UpdateSessionTurnInput): Promise<boolean> {
    return this.transaction(async (connection) => {
      const expectedStatusGuard = input.expectedStatus ? " AND status = $expectedStatus" : "";
      const expectedRunnerPidGuard = input.expectedRunnerPid === undefined
        ? ""
        : input.expectedRunnerPid === null
          ? " AND runner_pid IS NULL"
          : " AND runner_pid = $expectedRunnerPid";
      const expectedRunnerLogPathGuard = input.expectedRunnerLogPath === undefined
        ? ""
        : input.expectedRunnerLogPath === null
          ? " AND runner_log_path IS NULL"
          : " AND runner_log_path = $expectedRunnerLogPath";
      const result = await connection.run(
        `
          UPDATE session_turn
          SET
            agent_response = $agentResponse,
            token_in = $tokenIn,
            token_out = $tokenOut,
            status = $status,
            pending_reason = $pendingReason,
            pending_load_balance = $pendingLoadBalance,
            runner_exit_code = $runnerExitCode,
            runner_pid = CASE WHEN $status = 'running' THEN runner_pid ELSE NULL END,
            runner_heartbeat = now()
          WHERE id = $id${expectedStatusGuard}${expectedRunnerPidGuard}${expectedRunnerLogPathGuard}
          RETURNING id
        `,
        {
          id: input.id,
          agentResponse: input.agentResponse,
          tokenIn: input.tokenIn,
          tokenOut: input.tokenOut,
          status: input.status,
          pendingReason: input.pendingReason ?? null,
          pendingLoadBalance: input.pendingLoadBalance ?? null,
          runnerExitCode: input.runnerExitCode ?? null,
          ...(input.expectedStatus ? { expectedStatus: input.expectedStatus } : {}),
          ...(typeof input.expectedRunnerPid === "number" ? { expectedRunnerPid: input.expectedRunnerPid } : {}),
          ...(typeof input.expectedRunnerLogPath === "string" ? { expectedRunnerLogPath: input.expectedRunnerLogPath } : {})
        }
      );
      if ((await result.getRowObjectsJS()).length === 0) {
        return false;
      }
      const turn = await this.getSessionTurnWithConnection(connection, input.id);
      if (turn) {
        // Work completion adds no Grill discussion content and must not reopen ACK.
        // Consume the link once in the same transaction as terminal persistence.
        if (input.status === "done" && input.runnerExitCode === 0 && input.agentResponse.trim()) {
          const grills = await connection.run("SELECT turn_id, document FROM session_turn_grill WHERE session_id = $sessionId FOR UPDATE", { sessionId: turn.sessionId });
          for (const row of await grills.getRowObjectsJS()) {
            const saved = JSON.parse(String(row.document)) as TurnGrill;
            if (saved.workTurns?.[input.id] !== "pending") continue;
            const next = { ...saved, revision: saved.revision + 1,
              updated: new Date().toISOString(), workTurns: { ...saved.workTurns, [input.id]: "completed" } };
            await connection.run("UPDATE session_turn_grill SET revision = $revision, document = $document WHERE session_id = $sessionId AND turn_id = $turnId", { sessionId: turn.sessionId, turnId: String(row.turn_id), revision: next.revision, document: JSON.stringify(next) });
          }
        }
        await this.syncSessionUpdatedWithLastTurn(connection, turn.sessionId);
        await connection.run(
          `
            INSERT INTO token_usage (
              id, usage_type, source, session_id, turn_id, account_id, model,
              input_tokens, output_tokens, total_tokens, source_timestamp, created, updated
            )
            VALUES (
              $id, 'agent', 'turn_final', $sessionId, $turnId, $accountId, NULL,
              $inputTokens, $outputTokens, $totalTokens, now(), now(), now()
            )
            ON CONFLICT (id) DO UPDATE SET
              account_id = excluded.account_id,
              source = excluded.source,
              model = COALESCE(excluded.model, token_usage.model),
              input_tokens = excluded.input_tokens,
              output_tokens = excluded.output_tokens,
              total_tokens = excluded.total_tokens,
              source_timestamp = excluded.source_timestamp,
              updated = now()
          `,
          {
            id: `agent:turn:${input.id}`,
            sessionId: turn.sessionId,
            turnId: input.id,
            accountId: turn.accountId,
            inputTokens: input.tokenIn,
            outputTokens: input.tokenOut,
            totalTokens: input.tokenIn + input.tokenOut
          }
        );
      }
      await this.refreshSessionTurnFtsIndex(connection);
      return true;
    });
  }

  async updatePendingSessionTurn(input: UpdatePendingSessionTurnInput): Promise<SessionTurnRecord> {
    return this.write(async (connection) => {
      const existing = await this.getSessionTurnWithConnection(connection, input.id);
      if (!existing || existing.sessionId !== input.sessionId) {
        throw new Error(`Pending turn not found: ${input.id}`);
      }
      if (existing.status !== "todo" || existing.lastEventName === "queue.steer_reserved") {
        throw new Error("Only pending turns can be edited.");
      }

      await connection.run(
        `
          UPDATE session_turn
          SET user_input = $userInput, request_metadata = $requestMetadata
          WHERE id = $id
        `,
        {
          id: input.id,
          userInput: input.userInput,
          requestMetadata: JSON.stringify({ ...existing.requestMetadata, message: input.message ?? input.userInput })
        }
      );
      await this.syncSessionUpdatedWithLastTurn(connection, input.sessionId);
      await this.refreshSessionTurnFtsIndex(connection);
      const updated = await this.getSessionTurnWithConnection(connection, input.id);
      if (!updated) {
        throw new Error(`Failed to load pending turn after edit: ${input.id}`);
      }
      return updated;
    });
  }

  async deleteQueuedSessionTurn(id: string, sessionId: string, reservedForSteer = false): Promise<boolean> {
    return this.write(async (connection) => {
      const result = await connection.run(
        `DELETE FROM session_turn
         WHERE id = $id AND session_id = $sessionId AND status = 'todo'
           AND pending_reason = 'queued'
           AND (($reservedForSteer = true AND last_event_name = 'queue.steer_reserved')
             OR ($reservedForSteer = false AND last_event_name IS DISTINCT FROM 'queue.steer_reserved'))
         RETURNING id`,
        { id, sessionId, reservedForSteer }
      );
      if ((await result.getRowObjectsJS()).length === 0) return false;
      await connection.run("DELETE FROM session_turn_reference WHERE session_id = $sessionId AND turn_id = $id", { id, sessionId });
      await connection.run("DELETE FROM execution_approval_policy WHERE owner_id = $ownerId", { ownerId: `turn:${sessionId}:${id}` });
      await this.syncSessionUpdatedWithLastTurn(connection, sessionId);
      await this.refreshSessionTurnFtsIndex(connection);
      return true;
    });
  }

  async reserveQueuedSessionTurnForSteer(id: string, sessionId: string, runningTurnId: string): Promise<SessionTurnRecord | null> {
    return this.write(async (connection) => {
      const result = await connection.run(
        `UPDATE session_turn AS pending_turn
         SET last_event_name = 'queue.steer_reserved'
         WHERE pending_turn.id = $id AND pending_turn.session_id = $sessionId
           AND pending_turn.status = 'todo' AND pending_turn.pending_reason = 'queued'
           AND pending_turn.last_event_name IS DISTINCT FROM 'queue.steer_reserved'
           AND EXISTS (
             SELECT 1 FROM session_turn AS active_turn
             WHERE active_turn.id = $runningTurnId
               AND active_turn.session_id = pending_turn.session_id
               AND active_turn.status = 'running'
           )
         RETURNING pending_turn.id`,
        { id, sessionId, runningTurnId }
      );
      if ((await result.getRowObjectsJS()).length === 0) return null;
      return this.getSessionTurnWithConnection(connection, id);
    });
  }

  async restoreQueuedSessionTurnAfterSteerFailure(id: string, sessionId: string): Promise<boolean> {
    return this.write(async (connection) => {
      const result = await connection.run(
        `UPDATE session_turn
         SET last_event_name = 'queue.steer_failed'
         WHERE id = $id AND session_id = $sessionId AND status = 'todo'
           AND pending_reason = 'queued' AND last_event_name = 'queue.steer_reserved'
         RETURNING id`,
        { id, sessionId }
      );
      return (await result.getRowObjectsJS()).length > 0;
    });
  }

  async movePendingSessionTurn(input: {
    id: string;
    sessionId: string;
    direction: "up" | "down";
  }): Promise<SessionTurnRecord[]> {
    return this.write(async (connection) => {
      const turns = await this.listSessionTurnsWithConnection(connection, input.sessionId);
      const pendingTurns = turns.filter((turn) => turn.status === "todo" && turn.lastEventName !== "queue.steer_reserved");
      const currentIndex = pendingTurns.findIndex((turn) => turn.id === input.id);
      if (currentIndex < 0) {
        throw new Error(`Pending turn not found: ${input.id}`);
      }

      const targetIndex = input.direction === "up" ? currentIndex - 1 : currentIndex + 1;
      if (targetIndex < 0 || targetIndex >= pendingTurns.length) {
        return turns;
      }

      const current = pendingTurns[currentIndex];
      const target = pendingTurns[targetIndex];
      await connection.run(
        `
          UPDATE session_turn
          SET created = $targetCreated::TIMESTAMPTZ
          WHERE id = $currentId
        `,
        {
          currentId: current.id,
          targetCreated: target.created
        }
      );
      await connection.run(
        `
          UPDATE session_turn
          SET created = $currentCreated::TIMESTAMPTZ
          WHERE id = $targetId
        `,
        {
          targetId: target.id,
          currentCreated: current.created
        }
      );
      await this.syncSessionUpdatedWithLastTurn(connection, input.sessionId);
      return this.listSessionTurnsWithConnection(connection, input.sessionId);
    });
  }

  async markSessionTurnRunning(input: MarkSessionTurnRunningInput): Promise<boolean> {
    return this.write(async (connection) => {
      const result = await connection.run(
        `
          UPDATE session_turn
          SET
            status = 'running',
            runner_pid = $runnerPid,
            runner_started = coalesce(runner_started, now()),
            runner_heartbeat = now(),
            runner_log_path = $runnerLogPath,
            runner_exit_code = NULL,
            last_event_name = 'runner.started'
          WHERE id = $id
            AND status = 'running'
            AND (runner_log_path IS NULL OR runner_log_path = $runnerLogPath)
          RETURNING id
        `,
        {
          id: input.id,
          runnerPid: input.runnerPid,
          runnerLogPath: input.runnerLogPath
        }
      );
      return (await result.getRowObjectsJS()).length > 0;
    });
  }

  async recordSessionTurnEvent(input: RecordSessionTurnEventInput): Promise<void> {
    await this.write(async (connection) => {
      const eventId = input.id ?? crypto.randomUUID();
      if (input.eventName === "item") {
        const liveItem = await this.upsertSessionLiveItemWithConnection(connection, {
          ...input,
          id: eventId
        });
        await this.updateLockedTodoItemFileSummaryWithConnection(connection, input.sessionId, input.turnId, liveItem);
      } else {
        await connection.run(
          `
            INSERT INTO session_turn_event (
              id,
              turn_id,
              session_id,
              event_name,
              payload,
              created
            )
            VALUES (
              $id,
              $turnId,
              $sessionId,
              $eventName,
              $payload::JSON,
              now()
            )
            ON CONFLICT (id) DO NOTHING
          `,
          {
            id: eventId,
            turnId: input.turnId,
            sessionId: input.sessionId,
            eventName: input.eventName,
            payload: stringifyStoredJson(input.payload)
          }
        );
      }
      if (input.refreshRunnerHeartbeat !== false) {
        await connection.run(
          `
            UPDATE session_turn
            SET
              runner_heartbeat = now(),
              last_event_name = $eventName
            WHERE id = $turnId
          `,
          {
            turnId: input.turnId,
            eventName: input.eventName
          }
        );
      }
    });
  }

  /**
   * A managed Codex process has a native transcript turn id that differs from
   * the Threadex turn id. Persist their relationship when the Stop hook runs
   * so later local imports can identify the managed turn exactly instead of
   * guessing from the prompt text.
   */
  async linkManagedRunnerNativeTurn(input: LinkManagedRunnerNativeTurnInput): Promise<boolean> {
    const sessionId = normalizeText(input.sessionId);
    const managerTurnId = normalizeText(input.managerTurnId);
    const nativeTurnId = normalizeText(input.nativeTurnId);
    if (!sessionId || !managerTurnId || !nativeTurnId) {
      return false;
    }
    return this.write(async (connection) => {
      const managerTurn = await connection.run(
        `
          SELECT id
          FROM session_turn
          WHERE id = $managerTurnId
            AND session_id = $sessionId
        `,
        { managerTurnId, sessionId }
      );
      if ((await managerTurn.getRowObjectsJS()).length === 0) {
        return false;
      }
      if (!input.eventAlreadyRecorded) {
        await connection.run(
          `
            INSERT INTO session_turn_event (
              id,
              turn_id,
              session_id,
              event_name,
              payload,
              created
            )
            VALUES (
              $id,
              $managerTurnId,
              $sessionId,
              'runner.native_turn_link',
              $payload::JSON,
              now()
            )
            ON CONFLICT (id) DO NOTHING
          `,
          {
            id: `runner-native-turn-link:${shortHash(`${sessionId}:${managerTurnId}:${nativeTurnId}`)}`,
            managerTurnId,
            sessionId,
            payload: stringifyStoredJson({
              nativeTurnId,
              nativeSessionId: normalizeText(input.nativeSessionId) || null,
              transcriptPath: normalizeText(input.transcriptPath) || null
            })
          }
        );
      }
      // If the poller won the race before the runner could publish its exact
      // provenance link, remove only this known imported counterpart. The
      // manager-owned turn and any unrelated native follow-ups remain intact.
      await this.deleteImportedLocalTurnWithConnection(connection, sessionId, nativeTurnId);
      return true;
    });
  }

  private async upsertSessionLiveItemWithConnection(
    connection: SessionDbConnection,
    input: RecordSessionTurnEventInput & { id: string; created?: string | null }
  ): Promise<Record<string, unknown> | null> {
    const item = normalizeSessionLiveItemPayload(input.payload);
    if (!item) {
      return null;
    }
    const rawItemId = stringValue(item.id);
    const originThreadId = stringValue(item.originThreadId);
    const storageItemId = originThreadId ? JSON.stringify([originThreadId, rawItemId]) : rawItemId;
    const eventType = stringValue(item.eventType, "item.updated");
    const eventRank = sessionLiveItemEventRank(eventType);
    await connection.run(
      `
        INSERT INTO session_live_item (
          turn_id, item_id, session_id, item_type, event_type, event_rank, is_final,
          payload, source_event_id, jsonl_index, sequence, created, updated, finalized_at
        )
        VALUES (
          $turnId, $itemId, $sessionId, $itemType, $eventType, $eventRank, $isFinal,
          $payload::JSON, $sourceEventId, $jsonlIndex, $sequence,
          COALESCE($created::TIMESTAMPTZ, now()), COALESCE($created::TIMESTAMPTZ, now()),
          CASE WHEN $isFinal THEN COALESCE($created::TIMESTAMPTZ, now()) ELSE NULL END
        )
        ON CONFLICT (turn_id, item_id) DO UPDATE SET
          session_id = excluded.session_id,
          item_type = excluded.item_type,
          event_type = excluded.event_type,
          event_rank = excluded.event_rank,
          is_final = excluded.is_final,
          payload = excluded.payload,
          source_event_id = excluded.source_event_id,
          jsonl_index = excluded.jsonl_index,
          sequence = excluded.sequence,
          updated = excluded.updated,
          finalized_at = excluded.finalized_at
        WHERE session_live_item.source_event_id IS DISTINCT FROM excluded.source_event_id
          AND CASE
            WHEN session_live_item.jsonl_index IS NOT NULL AND excluded.jsonl_index IS NOT NULL
              THEN excluded.jsonl_index > session_live_item.jsonl_index
            WHEN session_live_item.jsonl_index IS NULL AND excluded.jsonl_index IS NOT NULL THEN true
            WHEN session_live_item.jsonl_index IS NOT NULL AND excluded.jsonl_index IS NULL THEN false
            WHEN session_live_item.sequence IS NOT NULL AND excluded.sequence IS NOT NULL
              THEN excluded.sequence > session_live_item.sequence
            WHEN session_live_item.sequence IS NULL AND excluded.sequence IS NOT NULL THEN true
            WHEN session_live_item.sequence IS NOT NULL AND excluded.sequence IS NULL THEN false
            ELSE excluded.event_rank >= session_live_item.event_rank
          END
      `,
      {
        turnId: input.turnId,
        itemId: storageItemId,
        sessionId: input.sessionId,
        itemType: stringValue(item.itemType),
        eventType,
        eventRank,
        isFinal: eventType === "item.completed",
        payload: stringifyStoredJson(item),
        sourceEventId: input.id,
        jsonlIndex: input.jsonlIndex ?? null,
        sequence: input.sequence ?? null,
        created: input.created ?? null
      }
    );
    const paths = changedFilePaths(item);
    if (paths.length) {
      await connection.run(
        `UPDATE session_turn SET changed_files = ARRAY(
          SELECT DISTINCT path FROM unnest(changed_files || $paths::TEXT[]) AS files(path) ORDER BY path
        ) WHERE id = $turnId AND session_id = $sessionId`,
        { paths, turnId: input.turnId, sessionId: input.sessionId }
      );
    }
    return item;
  }

  private async updateLockedTodoItemFileSummaryWithConnection(
    connection: SessionDbConnection,
    sessionId: string,
    turnId: string,
    item: Record<string, unknown> | null
  ): Promise<void> {
    const changedPaths = todoFileChangePaths(item);
    if (changedPaths.length === 0) {
      return;
    }
    const lockedItemsResult = await connection.run(
      `
        SELECT id, changed_files_json
        FROM session_todo_item
        WHERE session_id = $sessionId AND locked_by_turn_id = $turnId
      `,
      { sessionId, turnId }
    );
    const lockedItems = await lockedItemsResult.getRowObjectsJS();
    for (const lockedItem of lockedItems) {
      const files = new Set([
        ...stringArrayFromJson(lockedItem.changed_files_json),
        ...changedPaths
      ]);
      const changedFiles = [...files].sort();
      await connection.run(
        `
          UPDATE session_todo_item
          SET changed_file_count = $changedFileCount,
            changed_files_json = $changedFilesJson,
            updated = now()
          WHERE session_id = $sessionId AND id = $id
        `,
        {
          sessionId,
          id: stringValue(lockedItem.id),
          changedFileCount: changedFiles.length,
          changedFilesJson: JSON.stringify(changedFiles)
        }
      );
    }
  }

  async recordSessionTurnTokenUsageSamples(samples: SessionTurnTokenUsageSampleInput[]): Promise<void> {
    if (samples.length === 0) {
      return;
    }
    await this.recordTokenUsage(samples.map((sample) => ({
      id: `agent:sample:${sample.id ?? `${sample.turnId}:${sample.source}:${sample.sourceIndex ?? sample.sourceTimestamp ?? crypto.randomUUID()}`}`,
      usageType: "agent",
      source: sample.source,
      sessionId: sample.sessionId,
      turnId: sample.turnId,
      sourceIndex: sample.sourceIndex,
      sourceTimestamp: sample.sourceTimestamp,
      inputTokens: sample.inputTokens,
      cachedInputTokens: sample.cachedInputTokens,
      outputTokens: sample.outputTokens,
      reasoningOutputTokens: sample.reasoningOutputTokens,
      totalTokens: sample.totalTokens,
      cumulativeInputTokens: sample.cumulativeInputTokens,
      cumulativeCachedInputTokens: sample.cumulativeCachedInputTokens,
      cumulativeOutputTokens: sample.cumulativeOutputTokens,
      cumulativeReasoningOutputTokens: sample.cumulativeReasoningOutputTokens,
      cumulativeTotalTokens: sample.cumulativeTotalTokens,
      modelContextWindow: sample.modelContextWindow,
      primaryUsedPercent: sample.primaryUsedPercent,
      secondaryUsedPercent: sample.secondaryUsedPercent,
      primaryResetsAt: sample.primaryResetsAt,
      secondaryResetsAt: sample.secondaryResetsAt,
      planType: sample.planType
    })));
  }

  async recordCodexCommandCall(input: RecordCodexCommandCallInput): Promise<void> {
    const commandParts = commandHeadParts(input.command);
    await this.write(async (connection) => {
      await connection.run(
        `
          INSERT INTO codex_command_call (
            id,
            session_id,
            turn_id,
            item_id,
            first_event_id,
            last_event_id,
            first_jsonl_index,
            last_jsonl_index,
            command,
            command_length,
            response_length,
            command_part_1,
            command_part_2,
            command_part_3,
            status,
            exit_code,
            created,
            updated
          )
          VALUES (
            $id,
            $sessionId,
            $turnId,
            $itemId,
            $eventId,
            $eventId,
            $jsonlIndex,
            $jsonlIndex,
            $command,
            $commandLength,
            $responseLength,
            $commandPart1,
            $commandPart2,
            $commandPart3,
            $status,
            $exitCode,
            now(),
            now()
          )
          ON CONFLICT (id) DO UPDATE SET
            first_event_id = COALESCE(codex_command_call.first_event_id, excluded.first_event_id),
            last_event_id = COALESCE(excluded.last_event_id, codex_command_call.last_event_id),
            first_jsonl_index = CASE
              WHEN codex_command_call.first_jsonl_index IS NULL THEN excluded.first_jsonl_index
              WHEN excluded.first_jsonl_index IS NULL THEN codex_command_call.first_jsonl_index
              ELSE LEAST(codex_command_call.first_jsonl_index, excluded.first_jsonl_index)
            END,
            last_jsonl_index = CASE
              WHEN codex_command_call.last_jsonl_index IS NULL THEN excluded.last_jsonl_index
              WHEN excluded.last_jsonl_index IS NULL THEN codex_command_call.last_jsonl_index
              ELSE GREATEST(codex_command_call.last_jsonl_index, excluded.last_jsonl_index)
            END,
            command = excluded.command,
            command_length = excluded.command_length,
            response_length = GREATEST(codex_command_call.response_length, excluded.response_length),
            command_part_1 = excluded.command_part_1,
            command_part_2 = excluded.command_part_2,
            command_part_3 = excluded.command_part_3,
            status = excluded.status,
            exit_code = COALESCE(excluded.exit_code, codex_command_call.exit_code),
            updated = now()
        `,
        {
          id: `${input.turnId}:${input.itemId}`,
          sessionId: input.sessionId,
          turnId: input.turnId,
          itemId: input.itemId,
          eventId: input.eventId ?? null,
          jsonlIndex: input.jsonlIndex ?? null,
          command: input.command,
          commandLength: input.command.length,
          responseLength: input.responseLength,
          commandPart1: commandParts[0] ?? null,
          commandPart2: commandParts[1] ?? null,
          commandPart3: commandParts[2] ?? null,
          status: input.status,
          exitCode: input.exitCode ?? null
        }
      );
    });
  }

  async listRunningSessionTurns(): Promise<SessionTurnRecord[]> {
    return this.read(async (connection) => {
      const result = await connection.run(`
        SELECT
          id,
          session_id,
          account_id,
          user_input,
          agent_response,
          token_in,
          token_out,
          status,
          runner_pid,
          CAST(runner_started AS VARCHAR) AS runner_started,
          CAST(runner_heartbeat AS VARCHAR) AS runner_heartbeat,
          runner_log_path,
          runner_exit_code,
          last_event_name,
          pending_reason,
          CAST(created AS VARCHAR) AS created
        FROM session_turn
        WHERE status = 'running'
        ORDER BY runner_heartbeat ASC NULLS FIRST, created ASC
      `);
      return (await result.getRowObjectsJS()).map(toSessionTurnRecord);
    });
  }

  async getActiveSessionId(): Promise<string | null> {
    return this.read(async (connection) => {
      const workspaceId = await this.getActiveWorkspaceIdWithConnection(connection);
      if (!workspaceId) {
        return null;
      }
      const result = await connection.run(
        `
          SELECT active_session.session_id
          FROM active_session
          INNER JOIN sessions ON sessions.id = active_session.session_id
          WHERE active_session.key = $workspaceId
            AND sessions.workspace_id = $workspaceId
        `,
        { workspaceId }
      );
      const rows = await result.getRowObjectsJS();
      const value = rows[0]?.session_id;
      return typeof value === "string" ? value : null;
    });
  }

  async switchSession(id: string): Promise<SessionRecord> {
    return this.write(async (connection) => {
      const session = await this.getSessionWithConnection(connection, id);
      if (!session) {
        throw new Error(`Session not found: ${id}`);
      }

      await connection.run(
        `
          INSERT INTO active_session (key, session_id, updated)
          VALUES ($workspaceId, $id, now())
          ON CONFLICT (key) DO UPDATE SET
            session_id = excluded.session_id,
            updated = now()
        `,
        { id, workspaceId: session.workspaceId }
      );

      return session;
    });
  }

  async upsertSessionSummary(input: {
    sessionId: string;
    sourceHash: string;
    sourceTurnCount: number;
    sourceUpdated: string;
    summarizerModel: string;
    title?: string;
    keywordWeights?: KeywordWeights;
  }): Promise<SessionRecord> {
    return this.write(async (connection) => {
      const session = await this.getSessionWithConnection(connection, input.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${input.sessionId}`);
      }

      await connection.run(
        `
          UPDATE sessions
          SET
            keyword_weights = CASE
              WHEN $keywordWeights IS NULL THEN keyword_weights
              ELSE $keywordWeights::JSON
            END,
            title = CASE
              WHEN title_source IS DISTINCT FROM 'user' AND $title IS NOT NULL THEN $title
              ELSE title
            END,
            title_source = CASE
              WHEN title_source IS DISTINCT FROM 'user' AND $title IS NOT NULL THEN 'summarizer'
              ELSE title_source
            END
          WHERE id = $sessionId
        `,
        {
          sessionId: input.sessionId,
          title: normalizeText(input.title) ?? null,
          keywordWeights: input.keywordWeights ? JSON.stringify(input.keywordWeights) : null
        }
      );

      await connection.run(
        `
          INSERT INTO session_summary_state (
            session_id,
            source_hash,
            source_turn_count,
            source_updated,
            summarizer_model,
            summarized_at,
            updated
          )
          VALUES (
            $sessionId,
            $sourceHash,
            $sourceTurnCount,
            $sourceUpdated::TIMESTAMPTZ,
            $summarizerModel,
            now(),
            now()
          )
          ON CONFLICT (session_id) DO UPDATE SET
            source_hash = excluded.source_hash,
            source_turn_count = excluded.source_turn_count,
            source_updated = excluded.source_updated,
            summarizer_model = excluded.summarizer_model,
            summarized_at = excluded.summarized_at,
            updated = now()
        `,
        {
          sessionId: input.sessionId,
          sourceHash: input.sourceHash,
          sourceTurnCount: input.sourceTurnCount,
          sourceUpdated: input.sourceUpdated,
          summarizerModel: input.summarizerModel
        }
      );

      const updatedSession = await this.getSessionWithConnection(connection, input.sessionId);
      if (!updatedSession) {
        throw new Error(`Failed to load summarized session: ${input.sessionId}`);
      }
      return updatedSession;
    });
  }

  async refreshKeywordAppearance(workspaceId?: string | null) {
    const normalizedWorkspaceId = normalizeText(workspaceId);
    return this.write(async (connection) => {
      const sessions = await this.listSessionsWithConnection(connection, normalizedWorkspaceId);
      const countsByWorkspace = new Map<string, Map<string, number>>();

      for (const session of sessions) {
        const workspaceCounts = countsByWorkspace.get(session.workspaceId) ?? new Map<string, number>();
        const seen = new Set<string>();
        for (const keyword of Object.keys(session.keywordWeights)) {
          const normalized = normalizeKeywordToken(keyword);
          if (!normalized || seen.has(normalized)) {
            continue;
          }
          seen.add(normalized);
          workspaceCounts.set(normalized, (workspaceCounts.get(normalized) ?? 0) + 1);
        }
        countsByWorkspace.set(session.workspaceId, workspaceCounts);
      }

      const targetWorkspaceIds = normalizedWorkspaceId ? [normalizedWorkspaceId] : [...countsByWorkspace.keys()];
      for (const targetWorkspaceId of targetWorkspaceIds) {
        await connection.run(`DELETE FROM keyword_appearance WHERE workspace_id = $workspaceId`, {
          workspaceId: targetWorkspaceId
        });

        const workspaceCounts = countsByWorkspace.get(targetWorkspaceId) ?? new Map<string, number>();
        for (const [keyword, sessionCount] of workspaceCounts.entries()) {
          await connection.run(
            `
              INSERT INTO keyword_appearance (
                workspace_id,
                keyword,
                session_count,
                created,
                updated
              )
              VALUES (
                $workspaceId,
                $keyword,
                $sessionCount,
                now(),
                now()
              )
              ON CONFLICT (workspace_id, keyword) DO UPDATE SET
                session_count = excluded.session_count,
                updated = now()
            `,
            {
              workspaceId: targetWorkspaceId,
              keyword,
              sessionCount
            }
          );
        }
      }
    });
  }

  async getKeywordAppearanceWeights(workspaceId?: string | null) {
    const normalizedWorkspaceId = normalizeText(workspaceId);
    return this.read(async (connection) => {
      const rows = await this.getKeywordAppearanceRowsWithConnection(connection, normalizedWorkspaceId);
      if (rows.length === 0) {
        return {};
      }

      const max = rows.reduce((currentMax, row) => Math.max(currentMax, row.sessionCount), 0) || 1;
      return Object.fromEntries(
        rows.map((row) => [row.keyword, keywordAppearanceWeight(row.sessionCount, max)] as const)
      );
    });
  }

  async getKeywordAppearanceSessionCounts(workspaceId?: string | null) {
    return this.read(async (connection) => {
      const rows = await this.getKeywordAppearanceRowsWithConnection(connection, normalizeText(workspaceId));
      return new Map(rows.map((row) => [row.keyword, row.sessionCount] as const));
    });
  }

  async listSessionsForDescriptionEmbedding(input: {
    workspaceId?: string | null;
    sessionId?: string | null;
  } = {}): Promise<Array<{ id: string; description: string; existingModel: string; existingHash: string }>> {
    return this.read(async (connection) => {
      const where = ["length(trim(sessions.description)) > 0"];
      const params: Record<string, SessionDbValue> = {};
      const workspaceId = normalizeText(input.workspaceId);
      const sessionId = normalizeText(input.sessionId);
      if (workspaceId) {
        where.push("sessions.workspace_id = $workspaceId");
        params.workspaceId = workspaceId;
      }
      if (sessionId) {
        where.push("sessions.id = $sessionId");
        params.sessionId = sessionId;
      }

      const result = await connection.run(
        `
          SELECT
            sessions.id,
            sessions.description,
            session_description_embedding.model AS existing_model,
            session_description_embedding.description_hash AS existing_hash
          FROM sessions
          LEFT JOIN session_description_embedding
            ON session_description_embedding.session_id = sessions.id
          WHERE ${where.join(" AND ")}
          ORDER BY sessions.updated DESC, sessions.created DESC
        `,
        params
      );
      return (await result.getRowObjectsJS()).map((row) => ({
        id: stringValue(row.id),
        description: stringValue(row.description),
        existingModel: stringValue(row.existing_model),
        existingHash: stringValue(row.existing_hash)
      }));
    });
  }

  async upsertSessionDescriptionEmbedding(input: {
    sessionId: string;
    embedding: number[];
    model: string;
    descriptionHash: string;
  }): Promise<void> {
    return this.write(async (connection) => {
      const vectorSql = `[${input.embedding.map(formatEmbeddingNumber).join(",")}]::DOUBLE[]`;
      await connection.run(
        `
          INSERT INTO session_description_embedding (
            session_id,
            embedding,
            model,
            dimensions,
            description_hash,
            created,
            updated
          )
          VALUES (
            $sessionId,
            ${vectorSql},
            $model,
            $dimensions,
            $descriptionHash,
            now(),
            now()
          )
          ON CONFLICT (session_id) DO UPDATE SET
            embedding = excluded.embedding,
            model = excluded.model,
            dimensions = excluded.dimensions,
            description_hash = excluded.description_hash,
            updated = now()
        `,
        {
          sessionId: input.sessionId,
          model: input.model,
          dimensions: input.embedding.length,
          descriptionHash: input.descriptionHash
        }
      );
    });
  }

  async clearActiveSession(workspaceId?: string): Promise<void> {
    await this.write(async (connection) => {
      const targetWorkspaceId = workspaceId ?? await this.getActiveWorkspaceIdWithConnection(connection);
      if (!targetWorkspaceId) {
        return;
      }
      await connection.run(`
        INSERT INTO active_session (key, session_id, updated)
        VALUES ($workspaceId, NULL, now())
        ON CONFLICT (key) DO UPDATE SET
          session_id = NULL,
          updated = now()
      `, { workspaceId: targetWorkspaceId });
    });
  }

  normalizeMetadata(input: SessionMetadataInput, fallbackText: string) {
    const cleanFallbackText = stripTodoPlanOperationalSuffix(fallbackText);
    const title = normalizeText(stripTodoPlanOperationalSuffix(input.title ?? "")) ?? titleFromMessage(cleanFallbackText);
    const description =
      normalizeText(stripTodoPlanOperationalSuffix(input.description ?? "")) ??
      normalizeText(stripTodoPlanOperationalSuffix(input.desc ?? "")) ??
      cleanFallbackText.slice(0, 500);
    const parentSessionId =
      normalizeText(input.parentSessionId) ?? normalizeText(input.parent_session_id) ?? null;

    return {
      keywordWeights: normalizeKeywordWeights(input.keywordWeights) ?? {},
      title,
      description,
      parentSessionId
    };
  }

  private async open() {
    const connection = await openPostgresSessionConnection(undefined, this.postgresSchema);
    this.connection = connection;
    await connection.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id VARCHAR PRIMARY KEY,
        thread_id VARCHAR,
        workspace_id VARCHAR NOT NULL DEFAULT 'default',
        cwd VARCHAR NOT NULL DEFAULT '',
        account_id VARCHAR,
        keyword_weights JSON NOT NULL DEFAULT '{}'::JSON,
        title VARCHAR NOT NULL DEFAULT 'Untitled session',
        title_source VARCHAR NOT NULL DEFAULT 'initial',
        description VARCHAR NOT NULL DEFAULT '',
        parent_session_id VARCHAR,
        forked_from_turn_id VARCHAR,
        achieved_at TIMESTAMPTZ,
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id VARCHAR PRIMARY KEY,
        name VARCHAR NOT NULL,
        codex_home VARCHAR NOT NULL,
        cwd VARCHAR NOT NULL,
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run(`
      CREATE TABLE IF NOT EXISTS active_workspace (
        key VARCHAR PRIMARY KEY,
        workspace_id VARCHAR,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run(`CREATE TABLE IF NOT EXISTS workspace_manager (
      workspace_id VARCHAR PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id VARCHAR NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      notifications_enabled BOOLEAN NOT NULL DEFAULT true,
      created TIMESTAMPTZ NOT NULL DEFAULT now(), updated TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await connection.run(`CREATE TABLE IF NOT EXISTS workspace_manager_archive (
      session_id VARCHAR PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      workspace_id VARCHAR NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      replaced_by_session_id VARCHAR NOT NULL REFERENCES sessions(id),
      archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await connection.run(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_by_manager_session_id VARCHAR`);
    await connection.run(`CREATE TABLE IF NOT EXISTS workspace_manager_event (
      id VARCHAR PRIMARY KEY, workspace_id VARCHAR NOT NULL REFERENCES workspace_manager(workspace_id) ON DELETE CASCADE,
      session_id VARCHAR, turn_id VARCHAR, type VARCHAR NOT NULL, summary TEXT NOT NULL,
      created TIMESTAMPTZ NOT NULL DEFAULT now(), delivery_turn_id VARCHAR,
      dismissed_at TIMESTAMPTZ, dismissed_reason VARCHAR
    )`);
    // Early manager schemas required a task session; platform/process events have none.
    await connection.run(`ALTER TABLE workspace_manager_event ALTER COLUMN session_id DROP NOT NULL`);
    await connection.run(`ALTER TABLE workspace_manager_event ALTER COLUMN turn_id DROP NOT NULL`);
    await connection.run(`ALTER TABLE workspace_manager_event ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ`);
    await connection.run(`ALTER TABLE workspace_manager_event ADD COLUMN IF NOT EXISTS dismissed_reason VARCHAR`);
    await connection.run(`CREATE INDEX IF NOT EXISTS workspace_manager_inbox ON workspace_manager_event(workspace_id, created) WHERE delivery_turn_id IS NULL AND dismissed_at IS NULL`);
    await connection.run(`
      CREATE TABLE IF NOT EXISTS accounts (
        id VARCHAR PRIMARY KEY,
        name VARCHAR NOT NULL,
        external_account_id VARCHAR,
        external_user_id VARCHAR,
        email VARCHAR,
        snapshot_path VARCHAR,
        auth_json VARCHAR,
        config_toml VARCHAR,
        auth_version BIGINT NOT NULL DEFAULT 0,
        quota_snapshot JSON,
        quota_updated_at TIMESTAMPTZ,
        quota_error VARCHAR,
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        last_used TIMESTAMPTZ
      )
    `);
    const workspaceAccountTableExisted = await this.tableExists(connection, "workspace_account");
    await connection.run(`
      CREATE TABLE IF NOT EXISTS workspace_account (
        workspace_id VARCHAR NOT NULL,
        account_id VARCHAR NOT NULL,
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        PRIMARY KEY (workspace_id, account_id)
      )
    `);
    await connection.run(`
      CREATE TABLE IF NOT EXISTS active_account (
        key VARCHAR PRIMARY KEY,
        account_id VARCHAR,
        load_balance BOOLEAN NOT NULL DEFAULT FALSE,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run(`
      CREATE TABLE IF NOT EXISTS active_session (
        key VARCHAR PRIMARY KEY,
        session_id VARCHAR,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    // Before workspace-scoped selections, the sole `active` entry represented
    // the current session for the whole app. Preserve it for the workspace that
    // owns that session so an upgrade does not discard the visible conversation.
    await connection.run(`
      INSERT INTO active_session (key, session_id, updated)
      SELECT sessions.workspace_id, active_session.session_id, active_session.updated
      FROM active_session
      INNER JOIN sessions ON sessions.id = active_session.session_id
      WHERE active_session.key = 'active'
      ON CONFLICT (key) DO NOTHING
    `);
    await connection.run(`
      CREATE TABLE IF NOT EXISTS process_monitor (
        id VARCHAR PRIMARY KEY,
        workspace_id VARCHAR NOT NULL,
        label VARCHAR NOT NULL,
        command VARCHAR,
        executable VARCHAR,
        docker_image VARCHAR,
        docker_run_args JSON NOT NULL DEFAULT '[]'::JSON,
        args JSON NOT NULL DEFAULT '[]'::JSON,
        log_file VARCHAR,
        entry_points JSON NOT NULL DEFAULT '[]'::JSON,
        metric_monitors JSON NOT NULL DEFAULT '[]'::JSON,
        metric_readings JSON NOT NULL DEFAULT '[]'::JSON,
        entry_point VARCHAR,
        cwd VARCHAR NOT NULL,
        pid BIGINT,
        status VARCHAR NOT NULL DEFAULT 'starting',
        source_command_id VARCHAR,
        parameters JSON NOT NULL DEFAULT '[]'::JSON,
        parameter_values JSON NOT NULL DEFAULT '{}'::JSON,
        managed BOOLEAN NOT NULL DEFAULT false,
        remove_on_exit BOOLEAN NOT NULL DEFAULT false,
        wake_prompt VARCHAR,
        wake_session_id VARCHAR,
        wake_thread_id VARCHAR,
        timeout_at TIMESTAMPTZ,
        wake_status VARCHAR NOT NULL DEFAULT 'none',
        wake_error VARCHAR,
        woken_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ,
        last_exit_code BIGINT,
        last_signal VARCHAR,
        error VARCHAR,
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run(`
      CREATE TABLE IF NOT EXISTS wait_event (
        id VARCHAR PRIMARY KEY,
        workspace_id VARCHAR NOT NULL,
        topic VARCHAR NOT NULL,
        subject_key VARCHAR NOT NULL,
        status VARCHAR NOT NULL DEFAULT 'pending',
        expected_at TIMESTAMPTZ,
        payload JSON NOT NULL DEFAULT 'null'::JSON,
        fired_at TIMESTAMPTZ,
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS wait_event_subject_idx
      ON wait_event (workspace_id, topic, subject_key)
    `);
    await connection.run(`
      CREATE TABLE IF NOT EXISTS wait_subscription (
        id VARCHAR PRIMARY KEY,
        event_id VARCHAR NOT NULL,
        workspace_id VARCHAR NOT NULL,
        session_id VARCHAR NOT NULL,
        turn_id VARCHAR,
        action_type VARCHAR NOT NULL,
        action_payload JSON NOT NULL DEFAULT 'null'::JSON,
        status VARCHAR NOT NULL DEFAULT 'waiting',
        attempts BIGINT NOT NULL DEFAULT 0,
        error VARCHAR,
        delivered_at TIMESTAMPTZ,
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run(`
      CREATE INDEX IF NOT EXISTS wait_subscription_event_idx
      ON wait_subscription (event_id, status)
    `);
    await connection.run(`
      CREATE INDEX IF NOT EXISTS wait_subscription_session_idx
      ON wait_subscription (session_id, status)
    `);
    // Guard each legacy migration with an explicit schema lookup so repeated
    // startup checks do not rewrite existing JSON/default columns.
    const processMonitorMigrations: Array<[string, string]> = [
      ["executable", "VARCHAR"],
      ["docker_image", "VARCHAR"],
      ["docker_run_args", "JSON DEFAULT '[]'::JSON"],
      ["args", "JSON DEFAULT '[]'::JSON"],
      ["log_file", "VARCHAR"],
      ["entry_points", "JSON DEFAULT '[]'::JSON"],
      ["metric_monitors", "JSON DEFAULT '[]'::JSON"],
      ["metric_readings", "JSON DEFAULT '[]'::JSON"],
      ["entry_point", "VARCHAR"],
      ["source_command_id", "VARCHAR"],
      ["parameters", "JSON DEFAULT '[]'::JSON"],
      ["parameter_values", "JSON DEFAULT '{}'::JSON"],
      ["remove_on_exit", "BOOLEAN DEFAULT false"],
      ["wake_prompt", "VARCHAR"],
      ["wake_session_id", "VARCHAR"],
      ["wake_thread_id", "VARCHAR"],
      ["timeout_at", "TIMESTAMPTZ"],
      ["wake_status", "VARCHAR DEFAULT 'none'"],
      ["wake_error", "VARCHAR"],
      ["woken_at", "TIMESTAMPTZ"]
    ];
    for (const [column, definition] of processMonitorMigrations) {
      if (!(await this.columnExists(connection, "process_monitor", column))) {
        await connection.run(`ALTER TABLE process_monitor ADD COLUMN ${column} ${definition}`);
      }
    }
    await connection.run(`
      CREATE TABLE IF NOT EXISTS execution_approval_policy (
        owner_id VARCHAR PRIMARY KEY,
        policy VARCHAR NOT NULL
      )
    `);
    await connection.run(`CREATE TABLE IF NOT EXISTS loop_mode_settings (
      id VARCHAR PRIMARY KEY, enabled BOOLEAN NOT NULL
    )`);
    await connection.run(`CREATE TABLE IF NOT EXISTS turn_loop_mode (
      turn_id VARCHAR PRIMARY KEY
    )`);
    await connection.run(`CREATE TABLE IF NOT EXISTS loop_work_turn (
      turn_id VARCHAR PRIMARY KEY, root_turn_id VARCHAR NOT NULL, work_cycle INTEGER NOT NULL
    )`);
    await connection.run(`
      CREATE TABLE IF NOT EXISTS session_turn (
        id VARCHAR PRIMARY KEY,
        session_id VARCHAR NOT NULL,
        account_id VARCHAR,
        account_name VARCHAR,
        account_email VARCHAR,
        account_external_account_id VARCHAR,
        account_external_user_id VARCHAR,
        user_input VARCHAR NOT NULL,
        agent_response VARCHAR NOT NULL,
        token_in BIGINT NOT NULL DEFAULT 0,
        token_out BIGINT NOT NULL DEFAULT 0,
        status VARCHAR NOT NULL DEFAULT 'done',
        pending_reason VARCHAR,
        pending_load_balance BOOLEAN,
        request_metadata VARCHAR,
        runner_pid BIGINT,
        runner_started TIMESTAMPTZ,
        runner_heartbeat TIMESTAMPTZ,
        runner_log_path VARCHAR,
        runner_exit_code BIGINT,
        last_event_name VARCHAR,
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run("CREATE INDEX IF NOT EXISTS sessions_workspace_updated_idx ON sessions(workspace_id, updated DESC, created DESC, id)");
    await connection.run("CREATE INDEX IF NOT EXISTS sessions_thread_workspace_updated_idx ON sessions(thread_id, workspace_id, updated DESC, created DESC)");
    await connection.run("CREATE INDEX IF NOT EXISTS session_turn_session_created_idx ON session_turn(session_id, created ASC, id ASC)");
    await connection.run("CREATE INDEX IF NOT EXISTS session_turn_session_status_created_idx ON session_turn(session_id, status, created ASC, id ASC)");
    await connection.run("CREATE INDEX IF NOT EXISTS session_turn_status_heartbeat_idx ON session_turn(status, runner_heartbeat ASC, created ASC, id ASC)");
    await connection.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS session_turn_one_running_per_session_idx
      ON session_turn(session_id)
      WHERE status = 'running'
    `);
    await connection.run(`
      CREATE TABLE IF NOT EXISTS session_side_chat (
        id VARCHAR PRIMARY KEY,
        session_id VARCHAR NOT NULL,
        workspace_id VARCHAR NOT NULL,
        source_session_id VARCHAR,
        source_thread_id VARCHAR,
        source_turn_id VARCHAR,
        question VARCHAR NOT NULL,
        answer VARCHAR NOT NULL,
        model VARCHAR NOT NULL,
        context_turn_count BIGINT NOT NULL DEFAULT 0,
        context_filter VARCHAR,
        mode VARCHAR NOT NULL DEFAULT 'forked_ephemeral',
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run(`
      CREATE INDEX IF NOT EXISTS session_side_chat_session_idx
      ON session_side_chat (session_id, created)
    `);
    await connection.run(`
      CREATE INDEX IF NOT EXISTS session_side_chat_source_session_idx
      ON session_side_chat (source_session_id, created)
    `);
    await connection.run(`
      CREATE TABLE IF NOT EXISTS session_auto_model (
        session_id VARCHAR PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT false,
        model VARCHAR NOT NULL DEFAULT '${DEFAULT_MODEL}',
        effort VARCHAR NOT NULL DEFAULT 'high',
        revision BIGINT NOT NULL DEFAULT 0,
        full_prompt_shown BOOLEAN NOT NULL DEFAULT false,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run("ALTER TABLE session_auto_model ADD COLUMN IF NOT EXISTS full_prompt_shown BOOLEAN DEFAULT false");
    await connection.run("UPDATE session_auto_model SET full_prompt_shown = false WHERE full_prompt_shown IS NULL");
    await connection.run(`
      CREATE TABLE IF NOT EXISTS session_model_preferences (
        session_id VARCHAR PRIMARY KEY,
        selected_model VARCHAR NOT NULL DEFAULT '${DEFAULT_MODEL}',
        selected_effort VARCHAR NOT NULL DEFAULT 'low',
        gear_profiles JSON NOT NULL DEFAULT '${JSON.stringify(defaultGearProfiles())}'::JSON,
        active_gear_index INTEGER NOT NULL DEFAULT 0,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run(`
      CREATE TABLE IF NOT EXISTS workspace_model_preferences (
        workspace_id VARCHAR PRIMARY KEY,
        selected_model VARCHAR NOT NULL DEFAULT '${DEFAULT_MODEL}',
        selected_effort VARCHAR NOT NULL DEFAULT 'low',
        gear_profiles JSON NOT NULL DEFAULT '${JSON.stringify(defaultGearProfiles())}'::JSON,
        active_gear_index INTEGER NOT NULL DEFAULT 0,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run(`CREATE TABLE IF NOT EXISTS session_turn_grill (
      session_id VARCHAR NOT NULL, turn_id VARCHAR NOT NULL, revision BIGINT NOT NULL,
      document VARCHAR NOT NULL, PRIMARY KEY (session_id, turn_id)
    )`);
    await connection.run(`CREATE TABLE IF NOT EXISTS session_outcome_plan (
      session_id VARCHAR PRIMARY KEY,
      revision BIGINT NOT NULL,
      document VARCHAR NOT NULL
    )`);
    await connection.run(`
      CREATE TABLE IF NOT EXISTS session_todo_control (
        session_id VARCHAR PRIMARY KEY,
        paused BOOLEAN NOT NULL DEFAULT false,
        pause_reason VARCHAR,
        paused_by VARCHAR,
        context VARCHAR NOT NULL DEFAULT '',
        problem VARCHAR NOT NULL DEFAULT '',
        objective VARCHAR NOT NULL DEFAULT '',
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run(`
      CREATE TABLE IF NOT EXISTS session_todo_item (
        id VARCHAR PRIMARY KEY,
        session_id VARCHAR NOT NULL,
        parent_id VARCHAR,
        title VARCHAR NOT NULL,
        details VARCHAR NOT NULL DEFAULT '',
        context VARCHAR NOT NULL DEFAULT '',
        section VARCHAR,
        status VARCHAR NOT NULL DEFAULT 'todo',
        position DOUBLE NOT NULL DEFAULT 0,
        created_by VARCHAR NOT NULL DEFAULT 'agent',
        updated_by VARCHAR NOT NULL DEFAULT 'agent',
        locked_by_turn_id VARCHAR,
        lock_reason VARCHAR,
        active_status VARCHAR,
        child_session_id VARCHAR,
        child_turn_id VARCHAR,
        changed_file_count BIGINT NOT NULL DEFAULT 0,
        changed_files_json VARCHAR NOT NULL DEFAULT '[]',
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run("ALTER TABLE session_todo_control ADD COLUMN IF NOT EXISTS context VARCHAR DEFAULT ''");
    await connection.run("ALTER TABLE session_todo_control ADD COLUMN IF NOT EXISTS problem VARCHAR DEFAULT ''");
    await connection.run("ALTER TABLE session_todo_control ADD COLUMN IF NOT EXISTS objective VARCHAR DEFAULT ''");
    await connection.run("ALTER TABLE session_todo_item ADD COLUMN IF NOT EXISTS context VARCHAR DEFAULT ''");
    await connection.run("ALTER TABLE session_todo_item ADD COLUMN IF NOT EXISTS section VARCHAR");
    await connection.run("ALTER TABLE session_todo_item ADD COLUMN IF NOT EXISTS changed_file_count BIGINT DEFAULT 0");
    await connection.run("ALTER TABLE session_todo_item ADD COLUMN IF NOT EXISTS changed_files_json VARCHAR DEFAULT '[]'");
    await connection.run("CREATE INDEX IF NOT EXISTS session_todo_item_session_idx ON session_todo_item(session_id)");
    await connection.run("CREATE INDEX IF NOT EXISTS session_todo_item_parent_idx ON session_todo_item(session_id, parent_id, position)");
    await connection.run("CREATE INDEX IF NOT EXISTS session_todo_item_status_idx ON session_todo_item(session_id, status)");
    await connection.run("CREATE INDEX IF NOT EXISTS session_todo_item_order_idx ON session_todo_item(session_id, parent_id, position ASC, created ASC, id ASC)");
    await connection.run(`
      CREATE TABLE IF NOT EXISTS session_todo_item_session (
        id VARCHAR PRIMARY KEY,
        session_id VARCHAR NOT NULL,
        item_id VARCHAR NOT NULL,
        child_session_id VARCHAR NOT NULL,
        child_turn_id VARCHAR,
        title VARCHAR NOT NULL DEFAULT '',
        role VARCHAR NOT NULL DEFAULT 'worker',
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run("CREATE INDEX IF NOT EXISTS session_todo_item_session_item_idx ON session_todo_item_session(session_id, item_id, created)");
    await connection.run("CREATE INDEX IF NOT EXISTS session_todo_item_session_child_idx ON session_todo_item_session(child_session_id)");
    await connection.run("CREATE INDEX IF NOT EXISTS session_todo_item_session_order_idx ON session_todo_item_session(session_id, created ASC, id ASC)");
    await connection.run(`
      CREATE TABLE IF NOT EXISTS session_todo_message (
        session_id VARCHAR NOT NULL,
        id BIGINT NOT NULL,
        item_id VARCHAR NOT NULL,
        turn_id VARCHAR,
        type VARCHAR NOT NULL DEFAULT 'update',
        author VARCHAR NOT NULL DEFAULT 'agent',
        title VARCHAR NOT NULL,
        body VARCHAR NOT NULL DEFAULT '',
        resolved_by VARCHAR,
        resolved_at TIMESTAMPTZ,
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        PRIMARY KEY (session_id, id)
      )
    `);
    await connection.run("CREATE INDEX IF NOT EXISTS session_todo_message_item_idx ON session_todo_message(session_id, item_id, id)");
    await connection.run("CREATE INDEX IF NOT EXISTS session_todo_message_unresolved_idx ON session_todo_message(session_id, type, resolved_at)");
    await connection.run(`
      CREATE TABLE IF NOT EXISTS session_todo_comment (
        id VARCHAR PRIMARY KEY,
        session_id VARCHAR NOT NULL,
        item_id VARCHAR,
        turn_id VARCHAR,
        type VARCHAR NOT NULL DEFAULT 'note',
        author VARCHAR NOT NULL DEFAULT 'agent',
        body VARCHAR NOT NULL,
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run("CREATE INDEX IF NOT EXISTS session_todo_comment_session_idx ON session_todo_comment(session_id, created)");
    await connection.run("CREATE INDEX IF NOT EXISTS session_todo_comment_item_idx ON session_todo_comment(item_id, created)");
    await connection.run("CREATE INDEX IF NOT EXISTS session_todo_comment_order_idx ON session_todo_comment(session_id, created ASC, id ASC)");
    await connection.run("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workspace_id VARCHAR");
    await connection.run("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cwd VARCHAR");
    await connection.run("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS account_id VARCHAR");
    await connection.run("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS forked_from_turn_id VARCHAR");
    await connection.run("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title_source VARCHAR DEFAULT 'initial'");
    await connection.run("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS achieved_at TIMESTAMPTZ");
    await connection.run(`
      UPDATE sessions
      SET title_source = 'initial'
      WHERE title_source IS NULL OR title_source NOT IN ('initial', 'summarizer', 'user')
    `);
    await connection.run("ALTER TABLE session_turn ADD COLUMN IF NOT EXISTS account_id VARCHAR");
    // open() upgrades both fresh and existing stores before ready()/enqueue()
    // release readers or writers. PostgreSQL supplies [] for pre-existing rows.
    await connection.run("ALTER TABLE session_turn ADD COLUMN IF NOT EXISTS changed_files TEXT[] NOT NULL DEFAULT '{}'::TEXT[]");
    await connection.run(`CREATE TABLE IF NOT EXISTS session_turn_reference (
      session_id VARCHAR NOT NULL, turn_id VARCHAR NOT NULL, turn_number BIGINT NOT NULL CHECK (turn_number > 0),
      PRIMARY KEY (session_id, turn_id), UNIQUE (session_id, turn_number)
    )`);
    await connection.run("ALTER TABLE session_turn ADD COLUMN IF NOT EXISTS account_name VARCHAR");
    await connection.run("ALTER TABLE session_turn ADD COLUMN IF NOT EXISTS account_email VARCHAR");
    await connection.run("ALTER TABLE session_turn ADD COLUMN IF NOT EXISTS account_external_account_id VARCHAR");
    await connection.run("ALTER TABLE session_turn ADD COLUMN IF NOT EXISTS account_external_user_id VARCHAR");
    await connection.run("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS external_account_id VARCHAR");
    await connection.run("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS external_user_id VARCHAR");
    await connection.run("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS auth_json VARCHAR");
    await connection.run("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS config_toml VARCHAR");
    await connection.run("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS auth_version BIGINT DEFAULT 0");
    await connection.run("UPDATE accounts SET auth_version = 0 WHERE auth_version IS NULL");
    await connection.run("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS quota_snapshot JSON");
    await connection.run("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS quota_updated_at TIMESTAMPTZ");
    await connection.run("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS quota_error VARCHAR");
    await connection.run("ALTER TABLE active_account ADD COLUMN IF NOT EXISTS load_balance BOOLEAN DEFAULT FALSE");
    await connection.run("UPDATE active_account SET load_balance = FALSE WHERE load_balance IS NULL");
    await this.backfillExternalAccountColumns(connection);
    await this.ensureDefaultWorkspaceWithConnection(connection);
    // Before workspace-scoped selections, the sole `active` entry represented
    // the current account for the whole app. Keep that selection for the
    // workspace that was active at upgrade time.
    await connection.run(`
      INSERT INTO active_account (key, account_id, updated)
      SELECT active_workspace.workspace_id, active_account.account_id, active_account.updated
      FROM active_account
      INNER JOIN active_workspace ON active_workspace.key = 'active'
      WHERE active_account.key = 'active'
        AND active_workspace.workspace_id IS NOT NULL
      ON CONFLICT (key) DO NOTHING
    `);
    await connection.run("DELETE FROM active_account WHERE key = 'active'");
    await connection.run(
      `
        UPDATE sessions
        SET workspace_id = 'default'
        WHERE workspace_id IS NULL OR workspace_id = ''
      `
    );
    await connection.run(
      `
        UPDATE sessions
        SET cwd = $cwd
        WHERE cwd IS NULL OR cwd = ''
      `,
      { cwd: defaultCwd() }
    );
    if (!workspaceAccountTableExisted) {
      await connection.run(`
        INSERT INTO workspace_account (workspace_id, account_id, created)
        SELECT 'default', id, now()
        FROM accounts
        ON CONFLICT (workspace_id, account_id) DO NOTHING
      `);
    }
    await connection.run(`
      CREATE TABLE IF NOT EXISTS session_turn_event (
        id VARCHAR PRIMARY KEY,
        turn_id VARCHAR NOT NULL,
        session_id VARCHAR NOT NULL,
        event_name VARCHAR NOT NULL,
        payload JSON NOT NULL,
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run("CREATE INDEX IF NOT EXISTS session_turn_event_session_created_idx ON session_turn_event(session_id, created ASC, id ASC)");
    await connection.run("CREATE INDEX IF NOT EXISTS session_turn_event_session_name_created_idx ON session_turn_event(session_id, event_name, created ASC, id ASC)");
    await connection.run("CREATE INDEX IF NOT EXISTS session_turn_event_session_turn_created_idx ON session_turn_event(session_id, turn_id, created ASC, id ASC)");
    await connection.run("CREATE INDEX IF NOT EXISTS session_turn_event_turn_name_created_idx ON session_turn_event(turn_id, event_name, created ASC, id ASC)");
    await connection.run(`
      CREATE TABLE IF NOT EXISTS session_live_item (
        turn_id VARCHAR NOT NULL,
        item_id VARCHAR NOT NULL,
        session_id VARCHAR NOT NULL,
        item_type VARCHAR NOT NULL,
        event_type VARCHAR NOT NULL,
        event_rank BIGINT NOT NULL DEFAULT 0,
        is_final BOOLEAN NOT NULL DEFAULT false,
        payload JSON NOT NULL,
        source_event_id VARCHAR,
        jsonl_index BIGINT,
        sequence BIGINT,
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        finalized_at TIMESTAMPTZ,
        PRIMARY KEY (turn_id, item_id)
      )
    `);
    await connection.run("CREATE INDEX IF NOT EXISTS session_live_item_session_idx ON session_live_item(session_id)");
    await connection.run("CREATE INDEX IF NOT EXISTS session_live_item_turn_idx ON session_live_item(turn_id)");
    await connection.run("CREATE INDEX IF NOT EXISTS session_live_item_session_order_idx ON session_live_item(session_id, created ASC, item_id ASC)");
    await this.backfillSessionLiveItems(connection);
    await connection.run(`
      CREATE TABLE IF NOT EXISTS local_session_file (
        path VARCHAR PRIMARY KEY,
        source VARCHAR NOT NULL,
        workspace_id VARCHAR,
        session_id VARCHAR,
        title VARCHAR,
        cwd VARCHAR,
        file_size BIGINT NOT NULL DEFAULT 0,
        file_mtime TIMESTAMPTZ,
        event_count BIGINT NOT NULL DEFAULT 0,
        turn_count BIGINT NOT NULL DEFAULT 0,
        open_turn_count BIGINT NOT NULL DEFAULT 0,
        parse_error VARCHAR,
        imported_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        created TIMESTAMPTZ,
        updated TIMESTAMPTZ
      )
    `);
    await connection.run("ALTER TABLE local_session_file ADD COLUMN IF NOT EXISTS workspace_id VARCHAR");
    await connection.run("ALTER TABLE local_session_file ADD COLUMN IF NOT EXISTS open_turn_count BIGINT NOT NULL DEFAULT 0");
    await connection.run(`
      CREATE TABLE IF NOT EXISTS local_session_event (
        source_path VARCHAR NOT NULL,
        event_index BIGINT NOT NULL,
        session_id VARCHAR,
        turn_id VARCHAR,
        event_type VARCHAR NOT NULL,
        payload_type VARCHAR,
        event_timestamp TIMESTAMPTZ,
        payload JSON,
        raw JSON NOT NULL,
        imported_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        PRIMARY KEY (source_path, event_index)
      )
    `);
    await connection.run(`
      CREATE TABLE IF NOT EXISTS codex_command_call (
        id VARCHAR PRIMARY KEY,
        session_id VARCHAR NOT NULL,
        turn_id VARCHAR NOT NULL,
        item_id VARCHAR NOT NULL,
        first_event_id VARCHAR,
        last_event_id VARCHAR,
        first_jsonl_index BIGINT,
        last_jsonl_index BIGINT,
        command VARCHAR NOT NULL,
        command_length BIGINT NOT NULL DEFAULT 0,
        response_length BIGINT NOT NULL DEFAULT 0,
        command_part_1 VARCHAR,
        command_part_2 VARCHAR,
        command_part_3 VARCHAR,
        status VARCHAR NOT NULL DEFAULT '',
        exit_code BIGINT,
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run("ALTER TABLE codex_command_call ADD COLUMN IF NOT EXISTS first_event_id VARCHAR");
    await connection.run("ALTER TABLE codex_command_call ADD COLUMN IF NOT EXISTS last_event_id VARCHAR");
    await connection.run("ALTER TABLE codex_command_call ADD COLUMN IF NOT EXISTS first_jsonl_index BIGINT");
    await connection.run("ALTER TABLE codex_command_call ADD COLUMN IF NOT EXISTS last_jsonl_index BIGINT");
    await connection.run("ALTER TABLE codex_command_call ADD COLUMN IF NOT EXISTS command_length BIGINT");
    await connection.run("ALTER TABLE codex_command_call ADD COLUMN IF NOT EXISTS response_length BIGINT");
    await connection.run("ALTER TABLE codex_command_call ADD COLUMN IF NOT EXISTS command_part_1 VARCHAR");
    await connection.run("ALTER TABLE codex_command_call ADD COLUMN IF NOT EXISTS command_part_2 VARCHAR");
    await connection.run("ALTER TABLE codex_command_call ADD COLUMN IF NOT EXISTS command_part_3 VARCHAR");
    await connection.run("ALTER TABLE codex_command_call ADD COLUMN IF NOT EXISTS status VARCHAR");
    await connection.run("ALTER TABLE codex_command_call ADD COLUMN IF NOT EXISTS exit_code BIGINT");
    await connection.run("CREATE INDEX IF NOT EXISTS codex_command_call_turn_idx ON codex_command_call(turn_id)");
    await connection.run("CREATE INDEX IF NOT EXISTS codex_command_call_session_idx ON codex_command_call(session_id)");
    await connection.run(`
      CREATE TABLE IF NOT EXISTS account_token_usage_ratio (
        id VARCHAR PRIMARY KEY,
        account_id VARCHAR NOT NULL,
        turn_id VARCHAR NOT NULL,
        window_key VARCHAR NOT NULL,
        token_in BIGINT NOT NULL DEFAULT 0,
        token_out BIGINT NOT NULL DEFAULT 0,
        token_total BIGINT NOT NULL DEFAULT 0,
        used_percent_before DOUBLE,
        used_percent_after DOUBLE,
        used_percent_delta DOUBLE,
        tokens_per_used_percent DOUBLE,
        quota_updated_at TIMESTAMPTZ,
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run(`
      CREATE TABLE IF NOT EXISTS session_turn_token_usage_sample (
        id VARCHAR PRIMARY KEY,
        session_id VARCHAR NOT NULL,
        turn_id VARCHAR NOT NULL,
        source VARCHAR NOT NULL,
        source_index BIGINT,
        source_timestamp TIMESTAMPTZ,
        input_tokens BIGINT NOT NULL DEFAULT 0,
        cached_input_tokens BIGINT NOT NULL DEFAULT 0,
        output_tokens BIGINT NOT NULL DEFAULT 0,
        reasoning_output_tokens BIGINT NOT NULL DEFAULT 0,
        total_tokens BIGINT NOT NULL DEFAULT 0,
        cumulative_input_tokens BIGINT NOT NULL DEFAULT 0,
        cumulative_cached_input_tokens BIGINT NOT NULL DEFAULT 0,
        cumulative_output_tokens BIGINT NOT NULL DEFAULT 0,
        cumulative_reasoning_output_tokens BIGINT NOT NULL DEFAULT 0,
        cumulative_total_tokens BIGINT NOT NULL DEFAULT 0,
        model_context_window BIGINT,
        primary_used_percent DOUBLE,
        secondary_used_percent DOUBLE,
        primary_resets_at BIGINT,
        secondary_resets_at BIGINT,
        plan_type VARCHAR,
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run("CREATE INDEX IF NOT EXISTS session_turn_token_usage_sample_turn_idx ON session_turn_token_usage_sample(turn_id)");
    await connection.run("CREATE INDEX IF NOT EXISTS session_turn_token_usage_sample_session_idx ON session_turn_token_usage_sample(session_id)");
    await connection.run(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id VARCHAR PRIMARY KEY,
        usage_type VARCHAR NOT NULL,
        source VARCHAR NOT NULL,
        workspace_id VARCHAR,
        session_id VARCHAR,
        turn_id VARCHAR,
        account_id VARCHAR,
        model VARCHAR,
        source_index BIGINT,
        source_timestamp TIMESTAMPTZ,
        input_tokens BIGINT NOT NULL DEFAULT 0,
        cached_input_tokens BIGINT NOT NULL DEFAULT 0,
        output_tokens BIGINT NOT NULL DEFAULT 0,
        reasoning_output_tokens BIGINT NOT NULL DEFAULT 0,
        total_tokens BIGINT NOT NULL DEFAULT 0,
        cumulative_input_tokens BIGINT NOT NULL DEFAULT 0,
        cumulative_cached_input_tokens BIGINT NOT NULL DEFAULT 0,
        cumulative_output_tokens BIGINT NOT NULL DEFAULT 0,
        cumulative_reasoning_output_tokens BIGINT NOT NULL DEFAULT 0,
        cumulative_total_tokens BIGINT NOT NULL DEFAULT 0,
        model_context_window BIGINT,
        primary_used_percent DOUBLE,
        secondary_used_percent DOUBLE,
        primary_resets_at BIGINT,
        secondary_resets_at BIGINT,
        plan_type VARCHAR,
        window_key VARCHAR,
        used_percent_before DOUBLE,
        used_percent_after DOUBLE,
        used_percent_delta DOUBLE,
        tokens_per_used_percent DOUBLE,
        metadata JSON,
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run("ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS workspace_id VARCHAR");
    await connection.run(`
      UPDATE token_usage AS usage
      SET workspace_id = session.workspace_id
      FROM sessions AS session
      WHERE usage.workspace_id IS NULL AND usage.session_id = session.id
    `);
    await connection.run("CREATE INDEX IF NOT EXISTS token_usage_workspace_idx ON token_usage(workspace_id)");
    await connection.run("CREATE INDEX IF NOT EXISTS token_usage_session_idx ON token_usage(session_id)");
    await connection.run("CREATE INDEX IF NOT EXISTS token_usage_turn_idx ON token_usage(turn_id)");
    await connection.run("CREATE INDEX IF NOT EXISTS token_usage_account_idx ON token_usage(account_id)");
    await connection.run("CREATE INDEX IF NOT EXISTS token_usage_type_idx ON token_usage(usage_type, source)");
    await connection.run(`
      CREATE INDEX IF NOT EXISTS token_usage_turn_agent_latest_idx
      ON token_usage(
        turn_id,
        usage_type,
        source_timestamp DESC NULLS LAST,
        source_index DESC NULLS LAST,
        created DESC,
        id
      )
    `);
    await connection.run(`
      INSERT INTO token_usage (
        id, usage_type, source, session_id, turn_id, account_id,
        input_tokens, output_tokens, total_tokens, source_timestamp, created, updated
      )
      SELECT
        'agent:turn:' || id, 'agent', 'turn_final', session_id, id, account_id,
        token_in, token_out, token_in + token_out, created, created, created
      FROM session_turn
      ON CONFLICT (id) DO NOTHING
    `);
    await connection.run(`
      INSERT INTO token_usage (
        id, usage_type, source, session_id, turn_id, account_id, source_index, source_timestamp,
        input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
        cumulative_input_tokens, cumulative_cached_input_tokens, cumulative_output_tokens,
        cumulative_reasoning_output_tokens, cumulative_total_tokens, model_context_window,
        primary_used_percent, secondary_used_percent, primary_resets_at, secondary_resets_at,
        plan_type, created, updated
      )
      SELECT
        'agent:sample:' || sample.id, 'agent', sample.source, sample.session_id, sample.turn_id, turn.account_id,
        sample.source_index, sample.source_timestamp, sample.input_tokens, sample.cached_input_tokens,
        sample.output_tokens, sample.reasoning_output_tokens, sample.total_tokens,
        sample.cumulative_input_tokens, sample.cumulative_cached_input_tokens, sample.cumulative_output_tokens,
        sample.cumulative_reasoning_output_tokens, sample.cumulative_total_tokens, sample.model_context_window,
        sample.primary_used_percent, sample.secondary_used_percent, sample.primary_resets_at,
        sample.secondary_resets_at, sample.plan_type, sample.created, sample.updated
      FROM session_turn_token_usage_sample AS sample
      LEFT JOIN session_turn AS turn ON turn.id = sample.turn_id
      ON CONFLICT (id) DO NOTHING
    `);
    await connection.run(`
      INSERT INTO token_usage (
        id, usage_type, source, session_id, turn_id, account_id, window_key,
        input_tokens, output_tokens, total_tokens, used_percent_before, used_percent_after,
        used_percent_delta, tokens_per_used_percent, source_timestamp, created, updated
      )
      SELECT
        'account:ratio:' || ratio.id, 'account', 'quota_ratio', turn.session_id, ratio.turn_id,
        ratio.account_id, ratio.window_key, ratio.token_in, ratio.token_out, ratio.token_total,
        ratio.used_percent_before, ratio.used_percent_after, ratio.used_percent_delta,
        ratio.tokens_per_used_percent, ratio.quota_updated_at, ratio.created, ratio.updated
      FROM account_token_usage_ratio AS ratio
      LEFT JOIN session_turn AS turn ON turn.id = ratio.turn_id
      ON CONFLICT (id) DO NOTHING
    `);
    await connection.run(`
      CREATE TABLE IF NOT EXISTS session_description_embedding (
        session_id VARCHAR PRIMARY KEY,
        embedding DOUBLE[] NOT NULL,
        model VARCHAR NOT NULL DEFAULT '',
        dimensions BIGINT NOT NULL DEFAULT 0,
        description_hash VARCHAR NOT NULL DEFAULT '',
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run(`
      CREATE TABLE IF NOT EXISTS session_summary_state (
        session_id VARCHAR PRIMARY KEY,
        source_hash VARCHAR NOT NULL DEFAULT '',
        source_turn_count BIGINT NOT NULL DEFAULT 0,
        source_updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        summarizer_model VARCHAR NOT NULL DEFAULT '',
        summarized_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      )
    `);
    await connection.run(`
      CREATE TABLE IF NOT EXISTS keyword_appearance (
        workspace_id VARCHAR NOT NULL,
        keyword VARCHAR NOT NULL,
        session_count BIGINT NOT NULL DEFAULT 0,
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        PRIMARY KEY (workspace_id, keyword)
      )
    `);
    await connection.run(`
      CREATE TABLE IF NOT EXISTS composer_suggestion_keyword (
        workspace_id VARCHAR NOT NULL,
        keyword VARCHAR NOT NULL,
        position BIGINT NOT NULL DEFAULT 0,
        created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        PRIMARY KEY (workspace_id, keyword)
      )
    `);
    await connection.run("ALTER TABLE session_description_embedding ADD COLUMN IF NOT EXISTS description_hash VARCHAR");
    await connection.run("DROP INDEX IF EXISTS session_description_embedding_session_idx");
    await connection.run("CREATE INDEX IF NOT EXISTS keyword_appearance_workspace_idx ON keyword_appearance(workspace_id)");
    await connection.run("CREATE INDEX IF NOT EXISTS composer_suggestion_keyword_workspace_position_idx ON composer_suggestion_keyword(workspace_id, position)");
    await connection.run("ALTER TABLE session_summary_state ADD COLUMN IF NOT EXISTS source_hash VARCHAR");
    await connection.run("ALTER TABLE session_summary_state ADD COLUMN IF NOT EXISTS source_turn_count BIGINT");
    await connection.run("ALTER TABLE session_summary_state ADD COLUMN IF NOT EXISTS source_updated TIMESTAMPTZ");
    await connection.run("ALTER TABLE session_summary_state ADD COLUMN IF NOT EXISTS summarizer_model VARCHAR");
    await connection.run("ALTER TABLE session_summary_state ADD COLUMN IF NOT EXISTS summarized_at TIMESTAMPTZ");
    await connection.run(`
      ALTER TABLE session_turn
      ADD COLUMN IF NOT EXISTS status VARCHAR
    `);
    await connection.run("ALTER TABLE session_turn ADD COLUMN IF NOT EXISTS pending_reason VARCHAR");
    await connection.run("ALTER TABLE session_turn ADD COLUMN IF NOT EXISTS pending_load_balance BOOLEAN");
    await connection.run("ALTER TABLE session_turn ADD COLUMN IF NOT EXISTS request_metadata VARCHAR");
    // A direct prompt and its manager notification commit in the same INSERT.
    // Automatic task/manager turns carry backgroundTask and never self-notify.
    await connection.run(`CREATE OR REPLACE FUNCTION threadex_manager_direct_prompt_event() RETURNS trigger AS $$
      BEGIN
        IF NEW.request_metadata IS NOT NULL
          AND COALESCE((NEW.request_metadata::jsonb ->> 'backgroundTask')::boolean, false) = false THEN
          INSERT INTO workspace_manager_event (id, workspace_id, session_id, turn_id, type, summary, created)
          SELECT md5('task.prompted:' || NEW.id), m.workspace_id, NEW.session_id, NEW.id,
            'task.prompted', jsonb_build_object('source', 'direct_prompt', 'status', NEW.status,
              'promptPreview', left(NEW.user_input, 300))::text, NEW.created
          FROM sessions s JOIN workspace_manager m ON m.workspace_id = s.workspace_id
          WHERE s.id = NEW.session_id AND m.session_id <> NEW.session_id AND m.created <= NEW.created
          ON CONFLICT (id) DO NOTHING;
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    await connection.run(`DROP TRIGGER IF EXISTS threadex_manager_direct_prompt_event ON session_turn`);
    await connection.run(`CREATE TRIGGER threadex_manager_direct_prompt_event AFTER INSERT ON session_turn
      FOR EACH ROW EXECUTE FUNCTION threadex_manager_direct_prompt_event()`);
    await connection.run("ALTER TABLE session_turn ADD COLUMN IF NOT EXISTS runner_pid BIGINT");
    await connection.run("ALTER TABLE session_turn ADD COLUMN IF NOT EXISTS runner_started TIMESTAMPTZ");
    await connection.run("ALTER TABLE session_turn ADD COLUMN IF NOT EXISTS runner_heartbeat TIMESTAMPTZ");
    await connection.run("ALTER TABLE session_turn ADD COLUMN IF NOT EXISTS runner_log_path VARCHAR");
    await connection.run("ALTER TABLE session_turn ADD COLUMN IF NOT EXISTS runner_exit_code BIGINT");
    await connection.run("ALTER TABLE session_turn ADD COLUMN IF NOT EXISTS last_event_name VARCHAR");
    await connection.run(`
      UPDATE session_turn
      SET status = 'done'
      WHERE status IS NULL
    `);
    await connection.run(`
      UPDATE session_turn
      SET account_id = (
        SELECT sessions.account_id
        FROM sessions
        WHERE sessions.id = session_turn.session_id
      )
      WHERE account_id IS NULL
    `);
    await connection.run(`
      UPDATE session_turn
      SET
        account_name = (
          SELECT accounts.name
          FROM accounts
          WHERE accounts.id = session_turn.account_id
        ),
        account_email = (
          SELECT accounts.email
          FROM accounts
          WHERE accounts.id = session_turn.account_id
        ),
        account_external_account_id = (
          SELECT accounts.external_account_id
          FROM accounts
          WHERE accounts.id = session_turn.account_id
        ),
        account_external_user_id = (
          SELECT accounts.external_user_id
          FROM accounts
          WHERE accounts.id = session_turn.account_id
        )
      WHERE account_id IS NOT NULL
        AND (
          account_name IS NULL
          OR account_email IS NULL
          OR account_external_account_id IS NULL
          OR account_external_user_id IS NULL
        )
    `);
    await this.refreshSessionTurnFtsIndex(connection);
    return connection;
  }

  private async backfillSessionLiveItems(connection: SessionDbConnection): Promise<void> {
    const result = await connection.run(`
      SELECT id, turn_id, session_id, CAST(payload AS VARCHAR) AS payload_json, CAST(created AS VARCHAR) AS created
      FROM (
        SELECT
          id,
          turn_id,
          session_id,
          payload,
          created,
          row_number() OVER (
            PARTITION BY turn_id, COALESCE(json_extract_string(payload, '$.id'), id)
            ORDER BY created DESC, id DESC
          ) AS item_rank
        FROM session_turn_event
        WHERE event_name = 'item'
      ) AS ranked
      WHERE item_rank = 1
      ORDER BY created, id
    `);
    for (const row of await result.getRowObjectsJS()) {
      const payload = parseJsonObject(row.payload_json);
      if (!payload) {
        continue;
      }
      await this.upsertSessionLiveItemWithConnection(connection, {
        id: stringValue(row.id),
        turnId: stringValue(row.turn_id),
        sessionId: stringValue(row.session_id),
        eventName: "item",
        payload,
        created: stringValue(row.created)
      });
    }
    await connection.run("DELETE FROM session_turn_event WHERE event_name = 'item'");
  }

  private async refreshSessionTurnFtsIndex(connection: SessionDbConnection) {
    void connection;
  }

  private async listSessionsWithConnection(connection: SessionDbConnection, workspaceId?: string | null) {
    const result = workspaceId
      ? await connection.run(
          `
            SELECT
              id,
              thread_id,
              workspace_id,
              cwd,
              account_id,
              CAST(keyword_weights AS VARCHAR) AS keyword_weights,
              title,
              title_source,
              description,
              parent_session_id,
              forked_from_turn_id,
              CAST(created AS VARCHAR) AS created,
              CAST(updated AS VARCHAR) AS updated
            FROM sessions
            WHERE workspace_id = $workspaceId
            ORDER BY updated DESC, created DESC
          `,
          { workspaceId }
        )
      : await connection.run(`
          SELECT
            id,
            thread_id,
            workspace_id,
            cwd,
            account_id,
            CAST(keyword_weights AS VARCHAR) AS keyword_weights,
            title,
            title_source,
            description,
            parent_session_id,
            forked_from_turn_id,
            CAST(achieved_at AS VARCHAR) AS achieved_at,
            CAST(created AS VARCHAR) AS created,
            CAST(updated AS VARCHAR) AS updated
          FROM sessions
          ORDER BY updated DESC, created DESC
        `);
    return (await result.getRowObjectsJS()).map(toSessionRecord);
  }

  private async getKeywordAppearanceRowsWithConnection(connection: SessionDbConnection, workspaceId?: string | null) {
    const rowsResult = workspaceId
      ? await connection.run(
          `
            SELECT
              workspace_id,
              keyword,
              session_count,
              CAST(created AS VARCHAR) AS created,
              CAST(updated AS VARCHAR) AS updated
            FROM keyword_appearance
            WHERE workspace_id = $workspaceId
            ORDER BY session_count DESC, keyword ASC
          `,
          { workspaceId }
        )
      : await connection.run(`
          SELECT
            workspace_id,
            keyword,
            session_count,
            CAST(created AS VARCHAR) AS created,
            CAST(updated AS VARCHAR) AS updated
          FROM keyword_appearance
          ORDER BY session_count DESC, keyword ASC
        `);
    return (await rowsResult.getRowObjectsJS()).map(toKeywordAppearanceRecord);
  }

  private async listComposerSuggestionKeywordsWithConnection(
    connection: SessionDbConnection,
    workspaceId: string
  ): Promise<ComposerSuggestionKeywordRecord[]> {
    const result = await connection.run(
      `
        SELECT
          workspace_id,
          keyword,
          position,
          CAST(created AS VARCHAR) AS created,
          CAST(updated AS VARCHAR) AS updated
        FROM composer_suggestion_keyword
        WHERE workspace_id = $workspaceId
        ORDER BY position ASC, keyword ASC
      `,
      { workspaceId }
    );
    return (await result.getRowObjectsJS()).map(toComposerSuggestionKeywordRecord);
  }

  private async getSessionWithConnection(connection: SessionDbConnection, id: string) {
    const result = await connection.run(
      `
        SELECT
          id,
          thread_id,
          workspace_id,
          cwd,
          account_id,
          CAST(keyword_weights AS VARCHAR) AS keyword_weights,
          title,
          title_source,
          description,
          parent_session_id,
          forked_from_turn_id,
          CAST(achieved_at AS VARCHAR) AS achieved_at,
          CAST(created AS VARCHAR) AS created,
          CAST(updated AS VARCHAR) AS updated
        FROM sessions
        WHERE id = $id
      `,
      { id }
    );
    const rows = await result.getRowObjectsJS();
    return rows.length > 0 ? toSessionRecord(rows[0] as SessionRow) : null;
  }

  private async getSessionAutoModelWithConnection(
    connection: SessionDbConnection,
    sessionId: string
  ): Promise<SessionAutoModelConfig> {
    const result = await connection.run(
      `
        SELECT session_id, enabled, model, effort, revision, CAST(updated AS VARCHAR) AS updated
        FROM session_auto_model
        WHERE session_id = $sessionId
      `,
      { sessionId }
    );
    const row = (await result.getRowObjectsJS())[0] as Record<string, unknown> | undefined;
    return {
      sessionId,
      enabled: row?.enabled === true,
      model: normalizeAutoModel(row?.model) ?? DEFAULT_MODEL,
      effort: stringValue(row?.effort, "high"),
      revision: numberValue(row?.revision),
      updated: stringValue(row?.updated)
    };
  }

  private async getSessionModelPreferencesWithConnection(
    connection: SessionDbConnection,
    sessionId: string
  ): Promise<SessionModelPreferences> {
    const session = await this.getSessionWithConnection(connection, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const result = await connection.run(
      `
        SELECT
          selected_model,
          selected_effort,
          CAST(gear_profiles AS VARCHAR) AS gear_profiles,
          active_gear_index,
          CAST(updated AS VARCHAR) AS updated
        FROM session_model_preferences
        WHERE session_id = $sessionId
      `,
      { sessionId }
    );
    const row = (await result.getRowObjectsJS())[0] as Record<string, unknown> | undefined;
    if (!row) {
      return defaultSessionModelPreferences(sessionId);
    }
    return normalizeSessionModelPreferences(
      sessionId,
      {
        selectedModel: stringValue(row.selected_model),
        selectedEffort: stringValue(row.selected_effort),
        gearProfiles: parseSessionModelProfiles(row.gear_profiles),
        activeGearIndex: numberValue(row.active_gear_index)
      },
      defaultSessionModelPreferences(sessionId),
      stringValue(row.updated)
    );
  }

  private async getWorkspaceModelPreferencesWithConnection(
    connection: SessionDbConnection,
    workspaceId: string
  ): Promise<WorkspaceModelPreferences> {
    if (!(await this.getWorkspaceWithConnection(connection, workspaceId))) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    const result = await connection.run(
      `
        SELECT
          selected_model,
          selected_effort,
          CAST(gear_profiles AS VARCHAR) AS gear_profiles,
          active_gear_index,
          CAST(updated AS VARCHAR) AS updated
        FROM workspace_model_preferences
        WHERE workspace_id = $workspaceId
      `,
      { workspaceId }
    );
    const row = (await result.getRowObjectsJS())[0] as Record<string, unknown> | undefined;
    if (row) {
      return normalizeWorkspaceModelPreferences(
        workspaceId,
        {
          selectedModel: stringValue(row.selected_model),
          selectedEffort: stringValue(row.selected_effort),
          gearProfiles: parseSessionModelProfiles(row.gear_profiles),
          activeGearIndex: numberValue(row.active_gear_index)
        },
        defaultWorkspaceModelPreferences(workspaceId),
        stringValue(row.updated)
      );
    }

    // Preserve the workspace's most recently used gear setup on upgrade. Once
    // this value is saved, it becomes the single setting for every thread.
    const legacyResult = await connection.run(
      `
        SELECT
          preferences.selected_model,
          preferences.selected_effort,
          CAST(preferences.gear_profiles AS VARCHAR) AS gear_profiles,
          preferences.active_gear_index,
          CAST(preferences.updated AS VARCHAR) AS updated
        FROM session_model_preferences AS preferences
        JOIN sessions ON sessions.id = preferences.session_id
        WHERE sessions.workspace_id = $workspaceId
        ORDER BY preferences.updated DESC, sessions.updated DESC, sessions.id DESC
        LIMIT 1
      `,
      { workspaceId }
    );
    const legacyRow = (await legacyResult.getRowObjectsJS())[0] as Record<string, unknown> | undefined;
    if (!legacyRow) {
      return defaultWorkspaceModelPreferences(workspaceId);
    }
    return normalizeWorkspaceModelPreferences(
      workspaceId,
      {
        selectedModel: stringValue(legacyRow.selected_model),
        selectedEffort: stringValue(legacyRow.selected_effort),
        gearProfiles: parseSessionModelProfiles(legacyRow.gear_profiles),
        activeGearIndex: numberValue(legacyRow.active_gear_index)
      },
      defaultWorkspaceModelPreferences(workspaceId),
      stringValue(legacyRow.updated)
    );
  }

  private async syncSessionUpdatedWithLastTurn(connection: SessionDbConnection, sessionId: string): Promise<void> {
    await connection.run(
      `
        UPDATE sessions
        SET updated = greatest(
          sessions.created,
          coalesce(
            (SELECT max(created) FROM session_turn WHERE session_id = $sessionId),
            sessions.created
          ),
          coalesce(
            (SELECT max(updated) FROM local_session_file WHERE session_id = $sessionId),
            sessions.created
          )
        )
        WHERE id = $sessionId
      `,
      { sessionId }
    );
  }

  private async getSessionByThreadIdWithConnection(
    connection: SessionDbConnection,
    threadId: string,
    workspaceId?: string | null
  ) {
    const workspacePredicate = workspaceId ? "AND workspace_id = $workspaceId" : "";
    const result = await connection.run(
      `
        SELECT
          id,
          thread_id,
          workspace_id,
          cwd,
          account_id,
          CAST(keyword_weights AS VARCHAR) AS keyword_weights,
          title,
          title_source,
          description,
          parent_session_id,
          forked_from_turn_id,
          CAST(achieved_at AS VARCHAR) AS achieved_at,
          CAST(created AS VARCHAR) AS created,
          CAST(updated AS VARCHAR) AS updated
        FROM sessions
        WHERE thread_id = $threadId
          ${workspacePredicate}
        ORDER BY EXISTS (SELECT 1 FROM session_turn WHERE session_id = sessions.id) DESC,
          updated DESC, created DESC, id DESC
        LIMIT 1
      `,
      workspaceId ? { threadId, workspaceId } : { threadId }
    );
    const rows = await result.getRowObjectsJS();
    return rows.length > 0 ? toSessionRecord(rows[0] as SessionRow) : null;
  }

  private async insertSessionTurnWithConnection(
    connection: SessionDbConnection,
    input: RecordSessionTurnInput & { id: string },
    ignoreConflicts = false
  ): Promise<boolean> {
    const result = await connection.run(
      `
        INSERT INTO session_turn (
          id,
          session_id,
          account_id,
          account_name,
          account_email,
          account_external_account_id,
          account_external_user_id,
          user_input,
          agent_response,
          token_in,
          token_out,
          status,
          pending_reason,
          pending_load_balance,
          request_metadata,
          created
        )
        VALUES (
          $id,
          $sessionId,
          $accountId,
          $accountName,
          $accountEmail,
          $accountExternalAccountId,
          $accountExternalUserId,
          $userInput,
          $agentResponse,
          $tokenIn,
          $tokenOut,
          $status,
          $pendingReason,
          $pendingLoadBalance,
          $requestMetadata,
          now()
        )
        ${ignoreConflicts ? "ON CONFLICT DO NOTHING" : ""}
        RETURNING id
      `,
      {
        id: input.id,
        sessionId: input.sessionId,
        accountId: input.accountId ?? null,
        accountName: input.accountName ?? null,
        accountEmail: input.accountEmail ?? null,
        accountExternalAccountId: input.accountExternalAccountId ?? null,
        accountExternalUserId: input.accountExternalUserId ?? null,
        userInput: input.userInput,
        agentResponse: input.agentResponse,
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        status: input.status ?? "done",
        pendingReason: input.pendingReason ?? null,
        pendingLoadBalance: input.pendingLoadBalance ?? null,
        requestMetadata: input.requestMetadata ? JSON.stringify(input.requestMetadata) : null
      }
    );
    return (await result.getRowObjectsJS()).length > 0;
  }

  private async getLatestRunningTurnWithConnection(
    connection: SessionDbConnection,
    sessionId: string
  ): Promise<SessionTurnRecord | null> {
    const result = await connection.run(
      `
        SELECT id
        FROM session_turn
        WHERE session_id = $sessionId
          AND status = 'running'
        ORDER BY runner_started DESC NULLS LAST, created DESC
        LIMIT 1
      `,
      { sessionId }
    );
    const id = nullableString((await result.getRowObjectsJS())[0]?.id);
    return id ? this.getSessionTurnWithConnection(connection, id) : null;
  }

  private async getSessionTurnWithConnection(connection: SessionDbConnection, turnId: string): Promise<SessionTurnRecord | null> {
    const result = await connection.run(
      `
        SELECT
          session_turn.id,
          session_turn.session_id,
          EXISTS (SELECT 1 FROM turn_loop_mode WHERE turn_id = session_turn.id) AS loop_mode,
          session_turn.account_id,
          session_turn.user_input,
          session_turn.agent_response,
          session_turn.token_in,
          session_turn.token_out,
          session_turn.status,
          session_turn.runner_pid,
          CAST(session_turn.runner_started AS VARCHAR) AS runner_started,
          CAST(session_turn.runner_heartbeat AS VARCHAR) AS runner_heartbeat,
          session_turn.runner_log_path,
          session_turn.runner_exit_code,
          session_turn.last_event_name,
          session_turn.pending_reason,
          session_turn.pending_load_balance,
          CAST(session_turn.request_metadata AS VARCHAR) AS request_metadata,
          CAST(session_turn.created AS VARCHAR) AS created,
          ${resultExecutionDurationSelectSql},
          ${latestUsageSampleSelectSql}
        FROM session_turn
        ${latestUsageSampleJoinSql}
        WHERE session_turn.id = $turnId
      `,
      { turnId }
    );
    const rows = await result.getRowObjectsJS();
    return rows.length > 0 ? toSessionTurnRecord(rows[0] as SessionTurnRow) : null;
  }

  private async listSessionTurnsWithConnection(
    connection: SessionDbConnection,
    sessionId: string
  ): Promise<SessionTurnRecord[]> {
    const result = await connection.run(
      `
        SELECT
          session_turn.id,
          session_turn.session_id,
          EXISTS (SELECT 1 FROM turn_loop_mode WHERE turn_id = session_turn.id) AS loop_mode,
          session_turn.account_id,
          session_turn.user_input,
          session_turn.agent_response,
          session_turn.token_in,
          session_turn.token_out,
          session_turn.status,
          session_turn.runner_pid,
          CAST(session_turn.runner_started AS VARCHAR) AS runner_started,
          CAST(session_turn.runner_heartbeat AS VARCHAR) AS runner_heartbeat,
          session_turn.runner_log_path,
          session_turn.runner_exit_code,
          session_turn.last_event_name,
          session_turn.pending_reason,
          session_turn.pending_load_balance,
          CAST(session_turn.request_metadata AS VARCHAR) AS request_metadata,
          CAST(session_turn.created AS VARCHAR) AS created,
          ${resultExecutionDurationSelectSql},
          ${latestUsageSampleSelectSql}
        FROM session_turn
        ${latestUsageSampleJoinSql}
        WHERE session_turn.session_id = $sessionId
        ORDER BY session_turn.created ASC, session_turn.id ASC
      `,
      { sessionId }
    );
    return (await result.getRowObjectsJS()).map(toSessionTurnRecord);
  }

  private async resolveSessionWithConnection(
    connection: SessionDbConnection,
    input: SessionInspectorLookup
  ): Promise<SessionRecord | null> {
    const workspaceId = normalizeText(input.workspaceId);
    const sessionId = normalizeText(input.sessionId);
    if (sessionId) {
      for (const alias of sessionIdAliases(sessionId)) {
        const direct = await this.getSessionWithConnection(connection, alias);
        if (direct && (!workspaceId || direct.workspaceId === workspaceId)) return direct;
      }
      if (!isThreadexSessionId(sessionId)) {
        for (const alias of [`tx_${sessionId}`, `local_${sessionId}`]) {
          const local = await this.getSessionWithConnection(connection, alias);
          if (local && (!workspaceId || local.workspaceId === workspaceId)) return local;
        }
      }
    }

    const threadId = normalizeText(input.threadId);
    if (!threadId) {
      return null;
    }

    const workspacePredicate = workspaceId ? "AND workspace_id = $workspaceId" : "";
    const result = await connection.run(
      `
        SELECT
          id,
          thread_id,
          workspace_id,
          cwd,
          account_id,
          CAST(keyword_weights AS VARCHAR) AS keyword_weights,
          title,
          title_source,
          description,
          parent_session_id,
          forked_from_turn_id,
          CAST(achieved_at AS VARCHAR) AS achieved_at,
          CAST(created AS VARCHAR) AS created,
          CAST(updated AS VARCHAR) AS updated
        FROM sessions
        WHERE thread_id = $threadId
          ${workspacePredicate}
        ORDER BY updated DESC, created DESC
        LIMIT 1
      `,
      workspaceId ? { threadId, workspaceId } : { threadId }
    );
    const rows = await result.getRowObjectsJS();
    return rows.length > 0 ? toSessionRecord(rows[0] as SessionRow) : null;
  }

  private async resolveOptionalSessionFilterWithConnection(
    connection: SessionDbConnection,
    input: SessionInspectorLookup
  ): Promise<SessionRecord | null> {
    if (!normalizeText(input.sessionId) && !normalizeText(input.threadId)) {
      return null;
    }
    return this.resolveSessionWithConnection(connection, input);
  }

  private async listSessionTurnEventsWithConnection(
    connection: SessionDbConnection,
    input: {
      sessionId: string;
      turnId: string | null;
      eventName: string | null;
      query: string | null;
      limit: number;
      offset: number;
      order: "ASC" | "DESC";
    }
  ) {
    const where = ["session_id = $sessionId"];
    const filterParams: Record<string, SessionDbValue> = {
      sessionId: input.sessionId
    };
    if (input.turnId) {
      where.push("turn_id = $turnId");
      filterParams.turnId = input.turnId;
    }
    if (input.eventName) {
      where.push("event_name = $eventName");
      filterParams.eventName = input.eventName;
    }
    if (input.query) {
      where.push("contains(lower(CAST(payload AS VARCHAR)), lower($query))");
      filterParams.query = input.query;
    }

    const totalResult = await connection.run(
      `SELECT count(*) AS total FROM session_turn_event WHERE ${where.join(" AND ")}`,
      filterParams
    );
    const total = numberValue((await totalResult.getRowObjectsJS())[0]?.total);
    const pageParams = { ...filterParams, limit: input.limit, offset: input.offset };
    const result = await connection.run(
      `
        SELECT
          id,
          turn_id,
          session_id,
          event_name,
          CAST(payload AS VARCHAR) AS payload_json,
          CAST(created AS VARCHAR) AS created
        FROM session_turn_event
        WHERE ${where.join(" AND ")}
        ORDER BY created ${input.order}, id ${input.order}
        LIMIT $limit OFFSET $offset
      `,
      pageParams
    );
    return {
      total,
      records: (await result.getRowObjectsJS()).map(toSessionTurnEventRecord)
    };
  }

  private async listSessionSideChatsWithConnection(
    connection: SessionDbConnection,
    input: {
      sessionId: string;
      limit: number;
      offset: number;
      order: "ASC" | "DESC";
    }
  ) {
    const totalResult = await connection.run(
      "SELECT count(*) AS total FROM session_side_chat WHERE session_id = $sessionId",
      { sessionId: input.sessionId }
    );
    const total = numberValue((await totalResult.getRowObjectsJS())[0]?.total);
    const result = await connection.run(
      `
        SELECT
          id,
          session_id,
          workspace_id,
          source_session_id,
          source_thread_id,
          source_turn_id,
          question,
          answer,
          model,
          context_turn_count,
          context_filter,
          mode,
          CAST(created AS VARCHAR) AS created
        FROM session_side_chat
        WHERE session_id = $sessionId
        ORDER BY created ${input.order}, id ${input.order}
        LIMIT $limit OFFSET $offset
      `,
      {
        sessionId: input.sessionId,
        limit: input.limit,
        offset: input.offset
      }
    );
    return {
      total,
      records: (await result.getRowObjectsJS()).map(toSessionSideChatRecord)
    };
  }

  private async listSessionLiveItemsWithConnection(
    connection: SessionDbConnection,
    sessionId: string,
    turnId?: string
  ): Promise<Record<string, unknown[]>> {
    const turnFilter = turnId ? "AND turn_id = $turnId" : "";
    const queryParams = turnId ? { sessionId, turnId } : { sessionId };
    const result = await connection.run(
      `
        SELECT
          item_id AS event_id,
          turn_id,
          item_id,
          item_type,
          event_type,
          CAST(payload AS VARCHAR) AS payload_json,
          CAST(created AS VARCHAR) AS created
        FROM session_live_item
        WHERE session_id = $sessionId
          ${turnFilter}
        ORDER BY created ASC, item_id ASC
      `,
      queryParams
    );
    const itemsByTurn: Record<string, unknown[]> = {};
    for (const row of await result.getRowObjectsJS()) {
      const turnId = stringValue((row as { turn_id?: unknown }).turn_id);
      const payload = sessionLiveItemFromRow(row as Record<string, unknown>);
      if (!turnId || payload === null) {
        continue;
      }
      itemsByTurn[turnId] ??= [];
      itemsByTurn[turnId].push(withLiveItemSortFields(payload, row as Record<string, unknown>));
    }

    // Older managed turns persisted turn/diff/updated only as a raw Codex
    // event. Synthesize its final net file list on read so historical turns are
    // corrected too. New runners also persist this item directly for realtime
    // updates; in that case the stored authoritative item wins.
    // Stored net diffs already win over history. Only failed edits can require
    // repairing an incorrectly stored empty diff, so keep those turns eligible.
    const authoritativeTurnIds = Object.entries(itemsByTurn).filter(([, items]) =>
      items.some(isAuthoritativeFileChangeItem) && !items.some((item) => {
        const edit = recordValue(item);
        return edit?.itemType === "file_change" && !edit.authoritative && edit.status === "failed";
      })
    ).map(([id]) => id);
    const turnDiffRows = await this.listLatestTurnDiffsWithConnection(connection, sessionId, turnId, undefined, authoritativeTurnIds);
    const latestTurnDiffByTurn = new Map<string, Record<string, unknown>>();
    const rejectedEmptyDiffTurns = new Set<string>();
    for (const latestRow of turnDiffRows) {
      const currentTurnId = stringValue(latestRow.turn_id);
      if (!currentTurnId) continue;
      const edits = (itemsByTurn[currentTurnId] ?? [])
        .map(recordValue)
        .filter((item) => item?.itemType === "file_change" && !item.authoritative)
        .sort((a, b) => Date.parse(stringValue(b?.sortCreated)) - Date.parse(stringValue(a?.sortCreated)));
      let diffRow: Record<string, unknown> | undefined = latestRow;
      while (diffRow) {
        const diffTime = Date.parse(stringValue(diffRow.created));
        const lastEdit = edits.find((item) => Date.parse(stringValue(item?.sortCreated)) <= diffTime);
        // Walk back only when a failed patch published an invalid empty diff.
        // A successful revert's empty diff is authoritative and must stop here.
        if (stringValue(diffRow.diff).trim() || lastEdit?.status !== "failed") {
          latestTurnDiffByTurn.set(currentTurnId, diffRow);
          break;
        }
        rejectedEmptyDiffTurns.add(currentTurnId);
        [diffRow] = await this.listLatestTurnDiffsWithConnection(connection, sessionId, currentTurnId, {
          created: stringValue(diffRow.created), id: stringValue(diffRow.event_id)
        });
      }
    }
    for (const [turnId, row] of latestTurnDiffByTurn) {
      if (rejectedEmptyDiffTurns.has(turnId)) {
        itemsByTurn[turnId] = (itemsByTurn[turnId] ?? []).filter((item) => !isAuthoritativeFileChangeItem(item));
      } else if ((itemsByTurn[turnId] ?? []).some(isAuthoritativeFileChangeItem)) continue;
      const nativeTurnId = stringValue(row.native_turn_id);
      const eventId = stringValue(row.event_id);
      itemsByTurn[turnId] ??= [];
      itemsByTurn[turnId].push({
        id: `turn-diff:${nativeTurnId || eventId}`,
        eventType: "item.completed",
        itemType: "file_change",
        changes: fileChangesFromTurnDiff(stringValue(row.diff)),
        status: "completed",
        authoritative: true,
        sortCreated: stringValue(row.created),
        sortEventId: eventId
      });
    }
    return itemsByTurn;
  }

  private async listLatestTurnDiffsWithConnection(
    connection: SessionDbConnection,
    sessionId: string,
    turnId?: string,
    before?: { created: string; id: string },
    authoritativeTurnIds: string[] = []
  ): Promise<Record<string, unknown>[]> {
    // Use the existing session/turn/created index to search backward, stopping
    // at the latest diff for each turn. Historical cumulative diffs can total
    // gigabytes; never read them all merely to retain the last one in JavaScript.
    // Keep JSON extraction in JavaScript: PostgreSQL rejects escaped NULs when
    // json_extract_string runs against raw Codex output.
    const result = await connection.run(`
      WITH event_turns AS (
        SELECT DISTINCT turn_id FROM session_turn_event
        WHERE session_id = $sessionId AND event_name = 'codex'
          ${turnId ? "AND turn_id = $turnId" : ""}
          ${authoritativeTurnIds.length ? "AND turn_id <> ALL($authoritativeTurnIds::VARCHAR[])" : ""}
      ), latest_diffs AS MATERIALIZED (
        SELECT diff_event.* FROM event_turns
        CROSS JOIN LATERAL (
          SELECT id, turn_id, payload, created FROM session_turn_event
          WHERE session_id = $sessionId AND turn_id = event_turns.turn_id
            AND event_name = 'codex'
            ${before ? "AND (created, id) < ($beforeCreated::TIMESTAMPTZ, $beforeId)" : ""}
            AND contains(CAST(payload AS VARCHAR), 'turn/diff/updated')
          ORDER BY created DESC, id DESC LIMIT 1
        ) AS diff_event
      )
      SELECT id AS event_id, turn_id, CAST(payload AS VARCHAR) AS payload_json,
        CAST(created AS VARCHAR) AS created
      FROM latest_diffs
    `, {
      sessionId,
      ...(turnId ? { turnId } : {}),
      ...(authoritativeTurnIds.length ? { authoritativeTurnIds } : {}),
      ...(before ? { beforeCreated: before.created, beforeId: before.id } : {})
    });
    return (await result.getRowObjectsJS()).flatMap((row) => {
      const event = recordValue(parseJsonObject(row.payload_json));
      if (event?.method !== "turn/diff/updated") return [];
      const params = recordValue(event.params);
      return [{
        ...row,
        native_turn_id: params?.turnId,
        diff: params?.diff
      }];
    });
  }

  private async listSessionApprovalLiveItemsWithConnection(
    connection: SessionDbConnection,
    sessionId: string
  ): Promise<Record<string, unknown[]>> {
    const result = await connection.run(
      `
        WITH approval_events AS (
          SELECT
            id AS event_id,
            turn_id,
            event_name,
            payload,
            created,
            json_extract_string(payload, '$.approvalId') AS approval_id
          FROM session_turn_event
          WHERE session_id = $sessionId
            AND event_name IN ('approval.requested', 'approval.resolved')
        ),
        ranked AS (
          SELECT
            *,
            row_number() OVER (
              PARTITION BY turn_id, approval_id
              ORDER BY created DESC, event_id DESC
            ) AS row_number
          FROM approval_events
          WHERE approval_id IS NOT NULL
        ),
        answer_events AS (
          SELECT
            turn_id,
            json_extract_string(payload, '$.approvalId') AS approval_id,
            min(created) AS submitted_at
          FROM session_turn_event
          WHERE session_id = $sessionId
            AND event_name = 'approval.decision'
          GROUP BY turn_id, json_extract_string(payload, '$.approvalId')
        )
        SELECT
          ranked.event_id,
          ranked.turn_id,
          ranked.event_name,
          CAST(ranked.payload AS VARCHAR) AS payload_json,
          CAST(ranked.created AS VARCHAR) AS created,
          CAST(answer_events.submitted_at AS VARCHAR) AS answer_submitted_at
        FROM ranked
        LEFT JOIN answer_events
          ON answer_events.turn_id = ranked.turn_id
          AND answer_events.approval_id = ranked.approval_id
        WHERE ranked.row_number = 1
        ORDER BY ranked.created ASC, ranked.event_id ASC
      `,
      { sessionId }
    );

    const itemsByTurn: Record<string, unknown[]> = {};
    for (const row of await result.getRowObjectsJS()) {
      const turnId = stringValue((row as { turn_id?: unknown }).turn_id);
      const item = approvalLiveItemFromRow(row as Record<string, unknown>);
      if (!turnId || item === null) {
        continue;
      }
      itemsByTurn[turnId] ??= [];
      itemsByTurn[turnId].push(withLiveItemSortFields(item, row as Record<string, unknown>));
    }
    return itemsByTurn;
  }

  private async listSessionDeveloperInstructionsWithConnection(
    connection: SessionDbConnection,
    sessionId: string
  ): Promise<Record<string, SessionDeveloperInstructionsRecord[]>> {
    const result = await connection.run(
      `
        SELECT
          turn_id,
          CAST(payload AS VARCHAR) AS payload_json,
          CAST(created AS VARCHAR) AS created
        FROM session_turn_event
        WHERE session_id = $sessionId
          AND event_name = 'developer_instructions'
        ORDER BY created ASC, id ASC
      `,
      { sessionId }
    );

    const recordsByTurn: Record<string, SessionDeveloperInstructionsRecord[]> = {};
    for (const row of await result.getRowObjectsJS()) {
      const turnId = stringValue((row as { turn_id?: unknown }).turn_id);
      const payload = parseJsonObject((row as { payload_json?: unknown }).payload_json);
      if (!turnId || !payload || typeof payload !== "object") {
        continue;
      }
      const record = payload as Record<string, unknown>;
      const developerInstructions = nullableString(record.developerInstructions);
      if (!developerInstructions) {
        continue;
      }
      const phaseValue = record.phase;
      recordsByTurn[turnId] ??= [];
      recordsByTurn[turnId].push({
        target: nullableString(record.target) ?? "turn",
        phase: typeof phaseValue === "number" && Number.isFinite(phaseValue) ? phaseValue : null,
        developerInstructions,
        created: stringValue((row as { created?: unknown }).created)
      });
    }
    return recordsByTurn;
  }

  private async listSessionAutoModelProvidersWithConnection(
    connection: SessionDbConnection,
    sessionId: string
  ): Promise<Record<string, { provider: SessionAutoModelProvider; confidence?: number }>> {
    const result = await connection.run(
      `
        SELECT turn_id, CAST(payload AS VARCHAR) AS payload_json
        FROM session_turn_event
        WHERE session_id = $sessionId
          AND event_name = 'auto_model.selected'
        ORDER BY created ASC, id ASC
      `,
      { sessionId }
    );
    const providers: Record<string, { provider: SessionAutoModelProvider; confidence?: number }> = {};
    for (const row of await result.getRowObjectsJS()) {
      const turnId = stringValue((row as { turn_id?: unknown }).turn_id);
      const payload = parseJsonObject((row as { payload_json?: unknown }).payload_json);
      const provider = (payload as Record<string, unknown> | null)?.provider;
      if (turnId && (provider === "typesafe" || provider === "fallback")) {
        const confidence = (payload as Record<string, unknown>).confidence;
        providers[turnId] = { provider, ...(typeof confidence === "number" ? { confidence } : {}) };
      }
    }
    return providers;
  }

  private async listSessionSteerMessagesWithConnection(
    connection: SessionDbConnection,
    sessionId: string
  ): Promise<Record<string, SessionSteerMessageRecord[]>> {
    const result = await connection.run(
      `
        SELECT
          id,
          turn_id,
          event_name,
          CAST(payload AS VARCHAR) AS payload_json,
          CAST(created AS VARCHAR) AS created
        FROM session_turn_event
        WHERE session_id = $sessionId
          AND event_name IN ('steer', 'steer.accepted')
        ORDER BY created ASC, id ASC
      `,
      { sessionId }
    );

    const recordsByTurn = new Map<string, Map<string, { steer: SessionSteerMessageRecord; isDurableSteer: boolean }>>();
    for (const row of await result.getRowObjectsJS()) {
      const record = row as Record<string, unknown>;
      const turnId = stringValue(record.turn_id);
      const payload = parseJsonObject(record.payload_json);
      if (!turnId || !payload || typeof payload !== "object" || Array.isArray(payload)) {
        continue;
      }
      const steer = payload as Record<string, unknown>;
      // `steer.accepted` was the event emitted by older runners.  It already
      // contains the accepted command and is the only durable trace for steers
      // created before explicit `steer` persistence was added.
      const content = nullableString(steer.content) ?? nullableString(steer.message);
      if (!content) {
        continue;
      }
      const id = nullableString(steer.id) ?? nullableString(steer.commandId) ?? stringValue(record.id);
      if (!id) {
        continue;
      }
      const isDurableSteer = stringValue(record.event_name) === "steer";
      const byId = recordsByTurn.get(turnId) ?? new Map();
      const current = byId.get(id);
      // A current `steer` event carries attachments/force-plan state, so it
      // wins over the matching legacy acceptance event regardless of arrival
      // ordering.
      if (!current || (isDurableSteer && !current.isDurableSteer)) {
        byId.set(id, {
          isDurableSteer,
          steer: {
            id,
            content,
            attachments: Array.isArray(steer.attachments) ? steer.attachments : [],
            forcePlan: steer.forcePlan === true,
            created: stringValue(record.created)
          }
        });
      }
      recordsByTurn.set(turnId, byId);
    }
    return Object.fromEntries([...recordsByTurn].map(([turnId, steers]) => [
      turnId,
      [...steers.values()].map(({ steer }) => steer)
    ]));
  }

  private async searchSessionsWithFts(
    connection: SessionDbConnection,
    input: SessionSearchInput,
    query: string,
    limit: number,
    offset: number,
    maxTextChars: number | null
  ) {
    const filter = await this.sessionSearchFilter(connection, input);
    const params = { ...filter.params, query, limit, offset };
    const where = filter.where.length > 0 ? `AND ${filter.where.join(" AND ")}` : "";
    const result = await connection.run(
      `
        WITH scored AS (
          SELECT
            session_turn.id,
            session_turn.session_id,
            session_turn.account_id,
            session_turn.user_input,
            session_turn.agent_response,
            session_turn.token_in,
            session_turn.token_out,
            session_turn.status,
            session_turn.runner_pid,
            CAST(session_turn.runner_started AS VARCHAR) AS runner_started,
            CAST(session_turn.runner_heartbeat AS VARCHAR) AS runner_heartbeat,
            session_turn.runner_log_path,
            session_turn.runner_exit_code,
            session_turn.last_event_name,
            CAST(session_turn.created AS VARCHAR) AS created,
            sessions.thread_id,
            sessions.workspace_id,
            sessions.cwd,
            sessions.title,
            sessions.description,
            CAST(sessions.created AS VARCHAR) AS session_created,
            CAST(sessions.updated AS VARCHAR) AS session_updated,
            fts_main_session_turn.match_bm25(session_turn.id, $query) AS score
          FROM session_turn
          JOIN sessions ON sessions.id = session_turn.session_id
        )
        SELECT *
        FROM scored
        WHERE score IS NOT NULL
          ${where}
        ORDER BY score DESC, created DESC
        LIMIT $limit OFFSET $offset
      `,
      params
    );
    const rows = (await result.getRowObjectsJS()).map((row) => sessionSearchResultFromRow(row as SessionSearchRow, maxTextChars));
    const total = rows.length < limit && offset === 0 ? rows.length : null;
    return { results: rows, page: { limit, offset, total, hasMore: rows.length === limit } };
  }

  private async searchSessionsWithContains(
    connection: SessionDbConnection,
    input: SessionSearchInput,
    query: string | null,
    limit: number,
    offset: number,
    maxTextChars: number | null
  ) {
    const filter = await this.sessionSearchFilter(connection, input);
    const where = [...filter.where];
    const filterParams: Record<string, SessionDbValue> = { ...filter.params };
    if (query) {
      where.push("(contains(lower(session_turn.user_input), lower($query)) OR contains(lower(session_turn.agent_response), lower($query)) OR contains(lower(sessions.title), lower($query)) OR contains(lower(sessions.description), lower($query)))");
      filterParams.query = query;
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const totalResult = await connection.run(
      `
        SELECT count(*) AS total
        FROM session_turn
        JOIN sessions ON sessions.id = session_turn.session_id
        ${whereSql}
      `,
      filterParams
    );
    const total = numberValue((await totalResult.getRowObjectsJS())[0]?.total);
    const pageParams = { ...filterParams, limit, offset };
    const result = await connection.run(
      `
        SELECT
          session_turn.id,
          session_turn.session_id,
          session_turn.account_id,
          session_turn.user_input,
          session_turn.agent_response,
          session_turn.token_in,
          session_turn.token_out,
          session_turn.status,
          session_turn.runner_pid,
          CAST(session_turn.runner_started AS VARCHAR) AS runner_started,
          CAST(session_turn.runner_heartbeat AS VARCHAR) AS runner_heartbeat,
          session_turn.runner_log_path,
          session_turn.runner_exit_code,
          session_turn.last_event_name,
          CAST(session_turn.created AS VARCHAR) AS created,
          sessions.thread_id,
          sessions.workspace_id,
          sessions.cwd,
          sessions.title,
          sessions.description,
          CAST(sessions.created AS VARCHAR) AS session_created,
          CAST(sessions.updated AS VARCHAR) AS session_updated,
          ${query ? "1.0" : "NULL"} AS score
        FROM session_turn
        JOIN sessions ON sessions.id = session_turn.session_id
        ${whereSql}
        ORDER BY session_turn.created DESC, session_turn.id DESC
        LIMIT $limit OFFSET $offset
      `,
      pageParams
    );
    const rows = (await result.getRowObjectsJS()).map((row) => sessionSearchResultFromRow(row as SessionSearchRow, maxTextChars));
    return { results: rows, page: { limit, offset, total, hasMore: offset + rows.length < total } };
  }

  private async sessionSearchFilter(connection: SessionDbConnection, input: SessionSearchInput) {
    const where: string[] = ["NOT EXISTS (SELECT 1 FROM workspace_manager_archive a WHERE a.session_id = sessions.id)"];
    const params: Record<string, SessionDbValue> = {};
    const workspaceId = normalizeText(input.workspaceId);
    if (workspaceId) {
      where.push("sessions.workspace_id = $workspaceId");
      params.workspaceId = workspaceId;
    }
    const status = normalizeSessionTurnStatus(input.status);
    if (status) {
      where.push("session_turn.status = $status");
      params.status = status;
    }
    const session = await this.resolveOptionalSessionFilterWithConnection(connection, input);
    if (session) {
      where.push("session_turn.session_id = $sessionId");
      params.sessionId = session.id;
    }
    return { where, params };
  }

  private async tableExists(connection: SessionDbConnection, tableName: string) {
    const result = await connection.run(
      `
        SELECT 1 AS found
        FROM information_schema.tables
        WHERE table_name = $tableName
        LIMIT 1
      `,
      { tableName }
    );
    return (await result.getRowObjectsJS()).length > 0;
  }

  private async tryLoadVss(connection: SessionDbConnection) {
    return connection.tryLoadVss();
  }

  private async ensureDefaultWorkspaceWithConnection(connection: SessionDbConnection): Promise<WorkspaceRecord> {
    const existing = await this.getWorkspaceWithConnection(connection, "default");
    if (existing) {
      const codexHome = defaultCodexHome();
      if (shouldUpdateDefaultWorkspaceCodexHome(existing.codexHome, codexHome)) {
        await connection.run(
          `
            UPDATE workspaces
            SET codex_home = $codexHome, updated = now()
            WHERE id = 'default'
          `,
          { codexHome }
        );
        return await this.getWorkspaceWithConnection(connection, "default") ?? existing;
      }
      return existing;
    }

    await connection.run(
      `
        INSERT INTO workspaces (id, name, codex_home, cwd, created, updated)
        VALUES ('default', 'Default', $codexHome, $cwd, now(), now())
        ON CONFLICT (id) DO NOTHING
      `,
      {
        codexHome: defaultCodexHome(),
        cwd: defaultCwd()
      }
    );
    await connection.run(`
      INSERT INTO active_workspace (key, workspace_id, updated)
      VALUES ('active', 'default', now())
      ON CONFLICT (key) DO NOTHING
    `);
    const workspace = await this.getWorkspaceWithConnection(connection, "default");
    if (!workspace) {
      throw new Error("Failed to initialize default workspace.");
    }
    return workspace;
  }

  private async getActiveWorkspaceIdWithConnection(connection: SessionDbConnection) {
    const result = await connection.run("SELECT workspace_id FROM active_workspace WHERE key = 'active'");
    const rows = await result.getRowObjectsJS();
    return typeof rows[0]?.workspace_id === "string" ? rows[0].workspace_id : null;
  }

  private async getWorkspaceWithConnection(connection: SessionDbConnection, id: string): Promise<WorkspaceRecord | null> {
    const result = await connection.run(
      `
        SELECT
          id,
          name,
          codex_home,
          cwd,
          CAST(created AS VARCHAR) AS created,
          CAST(updated AS VARCHAR) AS updated
        FROM workspaces
        WHERE id = $id
      `,
      { id }
    );
    const rows = await result.getRowObjectsJS();
    return rows.length > 0 ? toWorkspaceRecord(rows[0] as WorkspaceRow) : null;
  }

  private async getAccountWithConnection(connection: SessionDbConnection, id: string): Promise<AccountRecord | null> {
    const result = await connection.run(
      `
        SELECT
          id,
          name,
          external_account_id,
          external_user_id,
          email,
          CASE WHEN auth_json IS NOT NULL AND auth_json <> '' THEN true ELSE false END AS has_auth,
          auth_version,
          CAST(quota_snapshot AS VARCHAR) AS quota_snapshot,
          CAST(quota_updated_at AS VARCHAR) AS quota_updated_at,
          quota_error,
          CAST(created AS VARCHAR) AS created,
          CAST(updated AS VARCHAR) AS updated,
          CAST(last_used AS VARCHAR) AS last_used
        FROM accounts
        WHERE id = $id
      `,
      { id }
    );
    const rows = await result.getRowObjectsJS();
    return rows.length > 0 ? toAccountRecord(rows[0] as AccountRow) : null;
  }

  private async backfillExternalAccountColumns(connection: SessionDbConnection) {
    if (await this.columnExists(connection, "accounts", "account_id")) {
      await connection.run(`
        UPDATE accounts
        SET external_account_id = account_id
        WHERE external_account_id IS NULL
          AND account_id IS NOT NULL
      `);
    }

    if (await this.columnExists(connection, "accounts", "user_id")) {
      await connection.run(`
        UPDATE accounts
        SET external_user_id = user_id
        WHERE external_user_id IS NULL
          AND user_id IS NOT NULL
      `);
    }
  }

  private async upsertImportedLocalSessionWithConnection(
    connection: SessionDbConnection,
    session: ParsedLocalCodexSessionFile
  ): Promise<void> {
    if (!session.sessionId) {
      return;
    }
    const keywordWeights: KeywordWeights = {};
    await connection.run(
      `
        INSERT INTO sessions (
          id,
          thread_id,
          workspace_id,
          cwd,
          account_id,
          keyword_weights,
          title,
          title_source,
          description,
          parent_session_id,
          forked_from_turn_id,
          created,
          updated
        )
        VALUES (
          $id,
          $threadId,
          $workspaceId,
          $cwd,
          NULL,
          $keywordWeights::JSON,
          $title,
          'initial',
          $description,
          $parentSessionId,
          NULL,
          $created,
          $updated
        )
        ON CONFLICT (id) DO UPDATE SET
          thread_id = excluded.thread_id,
          workspace_id = excluded.workspace_id,
          cwd = excluded.cwd,
          title = CASE
            WHEN sessions.title_source = 'initial' THEN excluded.title
            ELSE sessions.title
          END,
          description = excluded.description,
          parent_session_id = coalesce(sessions.parent_session_id, excluded.parent_session_id),
          updated = excluded.updated
      `,
      {
        id: session.sessionId,
        threadId: session.threadId,
        workspaceId: session.workspaceId,
        cwd: session.cwd,
        keywordWeights: JSON.stringify(keywordWeights),
        title: session.title,
        description: session.description,
        parentSessionId: session.parentSessionId,
        created: session.created,
        updated: session.updated
      }
    );
  }

  private async upsertImportedLocalTurnWithConnection(
    connection: SessionDbConnection,
    session: ParsedLocalCodexSessionFile,
    turn: LocalCodexSessionTurn
  ): Promise<void> {
    if (!session.sessionId) {
      return;
    }
    const partialResponse = turn.finalResponses.join("\n\n") || turn.assistantMessages.join("\n\n");
    const agentResponse = turn.interrupted
      ? [partialResponse, "_Turn interrupted by user before completion._"].filter(Boolean).join("\n\n")
      : partialResponse;
    const lastEventName = turn.interrupted ? "local.hook_imported_aborted" : "local.hook_imported";
    await connection.run(
      `
        INSERT INTO session_turn (
          id,
          session_id,
          account_id,
          account_name,
          account_email,
          account_external_account_id,
          account_external_user_id,
          user_input,
          agent_response,
          token_in,
          token_out,
          status,
          pending_reason,
          pending_load_balance,
          runner_pid,
          runner_started,
          runner_heartbeat,
          runner_log_path,
          runner_exit_code,
          last_event_name,
          created
        )
        VALUES (
          $id,
          $sessionId,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          $userInput,
          $agentResponse,
          $tokenIn,
          $tokenOut,
          $status,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          $lastEventName,
          $created
        )
        ON CONFLICT (id) DO UPDATE SET
          session_id = excluded.session_id,
          user_input = excluded.user_input,
          agent_response = excluded.agent_response,
          token_in = excluded.token_in,
          token_out = excluded.token_out,
          status = excluded.status,
          last_event_name = CASE
            WHEN session_turn.last_event_name LIKE 'local.%' THEN excluded.last_event_name
            ELSE session_turn.last_event_name
          END
      `,
      {
        id: turn.id,
        sessionId: session.sessionId,
        userInput: turn.userInput,
        agentResponse,
        tokenIn: turn.tokenIn,
        tokenOut: turn.tokenOut,
        status: turn.status,
        lastEventName,
        created: turn.created
      }
    );
    await connection.run(
      `
        INSERT INTO token_usage (
          id, usage_type, source, session_id, turn_id, account_id, model,
          input_tokens, output_tokens, total_tokens, source_timestamp, created, updated
        )
        VALUES (
          $id, 'agent', 'local_hook_import', $sessionId, $turnId, NULL, $model,
          $inputTokens, $outputTokens, $totalTokens, $created::TIMESTAMPTZ, now(), now()
        )
        ON CONFLICT (id) DO UPDATE SET
          source = excluded.source,
          model = COALESCE(excluded.model, token_usage.model),
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          total_tokens = excluded.total_tokens,
          source_timestamp = excluded.source_timestamp,
          updated = now()
      `,
      {
        id: `agent:turn:${turn.id}`,
        sessionId: session.sessionId,
        turnId: turn.id,
        model: turn.model,
        inputTokens: turn.tokenIn,
        outputTokens: turn.tokenOut,
        totalTokens: turn.tokenIn + turn.tokenOut,
        created: turn.created
      }
    );
  }

  private async reconcileImportedLocalTurnIdsWithConnection(
    connection: SessionDbConnection,
    session: ParsedLocalCodexSessionFile
  ): Promise<void> {
    if (!session.sessionId || session.turns.length === 0) {
      return;
    }

    const result = await connection.run(
      `
        SELECT id, user_input, last_event_name, CAST(created AS VARCHAR) AS created
        FROM session_turn
        WHERE session_id = $sessionId
        ORDER BY created ASC, id ASC
      `,
      { sessionId: session.sessionId }
    );
    const existingTurns = (await result.getRowObjectsJS()).map((row) => ({
      id: stringValue(row.id),
      userInput: stringValue(row.user_input),
      lastEventName: nullableString(row.last_event_name),
      created: nullableString(row.created)
    })).filter((turn): turn is {
      id: string;
      userInput: string;
      lastEventName: string | null;
      created: string | null;
    } => Boolean(turn.id && turn.userInput));
    const usedIds = new Set<string>();
    const turnIdMap = new Map<string, string>();

    for (const turn of session.turns) {
      const candidates = existingTurns
        .filter((candidate) => !usedIds.has(candidate.id))
        .filter((candidate) => importedLocalTurnPromptsMatch(candidate.userInput, turn.userInput))
        .sort((left, right) => {
          const leftManagerOwned = !isImportedLocalTurnRow(left.lastEventName);
          const rightManagerOwned = !isImportedLocalTurnRow(right.lastEventName);
          if (leftManagerOwned !== rightManagerOwned) return leftManagerOwned ? -1 : 1;
          const leftIsNativeId = left.id === turn.id;
          const rightIsNativeId = right.id === turn.id;
          if (leftIsNativeId !== rightIsNativeId) return leftIsNativeId ? -1 : 1;
          return Math.abs(Date.parse(left.created ?? turn.created) - Date.parse(turn.created)) -
            Math.abs(Date.parse(right.created ?? turn.created) - Date.parse(turn.created));
        });
      const matched = candidates[0];
      if (!matched) {
        continue;
      }

      usedIds.add(matched.id);
      turnIdMap.set(turn.id, matched.id);
      if (matched.id !== turn.id && isImportedLocalTurnRow(matched.lastEventName)) {
        await this.deleteImportedLocalTurnWithConnection(connection, session.sessionId, turn.id);
      }
    }

    if (turnIdMap.size === 0) {
      return;
    }
    for (const turn of session.turns) {
      turn.id = turnIdMap.get(turn.id) ?? turn.id;
    }
    for (const liveItem of session.liveItems) {
      liveItem.turnId = turnIdMap.get(liveItem.turnId) ?? liveItem.turnId;
    }
    for (const event of session.events) {
      if (event.turnId) {
        event.turnId = turnIdMap.get(event.turnId) ?? event.turnId;
      }
    }
  }

  private async deleteImportedLocalTurnWithConnection(
    connection: SessionDbConnection,
    sessionId: string,
    turnId: string
  ): Promise<void> {
    await connection.run(
      `
        DELETE FROM token_usage
        WHERE turn_id = $turnId
          AND session_id = $sessionId
          AND starts_with(COALESCE(source, ''), 'local')
      `,
      { turnId, sessionId }
    );
    await connection.run(
      `
        DELETE FROM session_turn_event
        WHERE turn_id = $turnId
          AND session_id = $sessionId
          AND event_name LIKE 'local.%'
      `,
      { turnId, sessionId }
    );
    await connection.run(
      `
        DELETE FROM session_live_item
        WHERE turn_id = $turnId
          AND session_id = $sessionId
          AND starts_with(COALESCE(source_event_id, ''), 'local-live:')
      `,
      { turnId, sessionId }
    );
    await connection.run(
      `
        DELETE FROM session_turn
        WHERE id = $turnId
          AND session_id = $sessionId
          AND last_event_name LIKE 'local.%'
      `,
      { turnId, sessionId }
    );
  }

  private async isManagerOwnedSessionWithConnection(
    connection: SessionDbConnection,
    sessionId: string
  ): Promise<boolean> {
    const result = await connection.run(
      `
        SELECT count(*) AS count
        FROM session_turn
        WHERE session_id = $sessionId
          AND runner_log_path IS NOT NULL
      `,
      { sessionId }
    );
    return numberValue((await result.getRowObjectsJS())[0]?.count) > 0;
  }

  /**
   * A Threadex runner normally streams its own turn updates directly to
   * PostgreSQL, so importing the same Codex transcript would create duplicate
   * turns. If that stream is lost, though, the local transcript is the only
   * completion record. Reconcile a matching running manager turn, an exactly
   * linked turn that the watchdog moved to stopped-pending while its backlog
   * was still draining, or the terminal active-writer placeholder that means
   * the actual work continued in the native Codex client. Other local history
   * is imported separately.
   */
  private async reconcileRunningManagerOwnedLocalTurnsWithConnection(
    connection: SessionDbConnection,
    session: ParsedLocalCodexSessionFile,
    managedNativeTurnLinks: ReadonlyMap<string, string>
  ): Promise<number> {
    if (!session.sessionId || session.turns.length === 0) {
      return 0;
    }

    const result = await connection.run(
      `
        SELECT id, user_input, status, runner_pid, CAST(created AS VARCHAR) AS created
        FROM session_turn
        WHERE session_id = $sessionId
          AND runner_log_path IS NOT NULL
          AND (
            status = 'running'
            OR (status = 'todo' AND pending_reason = 'stopped')
            OR agent_response LIKE 'Codex error: thread % already has an active writer%'
          )
        ORDER BY created ASC, id ASC
      `,
      { sessionId: session.sessionId }
    );
    const managerTurns = (await result.getRowObjectsJS())
      .map((row) => ({
        id: stringValue(row.id),
        userInput: stringValue(row.user_input),
        status: stringValue(row.status),
        runnerPid: nullableNumber(row.runner_pid),
        created: nullableString(row.created)
      }))
      .filter((turn): turn is {
        id: string;
        userInput: string;
        status: string;
        runnerPid: number | null;
        created: string | null;
      } => Boolean(turn.id && turn.userInput))
      // A completed native attempt can already be present in the transcript
      // while Threadex is retrying the same prompt with another account.
      // Never let that older transcript finish a manager turn whose runner is
      // still alive (or has not received its PID yet). Dead runners can still
      // be recovered here; the active-writer placeholder path remains below.
      .filter((turn) => turn.status !== "running" || (
        turn.runnerPid !== null && !isLocalRunnerProcessAlive(turn.runnerPid)
      ));
    const usedManagerTurnIds = new Set<string>();
    let reconciled = 0;

    for (const localTurn of session.turns) {
      const linkedManagerTurnId = managedNativeTurnLinks.get(localTurn.id);
      const managerTurn = (linkedManagerTurnId
        ? managerTurns.filter((candidate) => candidate.id === linkedManagerTurnId)
        : managerTurns
      )
        .filter((candidate) => !usedManagerTurnIds.has(candidate.id))
        // A stopped pending turn is safe to complete only when the Stop hook
        // linked it to this exact native Codex turn. Prompt-only matching can
        // otherwise consume an older completion intended for a later retry.
        .filter((candidate) => candidate.status !== "todo" || candidate.id === linkedManagerTurnId)
        .filter((candidate) => linkedManagerTurnId || importedLocalTurnPromptsMatch(candidate.userInput, localTurn.userInput))
        .sort(
          (left, right) =>
            Math.abs(Date.parse(left.created ?? localTurn.created) - Date.parse(localTurn.created)) -
            Math.abs(Date.parse(right.created ?? localTurn.created) - Date.parse(localTurn.created))
        )[0];
      if (!managerTurn) {
        continue;
      }

      const agentResponse = localTurn.finalResponses.join("\n\n") || localTurn.assistantMessages.join("\n\n");
      const updated = await connection.run(
        `
          UPDATE session_turn
          SET
            agent_response = CASE
              WHEN nullif($agentResponse, '') IS NULL THEN agent_response
              ELSE $agentResponse
            END,
            token_in = greatest(coalesce(token_in, 0), $tokenIn),
            token_out = greatest(coalesce(token_out, 0), $tokenOut),
            status = 'done',
            pending_reason = NULL,
            pending_load_balance = NULL,
            runner_pid = NULL,
            runner_heartbeat = now(),
            runner_exit_code = coalesce(runner_exit_code, 0),
            last_event_name = 'local.manager_reconciled'
          WHERE id = $turnId
            AND session_id = $sessionId
            AND runner_log_path IS NOT NULL
            AND (
              (status = 'running' AND runner_pid = $runnerPid)
              OR (status = 'todo' AND pending_reason = 'stopped')
              OR agent_response LIKE 'Codex error: thread % already has an active writer%'
            )
          RETURNING account_id
        `,
        {
          turnId: managerTurn.id,
          sessionId: session.sessionId,
          runnerPid: managerTurn.runnerPid,
          agentResponse,
          tokenIn: localTurn.tokenIn,
          tokenOut: localTurn.tokenOut
        }
      );
      const rows = await updated.getRowObjectsJS();
      if (rows.length === 0) {
        continue;
      }

      usedManagerTurnIds.add(managerTurn.id);
      reconciled += 1;
      await connection.run(
        `
          INSERT INTO token_usage (
            id, usage_type, source, session_id, turn_id, account_id, model,
            input_tokens, output_tokens, total_tokens, source_timestamp, created, updated
          )
          VALUES (
            $id, 'agent', 'local_manager_reconciled', $sessionId, $turnId, $accountId, $model,
            $inputTokens, $outputTokens, $totalTokens, $sourceTimestamp::TIMESTAMPTZ, now(), now()
          )
          ON CONFLICT (id) DO UPDATE SET
            source = excluded.source,
            account_id = excluded.account_id,
            model = COALESCE(excluded.model, token_usage.model),
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            total_tokens = excluded.total_tokens,
            source_timestamp = excluded.source_timestamp,
            updated = now()
        `,
        {
          id: `agent:turn:${managerTurn.id}`,
          sessionId: session.sessionId,
          turnId: managerTurn.id,
          accountId: nullableString(rows[0]?.account_id),
          model: localTurn.model,
          inputTokens: localTurn.tokenIn,
          outputTokens: localTurn.tokenOut,
          totalTokens: localTurn.tokenIn + localTurn.tokenOut,
          sourceTimestamp: localTurn.created
        }
      );
    }

    return reconciled;
  }

  /**
   * A manager-owned thread can continue in the native Codex client after the
   * initial managed turn. Keep the manager turn as the canonical record when
   * prompts match, but import every other completed native turn into that same
   * session so the transcript does not silently stop after the first round.
   */
  private async importUnmatchedLocalTurnsForManagedSessionWithConnection(
    connection: SessionDbConnection,
    session: ParsedLocalCodexSessionFile,
    includeRawEvents: boolean,
    managedNativeTurnLinks: ReadonlyMap<string, string>
  ): Promise<{ turns: number; events: number }> {
    if (!session.sessionId || session.turns.length === 0) {
      return { turns: 0, events: 0 };
    }

    const result = await connection.run(
      `
        SELECT id, user_input, CAST(created AS VARCHAR) AS created
        FROM session_turn
        WHERE session_id = $sessionId
          AND runner_log_path IS NOT NULL
        ORDER BY created ASC, id ASC
      `,
      { sessionId: session.sessionId }
    );
    const managerTurns = (await result.getRowObjectsJS())
      .map((row) => ({
        id: stringValue(row.id),
        userInput: stringValue(row.user_input),
        created: nullableString(row.created)
      }))
      .filter((turn): turn is { id: string; userInput: string; created: string | null } => Boolean(turn.id && turn.userInput));
    const usedManagerTurnIds = new Set<string>();
    const externalTurns: LocalCodexSessionTurn[] = [];

    for (const localTurn of session.turns) {
      const linkedManagerTurnId = managedNativeTurnLinks.get(localTurn.id);
      if (linkedManagerTurnId) {
        usedManagerTurnIds.add(linkedManagerTurnId);
        continue;
      }
      const managerTurn = managerTurns
        .filter((candidate) => !usedManagerTurnIds.has(candidate.id))
        .filter((candidate) => importedLocalTurnPromptsMatch(candidate.userInput, localTurn.userInput))
        .sort(
          (left, right) =>
            Math.abs(Date.parse(left.created ?? localTurn.created) - Date.parse(localTurn.created)) -
            Math.abs(Date.parse(right.created ?? localTurn.created) - Date.parse(localTurn.created))
        )[0];
      if (managerTurn) {
        usedManagerTurnIds.add(managerTurn.id);
      } else {
        externalTurns.push(localTurn);
      }
    }

    for (const turn of externalTurns) {
      await this.upsertImportedLocalTurnWithConnection(connection, session, turn);
    }

    const externalTurnIds = new Set(externalTurns.map((turn) => turn.id));
    await this.deleteImportedLocalLiveItemsWithConnection(connection, session.sessionId);
    for (const liveItem of session.liveItems) {
      if (externalTurnIds.has(liveItem.turnId)) {
        await this.upsertImportedLocalLiveItemWithConnection(connection, session.sessionId, liveItem);
      }
    }

    let eventCount = 0;
    if (includeRawEvents) {
      for (const event of session.events) {
        if (event.turnId && externalTurnIds.has(event.turnId) && shouldPersistImportedLocalAuditEvent(event)) {
          await this.upsertImportedLocalEventWithConnection(connection, session, event);
          eventCount += 1;
        }
      }
    }

    return { turns: externalTurns.length, events: eventCount };
  }

  private async listManagedRunnerNativeTurnLinksWithConnection(
    connection: SessionDbConnection,
    sessionId: string
  ): Promise<Map<string, string>> {
    const result = await connection.run(
      `
        SELECT
          turn_id,
          json_extract_string(payload, '$.nativeTurnId') AS native_turn_id
        FROM session_turn_event
        WHERE session_id = $sessionId
          AND event_name = 'runner.native_turn_link'
        ORDER BY created ASC, id ASC
      `,
      { sessionId }
    );
    const links = new Map<string, string>();
    for (const row of await result.getRowObjectsJS()) {
      const nativeTurnId = stringValue(row.native_turn_id);
      const managerTurnId = stringValue(row.turn_id);
      if (nativeTurnId && managerTurnId && !links.has(nativeTurnId)) {
        links.set(nativeTurnId, managerTurnId);
      }
    }
    return links;
  }

  private async deleteImportedLocalTurnsForManagedSessionWithConnection(
    connection: SessionDbConnection,
    sessionId: string
  ): Promise<void> {
    const result = await connection.run(
      `
        SELECT id
        FROM session_turn AS imported_turn
        WHERE imported_turn.session_id = $sessionId
          AND imported_turn.last_event_name IN ('local.hook_imported', 'local.hook_imported_aborted', 'local.imported')
          AND imported_turn.created >= (
            SELECT min(manager_turn.created)
            FROM session_turn AS manager_turn
            WHERE manager_turn.session_id = $sessionId
              AND manager_turn.runner_log_path IS NOT NULL
          )
      `,
      { sessionId }
    );
    for (const row of await result.getRowObjectsJS()) {
      const turnId = stringValue(row.id);
      if (turnId) {
        await this.deleteImportedLocalTurnWithConnection(connection, sessionId, turnId);
      }
    }
  }

  private async deleteImportedLocalIncompleteTurnsWithConnection(
    connection: SessionDbConnection,
    session: ParsedLocalCodexSessionFile
  ): Promise<void> {
    if (!session.sessionId || session.incompleteTurnIds.length === 0) {
      return;
    }
    for (const turnId of session.incompleteTurnIds) {
      await this.deleteImportedLocalTurnWithConnection(connection, session.sessionId, turnId);
    }
  }

  private async deleteImportedLocalIncompleteTurnsForPathWithConnection(
    connection: SessionDbConnection,
    session: ParsedLocalCodexSessionFile
  ): Promise<void> {
    if (session.incompleteTurnIds.length === 0) {
      return;
    }
    const previousFileResult = await connection.run(
      `
        SELECT DISTINCT session_id
        FROM local_session_file
        WHERE path = $path
          AND session_id IS NOT NULL
      `,
      { path: session.path }
    );
    const previousSessionIds = (await previousFileResult.getRowObjectsJS())
      .map((row) => nullableString(row.session_id))
      .filter((value): value is string => Boolean(value));
    for (const sessionId of new Set([...previousSessionIds, session.sessionId].filter((value): value is string => Boolean(value)))) {
      await this.deleteImportedLocalIncompleteTurnsWithConnection(connection, {
        ...session,
        sessionId
      });
    }
  }

  private async deleteImportedLocalLiveItemsWithConnection(
    connection: SessionDbConnection,
    sessionId: string
  ): Promise<void> {
    await connection.run(
      `
        DELETE FROM session_live_item
        WHERE session_id = $sessionId
          AND starts_with(COALESCE(source_event_id, ''), 'local-live:')
      `,
      { sessionId }
    );
  }

  private async upsertImportedLocalLiveItemWithConnection(
    connection: SessionDbConnection,
    sessionId: string,
    liveItem: LocalCodexLiveItem
  ): Promise<void> {
    await this.upsertSessionLiveItemWithConnection(connection, {
      id: `local-live:${liveItem.turnId}:${nonEmptyString(liveItem.item.id) ?? shortHash(JSON.stringify(liveItem.item))}:${liveItem.jsonlIndex}`,
      turnId: liveItem.turnId,
      sessionId,
      eventName: "item",
      payload: liveItem.item,
      jsonlIndex: liveItem.jsonlIndex,
      created: liveItem.created
    });
  }

  private async upsertImportedLocalEventWithConnection(
    connection: SessionDbConnection,
    session: ParsedLocalCodexSessionFile,
    event: LocalCodexSessionEvent
  ): Promise<void> {
    if (!session.sessionId || !event.turnId) {
      return;
    }
    await connection.run(
      `
        INSERT INTO session_turn_event (
          id,
          turn_id,
          session_id,
          event_name,
          payload,
          created
        )
        VALUES (
          $id,
          $turnId,
          $sessionId,
          $eventName,
          $payload::JSON,
          COALESCE($created::TIMESTAMPTZ, now())
        )
        ON CONFLICT (id) DO UPDATE SET
          turn_id = excluded.turn_id,
          session_id = excluded.session_id,
          event_name = excluded.event_name,
          payload = excluded.payload
      `,
      {
        id: `local:${shortHash(`${session.path}:${event.index}`)}`,
        turnId: event.turnId,
        sessionId: session.sessionId,
        eventName: localCodexEventName(event),
        payload: stringifyStoredJson(event.raw),
        created: event.timestamp
      }
    );
  }

  private async upsertImportedLocalSessionFileWithConnection(
    connection: SessionDbConnection,
    session: ParsedLocalCodexSessionFile
  ): Promise<void> {
    await connection.run(
      `
        INSERT INTO local_session_file (
          path,
          source,
          workspace_id,
          session_id,
          title,
          cwd,
          file_size,
          file_mtime,
          event_count,
          turn_count,
          open_turn_count,
          parse_error,
          imported_at,
          created,
          updated
        )
        VALUES (
          $path,
          $source,
          $workspaceId,
          $sessionId,
          $title,
          $cwd,
          $fileSize,
          $fileMtime,
          $eventCount,
          $turnCount,
          $openTurnCount,
          $parseError,
          now(),
          $created,
          $updated
        )
        ON CONFLICT (path) DO UPDATE SET
          source = excluded.source,
          workspace_id = excluded.workspace_id,
          session_id = excluded.session_id,
          title = excluded.title,
          cwd = excluded.cwd,
          file_size = excluded.file_size,
          file_mtime = excluded.file_mtime,
          event_count = excluded.event_count,
          turn_count = excluded.turn_count,
          open_turn_count = excluded.open_turn_count,
          parse_error = excluded.parse_error,
          imported_at = now(),
          created = excluded.created,
          updated = excluded.updated
      `,
      {
        path: session.path,
        source: session.source,
        workspaceId: session.workspaceId,
        sessionId: session.sessionId,
        title: session.title,
        cwd: session.cwd,
        fileSize: session.stat.size,
        fileMtime: session.stat.mtime.toISOString(),
        eventCount: session.events.length,
        turnCount: session.turns.length,
        openTurnCount: session.openTurnIds.length,
        parseError: session.parseErrors.join("\n").slice(0, 4000) || null,
        created: session.created,
        updated: session.updated
      }
    );
  }

  private async columnExists(connection: SessionDbConnection, tableName: string, columnName: string) {
    const result = await connection.run(
      `
        SELECT 1 AS found
        FROM information_schema.columns
        WHERE table_name = $tableName
          AND table_schema = current_schema()
          AND column_name = $columnName
        LIMIT 1
      `,
      { tableName, columnName }
    );
    return (await result.getRowObjectsJS()).length > 0;
  }

  private async read<T>(operation: (connection: SessionDbConnection) => Promise<T>): Promise<T> {
    return this.enqueue(operation);
  }

  private async write<T>(operation: (connection: SessionDbConnection) => Promise<T>): Promise<T> {
    return this.enqueue(operation);
  }

  private async transaction<T>(operation: (connection: SessionDbConnection) => Promise<T>): Promise<T> {
    return this.enqueue(async (connection) => {
      await connection.run("BEGIN");
      try {
        const value = await operation(connection);
        await connection.run("COMMIT");
        return value;
      } catch (error) {
        await connection.run("ROLLBACK");
        throw error;
      }
    });
  }

  private async enqueue<T>(operation: (connection: SessionDbConnection) => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new Error("SessionStore is closed.");
    }
    const next = this.queue.then(async () => {
      const connection = await this.connectionPromise;
      return operation(connection);
    });
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

function managerTimestamp(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toWorkspaceManager(row: Record<string, unknown>): WorkspaceManagerRecord {
  return { workspaceId: String(row.workspace_id), sessionId: String(row.session_id),
    notificationsEnabled: row.notifications_enabled === true,
    created: managerTimestamp(row.created), updated: managerTimestamp(row.updated) };
}

function localCodexSessionFile(path: string, codexHome?: string | null): LocalCodexSessionFile {
  const resolvedPath = resolveUserPath(path);
  const resolvedCodexHome = codexHome ? resolveUserPath(codexHome) : defaultCodexHome();
  const sessionsRoot = resolve(resolvedCodexHome, "sessions");
  const archivedRoot = resolve(resolvedCodexHome, "archived_sessions");
  if (isPathInside(resolvedPath, sessionsRoot)) {
    return { path: resolvedPath, source: "sessions", codexHome: resolvedCodexHome };
  }
  if (isPathInside(resolvedPath, archivedRoot)) {
    return { path: resolvedPath, source: "archived_sessions", codexHome: resolvedCodexHome };
  }
  return { path: resolvedPath, source: "hook", codexHome: resolvedCodexHome };
}

function parseLocalCodexSessionFile(file: LocalCodexSessionFile): ParsedLocalCodexSessionFile {
  const stat = statSync(file.path);
  const lines = readFileSync(file.path, "utf8").split(/\r?\n/);
  const events: LocalCodexSessionEvent[] = [];
  const turnsById = new Map<string, LocalCodexSessionTurn>();
  const commandCallsByCallId = new Map<string, LocalCodexPendingCommandCall>();
  const collaborationCallsByCallId = new Map<string, { turnId: string; itemId: string }>();
  const liveItems: LocalCodexLiveItem[] = [];
  const parseErrors: string[] = [];
  let codexSessionId = idFromLocalCodexFilename(file.path);
  let cwd = "";
  let created: string | null = null;
  let updated: string | null = null;
  let currentTurnId: string | null = null;
  let foundSessionMeta = false;
  let ignored = false;
  let parentSessionId: string | null = null;

  for (const [lineIndex, line] of lines.entries()) {
    if (!line.trim()) {
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      parseErrors.push(`line ${lineIndex + 1}: ${errorMessage(error)}`);
      continue;
    }

    const rawRecord = recordValue(raw);
    const timestamp = normalizeLocalTimestamp(rawRecord?.timestamp);
    created = minTimestamp(created, timestamp);
    updated = maxTimestamp(updated, timestamp);

    const payload = rawRecord?.payload;
    const payloadRecord = recordValue(payload);
    if (!foundSessionMeta && rawRecord?.type === "session_meta" && payloadRecord) {
      codexSessionId = nonEmptyString(payloadRecord.session_id) ?? nonEmptyString(payloadRecord.id) ?? codexSessionId;
      cwd = nonEmptyString(payloadRecord.cwd) ?? cwd;
      parentSessionId = parentSessionId ?? importedLocalParentSessionId(payloadRecord);
      foundSessionMeta = true;
      ignored = ignored || isLocalCodexInternalSubagentSessionMeta(payloadRecord);
    }

    const payloadTurnId = extractLocalCodexTurnId(payload);
    if (payloadRecord && (payloadRecord.type === "task_started" || rawRecord?.type === "turn_context") && payloadTurnId) {
      currentTurnId = payloadTurnId;
    }
    const turnId = payloadTurnId ?? currentTurnId;
    if (payloadRecord && rawRecord?.type === "turn_context") {
      cwd = nonEmptyString(payloadRecord.cwd) ?? cwd;
      parentSessionId = parentSessionId ?? importedLocalParentSessionId(payloadRecord);
    }

    const event: LocalCodexSessionEvent = {
      index: lineIndex,
      timestamp,
      raw,
      payload,
      turnId,
      eventType: nonEmptyString(rawRecord?.type) ?? "unknown",
      payloadType: payloadRecord ? nonEmptyString(payloadRecord.type) : null
    };
    events.push(event);

    if (turnId) {
      const turn = getLocalCodexTurn(turnsById, turnId, timestamp);
      turn.created = minTimestamp(turn.created, timestamp) ?? turn.created;
      applyLocalCodexEventToTurn(turn, event);
      applyLocalCodexEventToLiveItems(turn, event, commandCallsByCallId, collaborationCallsByCallId, liveItems);
    }

    if (payloadRecord?.type === "task_complete" && (!payloadTurnId || payloadTurnId === currentTurnId)) {
      currentTurnId = null;
    }
  }

  const titleRecord = codexSessionId ? readLocalCodexSessionIndexRecord(file.codexHome, codexSessionId) : null;
  updated = maxTimestamp(updated, titleRecord?.updated ?? null) ?? normalizeLocalTimestamp(stat.mtime) ?? new Date().toISOString();
  created = created ?? normalizeLocalTimestamp(stat.birthtime) ?? updated;
  const turnCandidates = [...turnsById.values()]
    .filter((turn) => turn.userInput || turn.assistantMessages.length > 0 || turn.finalResponses.length > 0)
    .sort((left, right) => left.created.localeCompare(right.created));
  const turns = ignored ? [] : turnCandidates.filter((turn) => turn.status === "done" && turn.userInput && !turn.ignored);
  const dedupedLiveItems = dedupeRenderedLocalCodexAgentMessageLiveItems(turns, liveItems);
  const incompleteTurnIds = turnCandidates
    .filter((turn) => ignored || turn.status !== "done" || !turn.userInput || turn.ignored)
    .map((turn) => turn.id);
  const openTurnIds = turnCandidates
    .filter((turn) => !ignored && !turn.ignored && turn.status !== "done")
    .map((turn) => turn.id);
  const firstUserInput = turns.find((turn) => turn.userInput)?.userInput ?? "";
  const title = cleanLocalCodexTitle(titleRecord?.title) ?? cleanLocalCodexTitle(firstUserInput) ?? codexSessionId ?? "Untitled session";
  const description = firstUserInput.slice(0, 500);
  const normalizedCwd = cwd ? resolveUserPath(cwd) : defaultCwd();
  const workspaceId = localCodexWorkspaceIdForCwd(normalizedCwd);

  return {
    path: file.path,
    source: file.source,
    stat,
    sessionId: codexSessionId ? localCodexSessionId(codexSessionId) : null,
    threadId: codexSessionId,
    workspaceId,
    cwd: normalizedCwd,
    title,
    description,
    parentSessionId,
    created,
    updated,
    events,
    turns,
    liveItems: dedupedLiveItems,
    incompleteTurnIds,
    openTurnIds,
    ignored,
    parseErrors
  };
}

function applyLocalCodexEventToTurn(turn: LocalCodexSessionTurn, event: LocalCodexSessionEvent) {
  const payload = recordValue(event.payload);
  if (!payload) {
    return;
  }

  if (event.eventType === "event_msg" && payload.type === "user_message") {
    const rawText = nonEmptyString(payload.message) ?? "";
    const text = normalizeLocalCodexUserInput(rawText);
    if (looksLikeLocalCodexSyntheticReviewerInput(rawText) || looksLikeLocalCodexSyntheticReviewerInput(text)) {
      turn.ignored = true;
    } else if (text && !looksLikeLocalCodexContextOnly(text)) {
      turn.userInput ||= text;
    }
  } else if (event.eventType === "response_item" && payload.type === "message" && payload.role === "user") {
    const rawText = localCodexContentToText(payload.content);
    const text = normalizeLocalCodexUserInput(rawText);
    if (looksLikeLocalCodexSyntheticReviewerInput(rawText) || looksLikeLocalCodexSyntheticReviewerInput(text)) {
      turn.ignored = true;
    } else if (text && !looksLikeLocalCodexContextOnly(text)) {
      turn.userInput ||= text;
    }
  }

  if (event.eventType === "turn_context") {
    turn.model = nonEmptyString(payload.model) ?? turn.model;
  }

  if (event.eventType === "event_msg" && payload.type === "agent_message") {
    const message = nonEmptyString(payload.message);
    if (message && payload.phase === "final_answer") {
      pushUniqueLocalCodexText(turn.finalResponses, message);
    } else if (message) {
      pushUniqueLocalCodexText(turn.assistantMessages, message);
    }
  } else if (event.eventType === "response_item" && payload.type === "message" && payload.role === "assistant") {
    const text = localCodexContentToText(payload.content);
    if (text && payload.phase === "final_answer") {
      pushUniqueLocalCodexText(turn.finalResponses, text);
    } else if (text) {
      pushUniqueLocalCodexText(turn.assistantMessages, text);
    }
  }

  if (event.eventType === "event_msg" && payload.type === "token_count") {
    const info = recordValue(payload.info);
    const usage = recordValue(info?.last_token_usage) ?? recordValue(info?.total_token_usage);
    if (usage) {
      turn.tokenIn = Math.max(turn.tokenIn, finiteNumber(usage.input_tokens) ?? 0);
      turn.tokenOut = Math.max(turn.tokenOut, finiteNumber(usage.output_tokens) ?? 0);
    }
  }

  if (event.eventType === "event_msg" && payload.type === "task_complete") {
    turn.status = "done";
  } else if (event.eventType === "event_msg" && payload.type === "turn_aborted") {
    // Historical local transcripts record an intentional interruption instead
    // of task_complete. Keep the partial, user-visible turn in the import.
    turn.status = "done";
    turn.interrupted = true;
  }
}

function applyLocalCodexEventToLiveItems(
  turn: LocalCodexSessionTurn,
  event: LocalCodexSessionEvent,
  commandCallsByCallId: Map<string, LocalCodexPendingCommandCall>,
  collaborationCallsByCallId: Map<string, { turnId: string; itemId: string }>,
  liveItems: LocalCodexLiveItem[]
) {
  const payload = recordValue(event.payload);
  if (!payload) {
    return;
  }

  const assistantText = event.eventType === "event_msg" && payload.type === "agent_message"
    ? nonEmptyString(payload.message)
    : event.eventType === "response_item" && payload.type === "message" && payload.role === "assistant"
      ? localCodexContentToText(payload.content)
      : null;
  if (assistantText) {
    const existing = liveItems.find(
      (candidate) => candidate.turnId === turn.id && candidate.item.itemType === "agent_message" && candidate.item.text === assistantText
    );
    const itemId = nonEmptyString(payload.id) ?? `message:${turn.id}:${event.index}`;
    const item = {
      id: itemId,
      eventType: "item.completed",
      itemType: "agent_message",
      text: assistantText
    };
    if (existing) {
      existing.jsonlIndex = event.index;
      existing.created = event.timestamp;
      existing.item = item;
    } else {
      liveItems.push({
        turnId: turn.id,
        jsonlIndex: event.index,
        created: event.timestamp,
        item
      });
    }
    return;
  }

  if (event.eventType === "response_item" && (payload.type === "function_call" || payload.type === "custom_tool_call")) {
    const callId = nonEmptyString(payload.call_id) ?? nonEmptyString(payload.id) ?? `${turn.id}:${event.index}`;
    const itemId = nonEmptyString(payload.id) ?? callId;
    if (isLocalCodexCollaborationCall(payload)) {
      const args = recordValue(parseJsonObject(nonEmptyString(payload.arguments) ?? ""));
      const taskName = nonEmptyString(args?.task_name) ?? nonEmptyString(args?.target);
      const prompt = readableLocalCodexCollaborationPrompt(args?.message);
      collaborationCallsByCallId.set(callId, { turnId: turn.id, itemId });
      liveItems.push({
        turnId: turn.id,
        jsonlIndex: event.index,
        created: event.timestamp,
        item: {
          id: itemId,
          eventType: "item.completed",
          itemType: "subagent",
          tool: nonEmptyString(payload.name) ?? "agent",
          status: "inProgress",
          ...(taskName ? { label: taskName } : {}),
          receiverThreadIds: [],
          ...(prompt ? { prompt } : {}),
          agents: []
        }
      });
      return;
    }

    const command = localCodexCommandFromCallPayload(payload);
    if (!command) {
      return;
    }
    commandCallsByCallId.set(callId, { turnId: turn.id, itemId, command });
    liveItems.push({
      turnId: turn.id,
      jsonlIndex: event.index,
      created: event.timestamp,
      item: {
        id: itemId,
        eventType: "item.completed",
        itemType: "command_execution",
        command,
        aggregatedOutput: "",
        status: nonEmptyString(payload.status) ?? "started"
      }
    });
    return;
  }

  if (event.eventType === "response_item" && (payload.type === "function_call_output" || payload.type === "custom_tool_call_output")) {
    const callId = nonEmptyString(payload.call_id);
    if (!callId) {
      return;
    }
    const collaborationCall = collaborationCallsByCallId.get(callId);
    if (collaborationCall) {
      const liveItem = liveItems.find((candidate) => candidate.turnId === turn.id && candidate.item.id === collaborationCall.itemId);
      if (liveItem?.item.itemType === "subagent") {
        const output = localCodexToolOutputToText(payload.output);
        const parsedOutput = recordValue(parseJsonObject(output));
        const agents = importedLocalCodexCollaborationAgents(parsedOutput);
        const taskName = nonEmptyString(parsedOutput?.task_name);
        if (liveItem.item.tool === "wait_agent" && agents.length === 0 && !liveItem.item.label && !liveItem.item.prompt) {
          liveItems.splice(liveItems.indexOf(liveItem), 1);
          return;
        }
        liveItem.jsonlIndex = event.index;
        liveItem.created = event.timestamp;
        liveItem.item = {
          ...liveItem.item,
          status: /failed|error/i.test(output) ? "failed" : "completed",
          ...(taskName ? { label: taskName } : {}),
          ...(agents.length > 0 ? { agents } : {})
        };
      }
      return;
    }

    const commandCall = commandCallsByCallId.get(callId);
    if (!commandCall) {
      return;
    }
    const output = localCodexToolOutputToText(payload.output);
    const exitCode = exitCodeFromLocalCodexOutput(output);
    const liveItem = liveItems.find((candidate) => candidate.turnId === turn.id && candidate.item.id === commandCall.itemId);
    if (liveItem?.item.itemType === "command_execution") {
      liveItem.jsonlIndex = event.index;
      liveItem.created = event.timestamp;
      liveItem.item = {
        ...liveItem.item,
        aggregatedOutput: output,
        aggregatedOutputLength: output.length,
        status: "completed",
        ...(exitCode === null ? {} : { exitCode })
      };
    }
    return;
  }

  if (event.eventType === "event_msg" && payload.type === "patch_apply_end") {
    const changes = fileChangesFromLocalCodexPatchPayload(payload);
    if (changes.length === 0) {
      return;
    }
    liveItems.push({
      turnId: turn.id,
      jsonlIndex: event.index,
      created: event.timestamp,
      item: {
        id: `file:${nonEmptyString(payload.call_id) ?? event.index}`,
        eventType: "item.completed",
        itemType: "file_change",
        changes,
        status: nonEmptyString(payload.status) ?? (payload.success === true ? "completed" : "failed")
      }
    });
  }
}

function getLocalCodexTurn(turnsById: Map<string, LocalCodexSessionTurn>, id: string, timestamp: string | null) {
  const existing = turnsById.get(id);
  if (existing) {
    return existing;
  }
  const turn: LocalCodexSessionTurn = {
    id,
    created: timestamp ?? new Date(0).toISOString(),
    userInput: "",
    assistantMessages: [],
    finalResponses: [],
    model: null,
    tokenIn: 0,
    tokenOut: 0,
    status: "running",
    interrupted: false,
    ignored: false
  };
  turnsById.set(id, turn);
  return turn;
}

function dedupeRenderedLocalCodexAgentMessageLiveItems(
  turns: LocalCodexSessionTurn[],
  liveItems: LocalCodexLiveItem[]
) {
  const renderedTextByTurn = new Map(
    turns.map((turn) => [
      turn.id,
      new Set((turn.finalResponses.length > 0 ? turn.finalResponses : turn.assistantMessages).map(normalizeLocalCodexTextBlock))
    ])
  );
  return liveItems.filter((liveItem) => {
    if (liveItem.item.itemType !== "agent_message") {
      return true;
    }
    const renderedTexts = renderedTextByTurn.get(liveItem.turnId);
    const text = normalizeLocalCodexTextBlock(liveItem.item.text);
    return !text || !renderedTexts?.has(text);
  });
}

function isLocalMaintenanceSummarizerSession(session: ParsedLocalCodexSessionFile) {
  const firstUserInput = session.turns.find((turn) => turn.userInput)?.userInput ?? "";
  return isLocalMaintenanceSummarizerPrompt(firstUserInput) || isLocalMaintenanceSummarizerPrompt(session.title);
}

function isLocalMaintenanceSummarizerPrompt(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return (
    text.startsWith("You are a keyword-first session metadata generator for a coding workspace.") ||
    (text.startsWith("You are a session summarizer for a coding workspace.") && text.includes("Read the compact turn log"))
  );
}

function readLocalCodexSessionIndexRecord(codexHome: string | null, threadId: string): LocalCodexSessionIndexRecord | null {
  const indexPath = resolve(codexHome ?? defaultCodexHome(), "session_index.jsonl");
  if (!existsSync(indexPath)) {
    return null;
  }
  let matched: LocalCodexSessionIndexRecord | null = null;
  for (const line of readFileSync(indexPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      const row = recordValue(record);
      if (row?.id === threadId) {
        matched = {
          title: nonEmptyString(row.thread_name),
          updated: normalizeLocalTimestamp(row.updated_at)
        };
      }
    } catch {
      // Malformed index lines must not block transcript import.
    }
  }
  return matched;
}

function isLocalCodexInternalSubagentSessionMeta(payload: Record<string, unknown>) {
  const source = recordValue(payload.source);
  const baseInstructions = recordValue(payload.base_instructions);
  return (
    payload.thread_source === "subagent" ||
    Boolean(source?.subagent) ||
    nonEmptyString(baseInstructions?.text)?.startsWith("You are judging one planned coding-agent action.") === true
  );
}

function isLocalCodexCollaborationCall(payload: Record<string, unknown>) {
  const name = nonEmptyString(payload.name) ?? "";
  return (
    payload.namespace === "collaboration" ||
    new Set(["spawn_agent", "send_message", "followup_task", "wait_agent", "list_agents", "interrupt_agent"]).has(name)
  );
}

function readableLocalCodexCollaborationPrompt(value: unknown) {
  const prompt = nonEmptyString(value);
  if (!prompt || /^gAAAAA[A-Za-z0-9_-]+={0,2}$/.test(prompt)) {
    return null;
  }
  return prompt;
}

function importedLocalCodexCollaborationAgents(value: Record<string, unknown> | null) {
  if (!value || !Array.isArray(value.agents)) {
    return [];
  }
  return value.agents.flatMap((candidate) => {
    const record = recordValue(candidate);
    if (!record) {
      return [];
    }
    const name = nonEmptyString(record.agent_name);
    if (!name || name === "/root") {
      return [];
    }
    const rawStatus = record.agent_status;
    let status = nonEmptyString(rawStatus) ?? "unknown";
    let message = nonEmptyString(record.last_task_message);
    const statusRecord = recordValue(rawStatus);
    if (statusRecord) {
      const terminal = Object.entries(statusRecord).find(([, result]) => typeof result === "string");
      if (terminal) {
        status = terminal[0];
        message = nonEmptyString(terminal[1]);
      }
    }
    return [{ id: name, name, status, ...(message ? { message } : {}) }];
  });
}

function localCodexCommandFromCallPayload(payload: Record<string, unknown>) {
  const name = nonEmptyString(payload.name) ?? "tool";
  const args = recordValue(parseJsonObject(nonEmptyString(payload.arguments) ?? ""));
  if (name === "exec_command") {
    return nonEmptyString(args?.cmd) ?? name;
  }
  if (name === "apply_patch") {
    return "apply_patch";
  }
  if (name === "multi_tool_use.parallel") {
    const count = Array.isArray(args?.tool_uses) ? args.tool_uses.length : null;
    return count ? `multi_tool_use.parallel (${count} calls)` : name;
  }
  return name;
}

function fileChangesFromLocalCodexPatchPayload(payload: Record<string, unknown>) {
  const changes = recordValue(payload.changes);
  if (!changes) {
    return [];
  }
  return Object.entries(changes)
    .map(([path, change]) => {
      const record = recordValue(change);
      if (!record) {
        return { path, kind: "update" };
      }
      const kind = nonEmptyString(record.type) ?? "update";
      const content = nonEmptyString(record.content);
      const unifiedDiff = nonEmptyString(record.unified_diff) ?? nonEmptyString(record.unifiedDiff);
      return {
        path,
        kind,
        ...(content === null ? {} : { currentContent: content, afterContent: content }),
        ...(unifiedDiff === null ? {} : { unifiedDiff, patch: unifiedDiff, diff: unifiedDiff }),
        ...(nonEmptyString(record.move_path) === null ? {} : { movePath: nonEmptyString(record.move_path) })
      };
    })
    .filter((change) => change.path);
}

function exitCodeFromLocalCodexOutput(output: string) {
  const match = /Process exited with code (-?\d+)/.exec(output);
  return match ? Number(match[1]) : null;
}

function extractLocalCodexTurnId(payload: unknown) {
  const record = recordValue(payload);
  if (!record) {
    return null;
  }
  const passthrough = recordValue(record.internal_chat_message_metadata_passthrough);
  return nonEmptyString(record.turn_id) ?? nonEmptyString(passthrough?.turn_id);
}

function localCodexContentToText(content: unknown) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      const record = recordValue(part);
      return record
        ? nonEmptyString(record.text) ?? nonEmptyString(record.output_text) ?? nonEmptyString(record.input) ?? ""
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function localCodexToolOutputToText(output: unknown) {
  return nonEmptyString(output) ?? localCodexContentToText(output);
}

function pushUniqueLocalCodexText(values: string[], value: string) {
  const normalized = normalizeLocalCodexTextBlock(value);
  if (!normalized) {
    return;
  }
  if (!values.some((existing) => normalizeLocalCodexTextBlock(existing) === normalized)) {
    values.push(value);
  }
}

function normalizeLocalCodexTextBlock(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function isImportedLocalTurnRow(lastEventName: string | null) {
  return lastEventName === "local.hook_imported" ||
    lastEventName === "local.hook_imported_aborted" ||
    lastEventName === "local.imported";
}

function isLocalRunnerProcessAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function importedLocalTurnPromptsMatch(left: string, right: string) {
  const normalizePrompt = (value: string) => normalizeLocalCodexTextBlock(
    stripContextForkOperationalSuffix(stripTodoPlanOperationalSuffix(decodeHtmlEntities(value)))
  )
    .replace(/\s+(?:\[Attached files\]|Attached files:|<attached_file\b)[\s\S]*$/i, "")
    .trim();
  const normalizedLeft = normalizePrompt(left);
  const normalizedRight = normalizePrompt(right);
  if (normalizedLeft === normalizedRight) {
    return true;
  }

  // The native Codex transcript keeps only the portion after its final
  // "User request:" marker, while a Threadex runner can retain the
  // generated task framing before it. Treat those as the same prompt only
  // when the complete request suffix matches exactly.
  const userRequestSuffix = (value: string) => {
    const marker = "User request:";
    const markerIndex = value.lastIndexOf(marker);
    return markerIndex > 0 ? value.slice(markerIndex + marker.length).trim() : null;
  };
  return userRequestSuffix(normalizedLeft) === normalizedRight ||
    userRequestSuffix(normalizedRight) === normalizedLeft;
}

/**
 * The native transcript can HTML-escape user content that Threadex stores as
 * plain text. Decode the common entities before comparing prompts so a
 * manager-owned turn is not re-imported as a second, model-less local turn.
 */
function decodeHtmlEntities(value: string) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#(?:x[\da-f]+|\d+));/gi, (entity) => {
    const numeric = /^&#(x[\da-f]+|\d+);$/i.exec(entity);
    if (numeric) {
      const codePoint = Number.parseInt(numeric[1]!, numeric[1]!.toLowerCase().startsWith("x") ? 16 : 10);
      if (Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        return String.fromCodePoint(codePoint);
      }
      return entity;
    }
    switch (entity.toLowerCase()) {
      case "&amp;": return "&";
      case "&lt;": return "<";
      case "&gt;": return ">";
      case "&quot;": return '"';
      case "&apos;": return "'";
      default: return entity;
    }
  });
}

function looksLikeLocalCodexContextOnly(value: string) {
  const text = value.trim();
  return (
    text.startsWith("# AGENTS.md instructions") ||
    text.startsWith("<environment_context>") ||
    text.startsWith("<recommended_plugins>") ||
    text.startsWith("<codex_internal_context") ||
    text.startsWith("<turn_aborted>")
  );
}

function looksLikeLocalCodexSyntheticReviewerInput(value: string) {
  const text = value.trim();
  return (
    text.startsWith("The following is the Codex agent history added since your last approval assessment.") ||
    text.includes(">>> APPROVAL REQUEST START") ||
    text.includes(">>> TRANSCRIPT DELTA START") ||
    text.includes(">>> TRANSCRIPT END") ||
    text.includes("Reviewed Codex session id:")
  );
}

function normalizeLocalCodexUserInput(value: string) {
  const text = value.trim();
  const marker = "\nUser request:";
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex >= 0) {
    return normalizeLocalCodexInternalContext(text.slice(markerIndex + marker.length).trim());
  }
  return normalizeLocalCodexInternalContext(text);
}

function normalizeLocalCodexInternalContext(value: string) {
  const text = value.trim();
  if (text.startsWith("<codex_delegation>")) {
    const inputMatch = /<input>\s*([\s\S]*?)\s*<\/input>/i.exec(text);
    return inputMatch?.[1]?.trim() ?? text;
  }
  if (!text.startsWith("<codex_internal_context")) {
    return text;
  }
  const objectiveMatch = /<objective>\s*([\s\S]*?)\s*<\/objective>/i.exec(text);
  return objectiveMatch?.[1]?.trim() ?? text;
}

function idFromLocalCodexFilename(path: string) {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path);
  return match?.[1] ?? null;
}

function localCodexSessionId(sessionId: string) {
  return isThreadexSessionId(sessionId) ? canonicalSessionId(sessionId) : `tx_${sessionId}`;
}

function importedLocalParentSessionId(payload: Record<string, unknown>) {
  const rawParentId =
    nonEmptyString(payload.parent_session_id) ??
    nonEmptyString(payload.parentSessionId) ??
    nonEmptyString(payload.parent_id) ??
    nonEmptyString(payload.parentId);
  return rawParentId ? localCodexSessionId(rawParentId) : null;
}

function cleanLocalCodexTitle(value: unknown) {
  const text = nonEmptyString(value)?.replace(/\s+/g, " ").trim();
  if (!text) {
    return null;
  }
  return text.length > 72 ? `${text.slice(0, 69)}...` : text;
}

function localCodexWorkspaceIdForCwd(cwd: string) {
  const pathFromThreadex = relative(defaultCwd(), cwd);
  return pathFromThreadex === "" || (!pathFromThreadex.startsWith("..") && !pathFromThreadex.startsWith("/"))
    ? "threadex"
    : "default";
}

function shouldPersistImportedLocalAuditEvent(event: LocalCodexSessionEvent) {
  if (event.eventType === "response_item") {
    return false;
  }
  return !new Set([
    "agent_message",
    "agent_reasoning",
    "reasoning",
    "patch_apply_begin",
    "patch_apply_end"
  ]).has(event.payloadType ?? "");
}

function localCodexEventName(event: LocalCodexSessionEvent) {
  return ["local", event.eventType, event.payloadType].filter(Boolean).join(".");
}

function resolveUserPath(value: string) {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(value);
}

function isPathInside(path: string, root: string) {
  const relativePath = relative(root, path);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("/"));
}

function normalizeLocalTimestamp(value: unknown) {
  if (typeof value !== "string" && !(value instanceof Date)) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function minTimestamp(left: string | null, right: string | null) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left <= right ? left : right;
}

function maxTimestamp(left: string | null, right: string | null) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left >= right ? left : right;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

function shortHash(value: string) {
  return createHash("sha256").update(value).digest("base64url").slice(0, 16);
}

function toSessionRecord(row: SessionRow): SessionRecord {
  const session: SessionRecord = {
    id: stringValue(row.id),
    threadId: nullableString(row.thread_id),
    workspaceId: stringValue(row.workspace_id, "default"),
    cwd: stringValue(row.cwd, defaultCwd()),
    accountId: nullableString(row.account_id),
    keywordWeights: parseKeywordWeights(row.keyword_weights),
    title: stringValue(row.title, "Untitled session"),
    titleSource: sessionTitleSourceValue(row.title_source),
    description: stringValue(row.description),
    parentSessionId: nullableString(row.parent_session_id),
    forkedFromTurnId: nullableString(row.forked_from_turn_id),
    achievedAt: nullableString(row.achieved_at),
    created: stringValue(row.created),
    updated: stringValue(row.updated)
  };
  if (row.turn_count !== undefined) {
    session.turnCount = numberValue(row.turn_count);
  }
  if (row.token_count !== undefined) {
    session.tokenCount = numberValue(row.token_count);
  }
  if (row.model_token_usage !== undefined) {
    session.modelTokenUsage = parseSessionModelTokenUsage(row.model_token_usage);
  }
  if (row.matched_turn !== undefined) {
    session.matchedTurn = nullableString(row.matched_turn);
  }
  return session;
}

function sessionTitleSourceValue(value: unknown): SessionTitleSource {
  return value === "user" || value === "summarizer" ? value : "initial";
}

function canUpdateSessionTitle(currentSource: SessionTitleSource, nextSource: SessionTitleSource) {
  if (nextSource === "user") {
    return true;
  }
  if (currentSource === "user") {
    return false;
  }
  return nextSource === "summarizer";
}

function toWorkspaceRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: stringValue(row.id),
    name: stringValue(row.name, "Workspace"),
    codexHome: stringValue(row.codex_home, defaultCodexHome()),
    cwd: stringValue(row.cwd, defaultCwd()),
    created: stringValue(row.created),
    updated: stringValue(row.updated)
  };
}

function toAccountRecord(row: AccountRow): AccountRecord {
  return {
    id: stringValue(row.id),
    name: stringValue(row.name, "Account"),
    externalAccountId: nullableString(row.external_account_id),
    externalUserId: nullableString(row.external_user_id),
    email: nullableString(row.email),
    hasAuth: row.has_auth === true,
    authVersion: numberValue(row.auth_version),
    quotaSnapshot: parseJsonObject(row.quota_snapshot),
    quotaUpdatedAt: nullableString(row.quota_updated_at),
    quotaError: nullableString(row.quota_error),
    created: stringValue(row.created),
    updated: stringValue(row.updated),
    lastUsed: nullableString(row.last_used)
  };
}

function toSessionTurnRecord(row: SessionTurnRow): SessionTurnRecord {
  const status = sessionTurnStatusValue(row.status);
  const reasoningEffort = nullableString(row.turn_reasoning_effort);
  const executionDurationMs = nullableNumber(row.execution_duration_ms);
  const requestMetadata = parseJsonRecord(row.request_metadata);
  return {
    id: stringValue(row.id),
    sessionId: stringValue(row.session_id),
    loopMode: row.loop_mode === true,
    accountId: nullableString(row.account_id),
    userInput: stringValue(row.user_input),
    agentResponse: stringValue(row.agent_response),
    model: nullableString(row.turn_model),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    tokenIn: numberValue(row.token_in),
    tokenOut: numberValue(row.token_out),
    usageSample: toSessionTurnTokenUsageSampleRecord(row),
    status,
    runnerPid: status === "running" ? nullableNumber(row.runner_pid) : null,
    runnerStarted: nullableString(row.runner_started),
    runnerHeartbeat: nullableString(row.runner_heartbeat),
    ...(executionDurationMs === null ? {} : { executionDurationMs }),
    runnerLogPath: nullableString(row.runner_log_path),
    runnerExitCode: nullableNumber(row.runner_exit_code),
    lastEventName: nullableString(row.last_event_name),
    pendingReason: row.pending_reason === "rate_limit" || row.pending_reason === "queued" || row.pending_reason === "auth" || row.pending_reason === "stopped"
      ? row.pending_reason
      : null,
    pendingLoadBalance: typeof row.pending_load_balance === "boolean" ? row.pending_load_balance : null,
    ...(requestMetadata ? { requestMetadata } : {}),
    created: stringValue(row.created)
  };
}

function toSessionTurnTokenUsageSampleRecord(row: SessionTurnRow): SessionTurnTokenUsageSampleRecord | null {
  const id = nullableString(row.usage_sample_id);
  if (!id) {
    return null;
  }

  return {
    id,
    sessionId: stringValue(row.session_id),
    turnId: stringValue(row.id),
    source: stringValue(row.usage_sample_source),
    sourceIndex: nullableNumber(row.usage_sample_source_index),
    sourceTimestamp: nullableString(row.usage_sample_source_timestamp),
    inputTokens: numberValue(row.usage_sample_input_tokens),
    cachedInputTokens: numberValue(row.usage_sample_cached_input_tokens),
    outputTokens: numberValue(row.usage_sample_output_tokens),
    reasoningOutputTokens: numberValue(row.usage_sample_reasoning_output_tokens),
    totalTokens: numberValue(row.usage_sample_total_tokens),
    cumulativeInputTokens: numberValue(row.usage_sample_cumulative_input_tokens),
    cumulativeCachedInputTokens: numberValue(row.usage_sample_cumulative_cached_input_tokens),
    cumulativeOutputTokens: numberValue(row.usage_sample_cumulative_output_tokens),
    cumulativeReasoningOutputTokens: numberValue(row.usage_sample_cumulative_reasoning_output_tokens),
    cumulativeTotalTokens: numberValue(row.usage_sample_cumulative_total_tokens),
    modelContextWindow: nullableNumber(row.usage_sample_model_context_window),
    primaryUsedPercent: nullableNumber(row.usage_sample_primary_used_percent),
    secondaryUsedPercent: nullableNumber(row.usage_sample_secondary_used_percent),
    primaryResetsAt: nullableNumber(row.usage_sample_primary_resets_at),
    secondaryResetsAt: nullableNumber(row.usage_sample_secondary_resets_at),
    planType: nullableString(row.usage_sample_plan_type),
    created: stringValue(row.usage_sample_created),
    updated: stringValue(row.usage_sample_updated)
  };
}

function toSessionTurnEventRecord(row: SessionTurnEventRow): SessionTurnEventRecord {
  return {
    id: stringValue(row.id),
    turnId: stringValue(row.turn_id),
    sessionId: stringValue(row.session_id),
    eventName: stringValue(row.event_name),
    payload: parseJsonObject(row.payload_json),
    created: stringValue(row.created)
  };
}

function toSessionSideChatRecord(row: SessionSideChatRow): SessionSideChatRecord {
  return {
    id: stringValue(row.id),
    sessionId: stringValue(row.session_id),
    workspaceId: stringValue(row.workspace_id, "default"),
    sourceSessionId: nullableString(row.source_session_id),
    sourceThreadId: nullableString(row.source_thread_id),
    sourceTurnId: nullableString(row.source_turn_id),
    question: stringValue(row.question),
    answer: stringValue(row.answer),
    model: stringValue(row.model),
    contextTurnCount: numberValue(row.context_turn_count),
    contextFilter: nullableString(row.context_filter),
    mode: stringValue(row.mode, "forked_ephemeral"),
    created: stringValue(row.created)
  };
}

function sessionSearchResultFromRow(row: SessionSearchRow, maxTextChars: number | null) {
  return {
    session: {
      id: stringValue(row.session_id),
      threadId: nullableString(row.thread_id),
      workspaceId: stringValue(row.workspace_id, "default"),
      cwd: stringValue(row.cwd, defaultCwd()),
      title: stringValue(row.title, "Untitled session"),
      description: stringValue(row.description),
      created: stringValue(row.session_created),
      updated: stringValue(row.session_updated)
    },
    turn: truncateSessionTurnRecord(toSessionTurnRecord(row), maxTextChars),
    score: nullableNumber(row.score)
  };
}

function sessionDescriptionVectorResultFromRow(
  row: SessionDescriptionEmbeddingRow,
  embedding: number[],
  maxTextChars: number | null
) {
  const candidate = normalizeEmbedding(row.embedding);
  if (!candidate || candidate.length !== embedding.length) {
    return null;
  }
  const distance = cosineDistance(candidate, embedding);
  if (distance === null) {
    return null;
  }

  const session = toSessionRecord(row);
  const description = truncateText(session.description, maxTextChars ?? session.description.length);
  return {
    session: {
      ...session,
      description: description.text,
      ...(description.omittedChars > 0 ? { descriptionOmittedChars: description.omittedChars } : {})
    },
    distance,
    similarity: 1 - distance,
    score: 1 - distance,
    embedding: {
      model: stringValue(row.model),
      dimensions: candidate.length,
      updated: stringValue(row.embedding_updated)
    }
  };
}

function truncateSessionTurnRecord(turn: SessionTurnRecord, maxTextChars: number | null): SessionTurnRecord & {
  userInputOmittedChars?: number;
  agentResponseOmittedChars?: number;
} {
  if (maxTextChars === null) {
    return turn;
  }

  const userInput = truncateText(turn.userInput, maxTextChars);
  const agentResponse = truncateText(turn.agentResponse, maxTextChars);
  return {
    ...turn,
    userInput: userInput.text,
    agentResponse: agentResponse.text,
    ...(userInput.omittedChars > 0 ? { userInputOmittedChars: userInput.omittedChars } : {}),
    ...(agentResponse.omittedChars > 0 ? { agentResponseOmittedChars: agentResponse.omittedChars } : {})
  };
}

function truncateText(text: string, maxChars: number) {
  if (text.length <= maxChars) {
    return { text, omittedChars: 0 };
  }
  const omittedChars = text.length - maxChars;
  return {
    text: `${text.slice(0, maxChars)}\n[truncated: omitted ${omittedChars} chars]`,
    omittedChars
  };
}

function normalizeSessionInspectView(value: unknown): "full" | "file_changes" | "turn_summary" {
  return value === "file_changes" || value === "turn_summary" ? value : "full";
}

export function summarizeSessionFileChanges(
  turns: SessionTurnRecord[],
  liveItemsByTurn: Record<string, unknown[]>
) {
  const byPath = new Map<string, {
    path: string;
    kind: string;
    additions: number;
    deletions: number;
    movePath?: string;
    turnIds: string[];
  }>();

  for (const turn of turns) {
    const summary = summarizeFileChangeItems(liveItemsByTurn[turn.id] ?? []);
    for (const file of summary.files) {
      byPath.set(file.path, {
        ...file,
        turnIds: [turn.id]
      });
    }
  }

  return summarizeFileChangeRecords([...byPath.values()]);
}

function isAuthoritativeFileChangeItem(value: unknown) {
  const record = recordValue(value);
  return record?.itemType === "file_change" && record.authoritative === true && Array.isArray(record.changes);
}

function summarizeFileChangeItems(items: unknown[]) {
  const byPath = new Map<string, {
    path: string;
    kind: string;
    additions: number;
    deletions: number;
    movePath?: string;
  }>();

  const authoritativeItems = items.filter(isAuthoritativeFileChangeItem);
  const selectedItems = authoritativeItems.length > 0 ? [authoritativeItems.at(-1)] : items;
  for (const item of selectedItems) {
    const record = recordValue(item);
    if (record?.itemType !== "file_change" || !Array.isArray(record.changes)) {
      continue;
    }
    for (const candidate of record.changes) {
      const change = summarizeFileChange(candidate);
      if (!change) {
        continue;
      }
      byPath.set(change.path, change);
    }
  }

  return summarizeFileChangeRecords([...byPath.values()]);
}

function todoFileChangePaths(item: Record<string, unknown> | null): string[] {
  if (!item || item.itemType !== "file_change" || !Array.isArray(item.changes)) {
    return [];
  }
  const paths = new Set<string>();
  for (const change of item.changes) {
    if (!isPlainObject(change)) {
      continue;
    }
    const path = nullableString(change.path);
    if (path) {
      paths.add(path);
    }
    const movePath = nullableString(change.movePath);
    if (movePath) {
      paths.add(movePath);
    }
  }
  return [...paths];
}

function summarizeFileChange(value: unknown) {
  const record = recordValue(value);
  const path = nonEmptyString(record?.path);
  if (!record || !path) {
    return null;
  }

  const kind = nonEmptyString(record.kind) ?? nonEmptyString(record.type) ?? "update";
  const movePath = nonEmptyString(record.movePath) ?? nonEmptyString(record.move_path);
  const diff = nonEmptyString(record.unifiedDiff) ?? nonEmptyString(record.patch) ?? nonEmptyString(record.diff);
  const diffStats = diff ? lineStatsFromUnifiedDiff(diff) : null;
  const currentContent = nonEmptyString(record.currentContent) ?? nonEmptyString(record.beforeContent);
  const afterContent = nonEmptyString(record.afterContent) ?? nonEmptyString(record.content);
  const additions = diffStats?.additions ?? (kind === "add" && afterContent ? countTextLines(afterContent) : 0);
  const deletions = diffStats?.deletions ?? (kind === "delete" && currentContent ? countTextLines(currentContent) : 0);

  return {
    path,
    kind,
    additions,
    deletions,
    ...(movePath ? { movePath } : {})
  };
}

function summarizeFileChangeRecords<T extends {
  path: string;
  additions: number;
  deletions: number;
}>(files: T[]) {
  const sortedFiles = files.sort((first, second) => first.path.localeCompare(second.path));
  return {
    files: sortedFiles,
    totals: {
      files: sortedFiles.length,
      additions: sortedFiles.reduce((total, file) => total + file.additions, 0),
      deletions: sortedFiles.reduce((total, file) => total + file.deletions, 0)
    }
  };
}

function lineStatsFromUnifiedDiff(diff: string) {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function countTextLines(text: string) {
  if (!text) {
    return 0;
  }
  const lines = text.split(/\r?\n/);
  return text.endsWith("\n") || text.endsWith("\r") ? Math.max(0, lines.length - 1) : lines.length;
}

function normalizePageLimit(value: unknown, fallback: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.trunc(value)));
}

function normalizePageOffset(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

function normalizeSqlQuery(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("sql is required.");
  }
  const sql = value.trim();
  const scrubbed = stripSqlCommentsAndStrings(sql);
  if (/;\s*\S/.test(scrubbed)) {
    throw new Error("Only one SQL statement is allowed.");
  }
  return sql.replace(/;\s*$/, "");
}

function isReadOnlySql(sql: string) {
  const scrubbed = stripSqlCommentsAndStrings(sql).trim().toLowerCase();
  return /^(select|with|show|describe|desc|explain|pragma)\b/.test(scrubbed);
}

function stripSqlCommentsAndStrings(sql: string) {
  return sql
    .replace(/--[^\n\r]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/'([^']|'')*'/g, "''")
    .replace(/"([^"]|"")*"/g, '""');
}

function normalizeSqlParams(value: unknown): Record<string, SessionDbValue> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isPlainObject(value)) {
    throw new Error("params must be an object.");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === null) {
        return [key, item];
      }
      throw new Error(`Unsupported SQL param: ${key}`);
    })
  );
}

function normalizeSqlRow(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeSqlValue(value)]));
}

function normalizeSqlValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (Array.isArray(value)) {
    return value.map(normalizeSqlValue);
  }
  if (isPlainObject(value)) {
    return normalizeSqlRow(value);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMaxTextChars(value: unknown) {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 20_000;
  }
  return Math.max(200, Math.min(250_000, Math.trunc(value)));
}

function normalizeSessionTurnStatus(value: unknown): SessionTurnStatus | null {
  return value === "done" || value === "todo" || value === "running" ? value : null;
}

function normalizeEmbedding(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const embedding = value.map((item) => (typeof item === "number" && Number.isFinite(item) ? item : Number.NaN));
  return embedding.every((item) => Number.isFinite(item)) ? embedding : null;
}

function cosineDistance(first: number[], second: number[]) {
  let dot = 0;
  let firstNorm = 0;
  let secondNorm = 0;
  for (let index = 0; index < first.length; index += 1) {
    dot += first[index] * second[index];
    firstNorm += first[index] * first[index];
    secondNorm += second[index] * second[index];
  }
  if (firstNorm === 0 || secondNorm === 0) {
    return null;
  }
  return 1 - dot / (Math.sqrt(firstNorm) * Math.sqrt(secondNorm));
}

function sessionTurnStatusValue(value: unknown): SessionTurnStatus {
  return value === "todo" || value === "running" ? value : "done";
}

function todoItemStatusValue(value: unknown): TodoItemStatus {
  return value === "active" ||
    value === "paused" ||
    value === "hold" ||
    value === "skipped" ||
    value === "done" ||
    value === "blocked"
    ? value
    : "todo";
}

function todoPlanSectionValue(value: unknown): TodoPlanSection | null {
  return value === "solution" || value === "verification" ? value : null;
}

function todoCommentTypeValue(value: unknown): TodoCommentType {
  return value === "status" || value === "blocker" ? value : "note";
}

function todoMessageTypeValue(value: unknown): TodoMessageType {
  return value === "challenge" ? "challenge" : "update";
}

function todoActorValue(value: unknown): TodoActor {
  return value === "user" || value === "system" ? value : "agent";
}

function nullableTodoActorValue(value: unknown): TodoActor | null {
  if (value === "agent" || value === "user" || value === "system") return value;
  return null;
}

function normalizeKeywordWeights(value: unknown): KeywordWeights | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value).flatMap(([keyword, weight]) => {
    if (typeof weight !== "number" || !Number.isFinite(weight)) {
      return [];
    }

    const normalizedKeyword = keyword.trim();
    if (!normalizedKeyword) {
      return [];
    }

    return [[normalizedKeyword, weight] as const];
  });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseKeywordWeights(value: unknown): KeywordWeights {
  if (typeof value !== "string") {
    return {};
  }

  try {
    return normalizeKeywordWeights(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

function parseJsonObject(value: unknown): unknown {
  if (typeof value !== "string") {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  const parsed = parseJsonObject(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function parseSessionModelTokenUsage(value: unknown): SessionModelTokenUsage[] {
  const parsed = parseJsonObject(value);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const model = stringValue(record.model).trim() || "Unknown";
    const tokenCount = numberValue(record.tokenCount);
    const inputTokenCount = numberValue(record.inputTokenCount);
    const cachedInputTokenCount = numberValue(record.cachedInputTokenCount);
    const outputTokenCount = numberValue(record.outputTokenCount);
    return tokenCount > 0 ? [{ model, tokenCount, inputTokenCount, cachedInputTokenCount, outputTokenCount }] : [];
  });
}

function parseSessionModelProfiles(value: unknown): SessionModelProfile[] | undefined {
  const parsed = parseJsonObject(value);
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  return parsed.map((profile) => {
    if (!profile || typeof profile !== "object") {
      return null;
    }
    const candidate = profile as Record<string, unknown>;
    return {
      model: typeof candidate.model === "string" ? candidate.model : "",
      effort: typeof candidate.effort === "string" ? candidate.effort : ""
    };
  }).filter((profile): profile is SessionModelProfile => profile !== null);
}

function defaultSessionModelPreferences(sessionId: string): SessionModelPreferences {
  return {
    sessionId,
    selectedModel: DEFAULT_MODEL,
    selectedEffort: "low",
    gearProfiles: defaultGearProfiles(),
    activeGearIndex: 0,
    updated: ""
  };
}

function normalizeSessionModelPreferences(
  sessionId: string,
  input: SessionModelPreferencesInput,
  fallback: SessionModelPreferences,
  updated = fallback.updated
): SessionModelPreferences {
  const fallbackProfiles = defaultSessionModelPreferences(sessionId).gearProfiles.map(
    (profile, index) => fallback.gearProfiles[index] ?? profile
  );
  const inputProfiles = input.gearProfiles;
  // Preserve the first six presets if a client saved the temporary seventh Auto slot.
  const profiles = Array.isArray(inputProfiles) && [3, 6, 7].includes(inputProfiles.length)
    ? fallbackProfiles.map((fallbackProfile, index) => {
      const profile = inputProfiles[index];
      return {
        model: typeof profile?.model === "string" && profile.model.trim() ? profile.model.trim() : fallbackProfile.model,
        effort: typeof profile?.effort === "string" && profile.effort.trim() ? profile.effort.trim() : fallbackProfile.effort
      };
    })
    : fallbackProfiles.map((profile) => ({ ...profile }));
  const activeGearIndex = typeof input.activeGearIndex === "number" &&
    Number.isInteger(input.activeGearIndex) && input.activeGearIndex >= 0 && input.activeGearIndex < profiles.length
    ? input.activeGearIndex
    : fallback.activeGearIndex;
  const selectedProfile = profiles[activeGearIndex] ?? profiles[0];
  return {
    sessionId,
    selectedModel: typeof input.selectedModel === "string" && input.selectedModel.trim()
      ? input.selectedModel.trim()
      : selectedProfile.model,
    selectedEffort: typeof input.selectedEffort === "string" && input.selectedEffort.trim()
      ? input.selectedEffort.trim()
      : selectedProfile.effort,
    gearProfiles: profiles,
    activeGearIndex,
    updated
  };
}

function defaultWorkspaceModelPreferences(workspaceId: string): WorkspaceModelPreferences {
  const defaults = defaultSessionModelPreferences(workspaceId);
  return {
    workspaceId,
    selectedModel: defaults.selectedModel,
    selectedEffort: defaults.selectedEffort,
    gearProfiles: defaults.gearProfiles,
    activeGearIndex: defaults.activeGearIndex,
    updated: defaults.updated
  };
}

function normalizeWorkspaceModelPreferences(
  workspaceId: string,
  input: SessionModelPreferencesInput,
  fallback: WorkspaceModelPreferences,
  updated = fallback.updated
): WorkspaceModelPreferences {
  const normalized = normalizeSessionModelPreferences(
    workspaceId,
    input,
    {
      sessionId: workspaceId,
      selectedModel: fallback.selectedModel,
      selectedEffort: fallback.selectedEffort,
      gearProfiles: fallback.gearProfiles,
      activeGearIndex: fallback.activeGearIndex,
      updated: fallback.updated
    },
    updated
  );
  return {
    workspaceId,
    selectedModel: normalized.selectedModel,
    selectedEffort: normalized.selectedEffort,
    gearProfiles: normalized.gearProfiles,
    activeGearIndex: normalized.activeGearIndex,
    updated: normalized.updated
  };
}

function stringArrayFromJson(value: unknown): string[] {
  const parsed = parseJsonObject(value);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is string => typeof item === "string");
}

function normalizeSessionLiveItemPayload(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const id = stringValue(value.id);
  const itemType = stringValue(value.itemType);
  if (!id || !itemType) {
    return null;
  }
  const eventType = stringValue(value.eventType, "item.updated");
  const normalized: Record<string, unknown> = { ...value, id, itemType, eventType };
  if (itemType !== "command_execution") {
    return normalized;
  }

  const rawOutput = stringValue(value.aggregatedOutput);
  const previouslyOmitted = Math.max(0, nullableNumber(value.omittedOutputChars) ?? 0);
  const visibleOutput = previouslyOmitted > 0
    ? rawOutput.replace(/^\[output truncated: omitted [^\n]+\]\n/, "")
    : rawOutput;
  const declaredLength = nullableNumber(value.aggregatedOutputLength);
  const totalOutputLength = Math.max(
    visibleOutput.length,
    declaredLength ?? previouslyOmitted + visibleOutput.length
  );
  const outputTail = utf8Tail(visibleOutput, sessionLiveItemOutputTailBytes);
  const omittedOutputChars = Math.max(0, totalOutputLength - outputTail.length);
  return {
    ...normalized,
    command: stringValue(value.command),
    status: stringValue(value.status),
    ...(nullableNumber(value.exitCode) === null ? {} : { exitCode: nullableNumber(value.exitCode) }),
    aggregatedOutput: outputTail,
    aggregatedOutputLength: totalOutputLength,
    outputTruncated: omittedOutputChars > 0,
    omittedOutputChars
  };
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) {
    return value;
  }
  return bytes.subarray(bytes.length - maxBytes).toString("utf8").replace(/^\uFFFD/, "");
}

function sessionLiveItemEventRank(eventType: string): number {
  if (eventType === "item.completed") return 3;
  if (eventType === "item.updated") return 2;
  if (eventType === "item.started") return 1;
  return 0;
}

function stringifyStoredJson(value: unknown) {
  const json = JSON.stringify(value ?? null);
  const byteLength = Buffer.byteLength(json);
  if (byteLength <= storedJsonPayloadLimitBytes) {
    return json;
  }

  let maxStringChars = Math.max(storedJsonPayloadMinStringChars, Math.floor(storedJsonPayloadLimitBytes / 4));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const payload = addStoredJsonTruncationMetadata(
      trimStoredJsonStrings(value ?? null, maxStringChars),
      byteLength
    );
    const trimmedJson = JSON.stringify(payload);
    if (Buffer.byteLength(trimmedJson) <= storedJsonPayloadLimitBytes) {
      return trimmedJson;
    }
    maxStringChars = Math.max(storedJsonPayloadMinStringChars, Math.floor(maxStringChars / 2));
  }

  return stringifyStoredJsonFallback(json, byteLength);
}

function addStoredJsonTruncationMetadata(value: unknown, originalJsonBytes: number): unknown {
  const metadata = {
    threadexPayloadTruncated: true,
    threadexPayloadOriginalJsonBytes: originalJsonBytes,
    threadexPayloadLimitBytes: storedJsonPayloadLimitBytes
  };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>), ...metadata };
  }
  return { value, ...metadata };
}

function trimStoredJsonStrings(value: unknown, maxStringChars: number): unknown {
  if (typeof value === "string") {
    return trimStoredString(value, maxStringChars);
  }
  if (Array.isArray(value)) {
    return value.map((item) => trimStoredJsonStrings(item, maxStringChars));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        trimStoredJsonStrings(item, maxStringChars)
      ])
    );
  }
  return value;
}

function trimStoredString(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }
  const marker = `\n[stored payload truncated: omitted ${(value.length - maxChars).toLocaleString()} chars]\n`;
  const contentChars = Math.max(0, maxChars - marker.length);
  const headChars = Math.floor(contentChars / 2);
  const tailChars = contentChars - headChars;
  return `${value.slice(0, headChars)}${marker}${tailChars > 0 ? value.slice(-tailChars) : ""}`;
}

function stringifyStoredJsonFallback(json: string, originalJsonBytes: number) {
  let previewChars = Math.min(json.length, Math.floor(storedJsonPayloadLimitBytes / 2));
  while (previewChars >= 0) {
    const fallback = JSON.stringify({
      threadexPayloadTruncated: true,
      threadexPayloadOriginalJsonBytes: originalJsonBytes,
      threadexPayloadLimitBytes: storedJsonPayloadLimitBytes,
      threadexPayloadFallback: true,
      preview: trimStoredString(json, previewChars)
    });
    if (Buffer.byteLength(fallback) <= storedJsonPayloadLimitBytes) {
      return fallback;
    }
    previewChars = Math.floor(previewChars / 2);
  }
  return JSON.stringify({
    threadexPayloadTruncated: true,
    threadexPayloadOriginalJsonBytes: originalJsonBytes,
    threadexPayloadLimitBytes: storedJsonPayloadLimitBytes,
    threadexPayloadFallback: true
  });
}

function sessionLiveItemFromRow(row: Record<string, unknown>): unknown | null {
  const storedPayload = parseJsonObject(row.payload_json);
  // Keep raw JSON intact in storage; JavaScript supports escaped NULs in output.
  if (isPlainObject(storedPayload)) {
    row = {
      ...row,
      text: storedPayload.text,
      command: storedPayload.command,
      status: storedPayload.status,
      exit_code: storedPayload.exitCode,
      query: storedPayload.query,
      message: storedPayload.message,
      changes_json: JSON.stringify(storedPayload.changes ?? null),
      items_json: JSON.stringify(storedPayload.items ?? null),
      aggregated_output_length: storedPayload.aggregatedOutputLength,
      aggregated_output_tail: storedPayload.aggregatedOutput,
      output_truncated: storedPayload.outputTruncated,
      omitted_output_chars: storedPayload.omittedOutputChars
    };
  }
  const id = isPlainObject(storedPayload)
    ? stringValue(storedPayload.id, stringValue(row.item_id))
    : stringValue(row.item_id);
  const itemType = stringValue(row.item_type);
  const eventType = stringValue(row.event_type, "item.completed");
  if (!id || !itemType) {
    return null;
  }

  const origin = sessionLiveItemOrigin(storedPayload);

  if (itemType === "agent_message") {
    if (isPlainObject(storedPayload)) {
      const text = stringValue(storedPayload.text, stringValue(row.text));
      const comment = normalizeStructuredAgentComment(storedPayload.comment, text);
      return {
        ...storedPayload,
        id,
        eventType,
        itemType,
        text,
        ...(comment ? { comment } : {}),
        ...origin
      };
    }
    return { id, eventType, itemType, text: stringValue(row.text), ...origin };
  }

  if (itemType === "reasoning") {
    return { id, eventType, itemType, text: stringValue(row.text), ...origin };
  }

  if (itemType === "command_execution") {
    const outputLength = numberValue(row.aggregated_output_length);
    const omittedOutputChars = Math.max(
      0,
      nullableNumber(row.omitted_output_chars) ?? outputLength - stringValue(row.aggregated_output_tail).length
    );
    const outputTail = stringValue(row.aggregated_output_tail);
    const marker = omittedOutputChars > 0 ? `[output truncated: omitted ${omittedOutputChars.toLocaleString()} chars]\n` : "";
    return {
      id,
      eventType,
      itemType,
      command: stringValue(row.command),
      aggregatedOutput: `${marker}${outputTail}`,
      aggregatedOutputLength: outputLength,
      ...(omittedOutputChars > 0 ? { outputTruncated: true, omittedOutputChars } : {}),
      ...(nullableNumber(row.exit_code) !== null ? { exitCode: nullableNumber(row.exit_code) } : {}),
      status: stringValue(row.status),
      ...origin
    };
  }

  if (itemType === "file_change") {
    const changes = parseJsonObject(row.changes_json);
    return {
      id,
      eventType,
      itemType,
      changes: Array.isArray(changes) ? changes : [],
      status: stringValue(row.status),
      ...(isPlainObject(storedPayload) && storedPayload.authoritative === true ? { authoritative: true } : {}),
      ...origin
    };
  }

  if (itemType === "web_search") {
    return { id, eventType, itemType, query: stringValue(row.query), ...origin };
  }

  if (itemType === "todo_list") {
    const items = parseJsonObject(row.items_json);
    return { id, eventType, itemType, items: Array.isArray(items) ? items : [], ...origin };
  }

  if (itemType === "context_compaction") {
    return { id, eventType, itemType, ...origin };
  }

  if (itemType === "subagent") {
    const payload = parseJsonObject(row.payload_json);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    return { ...payload, id, eventType, itemType, ...origin };
  }

  if (itemType === "error") {
    return { id, eventType, itemType, message: stringValue(row.message), ...origin };
  }

  return null;
}

function sessionLiveItemOrigin(value: unknown) {
  if (!isPlainObject(value)) {
    return {};
  }
  const originThreadId = stringValue(value.originThreadId);
  const originTurnId = stringValue(value.originTurnId);
  return {
    ...(originThreadId ? { originThreadId } : {}),
    ...(originTurnId ? { originTurnId } : {})
  };
}

function approvalLiveItemFromRow(row: Record<string, unknown>): unknown | null {
  const payload = parseJsonObject(row.payload_json);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const approvalId = stringValue(record.approvalId);
  const method = stringValue(record.method);
  if (!approvalId || !method) {
    return null;
  }

  const resolved = stringValue(row.event_name) === "approval.resolved";
  return {
    id: `approval:${approvalId}`,
    eventType: resolved ? "item.completed" : "item.started",
    itemType: "approval",
    approvalId,
    method,
    params: record.params ?? null,
    status: resolved ? "resolved" : "pending",
    ...(resolved && row.answer_submitted_at ? { answerSubmittedAt: stringValue(row.answer_submitted_at) } : {}),
    ...(resolved ? { decision: record.decision, error: record.error } : {})
  };
}

function withLiveItemSortFields(item: unknown, row: Record<string, unknown>) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return item;
  }

  return {
    ...(item as Record<string, unknown>),
    sortCreated: sortableString(row.created),
    sortEventId: sortableString(row.event_id)
  };
}

function sortableString(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function keywordAppearanceWeight(sessionCount: number, maxSessionCount: number) {
  if (!Number.isFinite(sessionCount) || sessionCount <= 0 || !Number.isFinite(maxSessionCount) || maxSessionCount <= 0) {
    return 0;
  }
  if (maxSessionCount <= 1) {
    return 1;
  }
  const specificity = 1 - Math.min(1, Math.max(0, sessionCount / maxSessionCount));
  return Number((0.1 + specificity * 0.9).toFixed(3));
}

function keywordWeightsFromText(text: string): KeywordWeights {
  const tokens = text
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}_-]{2,}/gu);

  if (!tokens) {
    return {};
  }

  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  const total = tokens.length;
  const entries = [...counts.entries()]
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
    .slice(0, 16)
    .map(([keyword, count]) => [keyword, Number((count / total).toFixed(4))] as const);

  return Object.fromEntries(entries);
}

const genericKeywordTokens = new Set([
  "add",
  "added",
  "agent",
  "app",
  "change",
  "changed",
  "code",
  "codex",
  "content",
  "data",
  "debug",
  "default",
  "description",
  "done",
  "field",
  "find",
  "fix",
  "fixed",
  "for",
  "index",
  "local",
  "make",
  "new",
  "repo",
  "search",
  "session",
  "sessions",
  "setup",
  "task",
  "test",
  "text",
  "update",
  "updated",
  "user",
  "word",
  "work"
]);

function normalizeKeywordToken(value: string) {
  const normalized = value.trim().toLocaleLowerCase().replace(/[^a-z0-9_-]+/g, "");
  return /^[a-z][a-z0-9_-]{1,39}$/.test(normalized) ? normalized : "";
}

function normalizeComposerSuggestionKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const keyword = item.trim().replace(/\s+/g, " ").slice(0, 120);
    const key = keyword.toLocaleLowerCase();
    if (!keyword || seen.has(key)) continue;
    seen.add(key);
    keywords.push(keyword);
    if (keywords.length >= 100) break;
  }
  return keywords;
}

function normalizeKeywordList(values: string[]) {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const keyword = normalizeKeywordToken(value);
    if (!keyword || seen.has(keyword)) {
      continue;
    }
    seen.add(keyword);
    normalized.push(keyword);
  }
  return normalized.slice(0, 12);
}

function isGenericKeywordToken(keyword: string) {
  return genericKeywordTokens.has(keyword);
}

function scoreSessionKeywordCandidate(
  session: SessionRecord,
  keywords: string[],
  now: number,
  appearanceWeights: Record<string, number>,
  contentMatchedKeywords: Set<string> = new Set()
): SessionKeywordCandidate | null {
  if (keywords.length === 0) {
    return null;
  }

  const title = session.title.toLocaleLowerCase();
  const description = session.description.toLocaleLowerCase();
  const matched = new Set<string>();
  let keywordScore = 0;

  for (const keyword of keywords) {
    const normalizedKeyword = normalizeKeywordToken(keyword);
    if (!normalizedKeyword) {
      continue;
    }

    const weight = session.keywordWeights[normalizedKeyword] ?? 0;
    const appearanceWeight = appearanceWeights[normalizedKeyword] ?? 1;
    let score = Number.isFinite(weight) && weight > 0 ? weight * 8 * appearanceWeight : 0;
    if (containsKeywordLike(title, normalizedKeyword)) {
      score += 5 * appearanceWeight;
    }
    if (containsKeywordLike(description, normalizedKeyword)) {
      score += 2 * appearanceWeight;
    }
    if (contentMatchedKeywords.has(normalizedKeyword)) {
      score += 4 * appearanceWeight;
    }

    if (score > 0) {
      keywordScore += score;
      matched.add(normalizedKeyword);
    }
  }

  if (keywordScore <= 0) {
    return null;
  }

  const updatedMs = Date.parse(session.updated);
  const ageDays = Number.isFinite(updatedMs) ? Math.max(0, (now - updatedMs) / 86_400_000) : 365;
  const recencyScore = Number(Math.max(0, 1 - ageDays / 30).toFixed(4));
  const score = Number((keywordScore + recencyScore * 0.75).toFixed(4));
  return {
    session,
    score,
    keywordScore: Number(keywordScore.toFixed(4)),
    recencyScore,
    matchedKeywords: [...matched].sort()
  };
}

function containsKeywordLike(text: string, keyword: string) {
  if (!text || !keyword) {
    return false;
  }
  if (text.includes(keyword)) {
    return true;
  }
  return text.replace(/[^a-z0-9]+/g, "-").includes(keyword);
}

function truncateSessionRecord(session: SessionRecord, maxTextChars: number | null): SessionRecord {
  if (maxTextChars === null || session.description.length <= maxTextChars) {
    return session;
  }
  return {
    ...session,
    description: `${session.description.slice(0, Math.max(0, maxTextChars))}\n[truncated: omitted ${session.description.length - maxTextChars} chars]`
  };
}

function formatEmbeddingNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return Number(value).toFixed(8).replace(/\.?0+$/, "");
}

function toSessionSummaryStateRecord(row: SessionSummaryStateRow): SessionSummaryStateRecord {
  return {
    sessionId: stringValue(row.session_id),
    sourceHash: stringValue(row.source_hash),
    sourceTurnCount: numberValue(row.source_turn_count),
    sourceUpdated: stringValue(row.source_updated),
    summarizerModel: stringValue(row.summarizer_model),
    summarizedAt: stringValue(row.summarized_at),
    updated: stringValue(row.updated)
  };
}

function toKeywordAppearanceRecord(row: KeywordAppearanceRow): KeywordAppearanceRecord {
  return {
    workspaceId: stringValue(row.workspace_id, "default"),
    keyword: stringValue(row.keyword),
    sessionCount: numberValue(row.session_count),
    created: stringValue(row.created),
    updated: stringValue(row.updated)
  };
}

function toComposerSuggestionKeywordRecord(row: Record<string, unknown>): ComposerSuggestionKeywordRecord {
  return {
    workspaceId: stringValue(row.workspace_id, "default"),
    keyword: stringValue(row.keyword),
    position: numberValue(row.position),
    created: stringValue(row.created),
    updated: stringValue(row.updated)
  };
}

function toProcessMonitorRecord(row: ProcessMonitorRow): ProcessMonitorRecord {
  const status = stringValue(row.status, "error");
  const wakeStatus = stringValue(row.wake_status, "none");
  const rawArgs = parseJsonObject(row.args_json);
  const args = Array.isArray(rawArgs) ? rawArgs.filter((arg): arg is string => typeof arg === "string") : [];
  const rawDockerRunArgs = parseJsonObject(row.docker_run_args_json);
  const dockerRunArgs = Array.isArray(rawDockerRunArgs)
    ? rawDockerRunArgs.filter((arg): arg is string => typeof arg === "string")
    : [];
  const rawEntryPoints = parseJsonObject(row.entry_points_json);
  const storedEntryPoints = Array.isArray(rawEntryPoints)
    ? rawEntryPoints.filter((entryPoint): entryPoint is string => typeof entryPoint === "string")
    : [];
  const legacyEntryPoint = nullableString(row.entry_point);
  const entryPoints = storedEntryPoints.length > 0
    ? storedEntryPoints
    : legacyEntryPoint ? [legacyEntryPoint] : [];
  const metricMonitors = parseProcessMetricMonitors(row.metric_monitors_json);
  const metricReadings = parseProcessMetricReadings(row.metric_readings_json, metricMonitors);
  return {
    id: stringValue(row.id),
    workspaceId: stringValue(row.workspace_id, "default"),
    label: stringValue(row.label),
    command: nullableString(row.command),
    executable: nullableString(row.executable),
    dockerImage: nullableString(row.docker_image),
    dockerRunArgs,
    args,
    logFile: nullableString(row.log_file),
    entryPoints,
    metricMonitors,
    metricReadings,
    cwd: stringValue(row.cwd),
    pid: nullableNumber(row.pid),
    status: isProcessMonitorStatus(status) ? status : "error",
    sourceCommandId: nullableString(row.source_command_id),
    parameters: (parseJsonObject(row.parameters_json) ?? []) as ProcessCommandParameter[],
    parameterValues: (parseJsonObject(row.parameter_values_json) ?? {}) as ProcessCommandValues,
    managed: row.managed === true,
    removeOnExit: row.remove_on_exit === true,
    wakePrompt: nullableString(row.wake_prompt),
    wakeSessionId: nullableString(row.wake_session_id),
    wakeThreadId: nullableString(row.wake_thread_id),
    timeoutAt: nullableString(row.timeout_at),
    wakeStatus: isProcessMonitorWakeStatus(wakeStatus) ? wakeStatus : "none",
    wakeError: nullableString(row.wake_error),
    wokenAt: nullableString(row.woken_at),
    startedAt: nullableString(row.started_at),
    lastExitCode: nullableNumber(row.last_exit_code),
    lastSignal: nullableString(row.last_signal),
    error: nullableString(row.error),
    created: stringValue(row.created),
    updated: stringValue(row.updated)
  };
}

function parseProcessMetricMonitors(value: unknown): ProcessMetricMonitor[] {
  const rawMetrics = parseJsonObject(value);
  if (!Array.isArray(rawMetrics)) return [];
  return rawMetrics.flatMap((metric) => {
    if (!metric || typeof metric !== "object") return [];
    const name = nullableString((metric as Record<string, unknown>).name);
    const command = nullableString((metric as Record<string, unknown>).command);
    return name && command ? [{ name, command, nameSuffix: (metric as Record<string, unknown>).nameSuffix === true }] : [];
  });
}

function parseProcessMetricReadings(value: unknown, metricMonitors: ProcessMetricMonitor[]): ProcessMetricReading[] {
  const rawReadings = parseJsonObject(value);
  if (!Array.isArray(rawReadings)) {
    return metricMonitors.map((metric) => ({ ...metric, value: null, status: "idle", updatedAt: null, error: null }));
  }
  const readingsByKey = new Map<string, ProcessMetricReading>();
  for (const reading of rawReadings) {
    if (!reading || typeof reading !== "object") continue;
    const record = reading as Record<string, unknown>;
    const name = nullableString(record.name);
    const command = nullableString(record.command);
    if (!name || !command) continue;
    const status = record.status === "ok" || record.status === "error" || record.status === "idle" ? record.status : "idle";
    readingsByKey.set(`${name}\u0000${command}`, {
      name,
      command,
      nameSuffix: record.nameSuffix === true,
      value: nullableString(record.value),
      status,
      updatedAt: nullableString(record.updatedAt),
      error: nullableString(record.error)
    });
  }
  return metricMonitors.map((metric) => readingsByKey.get(`${metric.name}\u0000${metric.command}`) ?? {
    ...metric,
    value: null,
    status: "idle",
    updatedAt: null,
    error: null
  });
}

function isProcessMonitorStatus(value: string): value is ProcessMonitorStatus {
  return ["available", "starting", "running", "exited", "stopped", "error"].includes(value);
}

function isProcessMonitorWakeStatus(value: string): value is ProcessMonitorWakeStatus {
  return ["none", "pending", "sent", "done", "error"].includes(value);
}

function toWaitEventRecord(row: WaitEventRow): WaitEventRecord {
  const status = stringValue(row.status, "pending");
  return {
    id: stringValue(row.id),
    workspaceId: stringValue(row.workspace_id, "default"),
    topic: stringValue(row.topic),
    subjectKey: stringValue(row.subject_key),
    status: isWaitEventStatus(status) ? status : "pending",
    expectedAt: nullableString(row.expected_at),
    payload: parseJsonObject(row.payload_json),
    firedAt: nullableString(row.fired_at),
    created: stringValue(row.created),
    updated: stringValue(row.updated)
  };
}

function toWaitSubscriptionRecord(row: WaitSubscriptionRow): WaitSubscriptionRecord {
  const status = stringValue(row.status, "waiting");
  const actionType = stringValue(row.action_type, "notify");
  return {
    id: stringValue(row.id),
    eventId: stringValue(row.event_id),
    workspaceId: stringValue(row.workspace_id, "default"),
    sessionId: stringValue(row.session_id),
    turnId: nullableString(row.turn_id),
    actionType: isWaitSubscriptionActionType(actionType) ? actionType : "notify",
    actionPayload: parseJsonObject(row.action_payload_json),
    status: isWaitSubscriptionStatus(status) ? status : "waiting",
    attempts: numberValue(row.attempts),
    error: nullableString(row.error),
    deliveredAt: nullableString(row.delivered_at),
    created: stringValue(row.created),
    updated: stringValue(row.updated)
  };
}

function toTodoItemRecord(row: TodoItemRow): TodoItemRecord {
  return {
    id: stringValue(row.id),
    sessionId: stringValue(row.session_id),
    parentId: nullableString(row.parent_id),
    title: stringValue(row.title),
    details: stringValue(row.details),
    context: stringValue(row.context),
    section: todoPlanSectionValue(row.section),
    status: todoItemStatusValue(row.status),
    position: numberValue(row.position),
    createdBy: todoActorValue(row.created_by),
    updatedBy: todoActorValue(row.updated_by),
    lockedByTurnId: nullableString(row.locked_by_turn_id),
    lockReason: nullableString(row.lock_reason),
    activeStatus: nullableString(row.active_status),
    childSessionId: nullableString(row.child_session_id),
    childTurnId: nullableString(row.child_turn_id),
    changedFileCount: numberValue(row.changed_file_count),
    changedFiles: stringArrayFromJson(row.changed_files_json),
    created: stringValue(row.created),
    updated: stringValue(row.updated)
  };
}

function toTodoItemSessionRecord(row: TodoItemSessionRow): TodoItemSessionRecord {
  return {
    id: stringValue(row.id),
    sessionId: stringValue(row.session_id),
    itemId: stringValue(row.item_id),
    childSessionId: stringValue(row.child_session_id),
    childTurnId: nullableString(row.child_turn_id),
    title: stringValue(row.title),
    role: stringValue(row.role, "worker"),
    created: stringValue(row.created),
    updated: stringValue(row.updated)
  };
}

function toTodoCommentRecord(row: TodoCommentRow): TodoCommentRecord {
  return {
    id: stringValue(row.id),
    sessionId: stringValue(row.session_id),
    itemId: nullableString(row.item_id),
    turnId: nullableString(row.turn_id),
    type: todoCommentTypeValue(row.type),
    author: todoActorValue(row.author),
    body: stringValue(row.body),
    created: stringValue(row.created)
  };
}

function toTodoMessageRecord(row: TodoMessageRow): TodoMessageRecord {
  const type = todoMessageTypeValue(row.type);
  const id = numberValue(row.id);
  const resolvedAt = nullableString(row.resolved_at);
  return {
    id,
    sessionId: stringValue(row.session_id),
    itemId: stringValue(row.item_id),
    turnId: nullableString(row.turn_id),
    type,
    author: todoActorValue(row.author),
    title: stringValue(row.title),
    body: stringValue(row.body),
    challengeId: type === "challenge" ? id : null,
    resolved: type === "challenge" ? Boolean(resolvedAt) : true,
    resolvedBy: nullableTodoActorValue(row.resolved_by),
    resolvedAt,
    created: stringValue(row.created)
  };
}

function toTodoControlRecord(row: TodoControlRow): TodoControlRecord {
  return {
    sessionId: stringValue(row.session_id),
    paused: row.paused === true,
    pauseReason: nullableString(row.pause_reason),
    pausedBy: nullableTodoActorValue(row.paused_by),
    context: stringValue(row.context),
    problem: stringValue(row.problem),
    objective: stringValue(row.objective),
    updated: stringValue(row.updated)
  };
}

function defaultTodoControl(sessionId: string): TodoControlRecord {
  return {
    sessionId,
    paused: false,
    pauseReason: null,
    pausedBy: null,
    context: "",
    problem: "",
    objective: "",
    updated: ""
  };
}

function buildTodoItemTree(
  items: TodoItemRecord[],
  itemSessions: TodoItemSessionRecord[],
  messages: TodoMessageRecord[]
): TodoSnapshotItem[] {
  const sessionsByItem = new Map<string, TodoItemSessionRecord[]>();
  for (const session of itemSessions) {
    const sessions = sessionsByItem.get(session.itemId) ?? [];
    sessions.push(session);
    sessionsByItem.set(session.itemId, sessions);
  }

  const latestMessageByItem = new Map<string, TodoMessageRecord>();
  for (const message of messages) {
    latestMessageByItem.set(message.itemId, message);
  }

  const nodes = new Map<string, TodoSnapshotItem>();
  for (const item of items) {
    nodes.set(item.id, {
      id: item.id,
      parentId: item.parentId,
      title: item.title,
      details: item.details,
      context: item.context,
      section: item.section,
      status: item.status,
      activeStatus: item.activeStatus,
      latestProgressMessage: latestMessageByItem.get(item.id) ?? null,
      sessions: sessionsByItem.get(item.id) ?? [],
      children: []
    });
  }

  const roots: TodoSnapshotItem[] = [];
  for (const item of items) {
    const node = nodes.get(item.id);
    if (!node) continue;
    const parent = item.parentId ? nodes.get(item.parentId) : null;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function isWaitEventStatus(value: string): value is WaitEventStatus {
  return ["pending", "fired", "cancelled"].includes(value);
}

function isWaitSubscriptionStatus(value: string): value is WaitSubscriptionStatus {
  return ["waiting", "dispatching", "done", "error", "cancelled"].includes(value);
}

function isWaitSubscriptionActionType(value: string): value is WaitSubscriptionActionType {
  return ["retry_turn", "enqueue_prompt", "notify"].includes(value);
}

function titleFromMessage(message: string) {
  const singleLine = message.replace(/\s+/g, " ").trim();
  return singleLine.length > 72 ? `${singleLine.slice(0, 69)}...` : singleLine || "Untitled session";
}

function createSlugId(value: string, fallback: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || fallback;
  return `${slug}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultCodexHome() {
  return resolveUserPath(process.env.THREADEX_DEFAULT_WORKSPACE_CODEX_HOME ?? "~/.codex");
}

function shouldUpdateDefaultWorkspaceCodexHome(current: string, desired: string) {
  return current !== desired;
}

function defaultCwd() {
  return resolve(process.env.CODEX_WORKDIR ?? process.cwd());
}

function normalizeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseSessionListSearchTerms(query: string): string[] {
  const terms: string[] = [];
  let current = "";
  let inQuotes = false;
  let escaped = false;

  const pushCurrent = () => {
    const term = current.trim().slice(0, 128);
    current = "";
    if (!term || terms.some((candidate) => candidate.toLocaleLowerCase() === term.toLocaleLowerCase())) return;
    if (terms.length < 12) terms.push(term);
  };

  for (const character of query.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && inQuotes) {
      escaped = true;
    } else if (character === '"') {
      inQuotes = !inQuotes;
    } else if (/\s/.test(character) && !inQuotes) {
      pushCurrent();
    } else {
      current += character;
    }
  }
  if (escaped) current += "\\";
  pushCurrent();
  return terms;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readsProtectedAccountAuth(sql: string) {
  const normalized = sql.replace(/["`]/g, "");
  return (
    /\b(?:auth_json|config_toml)\b/i.test(normalized) ||
    /\b(?:from|join)\s+(?:[a-z_][a-z0-9_]*\.)?accounts\b/i.test(normalized)
  );
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  return fallback;
}

function commandHeadParts(command: string) {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if ((char === "'" || char === "\"") && !quote) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = null;
      continue;
    }

    if (!quote && /\s/.test(char)) {
      if (current) {
        parts.push(current.slice(0, 64));
        current = "";
        if (parts.length === 3) {
          break;
        }
      }
      continue;
    }

    current += char;
  }

  if (parts.length < 3 && current) {
    parts.push(current.slice(0, 64));
  }

  return parts;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}
