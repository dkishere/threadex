import { USER_INPUT_METHOD, inputResponse } from "../userInputRequest";
import { isAutoModel, isAutoEffort } from "../autoModelCatalog";
import { buildAutoModelState, selectAutoModel } from "./autoModelSelector";
import { AutoModelSettings, createAutoModelSettingsRouter } from "./autoModelSettings";
import { RunnerProcessRegistry } from "./runnerProcessRegistry";
import { createTurnGrillHandler } from "./turnGrillRoute";
import { reviseOutcomePlan } from "./lightweightTodo";
import express from "express";
import { createSecurity } from "./security";
import { createQuickChatRouter } from "./quickChatRoute";
import type { Request, Response } from "express";
import { buildCodexReference } from "../codexReference.js";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import type { Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  SessionStore,
  type AccountRecord,
  summarizeSessionFileChanges,
  type SessionInspectInput,
  type SessionKeywordCandidate,
  type SessionMetadataInput,
  type SessionModelPreferencesInput,
  type ProcessMonitorRecord,
  type SessionRecord,
  type SessionSearchInput,
  type SessionTurnTokenUsageSampleInput,
  type SessionTurnRecord,
  type SessionVectorSearchInput,
  type TodoActor,
  type TodoCommentType,
  type TodoItemStatus,
  type TodoMessageType,
  type WaitEventRecord,
  type WaitSubscriptionActionType,
  type WaitSubscriptionRecord,
  type WorkspaceRecord
} from "./sessionStore";
import { ProcessMonitorService, type AdoptProcessMonitorInput, type MonitorProcessInput } from "./processMonitor";
import { WaitEventService } from "./waitEvent";
import { chooseLoadBalancedAccount } from "./accountPicker";
import { shouldChooseAccountForNewLoadBalancedThread } from "./loadBalanceRouting";
import { agentCliExecutable, createEphemeralAgentHome, defaultAgentHomeCandidates, runAgentCliExec, trimAgentCliOutput } from "./agentCli";
import { normalizeModelTokenUsage, type ModelTokenUsage } from "./modelTokenUsage";
import { embedSessionText, SessionSummarizer } from "./sessionSummarizer";
import {
  markCodexSessionTitlePending,
  normalizeCodexSessionTitle,
  readCodexSessionTitles
} from "./codexSessionTitles";
import {
  codexSessionPollSources,
  isPathInsideCodexHome
} from "./codexSessionPoll";
import { LocalBrowserBridgeClient, LocalBrowserBridgeError } from "./localBrowserBridgeClient";
import { buildStartupSnapshot } from "./startupSnapshot";
import {
  answerSessionQuestion,
  isSideChatReasoningEffort,
  stopSessionQuestionRunners
} from "./sessionQuestion";
import { mirrorProcessOutputToFile } from "../supervisorOutput";
import { injectBuiltinSkills, injectBuiltinSkillsForWorkspaces } from "./builtinSkills";
import { defaultThreadOptions, type ApprovalPolicy } from "./codexConfig";
import { isAccountLoginRequiredMessage } from "../codexAuth";
import { accountAuthIdentityError } from "./accountAuth";
import {
  buildTodoChildTaskContextFromSnapshot,
  delegatedTodoActiveStatus
} from "./todoInstructions";
import { isTodoPlanAwaitingClarification } from "../todoPlan";
import { decideSessionTaskCreation } from "./sessionTaskPolicy";
import { rebindSessionAccount } from "./sessionAccountBinding";
import {
  buildSessionRecoveryContext,
  shouldForcePersistedRecovery,
  type SessionRecoveryContext
} from "./sessionRecovery";
import { resolveNewSessionCwd } from "./sessionBaseDir";
import { resolveSessionWorkspace } from "./sessionWorkspace";
import {
  pendingLoadBalanceForUpdate,
  pendingRetryAt,
  pendingTurnRunsAutomatically,
  pendingUsesWorkspaceAccountPool as shouldUseWorkspaceAccountPool
} from "./pendingTurnRouting";
import { DEFAULT_TURN_RING_MAX_BYTES, TurnRingLog } from "./turnRingLog";
import { EventRingLog, type RingEvent } from "./eventRingLog";
import { canInlineWorkspaceFile, resolveWorkspaceFilePath } from "./workspaceFiles";
import { captureTurnGitBaseline } from "./turnGitPatch";
import { runnerStartupIsWithinGrace } from "./runnerWatchdog";
import {
  collectSessionReviewChanges,
  collectTurnReviewChanges,
  createWebVsCodeAnnotationSession,
  createWebVsCodeReviewSession,
  webVsCodeReviewRequestDirectory
} from "./webVsCodeReviewSession";
import {
  createWebVsCodeWalkthroughSession,
  webVsCodeWalkthroughActionDirectory,
  webVsCodeWalkthroughResultDirectory,
  WebVsCodeWalkthroughService
} from "./webVsCodeWalkthrough";
import { installBundledWebVsCodeReviewExtension, shouldAutoStartWebVsCodeServer } from "./webVsCodeExtension";
import { listCodexProjects, resolveCodexProjectCwd } from "./codexProjects";
import {
  normalizeSubagentTranscript,
  readAppServerThread,
  subagentThreadBelongsToRoot
} from "./subagentTranscript";
import {
  drainRunnerLogEntries,
  initialRunnerLogReadState,
  shouldRefreshRunnerHeartbeat,
  type RunnerLogApplicationMode
} from "./runnerLogReader";
import {
  isPathInsideOrEqual,
  safeFileName,
  saveUploadedAttachments,
  type SavedAttachment,
  type UploadedAttachment
} from "./attachmentUploads";
import { MAX_PATH_ATTACHMENT_BYTES } from "../attachmentLimits";

type ChatRequest = {
  grillOrigin?: { turnId: string; observedVersion: number };
  message?: string;
  sessionId?: string;
  resumeThreadId?: string;
  baseSessionId?: string;
  /** Selected project registered in the workspace's CODEX_HOME. */
  newSessionProjectId?: string;
  /** @deprecated Clients must select a project rather than provide a cwd. */
  newSessionCwd?: string;
  /** Backward compatibility for clients loaded before baseSessionId existed. */
  cwd?: string;
  contextFork?: boolean;
  forcePlan?: boolean;
  lightweightTodo?: boolean;
  taskChild?: boolean;
  backgroundTask?: boolean;
  retryPending?: boolean;
  turnId?: string;
  model?: string;
  modelReasoningEffort?: string;
  approvalPolicy?: ApprovalPolicy;
  autoModel?: boolean;
  attachments?: UploadedAttachment[];
  workspaceId?: string;
  accountId?: string | null;
  loadBalanceInWorkspace?: boolean;
  executionMode?: ExecutionMode;
  modelPreferences?: SessionModelPreferencesInput;
  skills?: RequestedSkill[];
  developerInstructions?: string;
  /** Internal routing fields for a child that owns one parent todo item. */
  todoParentSessionId?: string;
  todoItemId?: string;
} & SessionMetadataInput;

type ComposerSuggestionKeywordRequest = {
  workspaceId?: string;
  keyword?: string;
  keywords?: unknown;
};

type ExecutionMode = "default" | "plan" | "goal";

function combineDeveloperInstructions(...values: Array<string | undefined | null | false>) {
  return values.filter((value): value is string => Boolean(value)).join("\n\n") || undefined;
}

type RequestedSkill = {
  name: string;
  path: string;
};

type SqlQueryRequest = {
  sql?: string;
  params?: Record<string, unknown>;
  limit?: number;
};

type ProcessMonitorRequest = MonitorProcessInput & {
  sessionId?: string;
  threadId?: string;
};

type VirtualProcessRestartAction =
  | { kind: "signal"; pid: number; signal: NodeJS.Signals }
  | { kind: "touch"; path: string }
  | { kind: "command"; executable: string; args: string[]; cwd: string; stopPid: number | null };

type VirtualProcessMonitor = {
  monitor: ProcessMonitorRecord;
  restartAction: VirtualProcessRestartAction | null;
};

type AdoptProcessMonitorRequest = AdoptProcessMonitorInput;

type WaitSubscriptionRequest = {
  eventId?: string;
  workspaceId?: string;
  sessionId?: string;
  turnId?: string;
  actionType?: WaitSubscriptionActionType;
  actionPayload?: unknown;
};

type WaitSubscriptionUpdateRequest = {
  prompt?: string;
};

type SwitchSessionRequest = {
  sessionId?: string;
};

type SummarizeSessionsRequest = {
  sessionIds?: string[];
  force?: boolean;
};

type ForkSessionRequest = {
  sessionId?: string;
  turnId?: string;
  title?: string;
};

type CreateSessionTaskRequest = {
  parentSessionId?: string;
  /** Internal caller identity supplied by the managed Session Inspector MCP. */
  sourceSessionId?: string;
  /** True only for an explicit UI context-fork request. */
  contextFork?: boolean;
  prompt?: string;
  title?: string;
  todoItemId?: string;
  startImmediately?: boolean;
  model?: string;
  modelReasoningEffort?: string;
  approvalPolicy?: ApprovalPolicy;
  executionMode?: ExecutionMode;
  forcePlan?: boolean;
  lightweightTodo?: boolean;
  skills?: RequestedSkill[];
  developerInstructions?: string;
};

type TodoItemRequest = {
  id?: string;
  parentId?: string | null;
  title?: string;
  details?: string | null;
  context?: string | null;
  section?: "solution" | "verification" | null;
  status?: TodoItemStatus;
  position?: number | null;
  actor?: TodoActor;
  turnId?: string | null;
  activeStatus?: string | null;
  lockReason?: string | null;
};

type TodoCommentRequest = {
  itemId?: string | null;
  turnId?: string | null;
  type?: TodoCommentType;
  author?: TodoActor;
  body?: string;
};

type TodoMessageRequest = {
  itemId?: string;
  turnId?: string | null;
  type?: TodoMessageType;
  author?: TodoActor;
  title?: string;
  body?: string | null;
};

type TodoChallengeResolveRequest = {
  actor?: TodoActor;
};

type TodoControlRequest = {
  paused?: boolean;
  pauseReason?: string | null;
  context?: string | null;
  problem?: string | null;
  objective?: string | null;
  actor?: TodoActor;
};

type SwitchWorkspaceRequest = {
  workspaceId?: string;
};

type CreateWorkspaceRequest = {
  name?: string;
  codexHome?: string;
  cwd?: string;
};

type SessionCwdMigrationRequest = {
  threadIds?: string[];
  cwd?: string;
  workspaceId?: string;
  allowMissing?: boolean;
};

type SwitchAccountRequest = {
  accountId?: string | null;
  sessionId?: string | null;
};

type ResetAccountRateLimitRequest = {
  accountId?: string;
  creditId?: string;
  idempotencyKey?: string;
};

type ImportAccountRequest = {
  accountId?: string;
  name?: string;
};

type CreateApiAccountRequest = {
  accountId?: string;
  name?: string;
  apiUrl?: string;
  apiKey?: string;
};

type StartAccountLoginRequest = {
  accountId?: string;
  name?: string;
  sessionId?: string | null;
};

type CompleteAccountLoginRequest = {
  loginId?: string;
};

type AccountLoginStatusRequest = {
  loginId?: string;
};

type RunnerAccountAuthSyncRequest = {
  sessionId?: string;
  turnId?: string;
  accountId?: string;
  authVersion?: number;
};

type CodexStopHookRequest = {
  sessionId?: string;
  turnId?: string;
  transcriptPath?: string;
  cwd?: string;
  codexHome?: string;
  hookEventName?: string;
  managedByThreadex?: boolean;
  managerSessionId?: string;
  managerTurnId?: string;
  queuedAt?: string;
};

type WorkspaceAccountRequest = {
  workspaceId?: string;
  accountId?: string;
};

type DeleteAccountRequest = {
  accountId?: string;
};

type AdvanceLoadBalancedAccountRequest = {
  workspaceId?: string;
};

type AutoLoadBalanceRequest = {
  workspaceId?: string;
  enabled?: boolean;
};

type ManagedSession = {
  id: string;
  threadId?: string | null;
  parentSessionId?: string | null;
  workspaceId: string;
  codexHome: string;
  cwd: string;
  account: AccountRecord | null;
  accountId: string | null;
  accountName: string | null;
  accountEmail: string | null;
  accountExternalAccountId: string | null;
  accountExternalUserId: string | null;
  accountAuthVersion: number | null;
  accountChanged: boolean;
};

type RunnerJob = {
  sessionId: string;
  turnId: string;
  message: string;
  threadId?: string | null;
  model?: string;
  modelReasoningEffort?: string;
  approvalPolicy?: ApprovalPolicy;
  autoModelEnabled?: boolean;
  autoModelRevision?: number;
  autoModelPromptFullVersion?: boolean;
  executionMode?: ExecutionMode;
  forcePlan?: boolean;
  lightweightTodo?: boolean;
  todoPlanClarificationPending?: boolean;
  skills?: RequestedSkill[];
  attachments?: SavedAttachment[];
  serverUrl: string;
  logPath: string;
  pendingLogPath: string;
  controlPath: string;
  controlResultDir: string;
  workspaceId: string;
  codexHome: string;
  cwd: string;
  accountId?: string | null;
  accountExternalAccountId?: string | null;
  accountExternalUserId?: string | null;
  accountAuthVersion?: number | null;
  startupSnapshot?: string;
  contextParentSessionId?: string;
  contextForkRequest?: boolean;
  childExecutionMode?: ExecutionMode;
  todoParentSessionId?: string;
  todoItemId?: string;
  developerInstructions?: string;
  recoveryContext?: SessionRecoveryContext;
  forceRecoveryOnResume?: boolean;
};

type RunnerUpdateRequest = {
  id?: string;
  ts?: string;
  sessionId?: string;
  turnId?: string;
  event?: string;
  jsonlIndex?: number;
  data?: unknown;
  runnerPid?: number;
  logPath?: string;
};

type AutoModelUpgradeRequest = {
  sessionId?: string;
  model?: string;
  effort?: string;
  reason?: string;
};

type RunnerStreamRequest = {
  turnId?: string;
  sessionId?: string;
};

type RunnerStopRequest = {
  turnId?: string;
  sessionId?: string;
};

type RunnerSteerRequest = {
  turnId?: string;
  sessionId?: string;
  message?: string;
  forcePlan?: boolean;
  lightweightTodo?: boolean;
  attachments?: UploadedAttachment[];
  skills?: RequestedSkill[];
};

type RunnerSteerCommand = {
  id: string;
  message: string;
  attachments: SavedAttachment[];
  skills: RequestedSkill[];
  developerInstructions?: string;
};

type RunnerSteerResult = {
  ok: boolean;
  commandId: string;
  turnId: string;
  appTurnId?: string | null;
  error?: string;
};

type PendingTurnCreateRequest = ChatRequest & {
  message?: string;
};

type PendingTurnUpdateRequest = {
  sessionId?: string;
  turnId?: string;
  message?: string;
};

type PendingTurnMoveRequest = {
  sessionId?: string;
  turnId?: string;
  direction?: "up" | "down";
};

type SessionInspectorRequest = SessionInspectInput;

type SessionSearchRequest = SessionSearchInput;

type SessionVectorSearchRequest = SessionVectorSearchInput;

type SessionQuestionRequest = {
  sessionId?: string;
  threadId?: string;
  workspaceId?: string;
  sourceSessionId?: string | null;
  sourceThreadId?: string | null;
  sourceTurnId?: string | null;
  question?: string;
  model?: string;
  modelReasoningEffort?: string;
  q?: string;
  status?: SessionInspectInput["status"];
  turnLimit?: number;
  turnOffset?: number;
  maxTextChars?: number | null;
};

type ExperimentalSessionRoutingRequest = {
  message?: string;
  prompt?: string;
  workspaceId?: string | null;
  limit?: number;
  maxTextChars?: number | null;
  model?: string;
  apply?: boolean;
};

type ExperimentalKeywordRoutingRequest = {
  message?: string;
  prompt?: string;
  workspaceId?: string | null;
  limit?: number;
  keywordLimit?: number;
  vocabularyLimit?: number;
  maxTextChars?: number | null;
  model?: string;
};

type SessionRouteAction = "resume" | "start_new";

type SessionRouteCandidate = {
  index: number;
  sessionId: string;
  threadId: string | null;
  routeId: string;
  title: string;
  description: string;
  cwd: string;
  updated: string;
  similarity: number;
  score: number;
};

type ParsedSessionRouteDecision = {
  action: SessionRouteAction;
  routeId: string;
  sessionId: string | null;
  threadId: string | null;
  executorPrompt: string;
  rawText: string;
};

type ParsedKeywordRouteDecision = {
  keywords: string[];
  rawText: string;
};

type ApprovalRequestBody = {
  approvalId?: string;
  sessionId?: string;
  turnId?: string;
  requestId?: number | string;
  method?: string;
  params?: unknown;
};

type ApprovalDecisionBody = {
  decision?: unknown;
};

type PendingApproval = {
  approvalId: string;
  sessionId: string;
  turnId: string;
  requestId: number | string;
  method: string;
  params: unknown;
  createdAt: string;
  decision?: unknown;
  resolve?: (decision: unknown) => void;
};

type WorkspaceMonitorSession = {
  id: string;
  name: string;
  asking_approvals: WorkspaceMonitorApproval[];
};

type WorkspaceMonitorStatus = {
  id: string;
  name: string;
  active_sessions: WorkspaceMonitorSession[];
};

type WorkspaceMonitorApproval = {
  approvalId: string;
  sessionId: string;
  turnId: string;
  requestId: number | string;
  method: string;
  params: unknown;
  createdAt: string;
};

type PendingAccountLogin = {
  id: string;
  appServerLoginId: string | null;
  accountId: string | null;
  workspaceId: string;
  sessionId: string | null;
  name: string;
  codexHome: string;
  child: ChildProcess;
  output: string[];
  loginUrl: string | null;
  userCode: string | null;
  error: string | null;
  completedAccount: AccountRecord | null;
  completionPromise: Promise<AccountRecord | null> | null;
  createdAt: number;
};

type RunnerLogEntry = {
  id: string;
  ts: string;
  jsonlIndex?: number;
  sessionId: string;
  turnId: string;
  event: string;
  data: unknown;
};

type IndexedRunnerLogEntry = RunnerLogEntry & {
  jsonlIndex: number;
};

const runnerLogReadChunkBytes = 1024 * 1024;
const runnerLogMaxLineChars = 2 * 1024 * 1024;
const runnerLogSkipOversizedLine = "\0skip-oversized-runner-log-line";

type JsonRpcRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const app = express();
const localBrowserBridge = new LocalBrowserBridgeClient();
const sessionStore = new SessionStore();
const waitEvents = new WaitEventService(sessionStore, {
  onDispatch: dispatchWaitSubscription
});
type PendingSessionTurnCandidate = Awaited<ReturnType<SessionStore["listPendingSessionTurns"]>>[number];
const sessionSummarizer = new SessionSummarizer(sessionStore, undefined, async (sessionId) => {
  await publishTodoChanged(sessionId, await sessionStore.getSessionTodo(sessionId));
});
const pendingAccountLogins = new Map<string, PendingAccountLogin>();
const runnerSwitchReplayAttempts = new Map<string, number>();
const backgroundRunningTurnDiagnostics = new Set<string>();
const port = Number(process.env.PORT ?? 8787);
const serverMonitorStartedAt = new Date().toISOString();
const serverUrl = process.env.RUNNER_SERVER_URL ?? `http://127.0.0.1:${port}`;
const runnerPollMs = Number(process.env.RUNNER_LOG_POLL_MS ?? 250);
const runnerWatchdogMs = Number(process.env.RUNNER_WATCHDOG_MS ?? 15_000);
const runnerStaleMs = Number(process.env.RUNNER_STALE_MS ?? 120_000);
const runnerAbandonedMs = Number(process.env.RUNNER_ABANDONED_MS ?? 10 * 60 * 1000);
const runnerSwitchReplayStaleMs = Number(process.env.RUNNER_SWITCH_REPLAY_STALE_MS ?? Math.max(5_000, runnerPollMs * 4));
const runnerSwitchReplayThrottleMs = Number(process.env.RUNNER_SWITCH_REPLAY_THROTTLE_MS ?? 5_000);
const approvalWaitMs = Number(process.env.APPROVAL_WAIT_MS ?? 10 * 60 * 1000);
const quotaRpcTimeoutMs = Number(process.env.QUOTA_RPC_TIMEOUT_MS ?? 30_000);
const runnerStartupGraceMs = Number(
  process.env.RUNNER_STARTUP_GRACE_MS ?? Math.max(45_000, runnerWatchdogMs * 3)
);
const accountQuotaRefreshIntervalMs = parseDurationMs(
  process.env.ACCOUNT_QUOTA_REFRESH_INTERVAL_MS,
  5 * 60 * 1000,
  "ACCOUNT_QUOTA_REFRESH_INTERVAL_MS"
);
const accountQuotaRefreshInitialDelayMs = parseDurationMs(
  process.env.ACCOUNT_QUOTA_REFRESH_INITIAL_DELAY_MS,
  10_000,
  "ACCOUNT_QUOTA_REFRESH_INITIAL_DELAY_MS"
);
const codexSessionTitlePollIntervalMs = parseDurationMs(
  process.env.CODEX_SESSION_TITLE_POLL_INTERVAL_MS,
  30_000,
  "CODEX_SESSION_TITLE_POLL_INTERVAL_MS"
);
const codexSessionFilePollIntervalMs = parseDurationMs(
  process.env.CODEX_SESSION_FILE_POLL_INTERVAL_MS,
  15_000,
  "CODEX_SESSION_FILE_POLL_INTERVAL_MS"
);
const codexSessionFilePollQuietMs = parseDurationMs(
  process.env.CODEX_SESSION_FILE_POLL_QUIET_MS,
  5_000,
  "CODEX_SESSION_FILE_POLL_QUIET_MS"
);
const pendingAccountLoginTtlMs = 15 * 60 * 1000;
const accountLoggedOutQuotaError = "Logged out: Codex credentials need to be refreshed. Sign in again.";
const legacyDuckDbUiRequested = process.env.ENABLE_DUCKDB_UI === "true" || process.env.ENABLE_DUCKDB_UI === "1";
const enableDuckDbUi = false;
const duckDbUiAssetPort = parsePort(process.env.DBXLITE_ASSET_PORT, 8080);
const duckDbUiPort = parsePort(process.env.DUCKDB_UI_PORT, 4213);
const serverDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(serverDir, "../..");
const dataDir = resolve(process.env.SESSION_DATA_DIR ?? resolve(projectRoot, "data"));
const autoModelSettings = new AutoModelSettings(resolve(dataDir, "typesafe-api-key"));
const runnerPath = resolve(serverDir, "promptRunner.ts");
const tsxPath = resolve(projectRoot, "node_modules/tsx/dist/cli.mjs");
const runnerJobDir = resolve(dataDir, "runner-jobs");
const runnerLogDir = resolve(dataDir, "runner-logs");
const pendingRunnerLogDir = resolve(dataDir, "pending-runner-logs");
const runnerControlDir = resolve(dataDir, "runner-controls");
const runnerControlResultDir = resolve(dataDir, "runner-control-results");
const processMonitorLogDir = resolve(dataDir, "process-monitor-logs");
const eventRingLogPath = resolve(dataDir, "event-ring.jsonl");
const turnRingLogPath = resolve(process.env.TURN_RING_LOG_PATH ?? resolve(dataDir, "turn-ring.jsonl"));
const turnRingMaxBytes = parsePositiveBytes(
  process.env.TURN_RING_MAX_BYTES,
  DEFAULT_TURN_RING_MAX_BYTES,
  "TURN_RING_MAX_BYTES"
);
const turnRingLog = new TurnRingLog(turnRingLogPath, turnRingMaxBytes);
let webVsCodeWalkthroughService: WebVsCodeWalkthroughService | null = null;
const codexHookQueuePath = resolve(process.env.SESSION_CODEX_HOOK_QUEUE_PATH ?? resolve(dataDir, "codex-hook-queue.ndjson"));
const uploadDir = resolve(dataDir, "uploads");
const stagedAttachmentDir = resolve(uploadDir, "staged");
const accountPoolDir = resolve(dataDir, "account-pool");
mirrorProcessOutputToFile(supervisorLogPath("server"));
const processMonitor = new ProcessMonitorService(sessionStore, {
  onExit: publishProcessExit,
  logDir: processMonitorLogDir
});
const refreshingQuotaAccountIds = new Set<string>();
let codexSessionTitlePollTimer: NodeJS.Timeout | null = null;
let codexSessionTitlePollRunning = false;
let codexSessionFilePollTimer: NodeJS.Timeout | null = null;
let codexSessionFilePollRunning = false;
const pendingApprovals = new Map<string, PendingApproval>();
const listedSkillsByWorkspace = new Map<string, RequestedSkill[]>();
const sessionSummarizerEnabled = !["0", "false"].includes(
  (process.env.SESSION_SUMMARIZER_ENABLED ?? "true").trim().toLowerCase()
);
const autoLoadBalanceWorkspaceIds = new Set<string>();
const pendingTurnTimers = new Map<string, NodeJS.Timeout>();
const runnerProcesses = new RunnerProcessRegistry(terminateRunnerProcess);
const pendingTurnRuns = new Set<string>();
const pendingRetryFallbackMs = parseDurationMs(
  process.env.PENDING_RETRY_FALLBACK_MS,
  30_000,
  "PENDING_RETRY_FALLBACK_MS"
);
const eventRingCapacity = Math.max(1, Number.parseInt(process.env.EVENT_RING_CAPACITY ?? "4096", 10) || 4096);
const eventRingLog = new EventRingLog(eventRingLogPath, eventRingCapacity);
let eventPollSupplementCache: {
  workspaceId: string;
  expiresAt: number;
  statusMonitor: WorkspaceMonitorStatus[];
  processMonitors: ProcessMonitorRecord[];
} | null = null;
let eventPollSupplementInFlight: {
  workspaceId: string;
  promise: Promise<{ statusMonitor: WorkspaceMonitorStatus[]; processMonitors: ProcessMonitorRecord[] }>;
} | null = null;
let runnerUpdateQueue = Promise.resolve();
let duckDbUiAssetServer: ChildProcess | null = null;
let accountQuotaRefreshTimer: NodeJS.Timeout | null = null;
let accountQuotaRefreshInFlight = false;
let shuttingDown = false;

app.use("/api", createSecurity(resolve(dataDir, "security.json")));
app.use(express.json({ limit: "32mb" }));
app.use("/api/settings/auto-model", createAutoModelSettingsRouter(autoModelSettings));
app.use("/api/quick-chat", createQuickChatRouter(resolve(dataDir, "quick-chat-sessions.json")));
app.use(express.static(resolve(projectRoot, "dist"), { index: "index.html" }));

app.get("/api/browser-context/value-mappings", async (req, res) => {
  if (!isLoopbackClient(req)) {
    res.status(403).json({ error: "Browser context value mappings are local-only." });
    return;
  }
  try {
    res.json({ mappings: await localBrowserBridge.pageValueMappings() });
  } catch (error) {
    res.status(503).json({ error: errorMessage(error) });
  }
});

app.put("/api/browser-context/value-mappings", async (req, res) => {
  if (!isLoopbackClient(req)) {
    res.status(403).json({ error: "Browser context value mappings are local-only." });
    return;
  }
  try {
    const mappings = await localBrowserBridge.replacePageValueMappings(req.body?.mappings);
    res.json({ mappings });
  } catch (error) {
    const status = error instanceof LocalBrowserBridgeError && error.status === 400 ? 400 : 503;
    res.status(status).json({ error: errorMessage(error) });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/attachments/file", (req, res) => {
  const requestedPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
  if (!requestedPath) {
    res.status(400).json({ error: "path is required." });
    return;
  }

  const filePath = resolve(requestedPath.startsWith(uploadDir) ? requestedPath : resolve(uploadDir, requestedPath));
  if (!isPathInsideOrEqual(filePath, uploadDir)) {
    res.status(400).json({ error: "path must stay inside uploaded attachments." });
    return;
  }

  if (!existsSync(filePath)) {
    res.status(404).json({ error: "Attachment not found." });
    return;
  }

  const stat = statSync(filePath);
  if (!stat.isFile()) {
    res.status(400).json({ error: "path is not a file." });
    return;
  }

  res.setHeader("Content-Disposition", `inline; filename="${safeFileName(basename(filePath)).replace(/"/g, "_")}"`);
  res.sendFile(filePath);
});

app.post("/api/attachments/upload", async (req, res) => {
  const declaredSize = Number(req.header("x-attachment-size"));
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
    res.status(400).json({ error: "A valid attachment size is required." });
    return;
  }
  if (declaredSize > MAX_PATH_ATTACHMENT_BYTES) {
    res.status(413).json({ error: "Attachments uploaded by path are limited to 512 MB." });
    return;
  }

  const encodedName = req.header("x-attachment-name") ?? "";
  let decodedName = encodedName;
  try {
    decodedName = decodeURIComponent(encodedName);
  } catch {
    // Use the header verbatim; safeFileName still strips unsafe characters.
  }
  const name = safeFileName(decodedName || "attachment");
  const type = normalizeUploadedAttachmentMimeType(req.header("x-attachment-mime-type") ?? req.header("content-type") ?? "");
  const id = crypto.randomUUID();
  const relativePath = `staged/${id}/01-${name}`;
  const filePath = resolve(uploadDir, relativePath);
  let receivedSize = 0;

  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedSize += chunk.length;
        if (receivedSize > MAX_PATH_ATTACHMENT_BYTES) {
          callback(new Error("Attachments uploaded by path are limited to 512 MB."));
          return;
        }
        callback(null, chunk);
      }
    });
    await pipeline(req, limiter, createWriteStream(filePath, { flags: "wx" }));
    if (receivedSize !== declaredSize) {
      throw new Error("Uploaded file size did not match the selected file.");
    }
    res.status(201).json({
      attachment: {
        id,
        name,
        type,
        size: receivedSize,
        path: relativePath
      }
    });
  } catch (error) {
    rmSync(resolve(stagedAttachmentDir, id), { recursive: true, force: true });
    const message = errorMessage(error);
    res.status(message.includes("limited to 512 MB") ? 413 : 400).json({ error: message });
  }
});

app.get("/api/wait-events", async (_req, res) => {
  try {
    const workspace = await sessionStore.getActiveWorkspace();
    const events = await sessionStore.listWaitEvents({ workspaceId: workspace.id });
    const subscriptions = await sessionStore.listWaitSubscriptions({ workspaceId: workspace.id });
    const activeSubscriptions = subscriptions.filter((subscription) =>
      subscription.status === "waiting" || subscription.status === "dispatching" || subscription.status === "error"
    );
    const activeEventIds = new Set(activeSubscriptions.map((subscription) => subscription.eventId));
    res.json({
      events,
      subscriptions,
      pending: {
        events: events.filter((event) => activeEventIds.has(event.id)),
        subscriptions: activeSubscriptions
      }
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/wait-subscriptions", async (req: Request<object, object, WaitSubscriptionRequest>, res: Response) => {
  try {
    const eventId = req.body.eventId?.trim();
    const sessionId = req.body.sessionId?.trim();
    const actionType = req.body.actionType;
    if (!eventId || !sessionId || !actionType) {
      res.status(400).json({ error: "eventId, sessionId, and actionType are required." });
      return;
    }
    if (!(["retry_turn", "enqueue_prompt", "notify"] as const).includes(actionType)) {
      res.status(400).json({ error: "Unsupported wait subscription actionType." });
      return;
    }
    const turnId = req.body.turnId?.trim() || null;
    const actionPayload = readObject(req.body.actionPayload);
    if (actionType === "retry_turn" && !turnId) {
      res.status(400).json({ error: "retry_turn subscriptions require turnId." });
      return;
    }
    if (actionType === "enqueue_prompt" && !readString(actionPayload?.message)) {
      res.status(400).json({ error: "enqueue_prompt subscriptions require actionPayload.message." });
      return;
    }
    const workspace = await sessionStore.getActiveWorkspace();
    const [event, session] = await Promise.all([
      sessionStore.getWaitEvent(eventId),
      sessionStore.getSession(sessionId)
    ]);
    if (!event || event.workspaceId !== workspace.id) {
      res.status(404).json({ error: "Wait event not found." });
      return;
    }
    if (!session || session.workspaceId !== workspace.id) {
      res.status(404).json({ error: "Session not found." });
      return;
    }
    if (actionType === "retry_turn") {
      const turn = turnId ? await sessionStore.getSessionTurn(turnId) : null;
      if (!turn || turn.sessionId !== sessionId || turn.status !== "todo") {
        res.status(400).json({ error: "retry_turn requires a pending turn in the target session." });
        return;
      }
    }
    const subscription = await waitEvents.subscribe({
      eventId,
      workspaceId: workspace.id,
      sessionId,
      turnId,
      actionType,
      actionPayload: actionPayload ?? null
    });
    res.status(201).json({ event, subscription });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.patch("/api/wait-subscriptions/:subscriptionId", async (
  req: Request<{ subscriptionId: string }, object, WaitSubscriptionUpdateRequest>,
  res: Response
) => {
  const subscriptionId = req.params.subscriptionId.trim();
  const prompt = req.body.prompt?.trim();
  if (!subscriptionId || !prompt) {
    res.status(400).json({ error: "subscriptionId and prompt are required." });
    return;
  }
  try {
    const workspace = await sessionStore.getActiveWorkspace();
    const existing = await sessionStore.getWaitSubscription(subscriptionId);
    if (!existing || existing.workspaceId !== workspace.id) {
      res.status(404).json({ error: "Wait subscription not found." });
      return;
    }
    const subscription = await waitEvents.updateSubscriptionPrompt(subscriptionId, prompt);
    const turn = subscription.turnId ? await sessionStore.getSessionTurn(subscription.turnId) : null;
    res.json({ ok: true, subscription, turn });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.delete("/api/wait-subscriptions/:subscriptionId", async (
  req: Request<{ subscriptionId: string }>,
  res: Response
) => {
  const subscriptionId = req.params.subscriptionId.trim();
  if (!subscriptionId) {
    res.status(400).json({ error: "subscriptionId is required." });
    return;
  }
  try {
    const workspace = await sessionStore.getActiveWorkspace();
    const existing = await sessionStore.getWaitSubscription(subscriptionId);
    if (!existing || existing.workspaceId !== workspace.id) {
      res.status(404).json({ error: "Wait subscription not found." });
      return;
    }
    const subscription = await waitEvents.cancelSubscription(subscriptionId);
    res.json({ ok: true, cancelled: subscription.status === "cancelled", subscription });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.get("/api/process-monitors", async (_req, res) => {
  try {
    const workspace = await sessionStore.getActiveWorkspace();
    res.json({ processMonitors: await listProcessMonitors(workspace) });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/process-monitors/:monitorId/logs", async (req: Request<{ monitorId: string }>, res: Response) => {
  try {
    const workspace = await sessionStore.getActiveWorkspace();
    const rawTailBytes = typeof req.query.tailBytes === "string" ? Number(req.query.tailBytes) : undefined;
    if (rawTailBytes !== undefined && (!Number.isFinite(rawTailBytes) || rawTailBytes <= 0)) {
      res.status(400).json({ error: "tailBytes must be a positive number." });
      return;
    }
    const virtualMonitor = (await virtualProcessMonitors(workspace))
      .find(({ monitor }) => monitor.id === req.params.monitorId);
    if (virtualMonitor) {
      res.json({ log: readVirtualProcessLog(virtualMonitor.monitor, rawTailBytes) });
      return;
    }
    res.json({ log: await processMonitor.readLog(workspace.id, req.params.monitorId, rawTailBytes) });
  } catch (error) {
    const message = errorMessage(error);
    res.status(message === "Process monitor not found." ? 404 : 500).json({ error: message });
  }
});

app.post(
  "/api/process-monitors",
  async (req: Request<object, object, ProcessMonitorRequest>, res: Response) => {
    try {
      const workspace = await sessionStore.getActiveWorkspace();
      const request = req.body ?? {};
      let wakeSessionId = request.wakeSessionId?.trim() || request.sessionId?.trim() || null;
      let wakeThreadId = request.wakeThreadId?.trim() || request.threadId?.trim() || null;
      if (request.wakePrompt?.trim() && !wakeSessionId) {
        wakeSessionId = await sessionStore.getActiveSessionId();
      }
      if (request.wakePrompt?.trim() && wakeSessionId) {
        const wakeSession = await sessionStore.getSession(wakeSessionId);
        if (!wakeSession) {
          res.status(400).json({ error: "Wake-up session not found." });
          return;
        }
        wakeThreadId ??= wakeSession.threadId;
      }
      const monitor = await processMonitor.monitor(workspace, {
        ...request,
        wakeSessionId,
        wakeThreadId
      });
      const waitEvent = await ensureProcessExitEvent(monitor);
      await publishRingEvent({
        eventId: crypto.randomUUID(),
        type: "process.monitor.changed",
        workspaceId: workspace.id,
        sessionId: null,
        turnId: null,
        payload: { monitorId: monitor.id }
      });
      res.status(201).json({ monitor, waitEvent });
    } catch (error) {
      const message = errorMessage(error);
      res.status(message.includes("required") || message.includes("requires") || message.includes("exactly one") || message.includes("inside") || message.includes("between") || message.includes("session") || message.includes("entryPoint") || message.includes("dockerImage") || message.includes("Docker image") || message.includes("logFile") || message.includes("metrics") || message.includes("Metric") ? 400 : 500).json({ error: message });
    }
  }
);

app.post("/api/process-monitors/:monitorId/restart", async (req: Request<{ monitorId: string }>, res: Response) => {
  try {
    const workspace = await sessionStore.getActiveWorkspace();
    const virtualMonitor = (await virtualProcessMonitors(workspace))
      .find(({ monitor }) => monitor.id === req.params.monitorId);
    if (virtualMonitor) {
      if (!virtualMonitor.restartAction) {
        res.status(409).json({ error: "This externally supervised process has no restart control." });
        return;
      }
      res.once("finish", () => {
        void restartVirtualProcess(virtualMonitor.restartAction!);
      });
      res.status(202).json({ monitor: virtualMonitor.monitor, restarting: true });
      return;
    }
    const previousMonitor = await sessionStore.getProcessMonitor(req.params.monitorId);
    const monitor = await processMonitor.restart(workspace, req.params.monitorId);
    if (previousMonitor) await cancelProcessExitEvent(previousMonitor);
    const waitEvent = await ensureProcessExitEvent(monitor);
    await publishRingEvent({
      eventId: crypto.randomUUID(),
      type: "process.monitor.changed",
      workspaceId: workspace.id,
      sessionId: null,
      turnId: null,
      payload: { monitorId: monitor.id }
    });
    res.json({ monitor, waitEvent });
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.includes("not found") ? 404 : 409).json({ error: message });
  }
});

app.post(
  "/api/process-monitors/:monitorId/adopt",
  async (req: Request<{ monitorId: string }, object, AdoptProcessMonitorRequest>, res: Response) => {
    try {
      const workspace = await sessionStore.getActiveWorkspace();
      const previousMonitor = await sessionStore.getProcessMonitor(req.params.monitorId);
      const monitor = await processMonitor.adopt(workspace, req.params.monitorId, req.body ?? {} as AdoptProcessMonitorRequest);
      if (previousMonitor) await cancelProcessExitEvent(previousMonitor);
      const waitEvent = await ensureProcessExitEvent(monitor);
      await publishRingEvent({
        eventId: crypto.randomUUID(),
        type: "process.monitor.changed",
        workspaceId: workspace.id,
        sessionId: null,
        turnId: null,
        payload: { monitorId: monitor.id }
      });
      res.json({ monitor, waitEvent });
    } catch (error) {
      const message = errorMessage(error);
      res.status(message.includes("not found") ? 404 : 400).json({ error: message });
    }
  }
);

app.post("/api/process-monitors/:monitorId/stop", async (req: Request<{ monitorId: string }>, res: Response) => {
  try {
    const workspace = await sessionStore.getActiveWorkspace();
    const previousMonitor = await sessionStore.getProcessMonitor(req.params.monitorId);
    const monitor = await processMonitor.stopProcess(workspace.id, req.params.monitorId);
    if (previousMonitor) await cancelProcessExitEvent(previousMonitor);
    await publishRingEvent({
      eventId: crypto.randomUUID(),
      type: "process.monitor.changed",
      workspaceId: workspace.id,
      sessionId: null,
      turnId: null,
      payload: { monitorId: monitor.id }
    });
    res.json({ monitor });
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.includes("not found") ? 404 : 409).json({ error: message });
  }
});

app.delete("/api/process-monitors/:monitorId", async (req: Request<{ monitorId: string }>, res: Response) => {
  try {
    const workspace = await sessionStore.getActiveWorkspace();
    const monitor = await sessionStore.getProcessMonitor(req.params.monitorId);
    await processMonitor.remove(workspace.id, req.params.monitorId);
    if (monitor) await cancelProcessExitEvent(monitor);
    await publishRingEvent({
      eventId: crypto.randomUUID(),
      type: "process.monitor.changed",
      workspaceId: workspace.id,
      sessionId: null,
      turnId: null,
      payload: { monitorId: req.params.monitorId }
    });
    res.json({ ok: true });
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.includes("not found") ? 404 : 500).json({ error: message });
  }
});

app.get("/api/events", async (req, res) => {
  const after = Math.max(0, Number.parseInt(typeof req.query.after === "string" ? req.query.after : "0", 10) || 0);
  try {
    const workspace = await sessionStore.getActiveWorkspace();
    const oldestPos = eventRingLog.entries[0]?.pos ?? 0;
    const latestPos = eventRingLog.latestPosition;
    const resetRequired = after > 0 && (latestPos === 0 || after > latestPos || after < oldestPos - 1);
    const events = resetRequired
      ? []
      : eventRingLog.entries.filter((event) => event.pos > after && (!event.workspaceId || event.workspaceId === workspace.id));
    const supplement = await getEventPollSupplement(workspace);
    res.json({
      events,
      nextPos: latestPos,
      resetRequired,
      statusMonitor: supplement.statusMonitor,
      processMonitors: supplement.processMonitors,
      grillSummaries: await sessionStore.listGrillSummaries(workspace.id)
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/session-execution-statuses", async (_req, res) => {
  try {
    const workspace = await sessionStore.getActiveWorkspace();
    res.json({
      workspaceId: workspace.id,
      sessionExecutionStatuses: await sessionStore.listActiveSessionExecutionStatuses(workspace.id),
      pendingApprovalSessionIds: [...new Set(
        [...pendingApprovals.values()]
          .filter((approval) => approval.decision === undefined)
          .map((approval) => approval.sessionId)
      )]
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

async function getWorkspaceStatusMonitor(
  activeWorkspaceId: string,
  options: { releaseDeadRunningTurns?: boolean } = {}
): Promise<WorkspaceMonitorStatus[]> {
  if (options.releaseDeadRunningTurns !== false) {
    await releaseDeadRunningTurnsForDisplay("workspace_status_monitor");
  }
  const pending = [...pendingApprovals.values()]
    .filter((approval) => approval.decision === undefined);
  const pendingSessionIds = [...new Set(pending.map((approval) => approval.sessionId))];
  const approvalsBySessionId = new Map<string, WorkspaceMonitorApproval[]>();
  for (const approval of pending) {
    const approvals = approvalsBySessionId.get(approval.sessionId) ?? [];
    approvals.push(publicApprovalRecord(approval));
    approvalsBySessionId.set(approval.sessionId, approvals);
  }
  const [workspaces, monitoredSessions, pendingSessions] = await Promise.all([
    sessionStore.listWorkspaces(),
    sessionStore.listWorkspaceMonitorSessions(),
    Promise.all(pendingSessionIds.map((sessionId) => sessionStore.getSession(sessionId)))
  ]);
  const pendingSessionById = new Map(
    pendingSessions.flatMap((session) => session ? [[session.id, session] as const] : [])
  );

  return workspaces
    .filter((workspace) => workspace.id !== activeWorkspaceId)
    .map((workspace) => {
      const activeSessions = new Map<string, WorkspaceMonitorSession>();
      for (const session of monitoredSessions) {
        if (session.workspaceId !== workspace.id) continue;
        activeSessions.set(session.sessionId, {
          id: session.sessionId,
          name: session.sessionName,
          asking_approvals: approvalsBySessionId.get(session.sessionId) ?? []
        });
      }
      for (const sessionId of pendingSessionIds) {
        const session = pendingSessionById.get(sessionId);
        if (!session || session.workspaceId !== workspace.id || activeSessions.has(session.id)) continue;
        activeSessions.set(session.id, {
          id: session.id,
          name: session.title,
          asking_approvals: approvalsBySessionId.get(session.id) ?? []
        });
      }
      return {
        id: workspace.id,
        name: workspace.name,
        active_sessions: [...activeSessions.values()]
      };
    });
}

async function getEventPollSupplement(workspace: WorkspaceRecord) {
  const now = Date.now();
  if (
    eventPollSupplementCache?.workspaceId === workspace.id &&
    eventPollSupplementCache.expiresAt > now
  ) {
    return eventPollSupplementCache;
  }
  if (eventPollSupplementInFlight?.workspaceId === workspace.id) {
    return eventPollSupplementInFlight.promise;
  }

  const promise = Promise.all([
    getWorkspaceStatusMonitor(workspace.id, { releaseDeadRunningTurns: false }),
    listProcessMonitors(workspace)
  ]).then(([statusMonitor, processMonitors]) => {
    const value = { statusMonitor, processMonitors };
    eventPollSupplementCache = {
      workspaceId: workspace.id,
      expiresAt: Date.now() + 1_000,
      ...value
    };
    return value;
  });
  eventPollSupplementInFlight = { workspaceId: workspace.id, promise };
  try {
    return await promise;
  } finally {
    if (eventPollSupplementInFlight?.promise === promise) eventPollSupplementInFlight = null;
  }
}

app.post("/api/sql", async (req: Request<object, object, SqlQueryRequest>, res: Response) => {
  try {
    res.json(
      await sessionStore.runSqlQuery({
        sql: req.body.sql ?? "",
        params: req.body.params,
        limit: req.body.limit
      })
    );
  } catch (error) {
    const message = errorMessage(error);
    res.status(isSqlQueryClientError(message) ? 400 : 500).json({
      error: message
    });
  }
});

app.post("/api/maintenance/session-updated/backfill", async (_req, res) => {
  try {
    res.json({
      ok: true,
      ...(await sessionStore.backfillSessionUpdatedFromLastTurn())
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/maintenance/sessions/cwd", async (
  req: Request<object, object, SessionCwdMigrationRequest>,
  res: Response
) => {
  const threadIds = [...new Set(
    (Array.isArray(req.body.threadIds) ? req.body.threadIds : [])
      .map((threadId) => typeof threadId === "string" ? threadId.trim() : "")
      .filter(Boolean)
  )];
  if (threadIds.length === 0) {
    res.status(400).json({ error: "threadIds is required." });
    return;
  }
  if (threadIds.length > 200) {
    res.status(400).json({ error: "threadIds supports at most 200 threads per request." });
    return;
  }

  const requestedCwd = req.body.cwd?.trim();
  if (!requestedCwd) {
    res.status(400).json({ error: "cwd is required." });
    return;
  }
  const cwd = resolveUserPath(requestedCwd);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    res.status(400).json({ error: "cwd must be an existing directory." });
    return;
  }

  try {
    const workspace = await getRequestedOrActiveWorkspace(req.body.workspaceId);
    const sessions = await Promise.all(threadIds.map((threadId) =>
      sessionStore.resolveSession({ threadId, workspaceId: workspace.id })
    ));
    const missingThreadIds = threadIds.filter((threadId, index) => !sessions[index]);
    if (missingThreadIds.length > 0 && req.body.allowMissing !== true) {
      res.status(404).json({ error: "One or more threads were not found in the requested workspace.", missingThreadIds });
      return;
    }
    const resolvedSessions = sessions.filter((session): session is SessionRecord => session !== null);
    const runningSessionIds = (await Promise.all(resolvedSessions.map(async (session) =>
      (await sessionStore.getLatestRunningTurn(session.id)) ? session.id : null
    ))).filter((sessionId): sessionId is string => sessionId !== null);
    if (runningSessionIds.length > 0) {
      res.status(409).json({ error: "Cannot change cwd while a session has a running turn.", runningSessionIds });
      return;
    }

    for (const session of resolvedSessions) {
      await sessionStore.upsertSession({ id: session.id, cwd });
      await publishRingEvent({
        eventId: crypto.randomUUID(),
        type: "session.cwd.updated",
        workspaceId: session.workspaceId,
        sessionId: session.id,
        turnId: null,
        payload: { cwd }
      });
    }

    res.json({
      ok: true,
      workspaceId: workspace.id,
      cwd,
      sessionIds: resolvedSessions.map((session) => session.id),
      missingThreadIds
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/workspace/snapshot", async (_req, res) => {
  try {
    res.json(await getWorkspaceSnapshot());
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get(["/api/sessions", "/api/sessions/list"], async (req, res) => {
  const offset = Math.max(0, Number.parseInt(typeof req.query.offset === "string" ? req.query.offset : "0", 10) || 0);
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const projectCwd = typeof req.query.cwd === "string" ? req.query.cwd : null;
  const requestedLimit = Number.parseInt(typeof req.query.limit === "string" ? req.query.limit : "20", 10) || 20;
  const limit = query ? Math.min(100, Math.max(1, requestedLimit)) : 20;
  try {
    const workspace = await sessionStore.getActiveWorkspace();
    if (!query && projectCwd === null) {
      const projectPage = await sessionStore.listSessionsByProjectPage(workspace.id, limit);
      res.json({
        sessions: projectPage.sessions.map(toSessionListResponse),
        page: {
          offset: 0,
          limit,
          hasMore: projectPage.projects.some((project) => project.hasMore),
          total: projectPage.projects.reduce((total, project) => total + project.total, 0),
          nextOffset: null,
          projects: projectPage.projects.map(({ cwd, offset, limit: projectLimit, hasMore, total, nextOffset }) => ({
            cwd,
            offset,
            limit: projectLimit,
            hasMore,
            total,
            nextOffset
          }))
        }
      });
      return;
    }
    const page = await sessionStore.listSessionsPage(workspace.id, offset, limit, query, projectCwd);
    res.json({
      sessions: page.sessions.map(toSessionListResponse),
      page: {
        offset,
        limit,
        hasMore: page.hasMore,
        total: page.total,
        nextOffset: page.nextOffset
      }
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

function toSessionListResponse(session: SessionRecord) {
  return {
    ...session,
    name: session.title,
    turnCount: session.turnCount ?? 0,
    tokenCount: session.tokenCount ?? 0,
    time: session.updated
  };
}

app.get("/api/sessions/resolve-reference", async (req, res) => {
  const target = typeof req.query.target === "string" ? req.query.target.trim() : "";
  const requestedWorkspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId.trim() : "";
  if (!target || target.length > 200) {
    res.status(400).json({ error: "A valid target is required." });
    return;
  }
  if (requestedWorkspaceId.length > 200) {
    res.status(400).json({ error: "A valid workspaceId is required." });
    return;
  }

  try {
    const workspaceId = normalizeWorkspaceId(requestedWorkspaceId) || (await sessionStore.getActiveWorkspace()).id;
    const session = await sessionStore.resolveSession(
      target.startsWith("local_")
        ? { sessionId: target, workspaceId }
        : { threadId: target, workspaceId }
    );
    if (!session) {
      res.status(404).json({ error: "Session not found." });
      return;
    }
    res.json({ session });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/sessions/:sessionId/children", async (
  req: Request<{ sessionId: string }>,
  res: Response
) => {
  try {
    const session = await sessionStore.getSession(req.params.sessionId.trim());
    if (!session) {
      res.status(404).json({ error: "Session not found." });
      return;
    }
    const children = (await sessionStore.listSessions(session.workspaceId))
      .filter((candidate) => candidate.parentSessionId === session.id)
      .map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        parentSessionId: candidate.parentSessionId,
        created: candidate.created,
        updated: candidate.updated
      }));
    res.json({ sessionId: session.id, children });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/link-preview", async (req, res) => {
  const rawUrl = typeof req.query.url === "string" ? req.query.url.trim() : "";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    res.status(400).json({ error: "A valid URL is required." });
    return;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || rawUrl.length > 2_000) {
    res.status(400).json({ error: "Only public HTTP(S) URLs are supported." });
    return;
  }

  try {
    const response = await fetch(url, {
      headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "Threadex link preview" },
      redirect: "follow",
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) {
      res.status(502).json({ error: `Link returned HTTP ${response.status}.` });
      return;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/html|xhtml/i.test(contentType)) {
      res.json({ title: url.hostname, url: url.href });
      return;
    }
    const html = await readLinkPreviewBody(response, 256 * 1024);
    const title = extractLinkPreviewTitle(html) || url.hostname;
    res.json({ title, url: url.href });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Could not fetch link title." });
  }
});

app.get("/api/sessions/:sessionId/snapshot", async (req: Request<{ sessionId: string }>, res: Response) => {
  try {
    const session = await sessionStore.getSession(req.params.sessionId.trim());
    if (!session) {
      res.status(404).json({ error: "Session not found." });
      return;
    }
    res.json(await getSessionSnapshot(session));
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/sessions/:sessionId/subagents/:threadId/transcript", async (
  req: Request<{ sessionId: string; threadId: string }>,
  res: Response
) => {
  const requestedSessionId = req.params.sessionId.trim();
  const requestedThreadId = req.params.threadId.trim();
  if (!isSafeTranscriptIdentifier(requestedSessionId) || !isSafeTranscriptIdentifier(requestedThreadId)) {
    res.status(400).json({ error: "A valid sessionId and threadId are required." });
    return;
  }

  try {
    const session = await getSessionForRequestedId(requestedSessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found." });
      return;
    }
    if (!session.threadId) {
      res.status(409).json({ error: "Session has no Codex thread." });
      return;
    }
    const workspace = await sessionStore.getWorkspace(session.workspaceId);
    if (!workspace) {
      res.status(404).json({ error: `Workspace not found: ${session.workspaceId}` });
      return;
    }

    let threadReadResult: unknown;
    let belongsToSession: boolean;
    try {
      threadReadResult = await runCodexAppServerRequest(
        workspace,
        "thread/read",
        { threadId: requestedThreadId, includeTurns: true }
      );
      if (!readAppServerThread(threadReadResult)) {
        res.status(404).json({ error: "Subagent thread not found." });
        return;
      }
      belongsToSession = await subagentThreadBelongsToRoot({
        rootThreadId: session.threadId,
        requestedThreadId,
        requestedThreadResult: threadReadResult,
        readThread: (threadId) => runCodexAppServerRequest(
          workspace,
          "thread/read",
          { threadId, includeTurns: false }
        )
      });
    } catch (error) {
      const message = errorMessage(error);
      res.status(/not found|unknown thread|no such thread/i.test(message) ? 404 : 502).json({ error: message });
      return;
    }

    if (!belongsToSession) {
      res.status(403).json({ error: "Subagent thread does not belong to this session." });
      return;
    }

    const liveItemsByTurn = await sessionStore.listSessionLiveItems(session.id);
    res.json(normalizeSubagentTranscript({
      sessionId: session.id,
      threadId: requestedThreadId,
      threadReadResult,
      liveItemsByTurn
    }));
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/sessions/:sessionId/achieve", async (req: Request<{ sessionId: string }>, res: Response) => {
  try {
    const sessionId = await resolveRequestedSessionId(req.params.sessionId.trim());
    const session = await sessionStore.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found." });
      return;
    }
    if (!session.threadId) {
      res.status(409).json({ error: "Session has no Codex thread to achieve." });
      return;
    }
    if (await sessionStore.getLatestRunningTurn(session.id)) {
      res.status(409).json({ error: "Session is currently running." });
      return;
    }

    const workspace = await sessionStore.getWorkspace(session.workspaceId);
    if (!workspace) {
      res.status(404).json({ error: `Workspace not found: ${session.workspaceId}` });
      return;
    }

    await runCodexAppServerRequest(workspace, "thread/goal/clear", { threadId: session.threadId });
    const achievedSession = await sessionStore.markSessionAchieved(session.id);
    res.json({ ok: true, session: achievedSession, sessionId: session.id, threadId: session.threadId });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/workspaces", async (_req, res) => {
  try {
    res.json({
      workspaces: await sessionStore.listWorkspaces(),
      activeWorkspace: await sessionStore.getActiveWorkspace()
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/workspaces/projects", async (req, res) => {
  try {
    const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId.trim() : "";
    const workspace = await getRequestedOrActiveWorkspace(workspaceId || undefined);
    res.json({
      workspaceId: workspace.id,
      projects: listCodexProjects(workspace.codexHome).map(({ id, name }) => ({ id, name }))
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/profile-analytics", async (req, res) => {
  try {
    const workspace = await getRequestedOrActiveWorkspace(req.query.workspaceId);
    const requestedAccountId = typeof req.query.accountId === "string" ? req.query.accountId.trim() : "";
    if (requestedAccountId && !(await sessionStore.getAccount(requestedAccountId))) {
      res.status(400).json({ error: "The selected account does not exist." });
      return;
    }

    const accounts = await sessionStore.listAccounts();
    const params = {
      workspaceId: workspace.id,
      accountId: requestedAccountId,
      existingAccountIds: JSON.stringify(accounts.map((account) => account.id))
    };
    const turnUsageCte = `
      WITH saved_accounts AS (
        SELECT value AS account_id
        FROM json_array_elements_text($existingAccountIds::JSON) AS saved_account(value)
      ),
      turn_usage AS (
        SELECT
          turn.id AS turn_id,
          turn.session_id,
          coalesce(turn.account_id, max(usage.account_id)) AS account_id,
          turn.created AS started_at,
          coalesce((
            SELECT max(
              CASE
                WHEN json_extract_string(event.payload, '$.elapsedMs') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                  THEN CAST(json_extract_string(event.payload, '$.elapsedMs') AS DOUBLE PRECISION) / 1000.0
                ELSE NULL
              END
            )
            FROM session_turn_event AS event
            WHERE event.turn_id = turn.id AND event.event_name = 'result'
          ), 0) AS duration_seconds,
          coalesce(
            lower(replace(max(usage.model) FILTER (WHERE usage.model IS NOT NULL AND usage.model <> ''), ' ', '-')),
            'Unknown'
          ) AS model,
          coalesce(
            max(usage.total_tokens) FILTER (WHERE usage.source = 'app_server'),
            max(usage.total_tokens) FILTER (WHERE usage.source = 'codex_exec'),
            max(usage.total_tokens) FILTER (WHERE usage.source = 'native_token_count'),
            max(usage.total_tokens) FILTER (WHERE usage.source = 'turn_final'),
            turn.token_in + turn.token_out,
            0
          ) AS tokens,
          coalesce(
            max(usage.input_tokens) FILTER (WHERE usage.source = 'app_server'),
            max(usage.input_tokens) FILTER (WHERE usage.source = 'codex_exec'),
            max(usage.input_tokens) FILTER (WHERE usage.source = 'native_token_count'),
            max(usage.input_tokens) FILTER (WHERE usage.source = 'turn_final'),
            turn.token_in,
            0
          ) AS input_tokens,
          coalesce(
            max(usage.cached_input_tokens) FILTER (WHERE usage.source = 'app_server'),
            max(usage.cached_input_tokens) FILTER (WHERE usage.source = 'codex_exec'),
            max(usage.cached_input_tokens) FILTER (WHERE usage.source = 'native_token_count'),
            max(usage.cached_input_tokens) FILTER (WHERE usage.source = 'turn_final'),
            0
          ) AS cached_input_tokens,
          coalesce(
            max(usage.output_tokens) FILTER (WHERE usage.source = 'app_server'),
            max(usage.output_tokens) FILTER (WHERE usage.source = 'codex_exec'),
            max(usage.output_tokens) FILTER (WHERE usage.source = 'native_token_count'),
            max(usage.output_tokens) FILTER (WHERE usage.source = 'turn_final'),
            turn.token_out,
            0
          ) AS output_tokens
        FROM session_turn AS turn
        JOIN sessions AS session ON session.id = turn.session_id
        LEFT JOIN token_usage AS usage ON usage.turn_id = turn.id AND usage.usage_type = 'agent'
        WHERE session.workspace_id = $workspaceId
        GROUP BY turn.id, turn.session_id, turn.account_id, turn.created, turn.token_in, turn.token_out
      ),
      filtered_usage AS (
        SELECT * FROM turn_usage
        WHERE ($accountId = '' OR account_id = $accountId)
          AND (
            turn_usage.account_id IS NULL
            OR turn_usage.account_id IN (SELECT account_id FROM saved_accounts)
          )
      )
    `;

    const [summaryResult, activityResult, trendResult, reasoningResult, skillResult] = await Promise.all([
      sessionStore.runSqlQuery({
        sql: `${turnUsageCte}
          SELECT
            coalesce(sum(tokens), 0) AS lifetime_tokens,
            count(*) AS total_tasks,
            count(DISTINCT session_id) AS total_sessions,
            count(DISTINCT CAST(started_at AS DATE)) AS active_days,
            coalesce((SELECT max(day_tokens) FROM (
              SELECT sum(tokens) AS day_tokens FROM filtered_usage GROUP BY CAST(started_at AS DATE)
            )), 0) AS peak_tokens,
            coalesce(max(duration_seconds), 0) AS longest_task_seconds,
            count(DISTINCT model) FILTER (WHERE model <> 'Unknown') AS models_used
          FROM filtered_usage`,
        params,
        limit: 1
      }),
      sessionStore.runSqlQuery({
        sql: `${turnUsageCte}
          SELECT
            to_char(CAST(started_at AS DATE), 'YYYY-MM-DD') AS date,
            sum(tokens) AS tokens,
            count(*) AS tasks
          FROM filtered_usage
          WHERE CAST(started_at AS DATE) >= current_date - INTERVAL '364 days'
          GROUP BY CAST(started_at AS DATE)
          ORDER BY CAST(started_at AS DATE)`,
        params,
        limit: 400
      }),
      sessionStore.runSqlQuery({
        sql: `${turnUsageCte}, daily_model AS (
            SELECT
              CAST(started_at AS DATE) AS day,
              model,
              sum(tokens) AS tokens,
              sum(input_tokens) AS input_tokens,
              sum(cached_input_tokens) AS cached_input_tokens,
              sum(output_tokens) AS output_tokens
            FROM filtered_usage
            WHERE CAST(started_at AS DATE) >= current_date - INTERVAL '9 days'
              AND model <> 'Unknown'
            GROUP BY CAST(started_at AS DATE), model
            UNION ALL
            SELECT
              CAST(coalesce(usage.source_timestamp, usage.created) AS DATE) AS day,
              'Summarizer · ' || coalesce(usage.model, 'unknown') AS model,
              sum(usage.total_tokens) AS tokens,
              sum(usage.input_tokens) AS input_tokens,
              sum(usage.cached_input_tokens) AS cached_input_tokens,
              sum(usage.output_tokens) AS output_tokens
            FROM token_usage AS usage
            JOIN sessions AS session ON session.id = usage.session_id
            WHERE usage.usage_type = 'summarizer'
              AND session.workspace_id = $workspaceId
              AND ($accountId = '' OR usage.account_id = $accountId)
              AND (
                usage.account_id IS NULL
                OR usage.account_id IN (SELECT account_id FROM saved_accounts)
              )
              AND CAST(coalesce(usage.source_timestamp, usage.created) AS DATE) >= current_date - INTERVAL '9 days'
            GROUP BY CAST(coalesce(usage.source_timestamp, usage.created) AS DATE), usage.model
            UNION ALL
            SELECT
              CAST(coalesce(usage.source_timestamp, usage.created) AS DATE) AS day,
              CASE coalesce(json_extract_string(usage.metadata, '$.task'), '')
                WHEN 'commentary_headline' THEN 'Commentary'
                WHEN 'session_question' THEN 'Session question'
                WHEN 'keyword_router' THEN 'Keyword router'
                WHEN 'session_router' THEN 'Session router'
                ELSE 'Background'
              END || ' · ' || coalesce(usage.model, 'unknown') AS model,
              sum(usage.total_tokens) AS tokens,
              sum(usage.input_tokens) AS input_tokens,
              sum(usage.cached_input_tokens) AS cached_input_tokens,
              sum(usage.output_tokens) AS output_tokens
            FROM token_usage AS usage
            WHERE usage.usage_type = 'background'
              AND usage.workspace_id = $workspaceId
              AND ($accountId = '' OR usage.account_id = $accountId)
              AND (
                usage.account_id IS NULL
                OR usage.account_id IN (SELECT account_id FROM saved_accounts)
              )
              AND CAST(coalesce(usage.source_timestamp, usage.created) AS DATE) >= current_date - INTERVAL '9 days'
            GROUP BY
              CAST(coalesce(usage.source_timestamp, usage.created) AS DATE),
              coalesce(json_extract_string(usage.metadata, '$.task'), ''),
              usage.model
          ), dates AS (
            SELECT CAST(value AS DATE) AS day
            FROM generate_series(
              current_date - INTERVAL '9 days',
              current_date,
              INTERVAL '1 day'
            ) AS series(value)
          ), models AS (
            SELECT DISTINCT model FROM daily_model
          )
          SELECT
            to_char(dates.day, 'YYYY-MM-DD') AS date,
            models.model,
            coalesce(daily_model.tokens, 0) AS tokens,
            coalesce(daily_model.input_tokens, 0) AS input_tokens,
            coalesce(daily_model.cached_input_tokens, 0) AS cached_input_tokens,
            coalesce(daily_model.output_tokens, 0) AS output_tokens
          FROM dates
          CROSS JOIN models
          LEFT JOIN daily_model
            ON daily_model.day = dates.day
            AND daily_model.model = models.model
          ORDER BY dates.day, tokens DESC, models.model`,
        params,
        limit: 500
      }),
      sessionStore.runSqlQuery({
        sql: `
          SELECT
            coalesce(json_extract_string(usage.metadata, '$.reasoningEffort'), 'default') AS effort,
            count(*) AS uses
          FROM token_usage AS usage
          JOIN session_turn AS turn ON turn.id = usage.turn_id
          JOIN sessions AS session ON session.id = turn.session_id
          WHERE json_extract_string(usage.metadata, '$.reasoningEffort') IS NOT NULL
            AND session.workspace_id = $workspaceId
            AND ($accountId = '' OR coalesce(usage.account_id, turn.account_id) = $accountId)
            AND (
              coalesce(usage.account_id, turn.account_id) IS NULL
              OR coalesce(usage.account_id, turn.account_id) IN (
                SELECT value
                FROM json_array_elements_text($existingAccountIds::JSON) AS saved_account(value)
              )
            )
          GROUP BY effort
          ORDER BY uses DESC, effort
        `,
        params,
        limit: 20
      }),
      sessionStore.runSqlQuery({
        sql: `
          SELECT skill.value AS name, count(*) AS uses
          FROM token_usage AS usage
          JOIN session_turn AS turn ON turn.id = usage.turn_id
          JOIN sessions AS session ON session.id = turn.session_id
          CROSS JOIN LATERAL json_array_elements_text(
            CASE
              WHEN json_typeof(usage.metadata -> 'skills') = 'array' THEN usage.metadata -> 'skills'
              ELSE '[]'::JSON
            END
          ) AS skill(value)
          WHERE json_extract(usage.metadata, '$.skills') IS NOT NULL
            AND session.workspace_id = $workspaceId
            AND ($accountId = '' OR coalesce(usage.account_id, turn.account_id) = $accountId)
            AND (
              coalesce(usage.account_id, turn.account_id) IS NULL
              OR coalesce(usage.account_id, turn.account_id) IN (
                SELECT value
                FROM json_array_elements_text($existingAccountIds::JSON) AS saved_account(value)
              )
            )
          GROUP BY name
          ORDER BY uses DESC, name
        `,
        params,
        limit: 50
      })
    ]);

    res.json({
      workspace,
      accountId: requestedAccountId || null,
      accounts: accounts.map((account) => ({
        id: account.id,
        name: account.name,
        email: account.email,
        externalAccountId: account.externalAccountId
      })),
      summary: summaryResult.rows[0] ?? {},
      activity: activityResult.rows,
      trend: trendResult.rows,
      reasoning: reasoningResult.rows,
      skills: skillResult.rows
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/skills", async (req, res) => {
  try {
    const workspace = await getRequestedOrActiveWorkspace(req.query.workspaceId);
    const extraRoots = skillExtraRoots(workspace);
    const result = await runCodexAppServerRequest(
      workspace,
      "skills/list",
      { cwds: [workspace.cwd], forceReload: true },
      extraRoots.length > 0
        ? [{ method: "skills/extraRoots/set", params: { extraRoots } }]
        : []
    );
    const skills = normalizeSkillsListResult(result);
    listedSkillsByWorkspace.set(
      workspace.id,
      skills.map(({ name, path }) => ({ name, path }))
    );
    res.json({ skills });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/composer-suggestions", async (req, res) => {
  try {
    const requestedSessionId = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
    const requestedProjectId = typeof req.query.projectId === "string" ? req.query.projectId.trim() : "";
    if (!requestedSessionId && !requestedProjectId) {
      res.json({ cwd: null, entries: [] });
      return;
    }
    const workspace = await getRequestedOrActiveWorkspace(req.query.workspaceId);
    const session = requestedSessionId ? await sessionStore.getSession(requestedSessionId) : null;
    if (requestedSessionId && !session) {
      res.status(404).json({ error: "Session not found." });
      return;
    }
    if (session && session.workspaceId !== workspace.id) {
      res.status(400).json({ error: "Session must belong to the requested workspace." });
      return;
    }
    const cwd = session?.cwd ?? resolveCodexProjectCwd(workspace.codexHome, requestedProjectId);
    if (!cwd) {
      res.status(400).json({ error: "Project must be registered in the requested workspace's CODEX_HOME." });
      return;
    }
    const entries = readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => ({
        name: entry.name,
        path: entry.name,
        kind: entry.isDirectory() ? "directory" : "file"
      }))
      .sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name))
      .slice(0, 250);
    res.json({ cwd, entries });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/composer-suggestion-keywords", async (req, res) => {
  try {
    const workspace = await getRequestedOrActiveWorkspace(req.query.workspaceId);
    res.json({
      workspaceId: workspace.id,
      keywords: await sessionStore.listComposerSuggestionKeywords(workspace.id)
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/composer-suggestion-keywords", async (
  req: Request<object, object, ComposerSuggestionKeywordRequest>,
  res: Response
) => {
  const values = Array.isArray(req.body.keywords)
    ? req.body.keywords
    : typeof req.body.keyword === "string"
      ? [req.body.keyword]
      : [];
  if (values.length === 0) {
    res.status(400).json({ error: "keyword or keywords is required." });
    return;
  }
  try {
    const workspace = await getRequestedOrActiveWorkspace(req.body.workspaceId);
    res.json({
      workspaceId: workspace.id,
      keywords: await sessionStore.addComposerSuggestionKeywords(workspace.id, values)
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.put("/api/composer-suggestion-keywords", async (
  req: Request<object, object, ComposerSuggestionKeywordRequest>,
  res: Response
) => {
  if (!Array.isArray(req.body.keywords)) {
    res.status(400).json({ error: "keywords must be an array." });
    return;
  }
  try {
    const workspace = await getRequestedOrActiveWorkspace(req.body.workspaceId);
    res.json({
      workspaceId: workspace.id,
      keywords: await sessionStore.replaceComposerSuggestionKeywords(workspace.id, req.body.keywords)
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.delete("/api/composer-suggestion-keywords/:keyword", async (req, res) => {
  const keyword = req.params.keyword?.trim();
  if (!keyword) {
    res.status(400).json({ error: "keyword is required." });
    return;
  }
  try {
    const workspace = await getRequestedOrActiveWorkspace(req.query.workspaceId);
    res.json({
      workspaceId: workspace.id,
      keywords: await sessionStore.removeComposerSuggestionKeyword(workspace.id, keyword)
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/workspaces/file-preview", async (req, res) => {
  const requestedPath = typeof req.query.path === "string" ? req.query.path : "";
  const requestedSessionId = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
  if (!requestedPath.trim()) {
    res.status(400).json({ error: "path is required." });
    return;
  }

  try {
    const requestedWorkspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined;
    const workspace = await getRequestedOrActiveWorkspace(requestedWorkspaceId);
    const session = requestedSessionId ? await sessionStore.getSession(requestedSessionId) : null;
    if (requestedSessionId && (!session || session.workspaceId !== workspace.id)) {
      res.status(404).json({ error: "Session not found in the requested workspace." });
      return;
    }

    // User file links can point anywhere the server's OS account can read.
    const filePath = resolve(session?.cwd ?? workspace.cwd, requestedPath);

    if (!existsSync(filePath)) {
      res.json({ path: requestedPath, exists: false, text: "" });
      return;
    }

    const stats = statSync(filePath);
    if (!stats.isFile()) {
      res.status(400).json({ error: "path is not a file." });
      return;
    }

    const maxPreviewBytes = 8 * 1024 * 1024;
    if (stats.size > maxPreviewBytes) {
      res.status(413).json({ error: "file is too large to preview." });
      return;
    }

    res.json({ path: requestedPath, exists: true, text: readFileSync(filePath, "utf8") });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/sessions/:sessionId/web-vscode-url", async (req, res) => {
  try {
    const workspace = await sessionStore.getActiveWorkspace();
    const session = await sessionStore.getSession(req.params.sessionId);
    if (!session || session.workspaceId !== workspace.id) {
      res.status(404).json({ error: "Session not found in the active workspace." });
      return;
    }

    const defaultPort = Number(process.env.WEB_VSCODE_PORT ?? 8790);
    const targetUrl = new URL(process.env.WEB_VSCODE_URL?.trim() || `http://127.0.0.1:${defaultPort}/`);
    targetUrl.searchParams.set("folder", session.cwd);
    createWebVsCodeAnnotationSession({
      dataDir,
      sessionId: session.id,
      cwd: session.cwd,
      returnUrl: normalizeThreadexReturnUrl(req.query.returnUrl, req)
    });
    const requestedPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
    if (requestedPath) {
      const filePath = resolveWorkspaceFilePath(session.cwd, requestedPath);
      if (!filePath) {
        res.status(400).json({ error: "path must stay inside the session project." });
        return;
      }
      targetUrl.searchParams.set("payload", JSON.stringify([
        ["gotoLineMode", "true"],
        ["openFile", `vscode-remote://${targetUrl.host}${filePath}`]
      ]));
    }
    res.json({ url: targetUrl.toString() });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/sessions/:sessionId/file-changes", async (req, res) => {
  try {
    const workspace = await sessionStore.getActiveWorkspace();
    const session = await sessionStore.getSession(req.params.sessionId);
    if (!session || session.workspaceId !== workspace.id) {
      res.status(404).json({ error: "Session not found in the active workspace." });
      return;
    }
    const [turns, liveItemsByTurn] = await Promise.all([
      sessionStore.listSessionTurns(session.id),
      sessionStore.listSessionLiveItems(session.id)
    ]);
    const summary = summarizeSessionFileChanges(turns, liveItemsByTurn);
    res.json({ fileChanges: summary.files, totals: summary.totals });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/sessions/:sessionId/file-change", async (req, res) => {
  try {
    const workspace = await sessionStore.getActiveWorkspace();
    const session = await sessionStore.getSession(req.params.sessionId);
    if (!session || session.workspaceId !== workspace.id) {
      res.status(404).json({ error: "Session not found in the active workspace." });
      return;
    }
    const requestedPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
    if (!requestedPath) {
      res.status(400).json({ error: "path is required." });
      return;
    }

    const liveItemsByTurn = await sessionStore.listSessionLiveItems(session.id);
    let matchedChange: Record<string, unknown> | null = null;
    for (const items of Object.values(liveItemsByTurn)) {
      for (const candidate of items) {
        const item = readObject(candidate);
        if (!item || item.itemType !== "file_change" || !Array.isArray(item.changes)) continue;
        for (const candidateChange of item.changes) {
          const change = readObject(candidateChange);
          if (typeof change?.path === "string" && change.path.trim() === requestedPath) matchedChange = change;
        }
      }
    }
    if (!matchedChange) {
      res.status(404).json({ error: "File change not found in this session." });
      return;
    }

    const change: Record<string, string> = {
      path: requestedPath,
      kind: typeof matchedChange.kind === "string" ? matchedChange.kind : "update"
    };
    for (const field of ["before", "after", "beforeText", "afterText", "beforeContent", "afterContent", "oldContent", "newContent", "previousContent", "currentContent", "original", "updated", "diff", "patch", "unifiedDiff"]) {
      if (typeof matchedChange[field] === "string") change[field] = matchedChange[field];
    }
    res.json({ change });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/sessions/:sessionId/web-vscode-review", async (req, res) => {
  try {
    const workspace = await sessionStore.getActiveWorkspace();
    const session = await sessionStore.getSession(req.params.sessionId);
    if (!session || session.workspaceId !== workspace.id) {
      res.status(404).json({ error: "Session not found in the active workspace." });
      return;
    }
    const scope = req.body?.scope === "session" ? "session" : "turn";
    const changes = Array.isArray(req.body?.changes) ? req.body.changes.slice(0, 250) : [];
    const turnId = typeof req.body?.turnId === "string" ? req.body.turnId.trim() : "";
    const liveItemsByTurn = turnId || scope === "session" ? await sessionStore.listSessionLiveItems(session.id) : {};
    const savedChanges = scope === "session"
      ? collectSessionReviewChanges(liveItemsByTurn)
      : collectTurnReviewChanges(liveItemsByTurn[turnId] ?? []);
    const reviewChanges = savedChanges.length > 0 ? savedChanges : changes;
    if (reviewChanges.length === 0) {
      res.status(400).json({ error: scope === "session" ? "This session does not have reviewable file changes." : "At least one file change is required." });
      return;
    }
    const review = createWebVsCodeReviewSession({
      dataDir,
      sessionId: session.id,
      turnId: scope === "session" ? "" : turnId,
      cwd: session.cwd,
      changes: reviewChanges,
      scope,
      returnUrl: normalizeThreadexReturnUrl(req.body?.returnUrl, req),
      // Absolute paths outside the session cwd are accepted only when they
      // came from runner events already saved by Threadex, never from the
      // browser request fallback.
      allowExternalPaths: savedChanges.length > 0
    });
    if (!review) {
      res.status(400).json({ error: scope === "session" ? "This session did not include reviewable file content." : "The turn did not include reviewable file content." });
      return;
    }

    const defaultPort = Number(process.env.WEB_VSCODE_PORT ?? 8790);
    const targetUrl = new URL(process.env.WEB_VSCODE_URL?.trim() || `http://127.0.0.1:${defaultPort}/`);
    targetUrl.searchParams.set("folder", review.workspacePath);
    if (review.firstOpenPath) {
      const firstOpenFile = resolveWorkspaceFilePath(review.workspacePath, review.firstOpenPath);
      if (firstOpenFile) {
        targetUrl.searchParams.set("payload", JSON.stringify([
          ["gotoLineMode", "true"],
          ["openFile", `vscode-remote://${targetUrl.host}${firstOpenFile}`]
        ]));
      }
    }
    res.json({
      url: targetUrl.toString(),
      fileCount: review.fileCount,
      reviewRequestId: review.requestId
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/sessions/:sessionId/web-vscode-walkthrough", async (req, res) => {
  try {
    const workspace = await sessionStore.getActiveWorkspace();
    const session = await sessionStore.getSession(req.params.sessionId);
    if (!session || session.workspaceId !== workspace.id) {
      res.status(404).json({ error: "Session not found in the active workspace." });
      return;
    }
    const walkthrough = createWebVsCodeWalkthroughSession({
      dataDir,
      sessionId: session.id,
      cwd: session.cwd,
      returnUrl: normalizeThreadexReturnUrl(req.body?.returnUrl, req)
    });
    const defaultPort = Number(process.env.WEB_VSCODE_PORT ?? 8790);
    const targetUrl = new URL(process.env.WEB_VSCODE_URL?.trim() || `http://127.0.0.1:${defaultPort}/`);
    targetUrl.searchParams.set("folder", session.cwd);
    res.json({
      url: targetUrl.toString(),
      walkthroughRequestId: walkthrough.requestId
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/workspaces/file", async (req, res) => {
  const requestedPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
  if (!requestedPath) {
    res.status(400).json({ error: "path is required." });
    return;
  }

  try {
    const workspace = await sessionStore.getActiveWorkspace();
    // Match preview access: workspace cwd only supplies the relative-path base.
    const filePath = resolve(workspace.cwd, requestedPath);

    if (!existsSync(filePath)) {
      res.status(404).json({ error: "File not found." });
      return;
    }

    const stats = statSync(filePath);
    if (!stats.isFile()) {
      res.status(400).json({ error: "path is not a file." });
      return;
    }

    const disposition = canInlineWorkspaceFile(filePath) ? "inline" : "attachment";
    const fileName = safeFileName(basename(filePath)).replace(/"/g, "_");
    res.setHeader("Content-Disposition", `${disposition}; filename="${fileName}"`);
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(filePath);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});


app.post("/api/workspaces/create", async (req: Request<object, object, CreateWorkspaceRequest>, res: Response) => {
  const name = req.body.name?.trim();
  if (!name) {
    res.status(400).json({ error: "Workspace name is required." });
    return;
  }

  try {
    const workspace = await sessionStore.upsertWorkspace({
      name,
      codexHome: resolveUserPath(req.body.codexHome?.trim() || resolve(projectRoot, "data/codex-homes", safePathSegment(name))),
      cwd: resolveUserPath(req.body.cwd?.trim() || projectRoot)
    });
    injectBuiltinSkills(workspace, resolve(projectRoot, "skills"));
    await sessionStore.switchWorkspace(workspace.id);
    await sessionStore.switchAccount(null, workspace.id);
    await publishRingEvent({
      eventId: crypto.randomUUID(),
      type: "workspace.created",
      workspaceId: workspace.id,
      sessionId: null,
      turnId: null,
      payload: { workspaceId: workspace.id }
    });
    res.json({
      workspace,
      activeWorkspace: workspace,
      workspaces: await sessionStore.listWorkspaces(),
      activeSessionId: null,
      ...(await getAccountResponseFields(workspace.id))
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/workspaces/switch", async (req: Request<object, object, SwitchWorkspaceRequest>, res: Response) => {
  const workspaceId = normalizeWorkspaceId(req.body.workspaceId?.trim());
  if (!workspaceId) {
    res.status(400).json({ error: "workspaceId is required." });
    return;
  }

  try {
    const workspace = await sessionStore.switchWorkspace(workspaceId);
    injectBuiltinSkills(workspace, resolve(projectRoot, "skills"));
    const selectedAccount = await sessionStore.getActiveAccount(workspace.id);
    const activeAccount = selectedAccount ?? await sessionStore.getFirstWorkspaceAccount(workspace.id);
    if (!selectedAccount && activeAccount) {
      await sessionStore.switchAccount(activeAccount.id, workspace.id);
    }
    if (activeAccount && accountHasSavedAuth(activeAccount)) {
      await applyAccountToWorkspace(activeAccount, workspace);
    }
    const activeSessionId = await sessionStore.getActiveSessionId();
    await publishRingEvent({
      eventId: crypto.randomUUID(),
      type: "workspace.switched",
      workspaceId: workspace.id,
      sessionId: null,
      turnId: null,
      payload: { workspaceId: workspace.id }
    });
    res.json({
      workspace,
      activeWorkspace: workspace,
      workspaces: await sessionStore.listWorkspaces(),
      activeSessionId,
      ...(await getAccountResponseFields(workspace.id, activeAccount))
    });
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.startsWith("Workspace not found") ? 404 : 500).json({ error: message });
  }
});

app.get("/api/accounts", async (_req, res) => {
  try {
    const workspace = await sessionStore.getActiveWorkspace();
    res.json({
      ...(await getAccountResponseFields(workspace.id))
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/accounts/reset-rate-limit", async (
  req: Request<object, object, ResetAccountRateLimitRequest>,
  res: Response
) => {
  const accountId = req.body.accountId?.trim();
  if (!accountId) {
    res.status(400).json({ error: "accountId is required." });
    return;
  }

  try {
    const account = await sessionStore.getAccount(accountId);
    if (!account) {
      res.status(404).json({ error: `Account not found: ${accountId}` });
      return;
    }
    if (!accountHasSavedAuth(account)) {
      res.status(409).json({ error: "Account needs login.", needsLogin: true, account });
      return;
    }
    const runningTurns = await sessionStore.listRunningSessionTurns();
    if (runningTurns.some((turn) => turn.accountId === account.id)) {
      res.status(409).json({ error: "Wait for the account's running turn to finish before resetting its rate limit." });
      return;
    }

    const resetPayload = await callWithTemporaryCodexHome(account, async (rpc) => {
      const consumePayload = await rpc("account/rateLimitResetCredit/consume", {
        idempotencyKey: req.body.idempotencyKey?.trim() || crypto.randomUUID(),
        ...(req.body.creditId?.trim() ? { creditId: req.body.creditId.trim() } : {})
      });
      const quotaPayload = await readQuotaPayloadAfterManualReset(rpc);
      return { consumePayload, quotaPayload };
    });

    const consumeRecord = readObject(resetPayload.consumePayload);
    const outcome = readString(consumeRecord?.outcome) ?? "unknown";
    const quotaSnapshot = pickCodexRateLimitSnapshot(resetPayload.quotaPayload);
    const updatedAccount = await sessionStore.upsertAccount({
      id: account.id,
      name: account.name,
      externalAccountId: account.externalAccountId,
      externalUserId: account.externalUserId,
      email: account.email,
      quotaSnapshot,
      quotaUpdatedAt: new Date().toISOString(),
      quotaError: null
    });
    void publishQuotaAvailableForAccount(updatedAccount).catch((error) => {
      console.warn(`Failed to publish quota availability after manual account reset: ${errorMessage(error)}`);
    });
    void schedulePendingTurnsForAccount(account.id, { immediate: true }).catch((error) => {
      console.warn(`Failed to schedule pending turns after manual account reset: ${errorMessage(error)}`);
    });
    const workspace = await sessionStore.getActiveWorkspace();
    res.json({
      outcome,
      account: updatedAccount,
      ...(await getAccountResponseFields(workspace.id))
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/accounts/bind", async (req: Request<object, object, WorkspaceAccountRequest>, res: Response) => {
  const accountId = req.body.accountId?.trim();
  if (!accountId) {
    res.status(400).json({ error: "accountId is required." });
    return;
  }

  try {
    const workspace = await getRequestedOrActiveWorkspace(req.body.workspaceId);
    const requestedAccount = await sessionStore.getAccount(accountId);
    if (!requestedAccount) {
      res.status(404).json({ error: `Account not found: ${accountId}` });
      return;
    }
    await sessionStore.bindWorkspaceAccount(workspace.id, accountId);
    res.json(await getAccountResponseFields(workspace.id));
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.includes("not found") ? 404 : 500).json({ error: message });
  }
});

app.post("/api/accounts/unbind", async (req: Request<object, object, WorkspaceAccountRequest>, res: Response) => {
  const accountId = req.body.accountId?.trim();
  if (!accountId) {
    res.status(400).json({ error: "accountId is required." });
    return;
  }

  try {
    const workspace = await getRequestedOrActiveWorkspace(req.body.workspaceId);
    await sessionStore.unbindWorkspaceAccount(workspace.id, accountId);
    res.json(await getAccountResponseFields(workspace.id));
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/accounts/delete", async (req: Request<object, object, DeleteAccountRequest>, res: Response) => {
  const accountId = req.body.accountId?.trim();
  if (!accountId) {
    res.status(400).json({ error: "accountId is required." });
    return;
  }

  try {
    const account = await sessionStore.getAccount(accountId);
    if (!account) {
      res.status(404).json({ error: `Account not found: ${accountId}` });
      return;
    }
    if (refreshingQuotaAccountIds.has(accountId)) {
      res.status(409).json({ error: "Wait for the account quota refresh to finish before deleting it." });
      return;
    }
    if ([...pendingAccountLogins.values()].some((login) => login.accountId === accountId)) {
      res.status(409).json({ error: "Wait for the account login to finish before deleting it." });
      return;
    }

    const [runningTurns, workspace] = await Promise.all([
      sessionStore.listRunningSessionTurns(),
      sessionStore.getActiveWorkspace()
    ]);
    const accountHasRunningTurn = runningTurns.some((turn) => turn.accountId === accountId);
    if (accountHasRunningTurn) {
      res.status(409).json({ error: "Stop the account's running turns before deleting it." });
      return;
    }

    const wasActive = (await sessionStore.getActiveAccount(workspace.id))?.id === accountId;
    await sessionStore.deleteAccount(accountId);

    let nextActiveAccount: AccountRecord | undefined;
    if (wasActive) {
      const fallbackAccount = await sessionStore.getFirstWorkspaceAccount(workspace.id);
      if (fallbackAccount) {
        await sessionStore.switchAccount(fallbackAccount.id, workspace.id);
        await applyAccountToWorkspace(fallbackAccount, workspace).catch((applyError) => {
          console.warn(`Failed to apply fallback account after deleting ${accountId}: ${errorMessage(applyError)}`);
        });
        nextActiveAccount = fallbackAccount;
      }
    }

    res.json({
      deletedAccountId: accountId,
      ...(await getAccountResponseFields(workspace.id, nextActiveAccount))
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/accounts/import-current", async (req: Request<object, object, ImportAccountRequest>, res: Response) => {
  const requestedAccountId = req.body.accountId?.trim();
  const name = req.body.name?.trim();
  if (!name) {
    res.status(400).json({ error: "Account name is required." });
    return;
  }

  try {
    const workspace = await sessionStore.getActiveWorkspace();
    const authPath = resolve(workspace.codexHome, "auth.json");
    if (!existsSync(authPath)) {
      res.status(400).json({ error: `No workspace Codex auth.json found at ${authPath}` });
      return;
    }

    const metadata = inferAuthMetadata(authPath);
    const requestedAccount = requestedAccountId ? await sessionStore.getAccount(requestedAccountId) : null;
    if (requestedAccountId && !requestedAccount) {
      res.status(404).json({ error: `Account not found: ${requestedAccountId}` });
      return;
    }
    const identityMatches = (account: AccountRecord) =>
      Boolean(
        metadata.externalAccountId &&
          account.externalAccountId === metadata.externalAccountId &&
          (!metadata.externalUserId || !account.externalUserId || account.externalUserId === metadata.externalUserId)
      );
    const matchingAccounts = (await sessionStore.listAccounts()).filter(identityMatches);
    const existingAccount =
      requestedAccount ??
      matchingAccounts.find((account) => account.name.toLowerCase() === name.toLowerCase()) ??
      matchingAccounts[0] ??
      null;
    const accountId = existingAccount?.id ?? `${safePathSegment(name)}-${crypto.randomUUID().slice(0, 8)}`;
    const authRaw = readFileSync(authPath, "utf8");
    const configRaw = readOptionalTextFile(accountConfigPath(authPath));
    let account = await sessionStore.upsertAccount({
      id: accountId,
      name: existingAccount?.name ?? name,
      externalAccountId: metadata.externalAccountId,
      externalUserId: metadata.externalUserId,
      email: metadata.email,
      quotaError: null
    });
    await sessionStore.setAccountAuth(account.id, authRaw, configRaw);
    account = (await sessionStore.getAccount(account.id)) ?? account;
    await sessionStore.bindWorkspaceAccount(workspace.id, account.id);
    await sessionStore.switchAccount(account.id, workspace.id);
    await refreshQuotaForAccount(account);
    account = (await sessionStore.getAccount(account.id)) ?? account;
    await applyAccountToWorkspace(account, workspace);
    res.json({
      account,
      ...(await getAccountResponseFields(workspace.id, account))
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/accounts/create-api", async (req: Request<object, object, CreateApiAccountRequest>, res: Response) => {
  const requestedAccountId = req.body.accountId?.trim();
  const name = req.body.name?.trim();
  const apiKey = req.body.apiKey?.trim();
  const apiUrl = req.body.apiUrl?.trim();
  if (!name) {
    res.status(400).json({ error: "Account name is required." });
    return;
  }
  if (!apiKey) {
    res.status(400).json({ error: "API key is required." });
    return;
  }

  try {
    const workspace = await sessionStore.getActiveWorkspace();
    const existingAccount = requestedAccountId ? await sessionStore.getAccount(requestedAccountId) : null;
    if (requestedAccountId && !existingAccount) {
      res.status(404).json({ error: `Account not found: ${requestedAccountId}` });
      return;
    }
    const accountId = existingAccount?.id ?? `${safePathSegment(name)}-${crypto.randomUUID().slice(0, 8)}`;
    const loginHome = mkdtempSync(resolve(tmpdir(), "threadex-api-login-"));
    let account: AccountRecord;
    try {
      writeAccountConfig(loginHome, apiUrl || null);
      await codexLoginWithApiKey(loginHome, apiKey);
      const authPath = resolve(loginHome, "auth.json");
      if (!existsSync(authPath)) {
        throw new Error("Codex login did not create auth.json.");
      }
      account = await sessionStore.upsertAccount({
        id: accountId,
        name,
        externalAccountId: apiUrl || "API key"
      });
      await sessionStore.setAccountAuth(
        account.id,
        readFileSync(authPath, "utf8"),
        readOptionalTextFile(resolve(loginHome, "config.toml"))
      );
      account = (await sessionStore.getAccount(account.id)) ?? account;
    } finally {
      rmSync(loginHome, { recursive: true, force: true });
    }
    await sessionStore.bindWorkspaceAccount(workspace.id, account.id);
    await sessionStore.switchAccount(account.id, workspace.id);
    res.json({
      account,
      ...(await getAccountResponseFields(workspace.id, account))
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/accounts/login/start", async (req: Request<object, object, StartAccountLoginRequest>, res: Response) => {
  const requestedAccountId = req.body.accountId?.trim();
  const name = req.body.name?.trim();
  if (!name) {
    res.status(400).json({ error: "Account name is required." });
    return;
  }

  cleanupExpiredAccountLogins();
  try {
    if (requestedAccountId && !(await sessionStore.getAccount(requestedAccountId))) {
      res.status(404).json({ error: `Account not found: ${requestedAccountId}` });
      return;
    }
    const workspace = await sessionStore.getActiveWorkspace();
    const requestedSessionId = req.body.sessionId?.trim() || null;
    if (requestedSessionId) {
      const session = await getSessionForRequestedId(requestedSessionId);
      if (!session || session.workspaceId !== workspace.id) {
        res.status(404).json({ error: "Session not found in the active workspace." });
        return;
      }
    }
    const login = await startAccountChatGptLogin(name, requestedAccountId || null, workspace.id, requestedSessionId);
    pendingAccountLogins.set(login.id, login);
    res.json({
      loginId: login.id,
      loginUrl: login.loginUrl,
      userCode: login.userCode
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/accounts/login/status", async (req: Request<object, object, AccountLoginStatusRequest>, res: Response) => {
  const loginId = req.body.loginId?.trim();
  if (!loginId) {
    res.status(400).json({ error: "loginId is required." });
    return;
  }

  const login = pendingAccountLogins.get(loginId);
  if (!login) {
    res.status(404).json({ error: "Login session not found or expired." });
    return;
  }

  try {
    if (!login.completedAccount && !login.completionPromise && existsSync(resolve(login.codexHome, "auth.json"))) {
      void finalizePendingAccountLogin(login).catch((error) => {
        login.error = errorMessage(error);
      });
    }

    const details = getAccountLoginDetails(login);
    if (!login.completedAccount) {
      res.json({
        loginId: login.id,
        loginUrl: details.loginUrl,
        userCode: details.userCode,
        complete: false,
        error: getAccountLoginError(login)
      });
      return;
    }

    const account = login.completedAccount;
    res.json({
      loginId: login.id,
      loginUrl: details.loginUrl,
      userCode: details.userCode,
      complete: true,
      error: null,
      account,
      ...(await getAccountResponseFields(login.workspaceId, account))
    });
    cleanupPendingAccountLogin(loginId);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/accounts/login/complete", async (req: Request<object, object, CompleteAccountLoginRequest>, res: Response) => {
  const loginId = req.body.loginId?.trim();
  if (!loginId) {
    res.status(400).json({ error: "loginId is required." });
    return;
  }

  const login = pendingAccountLogins.get(loginId);
  if (!login) {
    res.status(404).json({ error: "Login session not found or expired." });
    return;
  }

  try {
    const account = await finalizePendingAccountLogin(login);
    if (!account) {
      res.status(409).json({ error: "Login is not complete yet." });
      return;
    }
    res.json({
      account,
      ...(await getAccountResponseFields(login.workspaceId, account))
    });
    cleanupPendingAccountLogin(loginId);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/accounts/switch", async (req: Request<object, object, SwitchAccountRequest>, res: Response) => {
  const accountId = typeof req.body.accountId === "string" ? req.body.accountId.trim() : null;

  try {
    const workspace = await sessionStore.getActiveWorkspace();
    if (accountId) {
      const requestedAccount = await sessionStore.getAccount(accountId);
      if (!requestedAccount) {
        res.status(404).json({ error: `Account not found: ${accountId}` });
        return;
      }
      const identityError = await accountStoredAuthIdentityError(requestedAccount);
      if (identityError) {
        res.status(409).json({
          error: `Account auth mismatch: ${identityError}. Import the current auth or sign in again.`,
          needsLogin: false,
          account: requestedAccount,
          ...(await getAccountResponseFields(workspace.id))
        });
        return;
      }
      if (!accountHasSavedAuth(requestedAccount)) {
        res.status(409).json({
          error: "Account needs login.",
          needsLogin: true,
          account: requestedAccount,
          ...(await getAccountResponseFields(workspace.id))
        });
        return;
      }
    }

    const requestedSessionId = req.body.sessionId?.trim();
    const sessionToRebind = requestedSessionId ? await getSessionForRequestedId(requestedSessionId) : null;
    if (requestedSessionId && (!sessionToRebind || sessionToRebind.workspaceId !== workspace.id)) {
      res.status(404).json({ error: "Session not found in the active workspace." });
      return;
    }

    await disableWorkspaceAutoLoadBalance(workspace.id);
    const account = await sessionStore.switchAccount(accountId || null, workspace.id);
    if (account) {
      await applyAccountToWorkspace(account, workspace);
    }
    let activeSessionId: string | null = null;
    if (sessionToRebind) {
      await rebindSessionAccount(sessionStore, sessionToRebind, account);
      activeSessionId = sessionToRebind.id;
      if (account) {
        void schedulePendingTurnsForSession(sessionToRebind.id, { immediate: true }).catch((error) => {
          console.warn(`Failed to retry auth-pending turns after account switch: ${errorMessage(error)}`);
        });
      }
    } else {
      await sessionStore.clearActiveSession(workspace.id);
    }
    res.json({
      activeSessionId,
      ...(await getAccountResponseFields(workspace.id, account))
    });
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.startsWith("Account not found") ? 404 : 500).json({ error: message });
  }
});

app.post("/api/accounts/auto-load-balance", async (
  req: Request<object, object, AutoLoadBalanceRequest>,
  res: Response
) => {
  try {
    const workspace = await getRequestedOrActiveWorkspace(req.body.workspaceId);
    const enabled = req.body.enabled !== false;
    if (!enabled) {
      await disableWorkspaceAutoLoadBalance(workspace.id);
      res.json(await getAccountResponseFields(workspace.id));
      return;
    }

    await sessionStore.setWorkspaceAutoLoadBalance(workspace.id, true);
    autoLoadBalanceWorkspaceIds.add(workspace.id);
    const account = await advanceLoadBalancedAccountForWorkspace(workspace.id);
    res.json({
      activeSessionId: null,
      ...(await getAccountResponseFields(workspace.id, account))
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/accounts/advance-load-balanced", async (
  req: Request<object, object, AdvanceLoadBalancedAccountRequest>,
  res: Response
) => {
  try {
    const workspace = await getRequestedOrActiveWorkspace(req.body.workspaceId);
    const account = await advanceLoadBalancedAccountForWorkspace(workspace.id);
    res.json({
      activeSessionId: null,
      ...(await getAccountResponseFields(workspace.id, account))
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

async function getSessionSnapshot(session: SessionRecord, replayRunningTurns = false) {
  let turns = await sessionStore.listSessionTurns(session.id);
  if (replayRunningTurns) {
    const runningTurns = turns.filter((turn) => turn.status === "running");
    if (runningTurns.length > 0) {
      const now = Date.now();
      for (const turn of runningTurns) {
        if (shouldDiagnoseRunningTurnAfterSwitch(turn, now)) {
          scheduleBackgroundRunningTurnDiagnosis(turn, "switch");
        }
      }
    }
  }
  const [liveItemsByTurn, approvalLiveItemsByTurn, developerInstructionsByTurn, steerMessagesByTurn, autoModelProvidersByTurn, autoModel, modelPreferences] = await Promise.all([
    sessionStore.listSessionLiveItems(session.id),
    sessionStore.listSessionApprovalLiveItems(session.id),
    sessionStore.listSessionDeveloperInstructions(session.id),
    sessionStore.listSessionSteerMessages(session.id),
    sessionStore.listSessionAutoModelProviders(session.id),
    sessionStore.getSessionAutoModel(session.id),
    sessionStore.getWorkspaceModelPreferences(session.workspaceId)
  ]);
  const todo = await sessionStore.getSessionTodo(session.id);
  const pendingApprovalItemsByTurn = pendingApprovalLiveItemsForSession(session.id);
  return {
    session,
    autoModel,
    modelPreferences,
    todo,
    turns: turns.map((turn) => ({
      ...turn,
      liveItems: mergeLiveItemsById([
        ...(liveItemsByTurn[turn.id] ?? []),
        ...(approvalLiveItemsByTurn[turn.id] ?? []),
        ...(pendingApprovalItemsByTurn[turn.id] ?? [])
      ]),
      developerInstructions: developerInstructionsByTurn[turn.id] ?? [],
      steerMessages: steerMessagesByTurn[turn.id] ?? [],
      autoModelProvider: autoModelProvidersByTurn[turn.id]
    }))
  };
}

async function getWorkspaceSnapshot() {
  // Capture the cursor before reading the snapshot. Events committed while the
  // snapshot is being assembled will then be replayed instead of being skipped.
  const eventCursor = eventRingLog.latestPosition;
  const activeWorkspace = await sessionStore.getActiveWorkspace();
  await releaseDeadRunningTurnsForDisplay("workspace_snapshot");
  const [
    sessionPage,
    sessionExecutionStatuses,
    activeSessionId,
    workspaces,
    accountFields,
    processMonitors,
    statusMonitor,
    waitEventRecords,
    waitSubscriptions,
    modelPreferences
  ] = await Promise.all([
    sessionStore.listSessionsByProjectPage(activeWorkspace.id, 20),
    sessionStore.listActiveSessionExecutionStatuses(activeWorkspace.id),
    sessionStore.getActiveSessionId(),
    sessionStore.listWorkspaces(),
    getAccountResponseFields(activeWorkspace.id),
    listProcessMonitors(activeWorkspace),
    getWorkspaceStatusMonitor(activeWorkspace.id, { releaseDeadRunningTurns: false }),
    sessionStore.listWaitEvents({ workspaceId: activeWorkspace.id, activeSubscriptionsOnly: true }),
    sessionStore.listWaitSubscriptions({ workspaceId: activeWorkspace.id, activeOnly: true }),
    sessionStore.getWorkspaceModelPreferences(activeWorkspace.id)
  ]);
  const activeSession = activeSessionId ? await sessionStore.getSession(activeSessionId) : null;
  return {
    activeWorkspace,
    workspaces,
    sessions: sessionPage.sessions,
    grillSummaries: await sessionStore.listGrillSummaries(activeWorkspace.id),
    sessionPage: {
      offset: 0,
      limit: 20,
      hasMore: sessionPage.projects.some((project) => project.hasMore),
      nextOffset: null,
      projects: sessionPage.projects.map(({ cwd, offset, limit, hasMore, total, nextOffset }) => ({
        cwd,
        offset,
        limit,
        hasMore,
        total,
        nextOffset
      }))
    },
    sessionExecutionStatuses,
    pendingApprovalSessionIds: [...new Set(
      [...pendingApprovals.values()]
        .filter((approval) => approval.decision === undefined)
        .map((approval) => approval.sessionId)
    )],
    approvals: [...pendingApprovals.values()]
      .filter((approval) => approval.decision === undefined)
      .map(publicApprovalRecord),
    activeSessionId,
    activeSession: activeSession ? await getSessionSnapshot(activeSession, true) : null,
    processMonitors,
    statusMonitor,
    waitEvents: waitEventRecords,
    waitSubscriptions,
    modelPreferences,
    eventCursor,
    ...accountFields
  };
}

async function listProcessMonitors(workspace: WorkspaceRecord) {
  const storedMonitors = await processMonitor.list(workspace.id);
  if (!(await isThreadexProcessWorkspace(workspace))) {
    return storedMonitors;
  }
  const virtualMonitors = await virtualProcessMonitors(workspace);
  return [
    ...virtualMonitors.map(({ monitor }) => monitor),
    ...storedMonitors
  ];
}

async function isThreadexProcessWorkspace(workspace: WorkspaceRecord) {
  if (workspace.id === "threadex") return true;
  const threadexWorkspace = await sessionStore.getWorkspace("threadex");
  if (threadexWorkspace) return false;
  return resolve(workspace.cwd) === resolve(process.cwd());
}

async function virtualProcessMonitors(workspace: WorkspaceRecord): Promise<VirtualProcessMonitor[]> {
  const serverAction = serverRestartAction();
  return [
    {
      monitor: readOnlyServerProcessMonitor(workspace, serverAction !== null),
      restartAction: serverAction
    }
  ];
}

function readOnlyServerProcessMonitor(workspace: WorkspaceRecord, restartable: boolean): ProcessMonitorRecord {
  return {
    id: "builtin_threadex-server",
    workspaceId: workspace.id,
    label: "threadex-server",
    command: null,
    executable: basename(process.execPath),
    dockerImage: null,
    dockerRunArgs: [],
    args: [...process.execArgv, ...process.argv.slice(1)],
    logFile: supervisorLogPath("server"),
    entryPoints: [`http://localhost:${port}/`],
    metricMonitors: [],
    metricReadings: [],
    cwd: process.cwd(),
    pid: process.pid,
    status: "running",
    managed: false,
    readOnly: true,
    restartable,
    removeOnExit: false,
    wakePrompt: null,
    wakeSessionId: null,
    wakeThreadId: null,
    timeoutAt: null,
    wakeStatus: "none",
    wakeError: null,
    wokenAt: null,
    startedAt: serverMonitorStartedAt,
    lastExitCode: null,
    lastSignal: null,
    error: null,
    created: serverMonitorStartedAt,
    updated: serverMonitorStartedAt
  };
}

function serverRestartAction(): VirtualProcessRestartAction | null {
  const supervisorPid = readSupervisorPid("server") ?? Number(process.env.SESSION_SERVER_SUPERVISOR_PID);
  if (isLiveProcess(supervisorPid)) return { kind: "signal", pid: supervisorPid, signal: "SIGUSR1" };
  // Compatibility for a watch-server that began before it wrote a PID file.
  // Touching its watched entry gives that existing supervisor the same orderly
  // stop-and-replace path without tying the API route to a monitor name.
  if (legacyWatchServerParentPid() !== null) return { kind: "touch", path: serverEntryPath() };
  return null;
}

function readSupervisorPid(key: "server") {
  const path = resolve(dataDir, "process-supervisors", `${key}.pid`);
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return isLiveProcess(pid) ? pid : null;
  } catch {
    return null;
  }
}

function writeSupervisorPid(key: "server", pid: number) {
  const path = resolve(dataDir, "process-supervisors", `${key}.pid`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${pid}\n`, "utf8");
}

function supervisorLogPath(key: "server") {
  return resolve(dataDir, "process-supervisors", `${key}.log`);
}

function legacyWatchServerParentPid() {
  const value = Number(process.env.SESSION_SERVER_SUPERVISOR_PID);
  if (isLiveProcess(value)) return value;
  // A running watch-server process can predate the environment handoff added
  // above. Its child is the tsx CLI, so locate its parent once as a safe dev
  // compatibility fallback.
  try {
    const parent = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(process.ppid)], {
      encoding: "utf8",
      timeout: 1_000
    }).trim());
    if (!Number.isInteger(parent) || parent <= 0) return null;
    const command = processCommand(parent);
    return command?.includes("scripts/watch-server.mjs") && isLiveProcess(parent) ? parent : null;
  } catch {
    return null;
  }
}

function serverEntryPath() {
  return resolve(projectRoot, "src/server/index.ts");
}

function processCommand(pid: number) {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1_000
    }).trim() || null;
  } catch {
    return null;
  }
}

function readVirtualProcessLog(monitor: ProcessMonitorRecord, tailBytes?: number) {
  const requestedBytes = tailBytes === undefined ? 256 * 1024 : Math.floor(tailBytes);
  const boundedBytes = Math.max(1, Math.min(requestedBytes, 1024 * 1024));
  const path = monitor.logFile;
  if (!path || !existsSync(path)) {
    return { monitorId: monitor.id, content: "", size: 0, truncated: false, updatedAt: null };
  }
  const stats = statSync(path);
  const length = Math.min(stats.size, boundedBytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, Math.max(0, stats.size - length));
  } finally {
    closeSync(fd);
  }
  return {
    monitorId: monitor.id,
    content: buffer.toString("utf8"),
    size: stats.size,
    truncated: stats.size > length,
    updatedAt: stats.mtime.toISOString()
  };
}

async function restartVirtualProcess(action: VirtualProcessRestartAction) {
  try {
    if (action.kind === "signal") {
      process.kill(action.pid, action.signal);
      return;
    }
    if (action.kind === "touch") {
      const now = new Date();
      utimesSync(action.path, now, now);
      return;
    }
    if (action.stopPid !== null) {
      process.kill(action.stopPid, "SIGTERM");
      for (let attempt = 0; attempt < 40 && isLiveProcess(action.stopPid); attempt += 1) {
        await sleep(50);
      }
      if (isLiveProcess(action.stopPid)) {
        throw new Error(`Process ${action.stopPid} did not stop in time.`);
      }
    }
    const child = spawn(action.executable, action.args, {
      cwd: action.cwd,
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } catch (error) {
    console.warn(`Failed to restart virtual process monitor: ${errorMessage(error)}`);
  }
}

function isLiveProcess(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

app.post("/api/sessions/switch", async (req: Request<object, object, SwitchSessionRequest>, res: Response) => {
  const requestedSessionId = req.body.sessionId?.trim();
  if (!requestedSessionId) {
    try {
      const previousActiveSessionId = await sessionStore.getActiveSessionId();
      const workspace = await sessionStore.getActiveWorkspace();
      await sessionStore.clearActiveSession();
      if (previousActiveSessionId) {
        sessionSummarizer.noteSessionActivity(previousActiveSessionId);
      }
      await publishRingEvent({
        eventId: crypto.randomUUID(),
        type: "session.switched",
        workspaceId: workspace.id,
        sessionId: null,
        turnId: null,
        payload: { sessionId: null }
      });
      res.json({ session: null, activeSessionId: null });
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
    return;
  }

  try {
    const previousActiveSessionId = await sessionStore.getActiveSessionId();
    const sessionId = await resolveRequestedSessionId(requestedSessionId);
    const session = await sessionStore.switchSession(sessionId);
    sessionSummarizer.noteSessionActivity(session.id);
    if (previousActiveSessionId && previousActiveSessionId !== session.id) {
      sessionSummarizer.noteSessionActivity(previousActiveSessionId);
    }
    const snapshot = await getSessionSnapshot(session, true);
    await publishRingEvent({
      eventId: crypto.randomUUID(),
      type: "session.switched",
      workspaceId: session.workspaceId,
      sessionId: session.id,
      turnId: null,
      payload: { sessionId: session.id }
    });
    res.json(snapshot);
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.startsWith("Session not found") ? 404 : 500).json({ error: message });
  }
});

app.post("/api/sessions/fork", async (req: Request<object, object, ForkSessionRequest>, res: Response) => {
  const requestedSessionId = req.body.sessionId?.trim();
  const targetTurnId = req.body.turnId?.trim();

  if (!requestedSessionId || !targetTurnId) {
    res.status(400).json({ error: "sessionId and turnId are required." });
    return;
  }

  try {
    const parentSessionId = await resolveRequestedSessionId(requestedSessionId);
    const fork = await sessionStore.forkSessionAtTurn({
      id: createLocalSessionId(),
      parentSessionId,
      targetTurnId,
      title: req.body.title?.trim() || undefined,
      titleSource: req.body.title?.trim() ? "user" : "initial"
    });
    await sessionStore.switchSession(fork.session.id);
    res.json({
      session: fork.session,
      activeSessionId: fork.session.id,
      modelPreferences: await sessionStore.getWorkspaceModelPreferences(fork.session.workspaceId),
      turns: fork.turns
    });
  } catch (error) {
    const message = errorMessage(error);
    const status = message.startsWith("Session not found") || message.startsWith("Turn not found")
      ? 404
      : message.startsWith("Only completed")
        ? 409
        : 500;
    res.status(status).json({ error: message });
  }
});

async function enableOutcomeTracking(sessionId: string) {
  if (await sessionStore.getOutcomePlan(sessionId)) return;
  await sessionStore.saveOutcomePlan(sessionId, 0, {
    revision: 1, objective: "", items: [], progress: {}, sourceHash: null, updated: new Date().toISOString()
  });
}

app.get("/api/sessions/:sessionId/outcome-plan", async (req, res) => {
  try {
    const sessionId = await resolveRequestedSessionId(req.params.sessionId);
    res.json({ plan: await sessionStore.getOutcomePlan(sessionId) });
  } catch (error) { res.status(400).json({ error: errorMessage(error) }); }
});

app.post("/api/sessions/:sessionId/outcome-plan", async (req, res) => {
  try {
    const sessionId = await resolveRequestedSessionId(req.params.sessionId);
    const previous = await sessionStore.getOutcomePlan(sessionId);
    const plan = reviseOutcomePlan(previous, req.body);
    if (!await sessionStore.saveOutcomePlan(sessionId, previous?.revision ?? 0, plan)) {
      res.status(409).json({ error: "Plan revision conflict. Read the latest plan and retry." });
      return;
    }
    await publishTodoChanged(sessionId, await sessionStore.getSessionTodo(sessionId));
    sessionSummarizer.noteSessionActivity(sessionId);
    res.json({ plan });
  } catch (error) {
    res.status(errorMessage(error).includes("revision conflict") ? 409 : 400).json({ error: errorMessage(error) });
  }
});

app.get("/api/sessions/:sessionId/todos", async (req: Request<{ sessionId: string }>, res: Response) => {
  try {
    const sessionId = await resolveRequestedSessionId(req.params.sessionId);
    res.json(await sessionStore.getSessionTodo(sessionId));
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.startsWith("Session not found") ? 404 : 500).json({ error: message });
  }
});

app.post("/api/sessions/:sessionId/todos/items", async (
  req: Request<{ sessionId: string }, object, TodoItemRequest>,
  res: Response
) => {
  try {
    const sessionId = await resolveRequestedSessionId(req.params.sessionId);
    const title = req.body.title?.trim();
    if (!title) {
      res.status(400).json({ error: "title is required." });
      return;
    }
    const todo = await sessionStore.upsertTodoItem({
      id: readString(req.body.id) ?? undefined,
      sessionId,
      parentId: req.body.parentId ?? null,
      title,
      details: req.body.details ?? "",
      context: req.body.context ?? "",
      section: req.body.section === "solution" || req.body.section === "verification" ? req.body.section : undefined,
      status: normalizeTodoItemStatus(req.body.status),
      position: typeof req.body.position === "number" ? req.body.position : null,
      actor: normalizeTodoActor(req.body.actor),
      turnId: req.body.turnId ?? null,
      activeStatus: req.body.activeStatus ?? null
    });
    await publishTodoChanged(sessionId, todo);
    res.status(201).json(todo);
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.startsWith("Session not found") ? 404 : 500).json({ error: message });
  }
});

app.patch("/api/sessions/:sessionId/todos/items/:itemId", async (
  req: Request<{ sessionId: string; itemId: string }, object, TodoItemRequest>,
  res: Response
) => {
  try {
    const sessionId = await resolveRequestedSessionId(req.params.sessionId);
    const todo = await sessionStore.updateTodoItem({
      id: req.params.itemId,
      sessionId,
      parentId: req.body.parentId,
      title: req.body.title,
      details: req.body.details,
      context: req.body.context,
      section: req.body.section,
      status: normalizeTodoItemStatus(req.body.status),
      position: typeof req.body.position === "number" ? req.body.position : null,
      actor: normalizeTodoActor(req.body.actor),
      turnId: req.body.turnId ?? null,
      activeStatus: req.body.activeStatus,
      lockReason: req.body.lockReason,
      childSessionId: undefined,
      childTurnId: undefined
    });
    await publishTodoChanged(sessionId, todo);
    res.json(todo);
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.startsWith("Session not found") || message.startsWith("Todo item not found") ? 404 : 500).json({ error: message });
  }
});

app.post("/api/sessions/:sessionId/todos/comments", async (
  req: Request<{ sessionId: string }, object, TodoCommentRequest>,
  res: Response
) => {
  try {
    const sessionId = await resolveRequestedSessionId(req.params.sessionId);
    const body = req.body.body?.trim();
    if (!body) {
      res.status(400).json({ error: "body is required." });
      return;
    }
    const todo = await sessionStore.addTodoComment({
      sessionId,
      itemId: req.body.itemId ?? null,
      turnId: req.body.turnId ?? null,
      type: normalizeTodoCommentType(req.body.type),
      author: normalizeTodoActor(req.body.author),
      body
    });
    await publishTodoChanged(sessionId, todo);
    res.status(201).json(todo);
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.startsWith("Session not found") ? 404 : 500).json({ error: message });
  }
});

app.post("/api/sessions/:sessionId/todos/messages", async (
  req: Request<{ sessionId: string }, object, TodoMessageRequest>,
  res: Response
) => {
  try {
    const sessionId = await resolveRequestedSessionId(req.params.sessionId);
    const itemId = req.body.itemId?.trim();
    const title = req.body.title?.trim();
    if (!itemId || !title) {
      res.status(400).json({ error: "itemId and title are required." });
      return;
    }
    const todo = await sessionStore.addTodoMessage({
      sessionId,
      itemId,
      turnId: req.body.turnId ?? null,
      type: normalizeTodoMessageType(req.body.type),
      author: normalizeTodoActor(req.body.author),
      title,
      body: req.body.body ?? ""
    });
    await publishTodoChanged(sessionId, todo);
    res.status(201).json(todo);
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.startsWith("Session not found") || message.startsWith("Todo item not found") ? 404 : 500).json({ error: message });
  }
});

app.post("/api/sessions/:sessionId/todos/challenges/:challengeId/resolve", async (
  req: Request<{ sessionId: string; challengeId: string }, object, TodoChallengeResolveRequest>,
  res: Response
) => {
  const challengeId = Number(req.params.challengeId);
  if (!Number.isSafeInteger(challengeId) || challengeId <= 0) {
    res.status(400).json({ error: "challengeId must be a positive integer." });
    return;
  }
  try {
    const sessionId = await resolveRequestedSessionId(req.params.sessionId);
    const todo = await sessionStore.resolveTodoChallenge({
      sessionId,
      challengeId,
      actor: normalizeTodoActor(req.body.actor)
    });
    await publishTodoChanged(sessionId, todo);
    res.json(todo);
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.startsWith("Session not found") || message.startsWith("Todo challenge not found") ? 404 : 500).json({ error: message });
  }
});

app.get("/api/sessions/:sessionId/todos/challenges/unresolved", async (
  req: Request<{ sessionId: string }>,
  res: Response
) => {
  try {
    const sessionId = await resolveRequestedSessionId(req.params.sessionId);
    res.json({ challenges: await sessionStore.listUnresolvedTodoChallenges(sessionId) });
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.startsWith("Session not found") ? 404 : 500).json({ error: message });
  }
});

app.post("/api/sessions/:sessionId/todos/control", async (
  req: Request<{ sessionId: string }, object, TodoControlRequest>,
  res: Response
) => {
  try {
    const sessionId = await resolveRequestedSessionId(req.params.sessionId);
    let todo = await sessionStore.setTodoControl({
      sessionId,
      paused: req.body.paused === true,
      pauseReason: req.body.pauseReason ?? null,
      context: req.body.context,
      problem: req.body.problem,
      objective: req.body.objective,
      actor: normalizeTodoActor(req.body.actor)
    });
    const childTurnIds = [...new Set(todo.itemSessions.map((itemSession) => itemSession.childTurnId).filter((turnId): turnId is string => Boolean(turnId)))];
    if (req.body.paused === true) {
      const runningTurnIds: string[] = [];
      for (const turnId of childTurnIds) {
        const turn = await sessionStore.getSessionTurn(turnId);
        if (!turn || turn.status !== "running") continue;
        const message = "Todo plan paused. This worker will resume with the plan.";
        const stopEntries = buildRunnerStopEntries(turn, message);
        if (turn.runnerLogPath) appendRunnerLogEntries(turn.runnerLogPath, stopEntries);
        for (const entry of stopEntries) {
          await applyRunnerLogEntry(
            { ...entry, jsonlIndex: entry.jsonlIndex ?? 0 },
            turn.runnerLogPath ?? "",
            "live"
          );
        }
        terminateRunnerProcess(turn.runnerPid);
        runningTurnIds.push(turnId);
      }
      todo = await sessionStore.setTodoItemsForChildTurns({
        sessionId,
        turnIds: runningTurnIds,
        status: "paused",
        actor: normalizeTodoActor(req.body.actor)
      });
    } else {
      const resumableTurnIds: string[] = [];
      for (const turnId of childTurnIds) {
        const turn = await sessionStore.getSessionTurn(turnId);
        if (turn?.status === "todo") resumableTurnIds.push(turnId);
      }
      todo = await sessionStore.setTodoItemsForChildTurns({
        sessionId,
        turnIds: resumableTurnIds,
        status: "active",
        actor: normalizeTodoActor(req.body.actor)
      });
      for (const turnId of resumableTurnIds) void runPendingTurnAutomatically(turnId);
    }
    await publishTodoChanged(sessionId, todo);
    res.json(todo);
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.startsWith("Session not found") ? 404 : 500).json({ error: message });
  }
});

app.get("/api/sessions/:sessionId/todos/runner-control", async (
  req: Request<{ sessionId: string }>,
  res: Response
) => {
  const turnId = queryString(req.query as Record<string, unknown>, "turnId");
  if (!turnId) {
    res.status(400).json({ error: "turnId is required." });
    return;
  }
  try {
    const sessionId = await resolveRequestedSessionId(req.params.sessionId);
    res.json(await sessionStore.getTodoRunnerControl({
      sessionId,
      turnId,
      itemId: queryString(req.query as Record<string, unknown>, "itemId") ?? null
    }));
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.startsWith("Session not found") ? 404 : 500).json({ error: message });
  }
});

app.post("/api/sessions/summarize", async (req: Request<object, object, SummarizeSessionsRequest>, res: Response) => {
  const sessionIds = Array.isArray(req.body.sessionIds)
    ? req.body.sessionIds.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean)
    : [];
  if (sessionIds.length === 0) {
    res.status(400).json({ error: "sessionIds is required." });
    return;
  }

  try {
    const results = [];
    for (const sessionId of sessionIds) {
      if (req.body.force === true) {
        await sessionSummarizer.forceSummarizeSession(sessionId);
      } else {
        await sessionSummarizer.summarizeSessionNow(sessionId, "switch");
      }
      const session = await sessionStore.getSession(sessionId);
      results.push({
        sessionId,
        keywordWeights: session?.keywordWeights ?? {}
      });
    }
    res.json({ ok: true, results });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/session-inspector/session", async (req, res) => {
  try {
    const result = await sessionStore.inspectSession(sessionInspectInputFromQuery(req.query));
    if (!result) {
      res.status(404).json({ error: "Session not found." });
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/session-inspector/session", async (
  req: Request<object, object, SessionInspectorRequest>,
  res: Response
) => {
  try {
    const result = await sessionStore.inspectSession(req.body);
    if (!result) {
      res.status(404).json({ error: "Session not found." });
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/session-auto-model/upgrade", async (
  req: Request<object, object, AutoModelUpgradeRequest>,
  res: Response
) => {
  const sessionId = req.body.sessionId?.trim();
  const model = normalizeAutoModel(req.body.model);
  const effort = normalizeAutoEffort(req.body.effort);
  const reason = req.body.reason?.trim();
  if (!sessionId || !model || !effort || !reason) {
    res.status(400).json({ error: "sessionId, model, effort, and reason are required." });
    return;
  }
  try {
    const config = await sessionStore.upgradeSessionAutoModel({ sessionId, model, effort });
    await sessionStore.recordSessionTurnEvent({
      sessionId,
      turnId: (await sessionStore.getLatestRunningTurn(sessionId))?.id ?? `auto-model:${sessionId}`,
      eventName: "auto_model.upgraded",
      payload: { ...config, reason }
    }).catch(() => undefined);
    res.json({
      ok: true,
      ...config,
      reason,
      message: "Upgrade accepted. End this preparation phase now; Threadex will continue automatically at the upgraded setting."
    });
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.startsWith("Session not found") ? 404 : 409).json({ error: message });
  }
});

app.get("/api/session-auto-model/:sessionId", async (req: Request<{ sessionId: string }>, res: Response) => {
  try {
    const sessionId = await resolveRequestedSessionId(req.params.sessionId.trim());
    res.json(await sessionStore.getSessionAutoModel(sessionId));
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.startsWith("Session not found") ? 404 : 500).json({ error: message });
  }
});

app.put("/api/session-model-preferences/:sessionId", async (
  req: Request<{ sessionId: string }, object, SessionModelPreferencesInput>,
  res: Response
) => {
  try {
    const sessionId = await resolveRequestedSessionId(req.params.sessionId.trim());
    res.json(await sessionStore.setSessionModelPreferences(sessionId, req.body ?? {}));
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.startsWith("Session not found") ? 404 : 400).json({ error: message });
  }
});

app.put("/api/workspace-model-preferences/:workspaceId", async (
  req: Request<{ workspaceId: string }, object, SessionModelPreferencesInput>,
  res: Response
) => {
  try {
    const workspaceId = req.params.workspaceId.trim();
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace ID is required." });
      return;
    }
    res.json(await sessionStore.setWorkspaceModelPreferences(workspaceId, req.body ?? {}));
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.startsWith("Workspace not found") ? 404 : 400).json({ error: message });
  }
});

app.get("/api/session-inspector/search", async (req, res) => {
  try {
    res.json(await sessionStore.searchSessions(sessionSearchInputFromQuery(req.query)));
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/session-inspector/search", async (
  req: Request<object, object, SessionSearchRequest>,
  res: Response
) => {
  try {
    res.json(await sessionStore.searchSessions(req.body));
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

const turnGrillHandler = createTurnGrillHandler({
  sessionStore, serverUrl, recordUsage: recordBackgroundModelUsage
});
app.get("/api/sessions/:sessionId/grills", async (req, res) => {
  try {
    const session = await sessionStore.getSession(req.params.sessionId);
    if (!session) { res.status(404).json({ error: "Session not found." }); return; }
    const summaries = (await sessionStore.listGrillSummaries(session.workspaceId)).filter((item) => item.sessionId === session.id);
    res.json({ turnIds: summaries.map((item) => item.turnId), summaries });
  } catch (error) { res.status(500).json({ error: errorMessage(error) }); }
});
app.get("/api/sessions/:sessionId/turns/:turnId/grill", turnGrillHandler);
app.post("/api/sessions/:sessionId/turns/:turnId/grill", turnGrillHandler);

app.post("/api/session-inspector/ask", async (
  req: Request<object, object, SessionQuestionRequest>,
  res: Response
) => {
  const question = typeof req.body.question === "string" ? req.body.question.trim() : "";
  if (!question) {
    res.status(400).json({ error: "question is required." });
    return;
  }
  if (question.length > 8_000) {
    res.status(400).json({ error: "question is too long (maximum 8000 characters)." });
    return;
  }
  if (!req.body.sessionId?.trim() && !req.body.threadId?.trim()) {
    res.status(400).json({ error: "sessionId or threadId is required." });
    return;
  }

  try {
    const requestedModel = req.body.model?.trim();
    if (requestedModel && requestedModel.length > 100) {
      res.status(400).json({ error: "model is too long (maximum 100 characters)." });
      return;
    }
    const requestedEffortValue = req.body.modelReasoningEffort?.trim();
    if (requestedEffortValue && !isSideChatReasoningEffort(requestedEffortValue)) {
      res.status(400).json({ error: `Unsupported side-chat reasoning effort: ${requestedEffortValue}` });
      return;
    }
    const requestedEffort = requestedEffortValue && isSideChatReasoningEffort(requestedEffortValue)
      ? requestedEffortValue
      : undefined;

    const context = await sessionStore.inspectSession({
      sessionId: req.body.sessionId,
      threadId: req.body.threadId,
      workspaceId: req.body.workspaceId,
      q: req.body.q,
      status: req.body.status,
      turnLimit: 1,
      turnOffset: req.body.turnOffset ?? 0,
      maxTextChars: 200,
      includeSideChats: false,
      order: "asc"
    });
    if (!context) {
      res.status(404).json({ error: "Session not found." });
      return;
    }

    const workspace = await sessionStore.getWorkspace(context.session.workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "Session workspace not found." });
      return;
    }
    const answer = await answerSessionQuestion({
      question,
      context: { session: context.session },
      workspace,
      serverUrl,
      model: requestedModel,
      reasoningEffort: requestedEffort
    });
    const sourceSessionId = req.body.sourceSessionId?.trim()
      ? await resolveRequestedSessionId(req.body.sourceSessionId.trim())
      : null;
    const sourceThreadId = req.body.sourceThreadId?.trim() || null;
    const sourceTurnId = req.body.sourceTurnId?.trim() || null;
    const sideChat = await sessionStore.recordSessionSideChat({
      sessionId: context.session.id,
      workspaceId: context.session.workspaceId,
      sourceSessionId,
      sourceThreadId,
      sourceTurnId,
      question,
      answer: answer.answer,
      model: answer.model,
      contextTurnCount: context.turnPage.total,
      contextFilter: req.body.q?.trim() || null,
      mode: "isolated_ephemeral_thread"
    });
    await recordBackgroundModelUsage({
      id: `background:session_question:${sideChat.id}`,
      task: "session_question",
      source: "app_server",
      workspaceId: context.session.workspaceId,
      sessionId: context.session.id,
      accountId: context.session.accountId,
      model: answer.model,
      usage: answer.usage
    });
    res.json({
      session: {
        id: context.session.id,
        threadId: context.session.threadId,
        title: context.session.title,
        created: context.session.created,
        updated: context.session.updated
      },
      question,
      turnCount: context.turnPage.total,
      model: answer.model,
      answer: answer.answer,
      sideChat
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/session-inspector/vector/status", async (_req, res) => {
  try {
    res.json(await sessionStore.getSessionVectorStatus());
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/session-inspector/vector/search", async (
  req: Request<object, object, SessionVectorSearchRequest>,
  res: Response
) => {
  try {
    res.json(await sessionStore.searchSessionVectors(req.body));
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.includes("embedding") || message.includes("session_description_embedding") ? 400 : 500).json({ error: message });
  }
});

app.post("/api/experimental/session-routing/keywords", async (
  req: Request<object, object, ExperimentalKeywordRoutingRequest>,
  res: Response
) => {
  const rawMessage = typeof req.body.message === "string"
    ? req.body.message
    : typeof req.body.prompt === "string"
      ? req.body.prompt
      : "";
  const message = rawMessage.trim();
  if (!message) {
    res.status(400).json({ error: "message is required." });
    return;
  }

  try {
    const workspace = await getRequestedOrActiveWorkspace(req.body.workspaceId);
    const vocabulary = await sessionStore.listSessionKeywordVocabulary({
      workspaceId: workspace.id,
      limit: normalizeExperimentalKeywordVocabularyLimit(req.body.vocabularyLimit)
    });
    const decision = await chooseExperimentalRouteKeywords({
      message,
      workspace,
      vocabulary,
      keywordLimit: normalizeExperimentalKeywordLimit(req.body.keywordLimit),
      model: normalizeModel(req.body.model) ?? experimentalSessionRouterModel()
    });
    const selectedKeywords = mergeExperimentalKeywordRouteKeywords({
      modelKeywords: decision.keywords,
      promptKeywords: extractExperimentalPromptKeywords(message),
      keywordLimit: normalizeExperimentalKeywordLimit(req.body.keywordLimit)
    });
    const keywordResults = await sessionStore.searchSessionsByKeywords({
      keywords: selectedKeywords,
      workspaceId: workspace.id,
      limit: normalizeExperimentalRouteLimit(req.body.limit),
      maxTextChars: normalizeExperimentalRouteMaxTextChars(req.body.maxTextChars)
    });

    res.json({
      ok: true,
      workspace,
      selectedKeywords,
      modelSelectedKeywords: decision.keywords,
      promptKeywords: extractExperimentalPromptKeywords(message),
      rawKeywordText: decision.rawText,
      candidates: experimentalKeywordRouteCandidates(keywordResults.results),
      keyword: keywordResults,
      vocabulary: {
        totalProvided: vocabulary.length,
        sample: vocabulary.slice(0, 40)
      }
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/experimental/session-routing", async (
  req: Request<object, object, ExperimentalSessionRoutingRequest>,
  res: Response
) => {
  const rawMessage = typeof req.body.message === "string"
    ? req.body.message
    : typeof req.body.prompt === "string"
      ? req.body.prompt
      : "";
  const message = rawMessage.trim();
  if (!message) {
    res.status(400).json({ error: "message is required." });
    return;
  }

  try {
    const workspace = await getRequestedOrActiveWorkspace(req.body.workspaceId);
    const embedding = await embedSessionText(message);
    const limit = normalizeExperimentalRouteLimit(req.body.limit);
    const vectorResults = await sessionStore.searchSessionVectors({
      embedding,
      workspaceId: workspace.id,
      limit,
      maxTextChars: normalizeExperimentalRouteMaxTextChars(req.body.maxTextChars)
    });
    const candidates = experimentalRouteCandidates(vectorResults.results);
    const decision = await chooseExperimentalSessionRoute({
      message,
      workspace,
      candidates,
      clues: loadExperimentalRoutingClues(),
      model: normalizeModel(req.body.model) ?? experimentalSessionRouterModel()
    });
    const selectedCandidate = normalizeExperimentalRouteDecision(decision, candidates, message);
    let activeSessionId: string | null | undefined;

    if (req.body.apply === true && selectedCandidate.action === "resume" && selectedCandidate.sessionId) {
      const previousActiveSessionId = await sessionStore.getActiveSessionId();
      const session = await sessionStore.switchSession(selectedCandidate.sessionId);
      sessionSummarizer.noteSessionActivity(session.id);
      if (previousActiveSessionId && previousActiveSessionId !== session.id) {
        sessionSummarizer.noteSessionActivity(previousActiveSessionId);
      }
      activeSessionId = session.id;
    }

    res.json({
      ok: true,
      action: selectedCandidate.action,
      routeId: selectedCandidate.routeId,
      sessionId: selectedCandidate.sessionId,
      threadId: selectedCandidate.threadId,
      executorPrompt: selectedCandidate.executorPrompt,
      routingText: formatExperimentalRoutingText(selectedCandidate.routeId, selectedCandidate.executorPrompt),
      applied: req.body.apply === true && selectedCandidate.action === "resume",
      ...(activeSessionId !== undefined ? { activeSessionId } : {}),
      workspace,
      candidates,
      vector: {
        mode: vectorResults.mode,
        page: vectorResults.page
      }
    });
  } catch (error) {
    const messageText = errorMessage(error);
    res.status(messageText.includes("embedding") || messageText.includes("session_description_embedding") ? 400 : 500).json({
      error: messageText
    });
  }
});

app.post("/api/runner/update", async (req: Request<object, object, RunnerUpdateRequest>, res: Response) => {
  const update = req.body;
  if (!isRunnerUpdate(update)) {
    res.status(400).json({ error: "Invalid runner update." });
    return;
  }

  try {
    await processRunnerUpdate(update);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/codex/hooks/stop", async (req: Request<object, object, CodexStopHookRequest>, res: Response) => {
  try {
    const result = await importCodexStopHook(req.body);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/runner/account-auth-sync", async (
  req: Request<object, object, RunnerAccountAuthSyncRequest>,
  res: Response
) => {
  const sessionId = req.body.sessionId?.trim();
  const turnId = req.body.turnId?.trim();
  const accountId = req.body.accountId?.trim();
  const authVersion = req.body.authVersion;
  if (!sessionId || !turnId || !accountId || !Number.isInteger(authVersion) || Number(authVersion) < 0) {
    res.status(400).json({ error: "sessionId, turnId, accountId, and authVersion are required." });
    return;
  }

  try {
    const [turn, session, account] = await Promise.all([
      sessionStore.getSessionTurn(turnId),
      sessionStore.getSession(sessionId),
      sessionStore.getAccount(accountId)
    ]);
    if (!turn || !session || !account) {
      res.status(404).json({ error: "Runner auth sync target was not found." });
      return;
    }
    if (turn.sessionId !== session.id || turn.accountId !== account.id || session.accountId !== account.id) {
      res.status(409).json({ error: "Runner auth sync does not match the stored session account." });
      return;
    }

    const workspace = await sessionStore.getWorkspace(session.workspaceId);
    if (!workspace) {
      res.status(404).json({ error: `Workspace not found: ${session.workspaceId}` });
      return;
    }
    const authPath = resolve(workspace.codexHome, "auth.json");
    if (!existsSync(authPath)) {
      res.status(409).json({ error: "Runner auth.json is missing." });
      return;
    }
    const authRaw = readFileSync(authPath, "utf8");
    const identityError = accountAuthIdentityError(authRaw, {
      externalAccountId: account.externalAccountId,
      externalUserId: account.externalUserId
    });
    if (identityError) {
      res.status(409).json({ error: `Refusing runner auth sync: ${identityError}.` });
      return;
    }
    const result = await sessionStore.compareAndSetAccountAuth(
      account.id,
      Number(authVersion),
      authRaw,
      readOptionalTextFile(resolve(workspace.codexHome, "config.toml"))
    );
    if (result === "conflict") {
      res.status(409).json({ error: "Account auth changed after this runner started." });
      return;
    }
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/runner/stream", async (req: Request<object, object, RunnerStreamRequest>, res: Response) => {
  const turnId = req.body.turnId?.trim();
  const requestedSessionId = req.body.sessionId?.trim();

  if (!turnId && !requestedSessionId) {
    res.status(400).json({ error: "turnId or sessionId is required." });
    return;
  }

  try {
    const turn = turnId
      ? await sessionStore.getSessionTurn(turnId)
      : requestedSessionId
        ? await sessionStore.getLatestRunningTurn(await resolveRequestedSessionId(requestedSessionId))
        : null;

    if (!turn) {
      // The reconnect request can race the original /api/chat request while
      // it is still recording the turn. Return a retryable HTTP response
      // instead of a successful SSE stream containing a terminal-looking
      // error; otherwise the browser renders a transient "turn not found"
      // failure and stops reconnecting.
      res.status(404).json({ error: "Runner turn not found.", retryable: true });
      return;
    }

    if (!turn.runnerLogPath) {
      // A newly-created running turn gets its runner log path in a second
      // write, after the turn row is inserted. Treat that small window as
      // retryable for reconnects as well.
      res.status(409).json({ error: "Runner log is not ready yet.", retryable: true });
      return;
    }

    prepareEventStream(res);

    const abandoned = await abandonRunnerTurnIfStale(turn, "stream");
    if (abandoned) {
      emit(res, "pending", {
        sessionId: turn.sessionId,
        turnId: turn.id,
        message: "Prompt runner became stale and was saved for retry.",
        queued: true
      });
      emit(res, "done", { ok: true });
      return;
    }

    emit(res, "session", {
      sessionId: turn.sessionId,
      turnId: turn.id,
      message: turn.status === "running" ? "Reconnected to prompt runner" : "Loaded prompt runner log"
    });

    await streamRunnerLog(res, turn.runnerLogPath, null, {
      stopWhenProcessEnds: turn.status === "running",
      runnerPid: turn.runnerPid
    });
  } catch (error) {
    if (res.headersSent) {
      emit(res, "error", { message: errorMessage(error) });
      emit(res, "done", { ok: true });
    } else {
      res.status(500).json({ error: errorMessage(error) });
    }
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }
});

app.post("/api/runner/stop", async (req: Request<object, object, RunnerStopRequest>, res: Response) => {
  const turnId = req.body.turnId?.trim();
  const requestedSessionId = req.body.sessionId?.trim();

  if (!turnId && !requestedSessionId) {
    res.status(400).json({ error: "turnId or sessionId is required." });
    return;
  }

  try {
    let turn = turnId
      ? await sessionStore.getSessionTurn(turnId)
      : requestedSessionId
        ? await sessionStore.getLatestRunningTurn(await resolveRequestedSessionId(requestedSessionId))
        : null;

    if (!turn) {
      res.status(404).json({ error: "Runner turn not found." });
      return;
    }

    if (turn.status !== "running") {
      if (turn.status === "todo") {
        const pendingTurn = turn;
        const message = "Agent aborted. Todo turn was cancelled.";
        const cancelled = await sessionStore.updateSessionTurn({
          id: turn.id,
          agentResponse: message,
          tokenIn: turn.tokenIn,
          tokenOut: turn.tokenOut,
          status: "done",
          runnerExitCode: 143,
          expectedStatus: "todo"
        });
        if (cancelled) {
          const timer = pendingTurnTimers.get(pendingTurn.id);
          if (timer) clearTimeout(timer);
          pendingTurnTimers.delete(pendingTurn.id);
          await sessionStore.cancelWaitSubscriptionsForTurn(pendingTurn.id);
          await turnRingLog.appendAgentResponse({
            eventId: `response:${pendingTurn.id}:runner.stop`,
            source: "runner.stop",
            sessionId: pendingTurn.sessionId,
            turnId: pendingTurn.id,
            agentResponse: message,
            status: "done"
          });
          await sessionStore.recordSessionTurnEvent({
            turnId: pendingTurn.id,
            sessionId: pendingTurn.sessionId,
            eventName: "runner.aborted",
            payload: {
              reason: "explicit stop of pending turn",
              runnerPid: pendingTurn.runnerPid,
              runnerLogPath: pendingTurn.runnerLogPath
            }
          });
          res.json({
            ok: true,
            stopped: true,
            aborted: true,
            sessionId: pendingTurn.sessionId,
            turnId: pendingTurn.id,
            message
          });
          return;
        }

        // The automatic scheduler may have claimed the Todo between our read
        // and compare-and-set. Continue with the running cancellation path so
        // the newly spawned runner cannot escape an immediate Stop click.
        const claimedTurn = await sessionStore.getSessionTurn(pendingTurn.id);
        if (claimedTurn) turn = claimedTurn;
      }
    }

    if (turn.status !== "running") {
      res.json({
        ok: true,
        stopped: false,
        sessionId: turn.sessionId,
        turnId: turn.id,
        message: "Agent is not running."
      });
      return;
    }

    const cancellingStartedTodo = turn.pendingReason !== null;
    const message = cancellingStartedTodo
      ? "Agent aborted. Todo turn was cancelled."
      : "Agent stopped. Turn saved as todo and can be retried.";
    const stopEntries = cancellingStartedTodo
      ? buildRunnerCancelEntries(turn, message)
      : buildRunnerStopEntries(turn, message);
    // A cancellation result schedules the next Todo, so signal this runner
    // first and release the session only afterwards.
    // Resolve ownership from the current attempt, not the PID snapshot read
    // before Stop. It may have been spawned/attached during the awaits above.
    // Latch cancellation during startup before publishing a terminal state.
    const killedBeforeUpdate = runnerProcesses.stop(turn.runnerLogPath, turn.runnerPid);
    if (turn.runnerLogPath) {
      appendRunnerLogEntries(turn.runnerLogPath, stopEntries);
    }
    for (const entry of stopEntries) {
      await applyRunnerLogEntry(
        { ...entry, jsonlIndex: entry.jsonlIndex ?? 0 },
        turn.runnerLogPath ?? "",
        "live"
      );
    }

    const killed = runnerProcesses.stop(turn.runnerLogPath, turn.runnerPid) || killedBeforeUpdate;
    res.json({
      ok: true,
      stopped: true,
      aborted: cancellingStartedTodo,
      killed,
      sessionId: turn.sessionId,
      turnId: turn.id,
      message
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/runner/steer", async (req: Request<object, object, RunnerSteerRequest>, res: Response) => {
  const turnId = req.body.turnId?.trim();
  const requestedSessionId = req.body.sessionId?.trim();
  const message = req.body.message?.trim();

  if ((!turnId && !requestedSessionId) || !message) {
    res.status(400).json({ error: "message and either turnId or sessionId are required." });
    return;
  }

  try {
    const turn = turnId
      ? await sessionStore.getSessionTurn(turnId)
      : requestedSessionId
        ? await sessionStore.getLatestRunningTurn(await resolveRequestedSessionId(requestedSessionId))
        : null;

    if (!turn) {
      res.status(404).json({ error: "Runner turn not found." });
      return;
    }
    if (requestedSessionId && turn.sessionId !== await resolveRequestedSessionId(requestedSessionId)) {
      res.status(409).json({ error: "The running turn does not belong to this session." });
      return;
    }
    if (turn.status !== "running" || !turn.runnerPid || !isProcessAlive(turn.runnerPid)) {
      res.status(409).json({ error: "Agent is not running." });
      return;
    }

    const commandId = crypto.randomUUID();
    const session = await sessionStore.getSession(turn.sessionId);
    const command: RunnerSteerCommand = {
      id: commandId,
      message,
      attachments: saveUploadedAttachments(uploadDir, `steer-${commandId}`, req.body.attachments),
      skills: resolveRequestedSkills(req.body.skills, session?.workspaceId ?? "")
    };
    await turnRingLog.appendUserPrompt({
      eventId: `prompt:${turn.id}:steer:${commandId}`,
      source: "runner.steer",
      sessionId: turn.sessionId,
      turnId: turn.id,
      userPrompt: command.attachments.length > 0
        ? formatStoredUserInput(message, command.attachments)
        : message
    });
    mkdirSync(runnerControlDir, { recursive: true });
    appendFileSync(runnerControlPath(turn.id), `${JSON.stringify(command)}\n`, "utf8");

    const result = await waitForRunnerSteerResult(commandId, turn.id, turn.runnerPid);
    if (!result.ok) {
      res.status(409).json({ error: result.error || "The runner rejected the steer.", ...result });
      return;
    }

    const attachmentPayload = command.attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      type: attachment.mimeType,
      mimeType: attachment.mimeType,
      size: attachment.size,
      path: attachment.path
    }));
    await sessionStore.recordSessionTurnEvent({
      id: `steer:${commandId}`,
      turnId: turn.id,
      sessionId: turn.sessionId,
      eventName: "steer",
      payload: {
        id: commandId,
        content: message,
        attachments: attachmentPayload,
        forcePlan: req.body.forcePlan === true
      }
    });

    res.json({
      ok: true,
      commandId,
      sessionId: turn.sessionId,
      turnId: turn.id,
      appTurnId: result.appTurnId ?? null,
      attachments: attachmentPayload,
      message: "Agent steered."
    });
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.includes("timed out") ? 504 : 500).json({ error: message });
  }
});

app.post("/api/pending-turns", async (req: Request<object, object, PendingTurnCreateRequest>, res: Response) => {
  const message = req.body.message?.trim();
  if (!message) {
    res.status(400).json({ error: "Message is required." });
    return;
  }

  try {
    const chatRequest = await prepareAutoLoadBalancedChatRequest(req.body);
    const session = await getOrCreateSession(chatRequest, message);
    if (chatRequest.forcePlan === true) await enableOutcomeTracking(session.id);
    const turnId = chatRequest.turnId?.trim() || crypto.randomUUID();
    const existingTurn = await sessionStore.getSessionTurn(turnId);
    if (existingTurn) {
      if (existingTurn.sessionId !== session.id) {
        res.status(409).json({ error: "turnId already belongs to another session." });
        return;
      }
      res.json({
        ok: true,
        duplicate: true,
        sessionId: session.id,
        threadId: session.threadId ?? null,
        activeAccount: session.account,
        turn: existingTurn
      });
      return;
    }
    const attachments = saveUploadedAttachments(uploadDir, turnId, chatRequest.attachments);
    const messageForStorage = attachments.length > 0 ? formatStoredUserInput(message, attachments) : message;
    await recordSessionTurnWithLog({
      id: turnId,
      sessionId: session.id,
      accountId: session.accountId,
      accountName: session.accountName,
      accountEmail: session.accountEmail,
      accountExternalAccountId: session.accountExternalAccountId,
      accountExternalUserId: session.accountExternalUserId,
      userInput: messageForStorage,
      agentResponse: "Queued. Waiting for the current turn to finish.",
      tokenIn: 0,
      tokenOut: 0,
      status: "todo",
      pendingReason: "queued",
      pendingLoadBalance: chatRequest.loadBalanceInWorkspace === true
    }, "pending.create");

    const turn = await sessionStore.getSessionTurn(turnId);
    void schedulePendingTurnsForSession(session.id).catch((error) => {
      console.warn(`Failed to schedule newly queued pending turn ${turnId}: ${errorMessage(error)}`);
    });
    res.json({
      ok: true,
      sessionId: session.id,
      threadId: session.threadId ?? null,
      activeAccount: session.account,
      turn
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.patch("/api/pending-turns/:turnId", async (
  req: Request<{ turnId: string }, object, PendingTurnUpdateRequest>,
  res: Response
) => {
  const turnId = req.params.turnId.trim();
  const sessionId = req.body.sessionId?.trim();
  const message = req.body.message?.trim();

  if (!turnId || !sessionId || !message) {
    res.status(400).json({ error: "turnId, sessionId, and message are required." });
    return;
  }

  try {
    const turn = await sessionStore.updatePendingSessionTurn({
      id: turnId,
      sessionId,
      userInput: message
    });
    await turnRingLog.appendUserPrompt({
      eventId: `prompt:${turnId}:pending.edit:${crypto.randomUUID()}`,
      source: "pending.edit",
      sessionId,
      turnId,
      userPrompt: message
    });
    res.json({ ok: true, turn });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.post("/api/pending-turns/:turnId/move", async (
  req: Request<{ turnId: string }, object, PendingTurnMoveRequest>,
  res: Response
) => {
  const turnId = req.params.turnId.trim();
  const sessionId = req.body.sessionId?.trim();
  const direction = req.body.direction;

  if (!turnId || !sessionId || (direction !== "up" && direction !== "down")) {
    res.status(400).json({ error: "turnId, sessionId, and direction are required." });
    return;
  }

  try {
    const turns = await sessionStore.movePendingSessionTurn({ id: turnId, sessionId, direction });
    res.json({ ok: true, turns });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.get("/api/approvals", (req, res) => {
  const turnId = typeof req.query.turnId === "string" ? req.query.turnId : null;
  const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : null;
  const approvals = [...pendingApprovals.values()]
    .filter((approval) => approval.decision === undefined)
    .filter((approval) => !turnId || approval.turnId === turnId)
    .filter((approval) => !sessionId || approval.sessionId === sessionId)
    .map(publicApprovalRecord);
  res.json({ approvals });
});

app.post("/api/approvals/request", async (req: Request<object, object, ApprovalRequestBody>, res: Response) => {
  const approval = approvalFromRequest(req.body);
  if (!approval) {
    res.status(400).json({ error: "Invalid approval request." });
    return;
  }

  const existing = pendingApprovals.get(approval.approvalId);
  pendingApprovals.set(approval.approvalId, existing ? { ...existing, ...approval } : approval);
  res.json({ ok: true, approval: publicApprovalRecord(pendingApprovals.get(approval.approvalId) ?? approval) });
});

app.post("/api/approvals/:approvalId/wait", async (req: Request<{ approvalId: string }>, res: Response) => {
  const approvalId = req.params.approvalId;
  const approval = pendingApprovals.get(approvalId);
  if (!approval) {
    res.status(409).json({ error: "Approval request is no longer pending.", stale: true, approvalId });
    return;
  }

  if (approval.decision !== undefined) {
    pendingApprovals.delete(approvalId);
    res.json({ decision: approval.decision });
    return;
  }

  const timer = setTimeout(() => {
    resolveApproval(approvalId, "cancel");
  }, approvalWaitMs);
  timer.unref();

  const decision = await new Promise<unknown>((resolveDecision) => {
    approval.resolve = (value) => {
      clearTimeout(timer);
      resolveDecision(value);
    };
  });

  pendingApprovals.delete(approvalId);
  res.json({ decision });
});

app.post("/api/approvals/:approvalId/decision", async (req: Request<{ approvalId: string }, object, ApprovalDecisionBody>, res: Response) => {
  const approvalId = req.params.approvalId;
  const approval = pendingApprovals.get(approvalId);
  if (!approval) {
    res.status(409).json({ error: "Approval request is no longer pending.", stale: true, approvalId });
    return;
  }

  const decision = approval.method === USER_INPUT_METHOD
    ? req.body.decision === "cancel" ? "cancel" : inputResponse(req.body.decision, approval.params)
    : normalizeApprovalDecision(req.body.decision);
  if (decision === null) {
    res.status(400).json({ error: "Invalid approval decision." });
    return;
  }

  try {
    await sessionStore.recordSessionTurnEvent({
      turnId: approval.turnId,
      sessionId: approval.sessionId,
      eventName: "approval.decision",
      payload: {
        approvalId,
        requestId: approval.requestId,
        method: approval.method,
        decision
      }
    });
  } catch (error) {
    console.warn(`Failed to persist approval decision ${approvalId}: ${errorMessage(error)}`);
  }

  const resolvedApprovalIds = resolveApprovalWithRelated(approvalId, decision);
  res.json({ ok: true, resolvedApprovalIds });
});

app.post("/api/session-tasks", async (req: Request<object, object, CreateSessionTaskRequest>, res: Response) => {
  const requestedParentSessionId = req.body.parentSessionId?.trim();
  const prompt = req.body.prompt?.trim();
  if (!requestedParentSessionId || !prompt) {
    res.status(400).json({ error: "parentSessionId and prompt are required." });
    return;
  }
  if (prompt.length > 250_000) {
    res.status(400).json({ error: "prompt must be at most 250000 characters." });
    return;
  }

  try {
    const parentSessionId = await resolveRequestedSessionId(requestedParentSessionId);
    const parentSession = await sessionStore.getSession(parentSessionId);
    if (!parentSession) {
      res.status(404).json({ error: `Session not found: ${requestedParentSessionId}` });
      return;
    }

    const requestedSourceSessionId = req.body.sourceSessionId?.trim();
    const sourceSessionId = requestedSourceSessionId
      ? await resolveRequestedSessionId(requestedSourceSessionId)
      : null;
    const workerAssignment = sourceSessionId
      ? await sessionStore.getTodoWorkerAssignment(sourceSessionId)
      : null;
    let existingTodoWorkerSessionId: string | null = null;
    if (req.body.todoItemId) {
      const todo = await sessionStore.getSessionTodo(parentSessionId);
      const item = todo.items.find((candidate) => candidate.id === req.body.todoItemId);
      if (!item) {
        res.status(404).json({ error: `Todo item not found: ${req.body.todoItemId}` });
        return;
      }
      const existingWorker = todo.itemSessions.find((candidate) =>
        candidate.itemId === item.id && candidate.role === "worker"
      );
      existingTodoWorkerSessionId = item.childSessionId ?? existingWorker?.childSessionId ?? null;
    }

    const taskCreationPolicy = decideSessionTaskCreation({
      sourceSessionId,
      parentSessionId,
      todoItemId: req.body.todoItemId ?? null,
      contextFork: req.body.contextFork === true,
      workerAssignment,
      existingTodoWorkerSessionId
    });
    if (!taskCreationPolicy.allowed) {
      res.status(409).json({
        error: taskCreationPolicy.reason === "worker_followup"
          ? "Todo worker follow-ups must continue in their existing task. A worker may create another task only through an explicit context fork."
          : "This Todo item already has a worker task. Continue that task instead of creating another one.",
        sessionId: taskCreationPolicy.sessionId,
        parentSessionId: taskCreationPolicy.parentSessionId,
        todoItemId: taskCreationPolicy.todoItemId
      });
      return;
    }

    const sessionId = createLocalSessionId();
    const startImmediately = req.body.startImmediately === true;
    const turnId = startImmediately ? crypto.randomUUID() : null;
    const requestedTitle = req.body.title?.trim();
    const metadata = sessionStore.normalizeMetadata({
      title: requestedTitle,
      parentSessionId
    }, prompt);
    const childSession = await sessionStore.upsertSession({
      id: sessionId,
      threadId: null,
      workspaceId: parentSession.workspaceId,
      cwd: parentSession.cwd,
      accountId: parentSession.accountId,
      keywordWeights: metadata.keywordWeights,
      title: requestedTitle ? metadata.title : markCodexSessionTitlePending(metadata.title),
      titleSource: requestedTitle ? "user" : "initial",
      description: metadata.description,
      parentSessionId
    });
    const childModel = normalizeModel(req.body.model);
    const childModelReasoningEffort = normalizeReasoningEffort(req.body.modelReasoningEffort);
    if (childModel) {
      const parentPreferences = await sessionStore.getSessionModelPreferences(parentSessionId);
      const activeGearIndex = parentPreferences.activeGearIndex;
      const gearProfiles = parentPreferences.gearProfiles.map((profile, index) => index === activeGearIndex
        ? { model: childModel, effort: childModelReasoningEffort ?? profile.effort }
        : profile
      );
      await sessionStore.setSessionModelPreferences(childSession.id, {
        selectedModel: childModel,
        selectedEffort: childModelReasoningEffort ?? parentPreferences.selectedEffort,
        gearProfiles,
        activeGearIndex
      });
    }

    await publishRingEvent({
      eventId: crypto.randomUUID(),
      type: "session.task.created",
      workspaceId: childSession.workspaceId,
      sessionId: childSession.id,
      turnId: turnId ?? null,
      payload: { parentSessionId, sessionId: childSession.id, started: startImmediately }
    });

    const todoChildTask = req.body.todoItemId
      ? await buildTodoChildTaskContext(parentSessionId, req.body.todoItemId, prompt)
      : null;
    const taskPrompt = todoChildTask?.prompt ?? prompt;
    const taskDeveloperInstructions = combineDeveloperInstructions(
      req.body.developerInstructions,
      todoChildTask?.developerInstructions
    );
    if (req.body.todoItemId) {
      await sessionStore.updateTodoItem({
        id: req.body.todoItemId,
        sessionId: parentSessionId,
        ...(startImmediately ? { status: "active" as const } : {}),
        actor: "agent",
        turnId: turnId ?? undefined,
        activeStatus: startImmediately
          ? todoChildTask
            ? delegatedTodoActiveStatus(prompt, todoChildTask.item)
            : "Delegated to a background child task."
          : null,
        childSessionId: childSession.id,
        childTurnId: turnId
      });
      const todo = await sessionStore.linkTodoItemSession({
        sessionId: parentSessionId,
        itemId: req.body.todoItemId,
        childSessionId: childSession.id,
        childTurnId: turnId,
        title: childSession.title,
        role: "worker"
      });
      await publishTodoChanged(parentSessionId, todo);
    }

    if (startImmediately && turnId) {
      void runCreatedSessionTask({
        sessionId: childSession.id,
        turnId,
        parentSession,
        prompt: taskPrompt,
        model: req.body.model,
        modelReasoningEffort: req.body.modelReasoningEffort,
        approvalPolicy: req.body.approvalPolicy,
        executionMode: req.body.executionMode,
        skills: req.body.skills,
        developerInstructions: taskDeveloperInstructions,
        todoParentSessionId: req.body.todoItemId ? parentSessionId : undefined,
        todoItemId: req.body.todoItemId
      });
    }

    res.status(202).json({
      ok: true,
      sessionId: childSession.id,
      turnId,
      parentSessionId,
      todoItemId: req.body.todoItemId ?? null,
      started: startImmediately,
      uri: buildCodexReference(childSession.workspaceId, childSession.id),
      title: childSession.title
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

async function runCreatedSessionTask(input: {
  sessionId: string;
  turnId: string;
  parentSession: SessionRecord;
  prompt: string;
  model?: string;
  modelReasoningEffort?: string;
  approvalPolicy?: ApprovalPolicy;
  executionMode?: ExecutionMode;
  skills?: RequestedSkill[];
  developerInstructions?: string;
  todoParentSessionId?: string;
  todoItemId?: string;
}) {
  try {
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: input.prompt,
        sessionId: input.sessionId,
        turnId: input.turnId,
        workspaceId: input.parentSession.workspaceId,
        accountId: input.parentSession.accountId,
        loadBalanceInWorkspace: false,
        model: input.model,
        modelReasoningEffort: input.modelReasoningEffort,
        approvalPolicy: input.approvalPolicy,
        executionMode: input.executionMode,
        skills: input.skills,
        developerInstructions: input.developerInstructions,
        todoParentSessionId: input.todoParentSessionId,
        todoItemId: input.todoItemId,
        taskChild: true,
        backgroundTask: true
      } satisfies ChatRequest)
    });
    if (!response.ok) {
      throw new Error(`Background task returned HTTP ${response.status}`);
    }
    await response.arrayBuffer();
  } catch (error) {
    console.warn(`Background task ${input.sessionId} failed: ${errorMessage(error)}`);
  }
}

async function buildTodoChildTaskContext(parentSessionId: string, todoItemId: string, prompt: string) {
  const todo = await sessionStore.getSessionTodo(parentSessionId);
  const item = todo.items.find((candidate) => candidate.id === todoItemId);
  if (!item) {
    throw new Error(`Todo item not found: ${todoItemId}`);
  }
  return {
    item,
    ...buildTodoChildTaskContextFromSnapshot({
      parentSessionId,
      todoItemId,
      prompt,
      todo
    })
  };
}

app.post("/api/chat", async (req: Request<object, object, ChatRequest>, res: Response) => {
  const requestedMessage = req.body.message?.trim();
  const retryPending = req.body.retryPending === true;

  if (retryPending && req.get("X-Threadex-Automatic-Pending") !== "1") {
    res.status(409).json({ error: "Pending turns are retried automatically after the account limit reset." });
    return;
  }

  // A retry must always target an already-persisted pending turn.  Validate
  // this before getOrCreateSession(): otherwise a stale scheduler request can
  // create an empty session titled "Retry pending turn" and then discover it
  // has nothing to run.
  if (retryPending) {
    const retrySessionId = req.body.sessionId?.trim();
    const retryTurnId = req.body.turnId?.trim();
    if (!retrySessionId || !retryTurnId) {
      res.status(400).json({ error: "retryPending requires sessionId and turnId." });
      return;
    }
    const retrySession = await getSessionForRequestedId(retrySessionId);
    if (!retrySession) {
      res.status(404).json({ error: "Pending retry session not found." });
      return;
    }
    const retryTurn = await sessionStore.getSessionTurn(retryTurnId);
    if (!retryTurn || retryTurn.sessionId !== retrySession.id || retryTurn.status !== "todo") {
      res.status(409).json({ error: "Pending retry turn is no longer available." });
      return;
    }
  }

  if (!requestedMessage && !retryPending) {
    res.status(400).json({ error: "Message is required." });
    return;
  }

  prepareEventStream(res);

  let runner: ChildProcess | null = null;
  let claimedTurnId: string | null = null;
  try {
    const sessionMessage = requestedMessage || "Retry pending turn";
    const chatRequest = await prepareAutoLoadBalancedChatRequest(req.body);
    const session = await getOrCreateSession(chatRequest, sessionMessage);
    // A Todo worker keeps owning the same item for every later turn in its child
    // session. The browser follow-up request does not carry these internal fields,
    // so recover them from the task-to-item link instead of treating it as a new
    // planner turn (which can cause an unnecessary second child task).
    const todoWorkerAssignment = chatRequest.todoParentSessionId && chatRequest.todoItemId
      ? { parentSessionId: chatRequest.todoParentSessionId, itemId: chatRequest.todoItemId }
      : await sessionStore.getTodoWorkerAssignment(session.id);
    // Always claim the exact turn selected by the scheduler. A stop can race
    // this request after the initial validation, and falling back to the next
    // Todo would otherwise start a different queued prompt unexpectedly.
    const pendingTurn = retryPending && req.body.turnId
      ? await sessionStore.getSessionTurn(req.body.turnId.trim())
      : null;

    if (
      retryPending &&
      (!pendingTurn || pendingTurn.sessionId !== session.id || pendingTurn.status !== "todo")
    ) {
      emit(res, "pending", {
        sessionId: session.id,
        threadId: session.threadId ?? undefined,
        message: "No pending turns to run.",
        queued: false
      });
      emit(res, "done", { ok: true });
      return;
    }

    const message = pendingTurn?.userInput ?? requestedMessage ?? sessionMessage;
    const requestedTurnId = pendingTurn?.id ?? chatRequest.turnId?.trim();
    const requestedTurn = requestedTurnId ? await sessionStore.getSessionTurn(requestedTurnId) : null;

    // A pending retry reuses the same turn row, but must not replay the prior
    // attempt's terminal log. Replaying an old `pending` entry schedules the
    // same turn again and creates a zero-delay retry loop.
    if (requestedTurn?.runnerLogPath && !retryPending) {
      emit(res, "session", {
        sessionId: requestedTurn.sessionId,
        threadId: session.threadId ?? undefined,
        turnId: requestedTurn.id,
        message: requestedTurn.status === "running" ? "Reconnected to prompt runner" : "Loaded prompt runner log"
      });
      await streamRunnerLog(res, requestedTurn.runnerLogPath, null, {
        stopWhenProcessEnds: requestedTurn.status === "running",
        runnerPid: requestedTurn.runnerPid
      });
      return;
    }

    const matchingRunningTurn =
      !retryPending && !chatRequest.grillOrigin && requestedMessage ? await getMatchingRunningTurn(session.id, message) : null;

    if (matchingRunningTurn?.runnerLogPath) {
      emit(res, "session", {
        sessionId: session.id,
        threadId: session.threadId ?? undefined,
        turnId: matchingRunningTurn.id,
        message: "Reconnected to prompt runner"
      });
      await streamRunnerLog(res, matchingRunningTurn.runnerLogPath, null, {
        stopWhenProcessEnds: true,
        runnerPid: matchingRunningTurn.runnerPid
      });
      return;
    }

    if (chatRequest.forcePlan === true) await enableOutcomeTracking(session.id);
    const lightweightTodo = Boolean(await sessionStore.getOutcomePlan(session.id));
    const todoPlanClarificationPending = false;
    const forcePlanForTurn = false;
    const turnId = requestedTurnId ?? crypto.randomUUID();
    const runnerAttemptId = pendingTurn ? `${turnId}.${crypto.randomUUID()}` : turnId;
    const logPath = resolve(runnerLogDir, `${runnerAttemptId}.ndjson`);
    const pendingLogPath = resolve(pendingRunnerLogDir, `${runnerAttemptId}.ndjson`);
    const attachments = pendingTurn ? [] : saveUploadedAttachments(uploadDir, turnId, chatRequest.attachments);
    const messageForStorage = attachments.length > 0 ? formatStoredUserInput(message, attachments) : message;
    if (!pendingTurn) {
      const claim = await sessionStore.claimSessionTurn({
        id: turnId,
        sessionId: session.id,
        accountId: session.accountId,
        accountName: session.accountName,
        accountEmail: session.accountEmail,
        accountExternalAccountId: session.accountExternalAccountId,
        accountExternalUserId: session.accountExternalUserId,
        userInput: messageForStorage,
        agentResponse: "",
        tokenIn: 0,
        tokenOut: 0,
        status: "running",
        // This survives an API restart while the externally managed runner is
        // still executing, so a later rate-limit callback can choose another
        // workspace account.
        pendingLoadBalance: chatRequest.loadBalanceInWorkspace === true
      });
      if (claim.disposition === "reconnected") {
        emit(res, "session", {
          sessionId: session.id,
          threadId: session.threadId ?? undefined,
          turnId: claim.turn.id,
          message: claim.turn.runnerLogPath ? "Reconnected to prompt runner" : "Prompt runner is starting"
        });
        if (claim.turn.runnerLogPath) {
          await streamRunnerLog(res, claim.turn.runnerLogPath, null, {
            stopWhenProcessEnds: true,
            runnerPid: claim.turn.runnerPid
          });
        } else {
          emit(res, "pending", {
            sessionId: session.id,
            threadId: session.threadId ?? undefined,
            turnId: claim.turn.id,
            message: "This turn is already starting.",
            queued: false
          });
          emit(res, "done", { ok: true });
        }
        return;
      }
      if (claim.disposition === "queued") {
        if (chatRequest.grillOrigin) {
          const grill = await sessionStore.acknowledgeTurnGrill(session.id, chatRequest.grillOrigin.turnId, chatRequest.grillOrigin.observedVersion, turnId);
          emit(res, "grill_ack", { sessionId: session.id, turnId: chatRequest.grillOrigin.turnId, grill });
        }
        await appendSessionTurnPromptLog(claim.turn, "chat.queued");
        emit(res, "session", {
          sessionId: session.id,
          threadId: session.threadId ?? undefined,
          turnId: claim.turn.id,
          ...(attachments.length > 0 ? {
            attachments: attachments.map((attachment) => ({
              id: attachment.id,
              name: attachment.name,
              type: attachment.mimeType,
              mimeType: attachment.mimeType,
              size: attachment.size,
              path: attachment.path
            }))
          } : {}),
          message: "Queued behind the active turn"
        });
        emit(res, "pending", {
          sessionId: session.id,
          threadId: session.threadId ?? undefined,
          turnId: claim.turn.id,
          message: claim.turn.agentResponse,
          queued: true,
          reason: "queued"
        });
        emit(res, "done", { ok: true });
        return;
      }
      if (claim.disposition === "existing") {
        emit(res, "session", {
          sessionId: session.id,
          threadId: session.threadId ?? undefined,
          turnId: claim.turn.id,
          message: "Loaded existing turn"
        });
        emit(res, "result", {
          sessionId: session.id,
          threadId: session.threadId ?? undefined,
          turnId: claim.turn.id,
          reply: claim.turn.agentResponse,
          tokenIn: claim.turn.tokenIn,
          tokenOut: claim.turn.tokenOut
        });
        emit(res, "done", { ok: true });
        return;
      }
      claimedTurnId = claim.turn.id;
      await appendSessionTurnPromptLog(claim.turn, "chat.start");
    } else {
      const claim = await sessionStore.claimPendingSessionTurn(turnId, session.id, logPath);
      if (claim.disposition !== "started") {
        if (claim.disposition === "already_running" && claim.turn?.runnerLogPath) {
          emit(res, "session", {
            sessionId: session.id,
            threadId: session.threadId ?? undefined,
            turnId: claim.turn.id,
            message: "Reconnected to pending prompt runner"
          });
          await streamRunnerLog(res, claim.turn.runnerLogPath, null, {
            stopWhenProcessEnds: true,
            runnerPid: claim.turn.runnerPid
          });
          return;
        }
        if (claim.disposition === "completed" && claim.turn) {
          emit(res, "result", {
            sessionId: session.id,
            threadId: session.threadId ?? undefined,
            turnId: claim.turn.id,
            reply: claim.turn.agentResponse,
            tokenIn: claim.turn.tokenIn,
            tokenOut: claim.turn.tokenOut
          });
        } else {
          emit(res, "pending", {
            sessionId: session.id,
            threadId: session.threadId ?? undefined,
            turnId,
            message: claim.disposition === "missing"
              ? "Pending turn is no longer available."
              : "Still queued behind the active turn.",
            queued: claim.disposition !== "missing",
            reason: "queued"
          });
        }
        emit(res, "done", { ok: true });
        return;
      }
      claimedTurnId = turnId;
    }
    if (!retryPending && chatRequest.grillOrigin) {
      const grill = await sessionStore.acknowledgeTurnGrill(session.id, chatRequest.grillOrigin.turnId, chatRequest.grillOrigin.observedVersion, turnId);
      emit(res, "grill_ack", { sessionId: session.id, turnId: chatRequest.grillOrigin.turnId, grill });
    }
    await sessionStore.assignSessionTurnAccount(turnId, {
      accountId: session.accountId,
      accountName: session.accountName,
      accountEmail: session.accountEmail,
      accountExternalAccountId: session.accountExternalAccountId,
      accountExternalUserId: session.accountExternalUserId
    });

    let autoModel = retryPending
      ? await sessionStore.getSessionAutoModel(session.id)
      : await sessionStore.setSessionAutoModelEnabled(session.id, chatRequest.autoModel === true);
    const recoverySession = await sessionStore.getSession(session.id);
    const recoveryTurns = recoverySession ? await sessionStore.listSessionTurns(session.id) : [];
    const typeSafeApiKey = autoModel.enabled ? autoModelSettings.apiKey() : undefined;
    if (autoModel.enabled && recoverySession) {
      const selection = await selectAutoModel({
        state: buildAutoModelState({
          prompt: messageForStorage,
          session: recoverySession,
          turns: recoveryTurns,
          currentTurnId: turnId,
          liveItemsByTurn: await sessionStore.listSessionLiveItems(session.id)
        }),
        apiKey: typeSafeApiKey,
        ...autoModelSettings.customRules(),
        fallback: autoModel
      });
      if (selection.provider === "typesafe") {
        autoModel = await sessionStore.selectSessionAutoModel({ sessionId: session.id, model: selection.model, effort: selection.effort });
      }
      const selectionEvent = { ...selection, ...autoModel, turnId };
      await sessionStore.recordSessionTurnEvent({ sessionId: session.id, turnId, eventName: "auto_model.selected", payload: selectionEvent });
      emit(res, "auto_model.selected", selectionEvent);
    }
    await sessionStore.setWorkspaceModelPreferences(
      session.workspaceId,
      chatRequest.modelPreferences ?? {}
    );
    const autoModelPromptFullVersion = autoModel.enabled
      ? await sessionStore.claimSessionAutoModelPrompt(session.id)
      : false;
    const model = autoModel.enabled ? autoModel.model : normalizeModel(chatRequest.model);
    const modelReasoningEffort = autoModel.enabled
      ? normalizeReasoningEffort(autoModel.effort)
      : normalizeReasoningEffort(chatRequest.modelReasoningEffort);
    const requestedSkills = resolveRequestedSkills(chatRequest.skills, session.workspaceId);
    await sessionStore.recordTokenUsage([{
      id: `agent:turn:${turnId}`,
      usageType: "agent",
      source: "turn_started",
      sessionId: session.id,
      turnId,
      accountId: session.accountId,
      model,
      metadata: {
        reasoningEffort: modelReasoningEffort,
        autoModel: autoModel.enabled,
        autoModelRevision: autoModel.revision,
        skills: requestedSkills.map((skill) => skill.name)
      }
    }]);

    const recoveryContext = recoverySession
      ? buildSessionRecoveryContext({
          session: recoverySession,
          turns: recoveryTurns,
          currentTurnId: turnId,
          sourceThreadId: session.threadId ?? null,
          reason: session.accountChanged ? "account_changed" : "thread_unavailable"
        })
      : null;
    let forceRecoveryOnResume = false;
    if (recoverySession?.threadId && recoveryTurns.some((turn) =>
      turn.pendingReason === "auth" || isAccountLoginRequiredMessage(turn.agentResponse)
    )) {
      const [sessionEventInspection, recoveryEventInspection] = await Promise.all([
        sessionStore.inspectSession({
          sessionId: session.id,
          includeEvents: true,
          eventName: "session",
          eventLimit: 200,
          order: "desc",
          turnLimit: 1,
          maxTextChars: 1
        }),
        sessionStore.inspectSession({
          sessionId: session.id,
          includeEvents: true,
          eventName: "context_recovery",
          eventLimit: 200,
          order: "desc",
          turnLimit: 1,
          maxTextChars: 1
        })
      ]);
      forceRecoveryOnResume = shouldForcePersistedRecovery({
        session: recoverySession,
        turns: recoveryTurns,
        currentTurnId: turnId,
        sessionEvents: sessionEventInspection?.events ?? [],
        recoveryEvents: recoveryEventInspection?.events ?? []
      });
    }
    const startupSnapshot = session.threadId ? undefined : buildStartupSnapshot(session.cwd);
    // Composer Todo opts into the persistent lightweight harness. Explicit Plan mode remains separate.
    const runnerDeveloperInstructions = chatRequest.developerInstructions;
    const job: RunnerJob = {
      sessionId: session.id,
      turnId,
      message,
      threadId: session.threadId ?? undefined,
      model,
      modelReasoningEffort,
      approvalPolicy: normalizeApprovalPolicy(chatRequest.approvalPolicy),
      autoModelEnabled: autoModel.enabled,
      autoModelRevision: autoModel.revision,
      autoModelPromptFullVersion,
      executionMode: chatRequest.contextFork === true ? "default" : normalizeExecutionMode(chatRequest.executionMode),
      forcePlan: forcePlanForTurn,
      lightweightTodo,
      todoPlanClarificationPending,
      skills: requestedSkills,
      attachments,
      serverUrl,
      logPath,
      pendingLogPath,
      controlPath: runnerControlPath(turnId),
      controlResultDir: runnerControlResultDir,
      workspaceId: session.workspaceId,
      codexHome: session.codexHome,
      cwd: session.cwd,
      accountId: session.accountId,
      accountExternalAccountId: session.accountExternalAccountId,
      accountExternalUserId: session.accountExternalUserId,
      accountAuthVersion: session.accountAuthVersion,
      startupSnapshot,
      contextParentSessionId:
        chatRequest.taskChild === true && !session.threadId
          ? session.parentSessionId ?? undefined
          : undefined,
      contextForkRequest: chatRequest.contextFork === true,
      childExecutionMode: chatRequest.contextFork === true
        ? normalizeExecutionMode(chatRequest.executionMode)
        : undefined,
      todoParentSessionId: todoWorkerAssignment?.parentSessionId,
      todoItemId: todoWorkerAssignment?.itemId,
      developerInstructions: runnerDeveloperInstructions,
      recoveryContext: recoveryContext ?? undefined,
      forceRecoveryOnResume
    };

    await waitForAccountQuotaRefresh(session.accountId);
    try {
      captureTurnGitBaseline(dataDir, turnId, session.cwd);
    } catch (error) {
      console.warn(`${session.id}: Could not capture shadow Git baseline for turn review: ${errorMessage(error)}`);
    }

    // Stop can arrive while a claimed turn is waiting for quota/account setup.
    // Do not spawn a runner after that stop has already made the turn terminal.
    const turnBeforeSpawn = await sessionStore.getSessionTurn(turnId);
    if (turnBeforeSpawn?.status !== "running") {
      emit(res, "done", { ok: true, stopped: true });
      return;
    }
    runner = await spawnPromptRunner(job);
    console.log(`${session.id}: Prompt runner started.`);
    const runnerAttached = await sessionStore.markSessionTurnRunning({
      id: turnId,
      runnerPid: runner.pid ?? 0,
      runnerLogPath: logPath
    });
    if (!runnerAttached) {
      terminateRunnerProcess(runner.pid ?? null);
      emit(res, "done", { ok: true, stopped: true });
      return;
    }

    emit(res, "session", {
      sessionId: session.id,
      threadId: session.threadId ?? undefined,
      turnId,
      activeAccount: session.account,
      startupSnapshot,
      ...(attachments.length > 0 ? {
        attachments: attachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          type: attachment.mimeType,
          mimeType: attachment.mimeType,
          size: attachment.size,
          path: attachment.path
        }))
      } : {}),
      message: pendingTurn ? "Retrying pending Codex turn" : "Prompt runner started"
    });

    await streamRunnerLog(res, logPath, runner);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown prompt runner error";
    const loginRequired = isAccountLoginRequiredMessage(message);
    if (claimedTurnId && !runner) {
      await sessionStore.updateSessionTurn({
        id: claimedTurnId,
        agentResponse: loginRequired
          ? "Account authentication failed. The original prompt is saved and will be retried after login or an account switch."
          : `Codex error: ${message}`,
        tokenIn: 0,
        tokenOut: 0,
        status: loginRequired ? "todo" : "done",
        runnerExitCode: 1,
        pendingReason: loginRequired ? "auth" : null,
        expectedStatus: "running",
        expectedRunnerPid: null
      }).catch((releaseError) => {
        console.warn(`Failed to release unstarted turn ${claimedTurnId}: ${errorMessage(releaseError)}`);
      });
      if (loginRequired) {
        await markTurnAccountLoggedOut(claimedTurnId);
      }
    }
    if (loginRequired) {
      emit(res, "pending", {
        sessionId: req.body.sessionId,
        turnId: claimedTurnId,
        message: "Account authentication failed. The original prompt is saved and will be retried after login or an account switch.",
        queued: true,
        reason: "auth",
        needsLogin: true
      });
    } else {
      emit(res, "error", { message });
    }
    emit(res, "done", { ok: true });
  } finally {
    res.end();
  }
});

let apiServer: Server | null = null;
let webVsCodeProcess: ChildProcess | null = null;

void startApiServer();

const watchdog = setInterval(() => {
  void checkRunningTurns();
}, runnerWatchdogMs);
watchdog.unref();

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down Threadex.`);

  clearInterval(watchdog);
  webVsCodeWalkthroughService?.stop();
  webVsCodeWalkthroughService = null;
  stopCodexSessionTitlePollJob();
  stopCodexSessionFilePollJob();
  stopAccountQuotaRefreshJob();
  waitEvents.stop();
  processMonitor.stop();
  for (const timer of pendingTurnTimers.values()) {
    clearTimeout(timer);
  }
  pendingTurnTimers.clear();
  sessionSummarizer.close();
  stopSessionQuestionRunners();
  stopDuckDbUiAssetServer();
  signalWebVsCodeProcess(webVsCodeProcess, "SIGTERM");
  webVsCodeProcess = null;
  for (const id of [...pendingAccountLogins.keys()]) {
    cleanupPendingAccountLogin(id);
  }

  if (apiServer) {
    await Promise.race([closeHttpServer(apiServer), sleep(1500)]);
  }

  try {
    await sessionStore.close();
  } catch (error) {
    console.error(`Failed to close database cleanly: ${errorMessage(error)}`);
  }

  process.exitCode = 0;
  process.exit(0);
}

function closeHttpServer(server: Server) {
  return new Promise<void>((resolveClose) => {
    server.close((error) => {
      if (error) {
        console.error(`Failed to close HTTP server cleanly: ${errorMessage(error)}`);
      }
      resolveClose();
    });
  });
}

async function startApiServer() {
  try {
    await sessionStore.ready();
    for (const workspaceId of await sessionStore.listAutoLoadBalanceWorkspaceIds()) {
      autoLoadBalanceWorkspaceIds.add(workspaceId);
    }
    const removedImportedTurnDuplicates = await sessionStore.dedupeImportedTurnRows();
    if (removedImportedTurnDuplicates > 0) {
      console.log(`Removed ${removedImportedTurnDuplicates} duplicate imported session turn${removedImportedTurnDuplicates === 1 ? "" : "s"}.`);
    }
    await migrateLegacyAccountAuthToDatabase();
    const workspaces = await sessionStore.listWorkspaces();
    injectBuiltinSkillsForWorkspaces(workspaces, resolve(projectRoot, "skills"));
    await initializeCodexSessionTitleSyncState(workspaces);
    webVsCodeWalkthroughService = new WebVsCodeWalkthroughService({
      dataDir,
      getSession: (id) => sessionStore.getSession(id),
      getActiveWorkspace: () => sessionStore.getActiveWorkspace()
    });
    webVsCodeWalkthroughService.start();
  } catch (error) {
    console.error(`Failed to open PostgreSQL before starting API server: ${errorMessage(error)}`);
    try {
      await sessionStore.close();
    } catch (closeError) {
      console.error(`Failed to close database cleanly: ${errorMessage(closeError)}`);
    }
    process.exit(1);
  }

  apiServer = app.listen(port, () => {
    console.log(`Threadex API listening on http://localhost:${port}`);
    startWebVsCodeServer();
    if (sessionSummarizerEnabled) {
      sessionSummarizer.start();
    }
    void waitEvents.start().catch((error) => {
      console.warn(`Failed to start wait event service: ${errorMessage(error)}`);
    });
    void processMonitor.start()
      .then(recoverProcessExitEvents)
      .catch((error) => {
        console.warn(`Failed to start process monitor sweep: ${errorMessage(error)}`);
    });
    startAccountQuotaRefreshJob();
    startCodexSessionTitlePollJob();
    void recoverPendingTurns().catch((error) => {
      console.warn(`Failed to recover pending turns: ${errorMessage(error)}`);
    });
    void replayPendingRunnerLogs();
    void drainCodexHookQueue()
      .catch((error) => {
        console.warn(`Failed to drain Codex hook queue: ${errorMessage(error)}`);
      })
      .finally(() => startCodexSessionFilePollJob());
    if (legacyDuckDbUiRequested) {
      console.warn("ENABLE_DUCKDB_UI is ignored because Threadex now uses PostgreSQL. Use `npm run legacy:duckdb-ui` only for old DuckDB files.");
    }
    if (enableDuckDbUi) {
      void startDuckDbUiDevServer();
    }
  });
}

function startWebVsCodeServer() {
  if (!shouldAutoStartWebVsCodeServer(process.env, Boolean(webVsCodeProcess))) return;
  const webVsCodePort = Number(process.env.WEB_VSCODE_PORT ?? 8790);
  const homebrewCommand = "/opt/homebrew/opt/code-server/bin/code-server";
  const command = process.env.CODE_SERVER_COMMAND?.trim() || (existsSync(homebrewCommand) ? homebrewCommand : "code-server");
  const userDataDir = resolve(dataDir, "code-server", "user-data");
  const extensionsDir = resolve(dataDir, "code-server", "extensions");
  const reviewRequestDirectory = webVsCodeReviewRequestDirectory(dataDir);
  const walkthroughActionDirectory = webVsCodeWalkthroughActionDirectory(dataDir);
  const walkthroughResultDirectory = webVsCodeWalkthroughResultDirectory(dataDir);
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(extensionsDir, { recursive: true });
  mkdirSync(reviewRequestDirectory, { recursive: true });
  mkdirSync(walkthroughActionDirectory, { recursive: true });
  mkdirSync(walkthroughResultDirectory, { recursive: true });
  const bundledReviewExtension = resolve(dirname(fileURLToPath(import.meta.url)), "../../extensions/threadex-review");
  if (existsSync(bundledReviewExtension)) {
    installBundledWebVsCodeReviewExtension(bundledReviewExtension, extensionsDir);
  }
  const child = spawn(command, [
    "--bind-addr", `127.0.0.1:${webVsCodePort}`,
    "--auth", "none",
    "--disable-telemetry",
    "--disable-update-check",
    "--disable-workspace-trust",
    "--user-data-dir", userDataDir,
    "--extensions-dir", extensionsDir
  ], {
    detached: process.platform !== "win32",
    stdio: "ignore",
    env: {
      ...process.env,
      THREADEX_REVIEW_REQUEST_DIR: reviewRequestDirectory,
      THREADEX_WALKTHROUGH_ACTION_DIR: walkthroughActionDirectory,
      THREADEX_WALKTHROUGH_RESULT_DIR: walkthroughResultDirectory
    }
  });
  webVsCodeProcess = child;
  child.once("spawn", () => console.log(`Web VS Code listening on http://127.0.0.1:${webVsCodePort}`));
  child.once("error", (error) => {
    webVsCodeProcess = null;
    console.warn(`Failed to start Web VS Code (${command}): ${errorMessage(error)}`);
  });
  child.once("exit", () => {
    // The code-server launcher may leave a descendant behind after it exits.
    // Stop the whole process group so it cannot keep the port occupied.
    signalWebVsCodeProcess(child, "SIGTERM");
    if (webVsCodeProcess === child) webVsCodeProcess = null;
  });
}

function signalWebVsCodeProcess(child: ChildProcess | null, signal: NodeJS.Signals) {
  if (!child) return false;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  return child.kill(signal);
}

async function importCodexStopHook(payload: CodexStopHookRequest) {
  if (payload.managedByThreadex === true) {
    const managerSessionId = payload.managerSessionId?.trim();
    const managerTurnId = payload.managerTurnId?.trim();
    const nativeTurnId = payload.turnId?.trim();
    if (!managerSessionId || !managerTurnId || !nativeTurnId) {
      return { imported: false, skipped: true, reason: "missing_manager_identity" };
    }
    const linked = await sessionStore.linkManagedRunnerNativeTurn({
      sessionId: managerSessionId,
      managerTurnId,
      nativeSessionId: payload.sessionId?.trim() || null,
      nativeTurnId,
      transcriptPath: payload.transcriptPath?.trim() || null
    });
    return {
      imported: false,
      skipped: true,
      reason: linked ? "manager_linked" : "manager_turn_not_found"
    };
  }

  const transcriptPath = payload.transcriptPath?.trim();
  if (!transcriptPath) {
    return { imported: false, skipped: true, reason: "missing_transcript_path" };
  }
  if (!existsSync(transcriptPath)) {
    return { imported: false, skipped: true, reason: "missing_transcript_file" };
  }

  const codexHome = payload.codexHome?.trim() || undefined;
  const workspaceId = await workspaceIdForCodexHome(codexHome);
  const result = await sessionStore.importLocalCodexSessionFile({
    path: transcriptPath,
    codexHome,
    workspaceId
  });

  if (!result.skipped) {
    console.log(
      `Imported Codex stop hook transcript ${result.path}: ${result.sessionId ?? "unknown"} (${result.turns} turn${result.turns === 1 ? "" : "s"}).`
    );
    await publishImportedLocalCodexSession(result, "hook");
  }

  return {
    imported: !result.skipped,
    skipped: result.skipped,
    result
  };
}

async function workspaceIdForCodexHome(codexHome: string | undefined) {
  if (!codexHome) {
    return null;
  }
  const resolvedCodexHome = resolve(codexHome);
  const workspace = (await sessionStore.listWorkspaces()).find(
    (candidate) => resolve(candidate.codexHome) === resolvedCodexHome
  );
  return workspace?.id ?? null;
}

async function drainCodexHookQueue() {
  if (!existsSync(codexHookQueuePath)) {
    return;
  }

  const drainPath = `${codexHookQueuePath}.draining-${process.pid}-${Date.now()}`;
  try {
    renameSync(codexHookQueuePath, drainPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  const failed: unknown[] = [];
  let imported = 0;
  let skipped = 0;
  let malformed = 0;
  try {
    const lines = readFileSync(drainPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let payload: CodexStopHookRequest;
      try {
        payload = JSON.parse(line) as CodexStopHookRequest;
      } catch {
        malformed += 1;
        continue;
      }
      try {
        const result = await importCodexStopHook(payload);
        if (result.imported) {
          imported += 1;
        } else {
          skipped += 1;
        }
      } catch (error) {
        failed.push({
          ...payload,
          lastError: errorMessage(error),
          lastAttemptAt: new Date().toISOString()
        });
      }
    }
  } finally {
    rmSync(drainPath, { force: true });
  }

  if (failed.length > 0) {
    appendCodexHookQueue(failed);
  }
  if (imported > 0 || skipped > 0 || malformed > 0 || failed.length > 0) {
    console.log(
      `Codex hook queue drain: imported ${imported}, skipped ${skipped}, malformed ${malformed}, failed ${failed.length}.`
    );
  }
}

function appendCodexHookQueue(entries: unknown[]) {
  if (entries.length === 0) {
    return;
  }
  mkdirSync(dirname(codexHookQueuePath), { recursive: true });
  appendFileSync(codexHookQueuePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

async function migrateLegacyAccountAuthToDatabase() {
  const legacySources = await sessionStore.listLegacyAccountAuthSources();
  const allowedRoot = `${resolve(accountPoolDir)}${sep}`;
  for (const source of legacySources) {
    const snapshotPath = resolve(source.snapshotPath);
    if (!snapshotPath.startsWith(allowedRoot)) {
      // In particular, never read ~/.codex/codex-acc. External snapshot
      // references are retired so the database remains the only auth source.
      await sessionStore.clearLegacyAccountAuthSource(source.accountId);
      continue;
    }

    const account = await sessionStore.getAccount(source.accountId);
    if (!account || !existsSync(snapshotPath)) {
      await sessionStore.clearLegacyAccountAuthSource(source.accountId);
      continue;
    }
    const authRaw = readFileSync(snapshotPath, "utf8");
    const identityError = accountAuthIdentityError(authRaw, {
      externalAccountId: account.externalAccountId,
      externalUserId: account.externalUserId
    });
    if (identityError) {
      await sessionStore.clearLegacyAccountAuthSource(source.accountId);
      await sessionStore.upsertAccount({
        id: account.id,
        name: account.name,
        externalAccountId: account.externalAccountId,
        externalUserId: account.externalUserId,
        email: account.email,
        quotaUpdatedAt: new Date().toISOString(),
        quotaError: `Legacy auth was not imported: ${identityError}.`
      });
      continue;
    }
    await sessionStore.setAccountAuth(
      account.id,
      authRaw,
      readOptionalTextFile(accountConfigPath(snapshotPath))
    );
  }
}

async function initializeCodexSessionTitleSyncState(workspaces: WorkspaceRecord[]) {
  for (const workspace of workspaces) {
    const titles = readCodexSessionTitles(workspace.codexHome);
    await sessionStore.syncSessionTitles(workspace.id, titles);
    await sessionStore.markUnsyncedSessionTitlesPending(
      workspace.id,
      titles.map((title) => title.threadId)
    );
  }
}

function startCodexSessionTitlePollJob() {
  if (codexSessionTitlePollIntervalMs <= 0 || codexSessionTitlePollTimer) return;
  codexSessionTitlePollTimer = setInterval(() => {
    void pollCodexSessionTitles();
  }, codexSessionTitlePollIntervalMs);
  codexSessionTitlePollTimer.unref();
}

function stopCodexSessionTitlePollJob() {
  if (codexSessionTitlePollTimer) clearInterval(codexSessionTitlePollTimer);
  codexSessionTitlePollTimer = null;
}

async function pollCodexSessionTitles() {
  if (shuttingDown || codexSessionTitlePollRunning) return;
  codexSessionTitlePollRunning = true;
  try {
    for (const workspace of await sessionStore.listWorkspaces()) {
      const changedTitles = await sessionStore.syncSessionTitles(
        workspace.id,
        readCodexSessionTitles(workspace.codexHome)
      );
      for (const title of changedTitles) {
        await publishRingEvent({
          eventId: crypto.randomUUID(),
          type: "session.title.updated",
          workspaceId: workspace.id,
          sessionId: title.sessionId,
          turnId: null,
          payload: { threadId: title.threadId, title: title.title }
        });
      }
    }
  } catch (error) {
    console.warn(`Failed to poll Codex session titles: ${errorMessage(error)}`);
  } finally {
    codexSessionTitlePollRunning = false;
  }
}

function startCodexSessionFilePollJob() {
  if (codexSessionFilePollIntervalMs <= 0 || codexSessionFilePollTimer) return;
  codexSessionFilePollTimer = setInterval(() => {
    void pollCodexSessionFiles().catch((error) => {
      console.warn(`Failed to poll Codex session files: ${errorMessage(error)}`);
    });
  }, codexSessionFilePollIntervalMs);
  codexSessionFilePollTimer.unref();
  void pollCodexSessionFiles().catch((error) => {
    console.warn(`Failed to start Codex session file poll: ${errorMessage(error)}`);
  });
}

function stopCodexSessionFilePollJob() {
  if (codexSessionFilePollTimer) clearInterval(codexSessionFilePollTimer);
  codexSessionFilePollTimer = null;
}

async function pollCodexSessionFiles() {
  if (shuttingDown || codexSessionFilePollRunning) return;
  codexSessionFilePollRunning = true;
  try {
    const nowMs = Date.now();
    let imported = 0;
    const workspaces = await sessionStore.listWorkspaces();
    const importedPathsByWorkspace = new Map<string, string[]>(await Promise.all(workspaces.map(async (workspace) => [
      workspace.id,
      await sessionStore.listImportedLocalCodexSessionFilePaths(workspace.id)
    ] as const)));
    const allImportedPaths = [...importedPathsByWorkspace.values()].flat();
    for (const source of codexSessionPollSources(workspaces)) {
      // A rollout's directory is dated when its thread starts.  Once an old
      // thread has been imported, keep polling that exact path as well as the
      // current date directories so later turns continue to reach PostgreSQL.
      const transcriptPaths = new Set([
        ...recentCodexSessionFiles(source.codexHome, nowMs),
        ...(source.workspaceId
          ? importedPathsByWorkspace.get(source.workspaceId) ?? []
          : allImportedPaths.filter((path) => isPathInsideCodexHome(path, source.codexHome)))
      ]);
      for (const transcriptPath of [...transcriptPaths].sort()) {
        let fileStats;
        try {
          fileStats = statSync(transcriptPath);
        } catch {
          continue;
        }
        if (!fileStats.isFile() || nowMs - fileStats.mtimeMs < codexSessionFilePollQuietMs) {
          continue;
        }
        if (!(await sessionStore.isLocalCodexSessionFileStale(transcriptPath, fileStats.mtime))) {
          continue;
        }
        const result = await sessionStore.importLocalCodexSessionFile({
          path: transcriptPath,
          codexHome: source.codexHome,
          workspaceId: source.workspaceId
        });
        if (result.skipped) {
          continue;
        }
        imported += 1;
        await publishImportedLocalCodexSession(result, "poll");
      }
    }
    if (imported > 0) {
      console.log(`Codex session file poll imported ${imported} changed transcript${imported === 1 ? "" : "s"}.`);
    }
  } catch (error) {
    console.warn(`Failed to poll Codex session files: ${errorMessage(error)}`);
  } finally {
    codexSessionFilePollRunning = false;
  }
}

function recentCodexSessionFiles(codexHome: string, nowMs: number) {
  const files: string[] = [];
  for (const dateDir of recentCodexSessionDateDirs(codexHome, nowMs)) {
    if (!existsSync(dateDir)) {
      continue;
    }
    for (const entry of readdirSync(dateDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(resolve(dateDir, entry.name));
      }
    }
  }
  return files.sort();
}

function recentCodexSessionDateDirs(codexHome: string, nowMs: number) {
  const dirs = new Set<string>();
  for (let offset = 0; offset < 3; offset += 1) {
    addCodexSessionDateDir(dirs, codexHome, new Date(nowMs - offset * 86_400_000), false);
    addCodexSessionDateDir(dirs, codexHome, new Date(nowMs - offset * 86_400_000), true);
  }
  return [...dirs];
}

function addCodexSessionDateDir(dirs: Set<string>, codexHome: string, date: Date, utc: boolean) {
  const year = String(utc ? date.getUTCFullYear() : date.getFullYear());
  const month = String((utc ? date.getUTCMonth() : date.getMonth()) + 1).padStart(2, "0");
  const day = String(utc ? date.getUTCDate() : date.getDate()).padStart(2, "0");
  dirs.add(resolve(codexHome, "sessions", year, month, day));
}

async function publishImportedLocalCodexSession(
  result: Awaited<ReturnType<SessionStore["importLocalCodexSessionFile"]>>,
  source: "hook" | "poll"
) {
  if (!result.sessionId) {
    return;
  }
  const session = await sessionStore.getSession(result.sessionId);
  await publishRingEvent({
    eventId: crypto.randomUUID(),
    type: "session.imported",
    workspaceId: session?.workspaceId ?? null,
    sessionId: result.sessionId,
    turnId: null,
    payload: {
      source,
      path: result.path,
      threadId: result.threadId,
      turns: result.turns,
      events: result.events
    }
  });
  if (!(await sessionStore.hasIncompleteImportedLocalTurns(result.sessionId))) {
    sessionSummarizer.noteSessionActivity(result.sessionId);
  }
}

function startAccountQuotaRefreshJob() {
  if (accountQuotaRefreshIntervalMs <= 0 || accountQuotaRefreshTimer) {
    return;
  }

  scheduleAccountQuotaRefresh(accountQuotaRefreshInitialDelayMs);
}

function stopAccountQuotaRefreshJob() {
  if (accountQuotaRefreshTimer) {
    clearTimeout(accountQuotaRefreshTimer);
    accountQuotaRefreshTimer = null;
  }
}

function scheduleAccountQuotaRefresh(delayMs: number) {
  if (shuttingDown || accountQuotaRefreshIntervalMs <= 0) {
    return;
  }

  accountQuotaRefreshTimer = setTimeout(() => {
    accountQuotaRefreshTimer = null;
    void refreshAllAccountQuotas()
      .catch((error) => {
        console.warn(`Scheduled account quota refresh failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        scheduleAccountQuotaRefresh(accountQuotaRefreshIntervalMs);
      });
  }, delayMs);
  accountQuotaRefreshTimer.unref();
}

async function refreshAllAccountQuotas() {
  if (accountQuotaRefreshInFlight) {
    return;
  }

  accountQuotaRefreshInFlight = true;
  try {
    const accounts = await sessionStore.listAccounts();
    for (const account of accounts) {
      if (shuttingDown) {
        return;
      }
      await refreshQuotaForAccount(account, { skipIfBusy: true });
    }
  } finally {
    accountQuotaRefreshInFlight = false;
  }
}

async function waitForAccountQuotaRefresh(accountId: string | null) {
  if (!accountId) {
    return;
  }

  const deadline = Date.now() + quotaRpcTimeoutMs + 1_000;
  while (refreshingQuotaAccountIds.has(accountId)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for account ${accountId} quota refresh.`);
    }
    await sleep(50);
  }
}

async function recoverPendingTurns() {
  const pendingTurns = await sessionStore.listPendingSessionTurns();
  for (const pending of pendingTurns) {
    await schedulePendingTurn(pending);
  }
}

async function recoverProcessExitEvents() {
  const monitors = await sessionStore.listProcessMonitors();
  for (const monitor of monitors) {
    if (monitor.status === "running" || monitor.status === "starting") {
      await ensureProcessExitEvent(monitor);
    }
  }
}

async function schedulePendingTurnsForSession(sessionId: string, options: { immediate?: boolean } = {}) {
  const pendingTurns = (await sessionStore.listPendingSessionTurns())
    .filter((pending) => pending.session.id === sessionId);
  for (const pending of pendingTurns) {
    await schedulePendingTurn(pending, options);
  }
}

async function schedulePendingTurnsForAccount(accountId: string, options: { immediate?: boolean } = {}) {
  const pendingTurns = await sessionStore.listPendingSessionTurns();
  let workspaceIds: Set<string> | null = null;
  for (const pending of pendingTurns) {
    let matchesAccount =
      pending.turn.accountId === accountId ||
      pending.session.accountId === accountId;
    if (!matchesAccount && pendingUsesWorkspaceAccountPool(pending)) {
      workspaceIds ??= new Set(await listWorkspaceIdsForAccount(accountId));
      matchesAccount = workspaceIds.has(pending.session.workspaceId);
    }
    if (matchesAccount) {
      await schedulePendingTurn(pending, options);
    }
  }
}

function pendingUsesWorkspaceAccountPool(pending: PendingSessionTurnCandidate) {
  if (pendingTurnReason(pending.turn) === "auth") {
    return false;
  }
  return shouldUseWorkspaceAccountPool({
    sessionAccountId: pending.session.accountId,
    turnAccountId: pending.turn.accountId,
    pendingLoadBalance: pending.turn.pendingLoadBalance,
    workspaceLoadBalanceEnabled: autoLoadBalanceWorkspaceIds.has(pending.session.workspaceId)
  });
}

async function listWorkspaceIdsForAccount(accountId: string) {
  const workspaces = await sessionStore.listWorkspaces();
  const matches = await Promise.all(workspaces.map(async (workspace) => {
    return (await sessionStore.isAccountBoundToWorkspace(workspace.id, accountId))
      ? workspace.id
      : null;
  }));
  return matches.filter((workspaceId): workspaceId is string => Boolean(workspaceId));
}

async function publishQuotaAvailableForAccount(account: AccountRecord) {
  const workspaceIds = new Set(await listWorkspaceIdsForAccount(account.id));
  if (workspaceIds.size === 0) {
    return;
  }

  const events = await sessionStore.listWaitEvents({ status: "pending" });
  const now = Date.now();
  for (const event of events) {
    if (
      event.topic !== "quota.available" ||
      !workspaceIds.has(event.workspaceId) ||
      !quotaAvailableEventReferencesAccount(event, account.id)
    ) {
      continue;
    }
    await waitEvents.fire(event.id, {
      accountId: account.id,
      accountIds: [account.id],
      resetAt: now,
      manualReset: true
    });
  }
}

function quotaAvailableEventReferencesAccount(event: WaitEventRecord, accountId: string) {
  const payload = readObject(event.payload);
  const payloadAccountId = readString(payload?.accountId);
  if (payloadAccountId === accountId) {
    return true;
  }

  if (Array.isArray(payload?.accountIds) && payload.accountIds.some((value) => value === accountId)) {
    return true;
  }

  const scopeEnd = event.subjectKey.lastIndexOf(":");
  const scope = scopeEnd >= 0 ? event.subjectKey.slice(0, scopeEnd) : event.subjectKey;
  return scope.split(",").some((value) => value.trim() === accountId);
}

async function schedulePendingTurn(
  pending: PendingSessionTurnCandidate,
  options: { immediate?: boolean; delayMs?: number } = {}
) {
  const existingTimer = pendingTurnTimers.get(pending.turn.id);
  if (existingTimer) {
    clearTimeout(existingTimer);
    pendingTurnTimers.delete(pending.turn.id);
  }
  if (pendingTurnRuns.has(pending.turn.id)) {
    return;
  }

  const runningTurn = await sessionStore.getLatestRunningTurn(pending.session.id);
  if (runningTurn) {
    const released = await diagnoseRunningTurn(runningTurn, "pending_scheduler");
    if (released) {
      await schedulePendingTurn(pending, options);
    }
    return;
  }

  const pendingReason = pendingTurnReason(pending.turn);
  if (!options.immediate && !pendingTurnRunsAutomatically(pendingReason)) {
    if (pendingReason !== "auth") {
      return;
    }
    const account = pending.session.accountId
      ? await sessionStore.getAccount(pending.session.accountId)
      : null;
    if (!account || isAccountLoggedOut(account) || !accountHasSavedAuth(account)) {
      return;
    }
  }
  if (pendingReason === "rate_limit" && !options.immediate) {
    const resetAt = await pendingResetAt(pending);
    if (resetAt === null || resetAt > Date.now()) {
      await subscribeRateLimitedTurn(pending, resetAt);
      return;
    }
  }
  const delayMs = Math.max(0, options.delayMs ?? 0);
  const timer = setTimeout(() => {
    pendingTurnTimers.delete(pending.turn.id);
    void runPendingTurnAutomatically(pending.turn.id).catch((error) => {
      console.warn(`Automatic pending turn failed for ${pending.turn.id}: ${errorMessage(error)}`);
    });
  }, delayMs);
  timer.unref();
  pendingTurnTimers.set(pending.turn.id, timer);
}

async function pendingResetAt(pending: PendingSessionTurnCandidate): Promise<number | null> {
  const accounts = await pendingQuotaAccounts(pending);
  const pendingReason = pendingTurnReason(pending.turn);
  const candidateAccounts = pendingReason === "rate_limit"
    ? accounts.filter((account) => account.id !== pending.turn.accountId)
    : accounts;
  return pendingRetryAt({
    alternateAccountAvailable: pendingUsesWorkspaceAccountPool(pending) && Boolean(
      chooseLoadBalancedAccount(candidateAccounts, { hasSavedAuth: accountHasSavedAuth })
    ),
    resetTimes: accounts.flatMap((account) => accountQuotaResetTimes(account))
  });
}

async function pendingQuotaAccounts(pending: PendingSessionTurnCandidate): Promise<AccountRecord[]> {
  return pendingUsesWorkspaceAccountPool(pending)
    ? await sessionStore.listAccountsForWorkspace(pending.session.workspaceId)
    : pending.account
      ? [pending.account]
      : [];
}

async function runPendingTurnAutomatically(turnId: string) {
  if (pendingTurnRuns.has(turnId) || shuttingDown) {
    return;
  }

  const pendingTurns = await sessionStore.listPendingSessionTurns();
  const pending = pendingTurns.find((candidate) => candidate.turn.id === turnId);
  if (!pending) {
    return;
  }
  const firstPendingForSession = pendingTurns
    .filter((candidate) => candidate.session.id === pending.session.id)
    .filter((candidate) => pendingTurnReason(candidate.turn) !== "stopped")
    .sort((first, second) => first.turn.created.localeCompare(second.turn.created) || first.turn.id.localeCompare(second.turn.id))[0];
  if (firstPendingForSession && firstPendingForSession.turn.id !== turnId) {
    await schedulePendingTurn(firstPendingForSession);
    return;
  }

  const runningTurn = await sessionStore.getLatestRunningTurn(pending.session.id);
  if (runningTurn) {
    const released = await diagnoseRunningTurn(runningTurn, "pending_runner");
    if (released) {
      await schedulePendingTurn(pending);
    }
    return;
  }

  const pendingReason = pendingTurnReason(pending.turn);
  if (pendingReason === "stopped") {
    return;
  }
  if (pendingReason === "rate_limit") {
    const resetAt = await pendingResetAt(pending);
    if (resetAt !== null && resetAt > Date.now()) {
      await schedulePendingTurn(pending);
      return;
    }
  }

  if (pendingUsesWorkspaceAccountPool(pending)) {
    const excludedAccountId = pendingReason === "rate_limit" ? pending.turn.accountId : null;
    const account = await advanceLoadBalancedAccountForWorkspaceWithOptions(
      pending.session.workspaceId,
      false,
      excludedAccountId
    );
    if (!account && pendingReason === "rate_limit") {
      await schedulePendingTurn(pending);
      return;
    }
    if (account) {
      // /api/chat deliberately preserves a pending turn's stored account. A
      // load-balanced retry must therefore persist the selected replacement
      // before issuing that request, otherwise it starts the new runner with
      // the rate-limited account again.
      const session = await sessionStore.getSession(pending.session.id);
      if (session && session.accountId !== account.id) {
        await rebindSessionAccount(sessionStore, session, account);
      }
    }
  }

  pendingTurnRuns.add(turnId);
  let retryTransportFailed = false;
  try {
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Threadex-Automatic-Pending": "1"
      },
      body: JSON.stringify({
        retryPending: true,
        sessionId: pending.session.id,
        turnId,
        workspaceId: pending.session.workspaceId
      })
    });
    if (!response.ok) {
      throw new Error(`Automatic pending retry returned HTTP ${response.status}`);
    }
    await response.arrayBuffer();
  } catch (error) {
    retryTransportFailed = true;
    console.warn(`Automatic pending retry failed for ${turnId}: ${errorMessage(error)}`);
  } finally {
    pendingTurnRuns.delete(turnId);
    if (retryTransportFailed) {
      const latest = (await sessionStore.listPendingSessionTurns())
        .find((candidate) => candidate.turn.id === turnId);
      if (latest) {
        await schedulePendingTurn(latest, { delayMs: pendingRetryFallbackMs });
      }
    } else {
      await schedulePendingTurnsForSession(pending.session.id);
    }
  }
}

async function ensureProcessExitEvent(monitor: ProcessMonitorRecord) {
  return waitEvents.ensureEvent({
    workspaceId: monitor.workspaceId,
    topic: "process.exited",
    subjectKey: `${monitor.id}:${monitor.startedAt ?? monitor.created}`,
    payload: processExitPayload(monitor)
  });
}

async function cancelProcessExitEvent(monitor: ProcessMonitorRecord) {
  const event = await ensureProcessExitEvent(monitor);
  if (event.status === "pending") await waitEvents.cancel(event.id);
}

async function publishProcessExit(monitor: ProcessMonitorRecord) {
  const event = await ensureProcessExitEvent(monitor);
  let legacySubscriptionId: string | null = null;
  if (monitor.wakePrompt && monitor.wakeSessionId) {
    legacySubscriptionId = `process_wake:${event.id}:${monitor.wakeSessionId}`;
    await waitEvents.subscribe({
      id: legacySubscriptionId,
      eventId: event.id,
      workspaceId: monitor.workspaceId,
      sessionId: monitor.wakeSessionId,
      actionType: "enqueue_prompt",
      actionPayload: {
        message: monitor.wakePrompt,
        loadBalanceInWorkspace: false
      }
    });
  }
  await waitEvents.fire(event.id, processExitPayload(monitor));
  if (legacySubscriptionId) {
    const subscription = (await sessionStore.listWaitSubscriptions({ eventId: event.id }))
      .find((candidate) => candidate.id === legacySubscriptionId);
    if (subscription?.status === "error") {
      throw new Error(subscription.error ?? "Process wake subscription failed.");
    }
  }
}

function processExitPayload(monitor: ProcessMonitorRecord) {
  return {
    monitorId: monitor.id,
    label: monitor.label,
    status: monitor.status,
    startedAt: monitor.startedAt,
    exitCode: monitor.lastExitCode,
    signal: monitor.lastSignal,
    error: monitor.error
  };
}

async function dispatchWaitSubscription(subscription: WaitSubscriptionRecord, event: WaitEventRecord) {
  if (subscription.actionType === "notify") return;
  if (subscription.actionType === "retry_turn") {
    if (!subscription.turnId) throw new Error("retry_turn subscription requires a turnId.");
    await runPendingTurnAutomatically(subscription.turnId);
    return;
  }
  const payload = readObject(subscription.actionPayload);
  const message = readString(payload?.message)?.trim();
  if (!message) throw new Error("enqueue_prompt subscription requires actionPayload.message.");
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/pending-turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      turnId: readString(payload?.turnId)?.trim() || `wait_${subscription.id}`,
      sessionId: subscription.sessionId,
      workspaceId: subscription.workspaceId,
      loadBalanceInWorkspace: payload?.loadBalanceInWorkspace === true
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Wait subscription ${subscription.id} returned HTTP ${response.status}: ${body.slice(-500)}`);
  }
}

async function subscribeRateLimitedTurn(pending: PendingSessionTurnCandidate, knownResetAt?: number | null) {
  const resetAt = knownResetAt === undefined ? await pendingResetAt(pending) : knownResetAt;
  const now = Date.now();
  const expectedAt = resetAt !== null && resetAt > now
    ? resetAt
    : now + pendingRetryFallbackMs;
  const accounts = await pendingQuotaAccounts(pending);
  const scope = accounts.length > 0
    ? accounts.map((account) => account.id).sort().join(",")
    : `turn:${pending.turn.id}`;
  const event = await waitEvents.ensureEvent({
    workspaceId: pending.session.workspaceId,
    topic: "quota.available",
    subjectKey: `${scope}:${expectedAt}`,
    expectedAt: new Date(expectedAt).toISOString(),
    payload: {
      accountIds: accounts.map((account) => account.id),
      resetAt: expectedAt
    }
  });
  await sessionStore.cancelWaitSubscriptionsForTurn(pending.turn.id, event.id);
  await waitEvents.subscribe({
    id: `rate_limit:${event.id}:${pending.turn.id}`,
    eventId: event.id,
    workspaceId: pending.session.workspaceId,
    sessionId: pending.session.id,
    turnId: pending.turn.id,
    actionType: "retry_turn",
    actionPayload: {
      resetAt: expectedAt,
      prompt: pending.turn.userInput
    }
  });
}

function inferPendingReason(message: string): "queued" | "rate_limit" | "auth" | "stopped" {
  if (/\bstopped\b/i.test(message)) {
    return "stopped";
  }
  return /usage limit|rate limit|quota|out of credits?|insufficient credits?|credits? exhausted|workspace_member_credits_depleted/i.test(message)
    ? "rate_limit"
    : "queued";
}

function pendingTurnReason(turn: SessionTurnRecord): "queued" | "rate_limit" | "auth" | "stopped" {
  if (turn.pendingReason && turn.pendingReason !== "queued") {
    return turn.pendingReason;
  }
  return inferPendingReason(turn.agentResponse);
}

function normalizeRunnerPendingReason(
  reason: string | null | undefined,
  message: string
): "queued" | "rate_limit" | "auth" | "stopped" {
  if (reason === "queued" || reason === "rate_limit" || reason === "auth" || reason === "stopped") {
    return reason;
  }
  return inferPendingReason(message);
}

function accountQuotaResetTimes(account: AccountRecord): number[] {
  const quota = readObject(account.quotaSnapshot);
  if (!quota) {
    return [];
  }
  return ["primary", "secondary"].flatMap((key) => {
    const window = readObject(quota[key]);
    const raw = readNumber(window?.resetsAt) ?? readNumber(window?.resets_at);
    if (raw === null) {
      return [];
    }
    return [raw > 10_000_000_000 ? raw : raw * 1000];
  });
}

async function getOrCreateSession(request: ChatRequest, message: string): Promise<ManagedSession> {
  const requestedSessionId = request.sessionId?.trim();
  const requestedThreadId = request.resumeThreadId?.trim();
  const requestedSession = requestedSessionId ? await getSessionForRequestedId(requestedSessionId) : null;
  // An existing session owns its workspace. A stale browser render may still
  // submit the workspace that was active before a cross-workspace navigation;
  // letting that request value win would retain the session's workspace_id but
  // launch Codex with another workspace's CODEX_HOME.
  const activeWorkspace = await resolveSessionWorkspace({
    requestedWorkspaceId: request.workspaceId,
    sessionWorkspaceId: requestedSession?.workspaceId,
    getWorkspace: (id) => sessionStore.getWorkspace(id),
    getActiveWorkspace: () => sessionStore.getActiveWorkspace()
  });
  const resumedSession =
    !requestedSession && requestedThreadId
      ? await sessionStore.getSessionByThreadId(requestedThreadId, activeWorkspace.id)
      : null;
  const storedSession = requestedSession ?? resumedSession;
  const loadBalanceInWorkspace = request.loadBalanceInWorkspace === true;
  const requestedAccountId = typeof request.accountId === "string" && request.accountId.trim() ? request.accountId.trim() : null;
  const requestedNoAccount = request.accountId === null;
  const shouldLoadBalance = shouldChooseAccountForNewLoadBalancedThread({
    loadBalanceInWorkspace,
    retryPending: request.retryPending === true,
    hasStoredSession: Boolean(storedSession),
    hasRequestedThreadId: Boolean(requestedThreadId)
  });
  const sessionAccountChanged = Boolean(
    storedSession &&
      ((requestedAccountId && requestedAccountId !== storedSession.accountId) ||
        (requestedNoAccount && storedSession.accountId !== null))
  );
  // Account credentials are execution details, not Threadex session identity.
  // Keep the logical session and its native thread reference so the runner can
  // attempt a resume and deterministically recover from persisted turns if the
  // new account cannot access that native thread.
  const reusableSession = storedSession;
  const requestedBaseSessionId = request.baseSessionId?.trim();
  const requestedNewSessionProjectId = request.newSessionProjectId?.trim();
  const requestedNewSessionCwd = request.newSessionCwd?.trim();
  const requestedLegacyCwd = request.cwd?.trim();
  const baseSession = !reusableSession
    ? requestedBaseSessionId
      ? await getSessionForRequestedId(requestedBaseSessionId)
      : requestedLegacyCwd
        ? (await sessionStore.listSessions(activeWorkspace.id)).find((session) => session.cwd === requestedLegacyCwd) ?? null
        : null
    : null;
  const requestedProjectCwd = requestedNewSessionProjectId
    ? resolveCodexProjectCwd(activeWorkspace.codexHome, requestedNewSessionProjectId)
    : null;
  if (requestedNewSessionProjectId && !requestedProjectCwd) {
    throw new Error("Project must be registered in the active workspace's CODEX_HOME.");
  }
  // Older clients may still send cwd, but it must match a root registered by
  // Codex for this workspace rather than being accepted as arbitrary input.
  const suppliedNewSessionCwd = requestedNewSessionCwd
    ? resolveUserPath(requestedNewSessionCwd)
    : requestedLegacyCwd && !baseSession
      ? resolveUserPath(requestedLegacyCwd)
      : undefined;
  if (suppliedNewSessionCwd && !listCodexProjects(activeWorkspace.codexHome)
    .some((project) => project.roots.some((root) => resolveUserPath(root) === suppliedNewSessionCwd))) {
    throw new Error("New session cwd must match a project registered in the active workspace's CODEX_HOME.");
  }
  const selectedAccount = await getSessionAccount({
    workspaceId: activeWorkspace.id,
    requestedAccountId: request.accountId,
    storedAccountId: reusableSession?.accountId ?? null,
    preserveStoredAccount: !sessionAccountChanged && Boolean(reusableSession?.threadId || request.retryPending === true),
    loadBalanceInWorkspace: shouldLoadBalance
  });
  const isNewStoredSession = !reusableSession;
  // The client allocates local ids before it starts a runner. Retain that id
  // so the session remains addressable if the user switches views before the
  // first stream event is received. Do not treat arbitrary external ids as
  // new local session ids; those still use the existing generated-id path.
  const id = reusableSession?.id ?? (requestedSessionId?.startsWith("local_") ? requestedSessionId : createLocalSessionId());
  const threadId = reusableSession?.threadId || requestedThreadId || undefined;
  const workspaceId = reusableSession?.workspaceId ?? activeWorkspace.id;
  const cwd = resolveNewSessionCwd({
    workspace: activeWorkspace,
    reusableSession,
    baseSession,
    requestedBaseSessionId: requestedBaseSessionId ?? (baseSession ? "legacy-cwd" : undefined),
    requestedNewSessionCwd: requestedProjectCwd ?? suppliedNewSessionCwd
  });
  const accountId = selectedAccount?.id ?? (reusableSession && !shouldLoadBalance ? reusableSession.accountId : null);

  const metadata = isNewStoredSession ? sessionStore.normalizeMetadata(request, message) : null;
  const persistedSession = await sessionStore.upsertSession({
    id,
    threadId: threadId ?? null,
    workspaceId,
    cwd,
    accountId,
    ...(metadata ? { ...metadata, title: markCodexSessionTitlePending(metadata.title), titleSource: "initial" as const } : {})
  });
  const persistedAccount = persistedSession.accountId
    ? persistedSession.accountId === selectedAccount?.id
      ? selectedAccount
      : await sessionStore.getAccount(persistedSession.accountId)
    : null;
  if (persistedSession.accountId && request.backgroundTask !== true) {
    await sessionStore.switchAccount(persistedSession.accountId, persistedSession.workspaceId);
  }
  if (request.backgroundTask !== true) {
    await sessionStore.switchSession(persistedSession.id);
  }
  return {
    id: persistedSession.id,
    threadId: persistedSession.threadId,
    parentSessionId: persistedSession.parentSessionId,
    workspaceId: persistedSession.workspaceId,
    codexHome: activeWorkspace.codexHome,
    cwd: persistedSession.cwd,
    account: persistedAccount,
    accountId: persistedSession.accountId,
    accountName: persistedAccount?.name ?? null,
    accountEmail: persistedAccount?.email ?? null,
    accountExternalAccountId: persistedAccount?.externalAccountId ?? null,
    accountExternalUserId: persistedAccount?.externalUserId ?? null,
    accountAuthVersion: persistedAccount?.authVersion ?? null,
    accountChanged: sessionAccountChanged
  };
}

async function getSessionAccount(input: {
  workspaceId: string;
  requestedAccountId: unknown;
  storedAccountId: string | null;
  preserveStoredAccount: boolean;
  loadBalanceInWorkspace: boolean;
}) {
  if (input.loadBalanceInWorkspace) {
    return chooseWorkspaceLoadBalancedAccount(input.workspaceId);
  }

  if (input.preserveStoredAccount) {
    return input.storedAccountId ? await sessionStore.getAccount(input.storedAccountId) : null;
  }

  return getRequestedOrActiveAccount(input.workspaceId, input.requestedAccountId, input.storedAccountId);
}

async function getSessionForRequestedId(requestedSessionId: string) {
  const direct = await sessionStore.getSession(requestedSessionId);
  if (direct || requestedSessionId.startsWith("local_")) {
    return direct;
  }

  return sessionStore.getSession(`local_${requestedSessionId}`);
}

function isSafeTranscriptIdentifier(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

async function resolveRequestedSessionId(requestedSessionId: string) {
  const session = await getSessionForRequestedId(requestedSessionId);
  return session?.id ?? requestedSessionId;
}

async function getMatchingRunningTurn(sessionId: string, message: string) {
  const runningTurn = await sessionStore.getLatestRunningTurn(sessionId);
  if (!runningTurn) {
    return null;
  }

  return runningTurn.userInput === message ? runningTurn : null;
}

type RecordSessionTurnInput = Parameters<SessionStore["recordSessionTurn"]>[0];

async function recordSessionTurnWithLog(input: RecordSessionTurnInput, source: string) {
  const id = input.id ?? crypto.randomUUID();
  await appendSessionTurnPromptLog({ ...input, id }, source);
  return sessionStore.recordSessionTurn({ ...input, id });
}

async function appendSessionTurnPromptLog(
  turn: Pick<RecordSessionTurnInput, "sessionId" | "userInput"> & { id: string },
  source: string
) {
  await turnRingLog.appendUserPrompt({
    eventId: `prompt:${turn.id}:start`,
    source,
    sessionId: turn.sessionId,
    turnId: turn.id,
    userPrompt: turn.userInput
  });
}

async function spawnPromptRunner(job: RunnerJob): Promise<ChildProcess> {
  const ownership = runnerProcesses.begin(job.logPath);
  try {
    return await spawnOwnedPromptRunner(job, ownership);
  } catch (error) {
    ownership.dispose();
    throw error;
  }
}

async function spawnOwnedPromptRunner(
  job: RunnerJob,
  ownership: ReturnType<RunnerProcessRegistry["begin"]>
): Promise<ChildProcess> {
  mkdirSync(runnerJobDir, { recursive: true });
  mkdirSync(runnerLogDir, { recursive: true });
  mkdirSync(pendingRunnerLogDir, { recursive: true });
  mkdirSync(runnerControlDir, { recursive: true });
  mkdirSync(runnerControlResultDir, { recursive: true });
  mkdirSync(dirname(job.logPath), { recursive: true });
  mkdirSync(dirname(job.pendingLogPath), { recursive: true });
  mkdirSync(job.codexHome, { recursive: true, mode: 0o700 });
  rmSync(job.controlPath, { force: true });

  const runnerJob = {
    ...job,
    codexHome: await prepareRunnerCodexHome(job)
  };
  const jobPath = resolve(runnerJobDir, `${job.turnId}.json`);
  const stdoutPath = resolve(runnerLogDir, `${job.turnId}.stdout.log`);
  const stderrPath = resolve(runnerLogDir, `${job.turnId}.stderr.log`);
  writeFileSync(jobPath, JSON.stringify(runnerJob, null, 2), "utf8");

  const stdoutFd = openSync(stdoutPath, "a");
  const stderrFd = openSync(stderrPath, "a");
  try {
    const child = spawn(process.execPath, [tsxPath, runnerPath, jobPath], {
      cwd: projectRoot,
      detached: true,
      env: {
        ...process.env,
        CODEX_HOME: runnerJob.codexHome,
        CODEX_WORKDIR: job.cwd,
        RUNNER_SERVER_URL: runnerJob.serverUrl
      },
      stdio: ["ignore", stdoutFd, stderrFd]
    });
    ownership.attach(child.pid ?? null);
    child.once("exit", ownership.dispose);
    child.once("error", ownership.dispose);
    child.unref();
    return child;
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}

async function runCodexAppServerRequest(
  workspace: WorkspaceRecord,
  method: string,
  params: unknown,
  before: Array<{ method: string; params: unknown }> = []
) {
  const child = spawn(codexExecutable(), buildAppServerArgs(), {
    cwd: workspace.cwd,
    env: {
      ...process.env,
      CODEX_HOME: workspace.codexHome,
      CODEX_WORKDIR: workspace.cwd
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  return new Promise<unknown>((resolveRequest, rejectRequest) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const requests = [...before, { method, params }];
    let requestIndex = 0;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) rejectRequest(error);
      else resolveRequest(value);
    };
    const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
    const timer = setTimeout(() => finish(new Error(`Codex app-server ${method} timed out.`)), 10_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message.id === 1) {
          if (message.error) {
            finish(new Error(`Codex app-server initialize failed: ${JSON.stringify(message.error)}`));
            return;
          }
          send({ method: "initialized", params: {} });
          const request = requests[requestIndex];
          send({ id: 2, method: request.method, params: request.params });
        } else if (message.id === requestIndex + 2) {
          const request = requests[requestIndex];
          if (message.error) {
            finish(new Error(`Codex app-server ${request.method} failed: ${JSON.stringify(message.error)}`));
            return;
          }
          requestIndex += 1;
          const next = requests[requestIndex];
          if (next) send({ id: requestIndex + 2, method: next.method, params: next.params });
          else finish(undefined, message.result);
          return;
        }
      }
    });
    child.once("error", (error) => finish(error));
    child.stdin.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (!settled) finish(new Error(`Codex app-server exited (${code ?? "unknown"}). ${stderr}`.trim()));
    });
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "threadex", title: "Threadex", version: "0.1.0" } }
    });
  });
}

function skillExtraRoots(workspace: WorkspaceRecord) {
  const roots = [
    ...defaultAgentHomeCandidates().flatMap((candidate) => {
      const home = candidate?.trim();
      return home ? [resolve(resolveUserPath(home), "skills")] : [];
    }),
    resolve(workspace.cwd, "skills")
  ];
  const workspaceSkillHome = resolve(workspace.codexHome, "skills");
  return roots
    .filter((root) => root !== workspaceSkillHome && existsSync(root))
    .filter((root, index, all) => all.indexOf(root) === index);
}

function normalizeSkillsListResult(result: unknown) {
  const root = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const entries = Array.isArray(root.data) ? root.data : [];
  const skills = entries.flatMap((entry) => {
    const candidate = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    return Array.isArray(candidate.skills) ? candidate.skills : [];
  });
  const unique = new Map<string, { name: string; path: string; description: string; scope: string }>();
  for (const value of skills) {
    const skill = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const name = typeof skill.name === "string" ? skill.name.trim() : "";
    const path = typeof skill.path === "string" ? skill.path : "";
    if (!name || !path || skill.enabled === false) continue;
    const interfaceValue = skill.interface && typeof skill.interface === "object"
      ? skill.interface as Record<string, unknown>
      : {};
    const description =
      (typeof interfaceValue.shortDescription === "string" && interfaceValue.shortDescription) ||
      (typeof skill.shortDescription === "string" && skill.shortDescription) ||
      (typeof skill.description === "string" && skill.description) ||
      "Use this skill";
    const normalized = { name, path, description, scope: typeof skill.scope === "string" ? skill.scope : "user" };
    const existing = unique.get(name);
    if (!existing || skillPathPriority(path) > skillPathPriority(existing.path)) {
      unique.set(name, normalized);
    }
  }
  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function skillPathPriority(path: string) {
  return /(?:^|[/\\])[^/\\]*backup(?:-|_|[/\\])/i.test(path) ? 0 : 1;
}

function normalizeExecutionMode(value: unknown): ExecutionMode {
  return value === "plan" || value === "goal" ? value : "default";
}

function normalizeApprovalPolicy(value: unknown): ApprovalPolicy {
  if (value === "on-failure") {
    return "granular";
  }
  return value === "untrusted" || value === "on-request" || value === "granular" || value === "never"
    ? value
    : defaultThreadOptions.approvalPolicy;
}

function resolveRequestedSkills(value: unknown, workspaceId: string): RequestedSkill[] {
  if (!Array.isArray(value)) return [];
  const allowed = listedSkillsByWorkspace.get(workspaceId) ?? [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const input = candidate as Record<string, unknown>;
    const match = allowed.find((skill) => skill.name === input.name && skill.path === input.path);
    return match ? [match] : [];
  });
}

async function prepareRunnerCodexHome(job: RunnerJob) {
  await syncRunnerAccount(job);
  return job.codexHome;
}

function normalizeExperimentalRouteLimit(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 20) : 8;
}

function normalizeExperimentalRouteMaxTextChars(value: unknown) {
  if (value === null) {
    return null;
  }
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 4000) : 1200;
}

function normalizeExperimentalKeywordLimit(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 12) : 6;
}

function normalizeExperimentalKeywordVocabularyLimit(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : 240;
}

function experimentalRouteCandidates(results: unknown[]): SessionRouteCandidate[] {
  return results
    .map((result, index) => {
      const row = readObject(result);
      const session = readObject(row?.session);
      const sessionId = readString(session?.id);
      if (!row || !session || !sessionId) {
        return null;
      }

      const similarity = readNumber(row.similarity) ?? readNumber(row.score) ?? 0;
      const score = readNumber(row.score) ?? similarity;
      const threadId = readString(session.threadId);
      return {
        index: index + 1,
        sessionId,
        threadId,
        routeId: threadId ?? sessionId,
        title: readString(session.title) ?? "Untitled session",
        description: readString(session.description) ?? "",
        cwd: readString(session.cwd) ?? "",
        updated: readString(session.updated) ?? "",
        similarity,
        score
      };
    })
    .filter((candidate): candidate is SessionRouteCandidate => candidate !== null);
}

function experimentalKeywordRouteCandidates(results: SessionKeywordCandidate[]): SessionRouteCandidate[] {
  return results.map((result, index) => ({
    index: index + 1,
    sessionId: result.session.id,
    threadId: result.session.threadId,
    routeId: result.session.threadId ?? result.session.id,
    title: result.session.title,
    description: result.session.description,
    cwd: result.session.cwd,
    updated: result.session.updated,
    similarity: result.score,
    score: result.score
  }));
}

async function chooseExperimentalRouteKeywords(input: {
  message: string;
  workspace: WorkspaceRecord;
  vocabulary: Array<{ keyword: string; score: number; sessions: number }>;
  keywordLimit: number;
  model: string;
}): Promise<ParsedKeywordRouteDecision> {
  if (process.env.SESSION_ROUTER_PROVIDER === "mock") {
    return parseExperimentalKeywordRouteResponse(process.env.SESSION_ROUTER_MOCK_RESPONSE || "chatbox, resend, button");
  }

  const prompt = buildExperimentalKeywordRoutePrompt(input);
  const agentHome = createEphemeralAgentHome({
    prefix: "session-keyword-router-agent-",
    sourceHomeCandidates: experimentalSessionRouterAgentHomeCandidates(),
    allowMissingAuth: Boolean(process.env.OPENAI_API_KEY?.trim())
  });
  const outputPath = resolve(agentHome.home, "last-message.txt");

  try {
    const result = await runAgentCliExec({
      prompt,
      model: input.model,
      cwd: input.workspace.cwd || projectRoot,
      outputPath,
      timeoutMs: experimentalSessionRouterTimeoutMs(),
      sandbox: "read-only",
      env: {
        ...process.env,
        HOME: agentHome.home,
        AGENT_CLI_HOME: agentHome.home,
        CODEX_HOME: agentHome.home,
        CODEX_WORKDIR: input.workspace.cwd || projectRoot
      }
    });
    const output = existsSync(outputPath) ? readFileSync(outputPath, "utf8").trim() : "";
    const responseText = output || result.stdout.trim();
    if (!responseText) {
      throw new Error(`Session keyword router model produced no output.${result.stderr ? ` stderr: ${trimAgentCliOutput(result.stderr)}` : ""}`);
    }
    await recordBackgroundModelUsage({
      id: `background:keyword_router:${crypto.randomUUID()}`,
      task: "keyword_router",
      source: "codex_exec",
      workspaceId: input.workspace.id,
      model: input.model,
      usage: result.usage
    });
    return parseExperimentalKeywordRouteResponse(responseText);
  } finally {
    try {
      agentHome.cleanup();
    } catch {
      // Best-effort cleanup only; routing should not fail after the model answered.
    }
  }
}

function buildExperimentalKeywordRoutePrompt(input: {
  message: string;
  workspace: WorkspaceRecord;
  vocabulary: Array<{ keyword: string; score: number; sessions: number }>;
  keywordLimit: number;
}) {
  return [
    "You are a read-only keyword selector for a Threadex.",
    "Project context: this project builds agent session management. When a user enters a prompt, the app uses vector search, keyword matching, and related retrieval methods to find relevant past sessions as context so the coding agent can work more effectively.",
    "Do not solve the user's task. Do not choose a session. Do not call tools.",
    "Your only job is to select the best search keywords from the provided controlled vocabulary.",
    "Prefer specific product, file, feature, UI, API, library, and domain terms.",
    "For prompts about description vector search, embedding models, retrieval quality, or finding related sessions, map the user's words to this project's retrieval domain. Prefer useful terms such as keyword, routing, postgres, ollama, openrouter, inspector, summarizer, embedding, embeddings, vector, and model when they fit the prompt and appear in the vocabulary.",
    "Preserve hard constraints from the user prompt, especially feature words like resend, retry, chatbox, dialog, button, account, workspace, embeddings, vector, or model.",
    "You may include an exact user-prompt keyword even when it is absent or low-ranked in the controlled vocabulary, if it is a hard constraint.",
    "Ignore generic words like fix, update, add, code, task, work, session, user, local, repo, test unless they are the only meaningful choices.",
    "Return only a comma-separated keyword list. No JSON. No markdown. No explanation.",
    `Return at most ${input.keywordLimit} keywords.`,
    "",
    `Active workspace: ${JSON.stringify({ id: input.workspace.id, name: input.workspace.name, cwd: input.workspace.cwd })}`,
    `User prompt: ${JSON.stringify(input.message)}`,
    "Controlled vocabulary, sorted by corpus usefulness:",
    JSON.stringify(input.vocabulary.slice(0, 300), null, 2)
  ].join("\n");
}

function parseExperimentalKeywordRouteResponse(rawText: string): ParsedKeywordRouteDecision {
  const trimmed = rawText.trim();
  const keywords = trimmed
    .replace(/^keywords?\s*[:=]\s*/i, "")
    .split(/[,\n]/)
    .map((keyword) => keyword.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, ""))
    .filter((keyword, index, all) => keyword.length > 1 && all.indexOf(keyword) === index)
    .slice(0, 12);
  return { keywords, rawText: trimmed };
}

function mergeExperimentalKeywordRouteKeywords(input: {
  modelKeywords: string[];
  promptKeywords: string[];
  keywordLimit: number;
}) {
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const keyword of [...input.promptKeywords, ...input.modelKeywords]) {
    const normalized = normalizeExperimentalKeywordToken(keyword);
    if (!normalized || seen.has(normalized) || isGenericExperimentalKeyword(normalized)) {
      continue;
    }
    seen.add(normalized);
    selected.push(normalized);
    if (selected.length >= input.keywordLimit) {
      break;
    }
  }
  return selected;
}

function extractExperimentalPromptKeywords(message: string) {
  const matches = message.toLocaleLowerCase().match(/[a-z][a-z0-9_-]{1,39}/g) ?? [];
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const match of matches) {
    const keyword = normalizeExperimentalKeywordToken(match);
    if (!keyword || seen.has(keyword) || isGenericExperimentalKeyword(keyword)) {
      continue;
    }
    seen.add(keyword);
    keywords.push(keyword);
  }
  return keywords.slice(0, 8);
}

function normalizeExperimentalKeywordToken(value: string) {
  const normalized = value.trim().toLocaleLowerCase().replace(/[^a-z0-9_-]+/g, "");
  return /^[a-z][a-z0-9_-]{1,39}$/.test(normalized) ? normalized : "";
}

function isGenericExperimentalKeyword(keyword: string) {
  return experimentalGenericKeywordTokens.has(keyword);
}

const experimentalGenericKeywordTokens = new Set([
  "add",
  "added",
  "better",
  "change",
  "changed",
  "code",
  "codex",
  "data",
  "debug",
  "default",
  "description",
  "done",
  "fe",
  "field",
  "find",
  "fix",
  "fixed",
  "for",
  "index",
  "in",
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

async function chooseExperimentalSessionRoute(input: {
  message: string;
  workspace: WorkspaceRecord;
  candidates: SessionRouteCandidate[];
  clues: string;
  model: string;
}): Promise<ParsedSessionRouteDecision> {
  if (process.env.SESSION_ROUTER_PROVIDER === "mock") {
    return parseExperimentalRouteResponse(process.env.SESSION_ROUTER_MOCK_RESPONSE || `START_NEW\n${input.message}`);
  }

  const prompt = buildExperimentalSessionRoutePrompt(input);
  const agentHome = createEphemeralAgentHome({
    prefix: "session-router-agent-",
    sourceHomeCandidates: experimentalSessionRouterAgentHomeCandidates(),
    allowMissingAuth: Boolean(process.env.OPENAI_API_KEY?.trim())
  });
  const outputPath = resolve(agentHome.home, "last-message.txt");

  try {
    const result = await runAgentCliExec({
      prompt,
      model: input.model,
      cwd: input.workspace.cwd || projectRoot,
      outputPath,
      timeoutMs: experimentalSessionRouterTimeoutMs(),
      sandbox: "read-only",
      env: {
        ...process.env,
        HOME: agentHome.home,
        AGENT_CLI_HOME: agentHome.home,
        CODEX_HOME: agentHome.home,
        CODEX_WORKDIR: input.workspace.cwd || projectRoot
      }
    });
    const output = existsSync(outputPath) ? readFileSync(outputPath, "utf8").trim() : "";
    const responseText = output || result.stdout.trim();
    if (!responseText) {
      throw new Error(`Session router model produced no output.${result.stderr ? ` stderr: ${trimAgentCliOutput(result.stderr)}` : ""}`);
    }
    await recordBackgroundModelUsage({
      id: `background:session_router:${crypto.randomUUID()}`,
      task: "session_router",
      source: "codex_exec",
      workspaceId: input.workspace.id,
      model: input.model,
      usage: result.usage
    });
    return parseExperimentalRouteResponse(responseText);
  } finally {
    agentHome.cleanup();
  }
}

function buildExperimentalSessionRoutePrompt(input: {
  message: string;
  workspace: WorkspaceRecord;
  candidates: SessionRouteCandidate[];
  clues: string;
}) {
  return [
    "You are a temporary read-only routing session for a Threadex.",
    "Do not solve the user's task. Do not edit files. Do not call tools.",
    "Your only job is to choose whether an executor should resume one candidate thread/session or start a new thread, then write the executor prompt.",
    "Resume only when the user's prompt clearly continues, asks about, or depends on a candidate's prior context.",
    "Choose START_NEW when there is no strongly relevant candidate, even if a candidate is topically similar.",
    "Use the repo clues only to add relevant, concise guidance to the executor prompt.",
    "The executor prompt must follow the user's prompt language.",
    "Output plain text only. No JSON. No markdown fences. No explanation.",
    "Line 1 must be exactly one candidate routeId, or exactly START_NEW.",
    "Line 2 and below must be the prompt for the executor. Keep it direct and runnable.",
    "",
    `Active workspace: ${JSON.stringify({ id: input.workspace.id, name: input.workspace.name, cwd: input.workspace.cwd })}`,
    `User prompt: ${JSON.stringify(input.message)}`,
    "Repo clues from AGENTS.md / docs / skills references:",
    input.clues || "[none]",
    "Candidates:",
    JSON.stringify(input.candidates, null, 2)
  ].join("\n");
}

function parseExperimentalRouteResponse(rawText: string): ParsedSessionRouteDecision {
  const trimmed = rawText.trim();
  const lines = trimmed.split(/\r?\n/);
  const firstLine = lines.shift()?.trim() || "START_NEW";
  const routeId = firstLine === "START_NEW" ? "START_NEW" : firstLine;
  const executorPrompt = lines.join("\n").trim();
  return {
    action: routeId === "START_NEW" ? "start_new" : "resume",
    routeId,
    sessionId: null,
    threadId: null,
    executorPrompt,
    rawText: trimmed
  };
}

function normalizeExperimentalRouteDecision(
  decision: ParsedSessionRouteDecision,
  candidates: SessionRouteCandidate[],
  fallbackPrompt: string
) {
  const selected = decision.routeId === "START_NEW"
    ? null
    : candidates.find((candidate) => candidate.routeId === decision.routeId || candidate.sessionId === decision.routeId || candidate.threadId === decision.routeId);
  const executorPrompt = decision.executorPrompt || fallbackPrompt;
  if (decision.action !== "resume" || !selected) {
    return {
      action: "start_new" as const,
      routeId: "START_NEW",
      sessionId: null,
      threadId: null,
      executorPrompt
    };
  }

  return {
    action: "resume" as const,
    routeId: selected.routeId,
    sessionId: selected.sessionId,
    threadId: selected.threadId,
    executorPrompt
  };
}

function formatExperimentalRoutingText(routeId: string, executorPrompt: string) {
  return `${routeId || "START_NEW"}\n${executorPrompt}`.trimEnd();
}

function loadExperimentalRoutingClues() {
  const chunks: string[] = [];
  const agentsPath = resolve(projectRoot, "AGENTS.md");
  if (existsSync(agentsPath)) {
    chunks.push(`AGENTS.md:\n${trimRoutingClueText(readFileSync(agentsPath, "utf8"), 2500)}`);
  }

  const readmePath = resolve(projectRoot, "README.md");
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, "utf8");
    chunks.push(`README fast map:\n${trimRoutingClueText(extractReadmeSection(readme, "Agent Fast Map"), 2500)}`);
    chunks.push(`README API surface:\n${trimRoutingClueText(extractReadmeSection(readme, "API Surface"), 2200)}`);
    const skillLines = readme
      .split(/\r?\n/)
      .filter((line) => /skills\/|session-inspector|codex-app-server/i.test(line))
      .slice(0, 12)
      .join("\n");
    if (skillLines.trim()) {
      chunks.push(`README skill references:\n${trimRoutingClueText(skillLines, 1200)}`);
    }
  }

  return chunks.filter((chunk) => chunk.trim()).join("\n\n");
}

function extractReadmeSection(readme: string, heading: string) {
  const pattern = new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "m");
  const match = pattern.exec(readme);
  if (!match) {
    return "";
  }
  const start = match.index + match[0].length;
  const rest = readme.slice(start);
  const next = /^##\s+/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

function trimRoutingClueText(value: string, maxChars: number) {
  const trimmed = value.replace(/\n{3,}/g, "\n\n").trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars - 3)}...`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function experimentalSessionRouterModel() {
  return process.env.SESSION_ROUTER_MODEL?.trim() || "gpt-5.6-luna";
}

function experimentalSessionRouterTimeoutMs() {
  const parsed = Number(process.env.SESSION_ROUTER_TIMEOUT_MS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 90_000;
}

function experimentalSessionRouterAgentHomeCandidates() {
  return [
    process.env.SESSION_ROUTER_AGENT_HOME,
    process.env.SESSION_SUMMARIZER_AGENT_HOME,
    process.env.SESSION_SUMMARIZER_CODEX_HOME,
    ...defaultAgentHomeCandidates()
  ];
}

function clamp01(value: number) {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

async function getRequestedOrActiveWorkspace(
  requestedWorkspaceId: unknown,
  fallbackWorkspaceId?: string
): Promise<WorkspaceRecord> {
  const requestedId =
    typeof requestedWorkspaceId === "string" && requestedWorkspaceId.trim()
      ? requestedWorkspaceId.trim()
      : fallbackWorkspaceId;
  const workspaceId = normalizeWorkspaceId(requestedId);

  if (workspaceId) {
    const workspace = await sessionStore.getWorkspace(workspaceId);
    if (workspace) {
      return workspace;
    }
  }

  return sessionStore.getActiveWorkspace();
}

function normalizeWorkspaceId(workspaceId: string | undefined) {
  return workspaceId === "session-manager" ? "threadex" : workspaceId;
}

async function getRequestedOrActiveAccount(
  workspaceId: string,
  requestedAccountId: unknown,
  fallbackAccountId?: string | null,
  loadBalanceInWorkspace = false
): Promise<AccountRecord | null> {
  if (requestedAccountId === null && !loadBalanceInWorkspace) {
    return null;
  }

  if (loadBalanceInWorkspace) {
    return chooseWorkspaceLoadBalancedAccount(workspaceId);
  }

  const accountId =
    typeof requestedAccountId === "string" && requestedAccountId.trim()
      ? requestedAccountId.trim()
      : fallbackAccountId;

  if (accountId) {
    const account = await sessionStore.getAccount(accountId);
    if (account) return account;
  }

  const activeAccount = await sessionStore.getActiveAccount(workspaceId);
  if (activeAccount) return activeAccount;

  return sessionStore.getFirstWorkspaceAccount(workspaceId);
}

async function chooseWorkspaceLoadBalancedAccount(
  workspaceId: string,
  options: { excludeAccountId?: string | null } = {}
) {
  const accounts = (await sessionStore.listAccountsForWorkspace(workspaceId))
    .filter((account) => account.id !== options.excludeAccountId);
  return chooseLoadBalancedAccount(accounts, {
    hasSavedAuth: accountHasSavedAuth
  });
}

async function disableWorkspaceAutoLoadBalance(workspaceId: string) {
  await sessionStore.setWorkspaceAutoLoadBalance(workspaceId, false);
  autoLoadBalanceWorkspaceIds.delete(workspaceId);
}

async function advanceLoadBalancedAccountForWorkspace(workspaceId: string) {
  return advanceLoadBalancedAccountForWorkspaceWithOptions(workspaceId, true);
}

async function advanceLoadBalancedAccountForWorkspaceWithOptions(
  workspaceId: string,
  clearActiveSession: boolean,
  excludeAccountId?: string | null
) {
  const account = await chooseWorkspaceLoadBalancedAccount(workspaceId, { excludeAccountId });
  if (account) {
    await sessionStore.switchAccount(account.id, workspaceId);
  } else {
    await sessionStore.switchAccount(null, workspaceId);
  }
  if (clearActiveSession) {
    await sessionStore.clearActiveSession(workspaceId);
  }
  return account;
}

async function advanceAutoLoadBalanceAfterLimit(sessionId: string, persistedLoadBalance = false) {
  const session = await sessionStore.getSession(sessionId);
  if (!session || (!persistedLoadBalance && !autoLoadBalanceWorkspaceIds.has(session.workspaceId))) {
    return;
  }

  const account = await advanceLoadBalancedAccountForWorkspaceWithOptions(session.workspaceId, false, session.accountId);
  if (!account) {
    return;
  }

  // A usage-limited follow-up should stay in the same Codex thread while the
  // next available account handles the next turn. Manual account changes and
  // explicit load-balance actions still clear the session below this path.
  await rebindSessionAccount(sessionStore, session, account);
}

async function prepareAutoLoadBalancedChatRequest(request: ChatRequest): Promise<ChatRequest> {
  const workspace = await getRequestedOrActiveWorkspace(request.workspaceId);
  if (request.loadBalanceInWorkspace === true) {
    if (!autoLoadBalanceWorkspaceIds.has(workspace.id)) {
      await sessionStore.setWorkspaceAutoLoadBalance(workspace.id, true);
    }
    autoLoadBalanceWorkspaceIds.add(workspace.id);
  }
  return request;
}

async function getAccountResponseFields(workspaceId: string, knownActiveAccount?: AccountRecord | null) {
  const candidate = knownActiveAccount === undefined ? await sessionStore.getActiveAccount(workspaceId) : knownActiveAccount;
  const activeAccount = candidate ?? await sessionStore.getFirstWorkspaceAccount(workspaceId);
  return {
    accounts: await sessionStore.listAccounts(),
    activeAccount,
    loadBalanceInWorkspace: autoLoadBalanceWorkspaceIds.has(workspaceId),
    workspaceAccounts: await sessionStore.listAccountsForWorkspace(workspaceId),
    workspaceAccountIds: await sessionStore.listWorkspaceAccountIds(workspaceId)
  };
}

async function syncRunnerAccount(job: RunnerJob) {
  if (!job.accountId) {
    return;
  }

  const auth = await sessionStore.getAccountAuth(job.accountId);
  if (!auth) {
    throw new Error(`Account ${job.accountId} has no auth stored in the database.`);
  }

  const identityError = accountAuthIdentityError(auth.authRaw, {
    externalAccountId: job.accountExternalAccountId,
    externalUserId: job.accountExternalUserId
  });
  if (identityError) {
    throw new Error(`Account ${job.accountId} auth mismatch: ${identityError}.`);
  }

  materializeAccountAuth(job.codexHome, auth.authRaw, auth.configRaw);
  job.accountAuthVersion = auth.version;
}

async function applyAccountToWorkspace(account: AccountRecord, workspace: WorkspaceRecord) {
  const auth = await sessionStore.getAccountAuth(account.id);
  if (!auth) {
    return;
  }

  const identityError = accountAuthIdentityError(auth.authRaw, {
    externalAccountId: account.externalAccountId,
    externalUserId: account.externalUserId
  });
  if (identityError) {
    throw new Error(`Account ${account.id} auth mismatch: ${identityError}.`);
  }

  materializeAccountAuth(workspace.codexHome, auth.authRaw, auth.configRaw);
}

function accountHasSavedAuth(account: AccountRecord) {
  return account.hasAuth && !isAccountLoggedOut(account);
}

async function accountStoredAuthIdentityError(account: AccountRecord) {
  const auth = await sessionStore.getAccountAuth(account.id);
  if (!auth) {
    return null;
  }
  return accountAuthIdentityError(auth.authRaw, {
    externalAccountId: account.externalAccountId,
    externalUserId: account.externalUserId
  });
}

function materializeAccountAuth(codexHome: string, authRaw: string, configRaw: string | null) {
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(codexHome, "auth.json"), authRaw, { encoding: "utf8", mode: 0o600 });
  const configPath = resolve(codexHome, "config.toml");
  if (configRaw === null) {
    rmSync(configPath, { force: true });
  } else {
    writeFileSync(configPath, configRaw, { encoding: "utf8", mode: 0o600 });
  }
}

function isAccountLoggedOut(account: AccountRecord) {
  return isAccountLoginRequiredMessage(account.quotaError);
}

function isNoRolloutFoundMessage(value: string | null | undefined) {
  return Boolean(value && value.toLowerCase().includes("no rollout found for thread id"));
}

async function clearSessionThread(sessionId: string | undefined | null) {
  if (!sessionId) {
    return;
  }

  const session = await sessionStore.getSession(sessionId);
  if (!session) {
    return;
  }

  await sessionStore.upsertSession({
    id: session.id,
    threadId: null,
    workspaceId: session.workspaceId,
    cwd: session.cwd,
    accountId: session.accountId,
    title: session.title,
    titleSource: session.titleSource,
    description: session.description,
    parentSessionId: session.parentSessionId,
    forkedFromTurnId: session.forkedFromTurnId,
    keywordWeights: session.keywordWeights
  });
}

async function markTurnAccountLoggedOut(turnId: string): Promise<AccountRecord | null> {
  const turn = await sessionStore.getSessionTurn(turnId);
  if (!turn?.accountId) {
    return null;
  }

  const account = await sessionStore.getAccount(turn.accountId);
  if (!account) {
    return null;
  }

  return sessionStore.upsertAccount({
    id: account.id,
    name: account.name,
    externalAccountId: account.externalAccountId,
    externalUserId: account.externalUserId,
    email: account.email,
    quotaUpdatedAt: new Date().toISOString(),
    quotaError: accountLoggedOutQuotaError
  });
}

function accountConfigPath(snapshotPath: string) {
  return resolve(dirname(snapshotPath), "config.toml");
}

function readOptionalTextFile(path: string) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function writeAccountConfig(accountDir: string, apiUrl: string | null) {
  if (!apiUrl) {
    return;
  }

  const parsed = new URL(apiUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("API URL must start with http:// or https://.");
  }

  writeFileSync(resolve(accountDir, "config.toml"), `openai_base_url = ${tomlString(parsed.toString())}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

function tomlString(value: string) {
  return JSON.stringify(value);
}

async function codexLoginWithApiKey(codexHome: string, apiKey: string) {
  await runCodexLoginProcess({
    codexHome,
    args: ["login", "--with-api-key"],
    stdin: `${apiKey}\n`,
    timeoutMs: 30_000
  });
}

async function startAccountChatGptLogin(
  name: string,
  accountId: string | null,
  workspaceId: string,
  sessionId: string | null
): Promise<PendingAccountLogin> {
  const id = crypto.randomUUID();
  const codexHome = mkdtempSync(resolve(tmpdir(), "threadex-account-login-"));
  const child = spawn(codexExecutable(), buildAppServerArgs(), {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const login: PendingAccountLogin = {
    id,
    appServerLoginId: null,
    accountId,
    workspaceId,
    sessionId,
    name,
    codexHome,
    child,
    output: [],
    loginUrl: null,
    userCode: null,
    error: null,
    completedAccount: null,
    completionPromise: null,
    createdAt: Date.now()
  };

  let nextRpcId = 1;
  let stdoutBuffer = "";
  const pending = new Map<number, JsonRpcRequest>();
  const rpc = (method: string, params: unknown = {}) =>
    new Promise<unknown>((resolveRpc, rejectRpc) => {
      const rpcId = nextRpcId++;
      pending.set(rpcId, { resolve: resolveRpc, reject: rejectRpc });
      child.stdin?.write(`${JSON.stringify({ id: rpcId, method, params })}\n`);
    });
  const notify = (method: string, params: unknown = {}) => {
    child.stdin?.write(`${JSON.stringify({ method, params })}\n`);
  };

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdoutBuffer += String(chunk);
    let lineEnd = stdoutBuffer.indexOf("\n");
    while (lineEnd !== -1) {
      const line = stdoutBuffer.slice(0, lineEnd).trim();
      stdoutBuffer = stdoutBuffer.slice(lineEnd + 1);
      if (line) {
        login.output.push(line);
        handleJsonRpcLine(line, pending);
        const message = parseJsonRpcMessage(line);
        updatePendingLoginFromMessage(login, message);
        handlePendingLoginNotification(login, message);
      }
      lineEnd = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr?.on("data", (chunk) => login.output.push(String(chunk)));
  child.on("error", (error) => {
    login.error = errorMessage(error);
    for (const request of pending.values()) {
      request.reject(error instanceof Error ? error : new Error(String(error)));
    }
    pending.clear();
  });
  child.on("exit", (code) => {
    if (!login.error && code !== 0 && code !== null) {
      login.error = `Codex login app-server exited with code ${code}.`;
    }
    for (const request of pending.values()) {
      request.reject(new Error(login.error ?? "Codex login app-server exited."));
    }
    pending.clear();
  });

  try {
    await withTimeout(
      rpc("initialize", {
        clientInfo: { name: "threadex", title: "Threadex", version: "0.1.0" },
        capabilities: { experimentalApi: true }
      }),
      10_000,
      "Codex login app-server initialize timed out"
    );
    notify("initialized", {});
    const response = await withTimeout(
      rpc("account/login/start", {
        type: "chatgpt",
        useHostedLoginSuccessPage: true,
        appBrand: "codex"
      }),
      30_000,
      "Codex ChatGPT login start timed out"
    );
    updatePendingLoginFromPayload(login, response);
    if (!login.loginUrl) {
      throw new Error("Codex ChatGPT login did not return an auth URL.");
    }
  } catch (error) {
    login.error = errorMessage(error);
    child.kill("SIGTERM");
    rmSync(codexHome, { recursive: true, force: true });
    throw error;
  }

  return login;
}

function getAccountLoginDetails(login: PendingAccountLogin) {
  return {
    loginUrl: login.loginUrl ?? extractLoginUrl(cleanTerminalText(login.output.join("\n"))),
    userCode: login.userCode ?? extractDeviceUserCode(cleanTerminalText(login.output.join("\n")))
  };
}

function parseJsonRpcMessage(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return readObject(parsed);
  } catch {
    return null;
  }
}

function updatePendingLoginFromMessage(login: PendingAccountLogin, message: Record<string, unknown> | null) {
  if (!message) {
    return;
  }

  updatePendingLoginFromPayload(login, readObject(message.result) ?? readObject(message.params) ?? message);
}

function handlePendingLoginNotification(login: PendingAccountLogin, message: Record<string, unknown> | null) {
  if (readString(message?.method) !== "account/login/completed") {
    return;
  }

  const params = readObject(message?.params);
  if (readBoolean(params?.success) === false) {
    login.error = readString(params?.error) ?? "Codex ChatGPT login failed.";
    return;
  }

  if (readBoolean(params?.success) === true) {
    void finalizePendingAccountLogin(login).catch((error) => {
      login.error = errorMessage(error);
    });
  }
}

async function finalizePendingAccountLogin(login: PendingAccountLogin): Promise<AccountRecord | null> {
  if (login.completedAccount) {
    return login.completedAccount;
  }
  if (login.completionPromise) {
    return login.completionPromise;
  }

  const completion = finalizePendingAccountLoginInner(login);
  login.completionPromise = completion;
  try {
    return await completion;
  } finally {
    if (login.completionPromise === completion) {
      login.completionPromise = null;
    }
  }
}

async function finalizePendingAccountLoginInner(login: PendingAccountLogin): Promise<AccountRecord | null> {
  const authPath = resolve(login.codexHome, "auth.json");
  if (!existsSync(authPath)) {
    await waitForAccountAuth(login, 2_000);
  }
  if (!existsSync(authPath)) {
    return null;
  }

  const workspace = await sessionStore.getWorkspace(login.workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${login.workspaceId}`);
  }

  const metadata = inferAuthMetadata(authPath);
  const accountId = login.accountId ?? `${safePathSegment(login.name)}-${crypto.randomUUID().slice(0, 8)}`;

  let account = await sessionStore.upsertAccount({
    id: accountId,
    name: login.name,
    externalAccountId: metadata.externalAccountId,
    externalUserId: metadata.externalUserId,
    email: metadata.email
  });
  await sessionStore.setAccountAuth(
    account.id,
    readFileSync(authPath, "utf8"),
    readOptionalTextFile(resolve(login.codexHome, "config.toml"))
  );
  account = (await sessionStore.getAccount(account.id)) ?? account;
  await sessionStore.bindWorkspaceAccount(workspace.id, account.id);
  await sessionStore.switchAccount(account.id, workspace.id);
  await refreshQuotaForAccount(account);
  account = (await sessionStore.getAccount(account.id)) ?? account;
  await applyAccountToWorkspace(account, workspace);
  if (login.sessionId) {
    const session = await sessionStore.getSession(login.sessionId);
    if (session && session.workspaceId === workspace.id) {
      await rebindSessionAccount(sessionStore, session, account);
      void schedulePendingTurnsForSession(session.id, { immediate: true }).catch((error) => {
        console.warn(`Failed to retry auth-pending turns after login: ${errorMessage(error)}`);
      });
    }
  } else {
    void schedulePendingTurnsForAccount(account.id, { immediate: true }).catch((error) => {
      console.warn(`Failed to retry auth-pending turns after login: ${errorMessage(error)}`);
    });
  }
  login.completedAccount = account;
  stopPendingAccountLoginProcess(login);
  return account;
}

function updatePendingLoginFromPayload(login: PendingAccountLogin, payload: unknown) {
  const root = readObject(payload);
  if (!root) {
    return;
  }

  for (const value of [root, readObject(root.login), readObject(root.account)].filter(Boolean)) {
    const record = value as Record<string, unknown>;
    login.appServerLoginId ??= readString(record.loginId) ?? readString(record.login_id);
    login.userCode ??=
      normalizeDeviceUserCode(readString(record.userCode) ?? readString(record.user_code) ?? readString(record.code));
    login.loginUrl ??=
      readString(record.verificationUrl) ??
      readString(record.verification_url) ??
      readString(record.authUrl) ??
      readString(record.auth_url) ??
      readString(record.loginUrl) ??
      readString(record.url);
  }
}

function normalizeDeviceUserCode(value: string | null) {
  return value ? extractDeviceUserCode(value) ?? value : null;
}

function getAccountLoginError(login: PendingAccountLogin) {
  if (login.error) {
    return login.error;
  }
  if (login.child.exitCode === null) {
    return null;
  }

  const output = cleanTerminalText(login.output.join("\n")).trim();
  return output || `Codex login exited with code ${login.child.exitCode}.`;
}

async function waitForAccountAuth(login: PendingAccountLogin, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(resolve(login.codexHome, "auth.json"))) {
      return;
    }
    await sleep(250);
  }
}

function cleanupExpiredAccountLogins() {
  const now = Date.now();
  for (const [id, login] of pendingAccountLogins) {
    if (now - login.createdAt > pendingAccountLoginTtlMs) {
      cleanupPendingAccountLogin(id);
    }
  }
}

function cleanupPendingAccountLogin(id: string) {
  const login = pendingAccountLogins.get(id);
  if (!login) {
    return;
  }

  pendingAccountLogins.delete(id);
  stopPendingAccountLoginProcess(login);
}

function stopPendingAccountLoginProcess(login: PendingAccountLogin) {
  if (!login.child.killed) {
    login.child.kill("SIGTERM");
  }
  rmSync(login.codexHome, { recursive: true, force: true });
}

function extractLoginUrl(value: string) {
  const clean = cleanTerminalText(value);
  const match = clean.match(/https?:\/\/[^\s)"'<>]+/);
  if (!match) {
    return null;
  }

  try {
    return new URL(match[0]).toString();
  } catch {
    return match[0].replace(/[^\w./:?=&%#+~-]+$/g, "");
  }
}

function extractDeviceUserCode(value: string) {
  const clean = cleanTerminalText(value);
  const separated = clean.match(/\b([A-Z0-9]{4})[\s-]+([A-Z0-9]{4})\b/);
  if (separated) {
    return `${separated[1]}-${separated[2]}`;
  }

  const compact = clean.match(/\b[A-Z0-9]{8}\b/);
  if (!compact) {
    return null;
  }
  return `${compact[0].slice(0, 4)}-${compact[0].slice(4)}`;
}

function cleanTerminalText(value: string) {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, " ");
}

async function runCodexLoginProcess(input: {
  codexHome: string;
  args: string[];
  stdin?: string;
  timeoutMs: number;
}) {
  return new Promise<{ stdout: string; stderr: string }>((resolveProcess, rejectProcess) => {
    const child = spawn(codexExecutable(), input.args, {
      env: { ...process.env, CODEX_HOME: input.codexHome },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`Codex login timed out after ${input.timeoutMs}ms.`));
      child.kill("SIGTERM");
    }, input.timeoutMs);

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        rejectProcess(error);
      } else {
        resolveProcess({ stdout: stdout.join(""), stderr: stderr.join("") });
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    child.on("exit", (code, signal) => {
      if (code === 0) {
        finish();
      } else {
        finish(new Error(`Codex login failed (${signal ?? code ?? "unknown"}): ${stderr.join("").trim()}`));
      }
    });

    if (input.stdin) {
      child.stdin.end(input.stdin);
    } else {
      child.stdin.end();
    }
  });
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

function inferAuthMetadata(authPath: string) {
  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
    const tokens = parsed.tokens && typeof parsed.tokens === "object" ? (parsed.tokens as Record<string, unknown>) : parsed;
    const accessToken = stringField(tokens, "access_token") ?? stringField(tokens, "accessToken");
    const claims = parseJwtPayload(accessToken);
    const authClaims =
      claims?.["https://api.openai.com/auth"] && typeof claims["https://api.openai.com/auth"] === "object"
        ? (claims["https://api.openai.com/auth"] as Record<string, unknown>)
        : {};
    return {
      externalAccountId:
        stringField(tokens, "account_id") ??
        stringField(authClaims, "chatgpt_account_id") ??
        stringField(authClaims, "user_id"),
      externalUserId: stringField(authClaims, "user_id"),
      email: stringField(claims, "email") ?? stringField(parsed, "email")
    };
  } catch {
    return {
      externalAccountId: null,
      externalUserId: null,
      email: null
    };
  }
}

function parseJwtPayload(token: string | null) {
  if (!token) {
    return null;
  }

  const [, payload] = token.split(".");
  if (!payload) {
    return null;
  }

  try {
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringField(value: Record<string, unknown> | null, key: string) {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function formatStoredUserInput(message: string, attachments: SavedAttachment[]) {
  const attachmentLines = attachments.map((attachment) => `- ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes)`);
  return `${message}\n\n[Attached files]\n${attachmentLines.join("\n")}`;
}

function normalizeModel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return /^[A-Za-z0-9._: -]{1,80}$/.test(trimmed) ? trimmed : undefined;
}

function normalizeReasoningEffort(value: unknown): "minimal" | "low" | "medium" | "high" | "xhigh" | "ultra" | undefined {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "ultra"
    ? value
    : undefined;
}

function normalizeAutoModel(value: unknown) {
  return isAutoModel(value) ? value : undefined;
}

function normalizeAutoEffort(value: unknown) {
  return isAutoEffort(value) ? value : undefined;
}

function safePathSegment(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || crypto.randomUUID();
}

function runnerControlPath(turnId: string) {
  return resolve(runnerControlDir, `${safePathSegment(turnId)}.ndjson`);
}

function runnerControlResultPath(commandId: string) {
  return resolve(runnerControlResultDir, `${safePathSegment(commandId)}.json`);
}

async function waitForRunnerSteerResult(commandId: string, turnId: string, runnerPid: number) {
  const resultPath = runnerControlResultPath(commandId);
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    if (existsSync(resultPath)) {
      const result = JSON.parse(readFileSync(resultPath, "utf8")) as RunnerSteerResult;
      rmSync(resultPath, { force: true });
      return result;
    }
    if (!isProcessAlive(runnerPid)) {
      throw new Error(`Prompt runner ${runnerPid} exited before the steer was delivered.`);
    }
    const turn = await sessionStore.getSessionTurn(turnId);
    if (turn?.status !== "running") {
      throw new Error("The turn finished before the steer was delivered.");
    }
    await sleep(100);
  }
  throw new Error("Runner steer timed out.");
}

function createLocalSessionId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const randomPart = Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("");
  return `local_${Date.now().toString(36)}_${randomPart}`;
}

async function processRunnerUpdate(
  update: Required<Pick<RunnerUpdateRequest, "id" | "sessionId" | "turnId" | "event">> & RunnerUpdateRequest,
  options: { refreshRunnerHeartbeat?: boolean } = {}
) {
  const next = runnerUpdateQueue.then(async () => {
    const stateApplied = await applyRunnerUpdate(update, options);
    await appendRunnerResponseToTurnLog(update, stateApplied);
    await publishRunnerUpdateEvent(update);
  });
  runnerUpdateQueue = next.catch(() => undefined);
  await next;
}

async function appendRunnerResponseToTurnLog(
  update: Required<Pick<RunnerUpdateRequest, "id" | "sessionId" | "turnId" | "event">> & RunnerUpdateRequest,
  stateApplied: boolean
) {
  if (!stateApplied) {
    return;
  }

  let source: string | null = null;
  let agentResponse: string | null = null;
  let status: "done" | "todo" | null = null;

  if (update.event === "codex" && isCodexTurnCompleted(update.data)) {
    source = "runner.codex.completed";
    agentResponse = readCompletedTurnFallback(update.logPath, update.jsonlIndex).reply;
    status = "done";
  } else if (update.event === "result") {
    source = "runner.result";
    agentResponse = objectString(update.data, "reply") ?? "Turn completed without a final agent message.";
    status = "done";
  } else if (update.event === "pending") {
    source = "runner.pending";
    agentResponse = objectString(update.data, "message") ?? "Queued for retry after usage limit reset.";
    status = "todo";
  } else if (update.event === "error") {
    source = "runner.error";
    agentResponse = `Codex error: ${objectString(update.data, "message") ?? "Unknown error"}`;
    status = isAccountLoginRequiredMessage(objectString(update.data, "message")) ? "todo" : "done";
  }

  if (source && agentResponse !== null && status) {
    await turnRingLog.appendAgentResponse({
      eventId: `response:${update.id}`,
      source,
      sessionId: update.sessionId,
      turnId: update.turnId,
      agentResponse,
      status
    });
  }
}

async function applyRunnerUpdate(
  update: Required<Pick<RunnerUpdateRequest, "id" | "sessionId" | "turnId" | "event">> & RunnerUpdateRequest,
  options: { refreshRunnerHeartbeat?: boolean } = {}
): Promise<boolean> {
  if (update.event === "done" || update.event === "result" || update.event === "pending" || update.event === "error") {
    runnerSwitchReplayAttempts.delete(update.turnId);
  }
  await sessionStore.recordSessionTurnEvent({
    id: update.id,
    turnId: update.turnId,
    sessionId: update.sessionId,
    eventName: update.event,
    payload: update.data ?? null,
    jsonlIndex: update.jsonlIndex ?? null,
    sequence: readNumber(readObject(update.data)?.sequence),
    refreshRunnerHeartbeat: options.refreshRunnerHeartbeat
  });
  await persistRunnerBackgroundModelUsage(update);
  await persistRunnerUsageSamples(update);

  const runnerThreadId = objectString(update.data, "threadId") ?? objectString(update.data, "thread_id");
  if (runnerThreadId) {
    await sessionStore.upsertSession({
      id: update.sessionId,
      threadId: runnerThreadId
    });
  }

  const commandCall = codexCommandCallFromUpdate(update);
  if (commandCall) {
    await sessionStore.recordCodexCommandCall(commandCall);
  }

  if (update.event === "runner.started" && update.runnerPid && update.logPath) {
    await sessionStore.markSessionTurnRunning({
      id: update.turnId,
      runnerPid: update.runnerPid,
      runnerLogPath: update.logPath
    });
    return true;
  }

  if (update.event === "runner.native_turn_link") {
    const nativeTurnId = objectString(update.data, "nativeTurnId");
    if (!nativeTurnId) {
      return true;
    }
    return sessionStore.linkManagedRunnerNativeTurn({
      sessionId: update.sessionId,
      managerTurnId: update.turnId,
      nativeTurnId,
      eventAlreadyRecorded: true
    });
  }

  if (update.event === "session") {
    const threadId = objectString(update.data, "threadId");
    if (threadId) {
      await sessionStore.upsertSession({
        id: update.sessionId,
        threadId
      });
    }
    return true;
  }

  if (update.event === "codex") {
    const data = readObject(update.data);
    if (readString(data?.method) === "thread/name/updated") {
      const params = readObject(data?.params);
      const threadId = objectString(params, "threadId");
      const title = normalizeCodexSessionTitle(params?.threadName);
      if (threadId && title) {
        await sessionStore.updateSessionTitle({ sessionId: update.sessionId, threadId, title, source: "codex" });
      }
    }
    if (isCodexTurnCompleted(update.data)) {
      const fallback = readCompletedTurnFallback(update.logPath, update.jsonlIndex);
      const completed = await sessionStore.updateSessionTurn({
        id: update.turnId,
        agentResponse: fallback.reply,
        tokenIn: fallback.tokenIn,
        tokenOut: fallback.tokenOut,
        // turn/completed only means Codex finished generating. Keep the
        // manager turn active until promptRunner has stopped app-server and
        // posts the terminal result, otherwise the next prompt can race the
        // still-held thread writer.
        status: "running",
        runnerExitCode: null,
        // A reconnect replays the runner log from the beginning. Never let an
        // old turn/completed event revive a turn that a later result/pending
        // event already made terminal, especially while a newer turn owns the
        // session's single-writer slot.
        expectedStatus: "running",
        ...(update.logPath ? { expectedRunnerLogPath: update.logPath } : {})
      });
      if (completed) {
        sessionSummarizer.noteSessionActivity(update.sessionId);
      }
      return completed;
    }
    return true;
  }

  if (update.event === "result") {
    const completed = await sessionStore.updateSessionTurn({
      id: update.turnId,
      agentResponse: objectString(update.data, "reply") ?? "Turn completed without a final agent message.",
      tokenIn: objectNumber(update.data, "tokenIn") ?? 0,
      tokenOut: objectNumber(update.data, "tokenOut") ?? 0,
      status: "done",
      runnerExitCode: 0,
      expectedStatus: "running",
      ...(update.logPath ? { expectedRunnerLogPath: update.logPath } : {})
    });
    if (!completed) {
      return false;
    }
    await sessionStore.cancelWaitSubscriptionsForTurn(update.turnId);
    void schedulePendingTurnsForSession(update.sessionId).catch((error) => {
      console.warn(`Failed to schedule pending turns after ${update.turnId}: ${errorMessage(error)}`);
    });
    sessionSummarizer.noteSessionActivity(update.sessionId);
    return true;
  }

  if (update.event === "pending") {
    const pendingMessage = objectString(update.data, "message") ?? "Queued for retry after usage limit reset.";
    const pendingReason = normalizeRunnerPendingReason(objectString(update.data, "reason"), pendingMessage);
    const [currentTurn, session] = await Promise.all([
      sessionStore.getSessionTurn(update.turnId),
      sessionStore.getSession(update.sessionId)
    ]);
    const pendingLoadBalance = pendingLoadBalanceForUpdate({
      pendingReason,
      persistedLoadBalance: currentTurn?.pendingLoadBalance ?? null,
      workspaceLoadBalanceEnabled: autoLoadBalanceWorkspaceIds.has(session?.workspaceId ?? "")
    });
    const queued = await sessionStore.updateSessionTurn({
      id: update.turnId,
      agentResponse: pendingMessage,
      tokenIn: 0,
      tokenOut: 0,
      status: "todo",
      runnerExitCode: 0,
      pendingReason,
      pendingLoadBalance,
      expectedStatus: "running",
      ...(update.logPath ? { expectedRunnerLogPath: update.logPath } : {})
    });
    if (!queued) {
      return false;
    }
    if (pendingReason === "rate_limit") {
      void advanceAutoLoadBalanceAfterLimit(update.sessionId, pendingLoadBalance)
        .catch((error) => {
          console.warn(`Failed to auto advance after usage limit for ${update.sessionId}: ${errorMessage(error)}`);
        })
        .finally(() => {
          void schedulePendingTurnsForSession(update.sessionId).catch((error) => {
            console.warn(`Failed to schedule rate-limited pending turn ${update.turnId}: ${errorMessage(error)}`);
          });
        });
    } else {
      if (pendingReason === "auth") {
        await markTurnAccountLoggedOut(update.turnId);
      }
      await sessionStore.cancelWaitSubscriptionsForTurn(update.turnId);
    }
    sessionSummarizer.noteSessionActivity(update.sessionId);
    return true;
  }

  if (update.event === "error") {
    const message = objectString(update.data, "message") ?? "Unknown error";
    const loginRequired = isAccountLoginRequiredMessage(message);
    const failed = await sessionStore.updateSessionTurn({
      id: update.turnId,
      agentResponse: loginRequired
        ? "Account authentication failed. The original prompt is saved and will be retried after login or an account switch."
        : `Codex error: ${message}`,
      tokenIn: 0,
      tokenOut: 0,
      status: loginRequired ? "todo" : "done",
      runnerExitCode: 1,
      pendingReason: loginRequired ? "auth" : null,
      expectedStatus: "running",
      ...(update.logPath ? { expectedRunnerLogPath: update.logPath } : {})
    });
    if (!failed) {
      return false;
    }
    if (loginRequired) {
      await markTurnAccountLoggedOut(update.turnId);
    }
    if (isNoRolloutFoundMessage(message)) {
      await clearSessionThread(update.sessionId);
    }
    await sessionStore.cancelWaitSubscriptionsForTurn(update.turnId);
    if (!loginRequired) {
      void schedulePendingTurnsForSession(update.sessionId).catch((scheduleError) => {
        console.warn(`Failed to schedule pending turns after runner error ${update.turnId}: ${errorMessage(scheduleError)}`);
      });
    }
    sessionSummarizer.noteSessionActivity(update.sessionId);
    return true;
  }

  return true;
}

async function persistRunnerBackgroundModelUsage(
  update: Required<Pick<RunnerUpdateRequest, "id" | "sessionId" | "turnId" | "event">> & RunnerUpdateRequest
) {
  if (update.event !== "background_usage") {
    return;
  }
  const data = readObject(update.data);
  const task = readString(data?.task);
  const model = readString(data?.model);
  const usage = normalizeModelTokenUsage(data?.usage);
  if (!task || !model || !usage) {
    return;
  }
  await recordBackgroundModelUsage({
    id: `background:${update.id}`,
    task,
    source: "app_server",
    sessionId: update.sessionId,
    turnId: update.turnId,
    model,
    usage,
    sourceTimestamp: update.ts,
    metadata: { itemId: readString(data?.itemId) }
  });
}

async function recordBackgroundModelUsage(input: {
  id: string;
  task: string;
  source: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  accountId?: string | null;
  model: string;
  usage: ModelTokenUsage | null;
  sourceTimestamp?: string | null;
  metadata?: Record<string, unknown>;
}) {
  if (!input.usage) {
    return;
  }
  try {
    await sessionStore.recordTokenUsage([{
      id: input.id,
      usageType: "background",
      source: input.source,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      accountId: input.accountId,
      model: input.model,
      sourceTimestamp: input.sourceTimestamp,
      inputTokens: input.usage.inputTokens,
      cachedInputTokens: input.usage.cachedInputTokens,
      outputTokens: input.usage.outputTokens,
      reasoningOutputTokens: input.usage.reasoningOutputTokens,
      totalTokens: input.usage.totalTokens,
      metadata: { task: input.task, ...input.metadata }
    }]);
  } catch (error) {
    console.warn(`Failed to record ${input.task} token usage: ${errorMessage(error)}`);
  }
}

function codexCommandCallFromUpdate(
  update: Required<Pick<RunnerUpdateRequest, "id" | "sessionId" | "turnId" | "event">> & RunnerUpdateRequest
) {
  if (update.event !== "item") {
    return null;
  }

  const data = readObject(update.data);
  if (!data || data.itemType !== "command_execution") {
    return null;
  }

  const itemId = typeof data.id === "string" && data.id ? data.id : null;
  const command = typeof data.command === "string" ? data.command : null;
  if (!itemId || command === null) {
    return null;
  }

  const aggregatedOutput = typeof data.aggregatedOutput === "string" ? data.aggregatedOutput : "";
  const jsonlIndex = typeof update.jsonlIndex === "number" && Number.isInteger(update.jsonlIndex) && update.jsonlIndex >= 0
    ? update.jsonlIndex
    : null;
  return {
    sessionId: update.sessionId,
    turnId: update.turnId,
    itemId,
    eventId: update.id,
    jsonlIndex,
    command,
    responseLength: aggregatedOutput.length,
    status: typeof data.status === "string" ? data.status : "",
    exitCode: readNumber(data.exitCode)
  };
}

async function persistRunnerUsageSamples(
  update: Required<Pick<RunnerUpdateRequest, "id" | "sessionId" | "turnId" | "event">> & RunnerUpdateRequest
) {
  const samples = usageSamplesFromRunnerUpdate(update);
  if (samples.length === 0) {
    return;
  }

  await sessionStore.recordSessionTurnTokenUsageSamples(samples);
}

function usageSamplesFromRunnerUpdate(
  update: Required<Pick<RunnerUpdateRequest, "id" | "sessionId" | "turnId" | "event">> & RunnerUpdateRequest
): SessionTurnTokenUsageSampleInput[] {
  if (update.event === "codex") {
    const data = readObject(update.data);
    if (!data || readString(data.method) !== "thread/tokenUsage/updated") {
      return [];
    }

    const params = readObject(data.params);
    const usage = readObject(params?.tokenUsage);
    const sample = tokenUsageSampleFromUsageRecord({
      sessionId: update.sessionId,
      turnId: update.turnId,
      source: "app_server",
      sourceIndex: typeof update.jsonlIndex === "number" ? update.jsonlIndex : null,
      sourceTimestamp: typeof update.ts === "string" ? update.ts : null,
      usage,
      rateLimits: null
    });
    return sample ? [{ ...sample, id: `${update.turnId}:app_server:${update.jsonlIndex ?? update.id}` }] : [];
  }

  if (update.event !== "token_count") {
    return [];
  }

  const data = readObject(update.data);
  const rawSamples = Array.isArray(data?.samples) ? data.samples : [];
  return rawSamples.flatMap((rawSample, index) => {
    const sampleRecord = readObject(rawSample);
    if (!sampleRecord) {
      return [];
    }

    const sample = tokenUsageSampleFromNativeTokenCount({
      sessionId: update.sessionId,
      turnId: update.turnId,
      sourceIndex: readNumber(sampleRecord.sourceIndex) ?? index,
      sourceTimestamp: readString(sampleRecord.sourceTimestamp),
      info: readObject(sampleRecord.info),
      rateLimits: readObject(sampleRecord.rateLimits)
    });
    return sample ? [sample] : [];
  });
}

function tokenUsageSampleFromUsageRecord(input: {
  sessionId: string;
  turnId: string;
  source: string;
  sourceIndex: number | null;
  sourceTimestamp: string | null;
  usage: Record<string, unknown> | null;
  rateLimits: Record<string, unknown> | null;
}): SessionTurnTokenUsageSampleInput | null {
  const last = readObject(input.usage?.last);
  const total = readObject(input.usage?.total);
  if (!last && !total) {
    return null;
  }

  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    source: input.source,
    sourceIndex: input.sourceIndex,
    sourceTimestamp: input.sourceTimestamp,
    inputTokens: readNumber(last?.inputTokens) ?? readNumber(last?.input_tokens) ?? 0,
    cachedInputTokens: readNumber(last?.cachedInputTokens) ?? readNumber(last?.cached_input_tokens) ?? 0,
    outputTokens: readNumber(last?.outputTokens) ?? readNumber(last?.output_tokens) ?? 0,
    reasoningOutputTokens: readNumber(last?.reasoningOutputTokens) ?? readNumber(last?.reasoning_output_tokens) ?? 0,
    totalTokens: readNumber(last?.totalTokens) ?? readNumber(last?.total_tokens) ?? 0,
    cumulativeInputTokens: readNumber(total?.inputTokens) ?? readNumber(total?.input_tokens) ?? 0,
    cumulativeCachedInputTokens: readNumber(total?.cachedInputTokens) ?? readNumber(total?.cached_input_tokens) ?? 0,
    cumulativeOutputTokens: readNumber(total?.outputTokens) ?? readNumber(total?.output_tokens) ?? 0,
    cumulativeReasoningOutputTokens: readNumber(total?.reasoningOutputTokens) ?? readNumber(total?.reasoning_output_tokens) ?? 0,
    cumulativeTotalTokens: readNumber(total?.totalTokens) ?? readNumber(total?.total_tokens) ?? 0,
    modelContextWindow: readNumber(input.usage?.modelContextWindow) ?? readNumber(input.usage?.model_context_window),
    primaryUsedPercent: readRateLimitUsedPercent(input.rateLimits, "primary"),
    secondaryUsedPercent: readRateLimitUsedPercent(input.rateLimits, "secondary"),
    primaryResetsAt: readRateLimitResetsAt(input.rateLimits, "primary"),
    secondaryResetsAt: readRateLimitResetsAt(input.rateLimits, "secondary"),
    planType: readString(input.rateLimits?.plan_type) ?? readString(input.rateLimits?.planType)
  };
}

function tokenUsageSampleFromNativeTokenCount(input: {
  sessionId: string;
  turnId: string;
  sourceIndex: number;
  sourceTimestamp: string | null;
  info: Record<string, unknown> | null;
  rateLimits: Record<string, unknown> | null;
}): SessionTurnTokenUsageSampleInput | null {
  if (!input.info) {
    return null;
  }

  const usage = {
    last: readObject(input.info.last_token_usage),
    total: readObject(input.info.total_token_usage),
    model_context_window: input.info.model_context_window
  };
  const sample = tokenUsageSampleFromUsageRecord({
    sessionId: input.sessionId,
    turnId: input.turnId,
    source: "native_token_count",
    sourceIndex: input.sourceIndex,
    sourceTimestamp: input.sourceTimestamp,
    usage,
    rateLimits: input.rateLimits
  });
  return sample ? { ...sample, id: `${input.turnId}:native_token_count:${input.sourceIndex}` } : null;
}

function readRateLimitUsedPercent(rateLimits: Record<string, unknown> | null, key: string) {
  const window = rateLimits ? readObject(rateLimits[key]) : null;
  return readNumber(window?.used_percent) ?? readNumber(window?.usedPercent);
}

function readRateLimitResetsAt(rateLimits: Record<string, unknown> | null, key: string) {
  const window = rateLimits ? readObject(rateLimits[key]) : null;
  return readNumber(window?.resets_at) ?? readNumber(window?.resetsAt);
}

function isCodexTurnCompleted(data: unknown) {
  const record = readObject(data);
  if (!record || readString(record.method) !== "turn/completed") {
    return false;
  }

  const params = readObject(record.params);
  const turn = readObject(params?.turn);
  const status = readString(turn?.status);
  const error = readObject(turn?.error);
  return status === "completed" && !error;
}

function readCompletedTurnFallback(logPath: string | undefined, maxJsonlIndex?: number) {
  if (!logPath) {
    return {
      reply: "Turn completed without a final agent message.",
      tokenIn: 0,
      tokenOut: 0
    };
  }

  const entries = readNewRunnerEntries(logPath, 0, "");
  let reply = "";
  let tokenIn = 0;
  let tokenOut = 0;

  for (const entry of entries.items) {
    if (typeof maxJsonlIndex === "number" && entry.jsonlIndex > maxJsonlIndex) {
      break;
    }

    if (entry.event === "item") {
      const item = readObject(entry.data);
      if (
        readString(item?.itemType) === "agent_message" &&
        readString(item?.eventType) === "item.completed" &&
        readString(item?.phase) !== "commentary" &&
        readString(item?.text)
      ) {
        reply = readString(item?.text) ?? reply;
      }
      continue;
    }

    if (entry.event === "codex") {
      const data = readObject(entry.data);
      if (!data || readString(data.method) !== "thread/tokenUsage/updated") {
        continue;
      }

      const params = readObject(data.params);
      const usage = readObject(params?.tokenUsage);
      const lastUsage = readObject(usage?.last);
      tokenIn = readNumber(lastUsage?.inputTokens) ?? tokenIn;
      tokenOut = readNumber(lastUsage?.outputTokens) ?? tokenOut;
    }
  }

  return {
    reply: reply || "Turn completed without a final agent message.",
    tokenIn,
    tokenOut
  };
}

async function refreshQuotaForAccount(
  account: AccountRecord,
  options: { skipIfBusy?: boolean } = {}
) {
  const alreadyRefreshing = refreshingQuotaAccountIds.has(account.id);
  if (alreadyRefreshing && options.skipIfBusy === true) {
    return;
  }
  if (!alreadyRefreshing) {
    refreshingQuotaAccountIds.add(account.id);
  }

  const now = new Date().toISOString();
  try {
    if (options.skipIfBusy === true) {
      const runningTurns = await sessionStore.listRunningSessionTurns();
      if (runningTurns.some((turn) => turn.accountId === account.id)) {
        return;
      }
    }

    if (!account.hasAuth) {
      await sessionStore.upsertAccount({
        id: account.id,
        name: account.name,
        externalAccountId: account.externalAccountId,
        externalUserId: account.externalUserId,
        email: account.email,
        quotaUpdatedAt: now,
        quotaError: "No auth.json stored in the database for this account."
      });
      return;
    }

    const payload = await callWithTemporaryCodexHome(account, async (rpc) => {
      const [accountPayload, quotaPayload] = await Promise.all([
        rpc("account/read", { refreshToken: false }).catch(() => null),
        rpc("account/rateLimits/read", null)
      ]);
      return { accountPayload, quotaPayload };
    });
    const accountRecord = readObject(readObject(payload.accountPayload)?.account);
    const quotaSnapshot = pickCodexRateLimitSnapshot(payload.quotaPayload);
    await sessionStore.upsertAccount({
      id: account.id,
      name: account.name,
      externalAccountId: account.externalAccountId,
      externalUserId: account.externalUserId,
      email: readString(accountRecord?.email) ?? account.email,
      quotaSnapshot,
      quotaUpdatedAt: now,
      quotaError: null
    });
    void schedulePendingTurnsForAccount(account.id).catch((scheduleError) => {
      console.warn(`Failed to reschedule pending turns after quota refresh for ${account.id}: ${errorMessage(scheduleError)}`);
    });
  } catch (error) {
    await sessionStore.upsertAccount({
      id: account.id,
      name: account.name,
      externalAccountId: account.externalAccountId,
      externalUserId: account.externalUserId,
      email: account.email,
      quotaUpdatedAt: now,
      quotaError: errorMessage(error)
    });
  } finally {
    if (!alreadyRefreshing) {
      refreshingQuotaAccountIds.delete(account.id);
    }
  }
}

async function callWithTemporaryCodexHome<T>(
  account: AccountRecord,
  callback: (rpc: (method: string, params?: unknown) => Promise<unknown>) => Promise<T>
): Promise<T> {
  const storedAuth = await sessionStore.getAccountAuth(account.id);
  if (!storedAuth) {
    throw new Error(`Account ${account.id} has no auth stored in the database.`);
  }
  const authRaw = storedAuth.authRaw;
  const identityError = accountAuthIdentityError(authRaw, {
    externalAccountId: account.externalAccountId,
    externalUserId: account.externalUserId
  });
  if (identityError) {
    throw new Error(`Account ${account.id} auth mismatch: ${identityError}.`);
  }
  const tempCodexHome = mkdtempSync(resolve(tmpdir(), "threadex-codex-"));
  const tempAuthPath = resolve(tempCodexHome, "auth.json");
  materializeAccountAuth(tempCodexHome, authRaw, storedAuth.configRaw);

  const child = spawn(codexExecutable(), buildAppServerArgs(), {
    env: { ...process.env, CODEX_HOME: tempCodexHome },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let nextId = 1;
  let buffer = "";
  let closed = false;
  const pending = new Map<number, JsonRpcRequest>();

  const rejectAll = (error: Error) => {
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let lineEnd = buffer.indexOf("\n");
    while (lineEnd !== -1) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (line) {
        handleJsonRpcLine(line, pending);
      }
      lineEnd = buffer.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", () => undefined);
  child.on("error", (error) => rejectAll(error instanceof Error ? error : new Error(String(error))));
  child.on("exit", () => {
    if (!closed) {
      rejectAll(new Error("codex app-server exited unexpectedly"));
    }
  });

  const send = (payload: unknown) => {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };
  const rpc = async (method: string, params: unknown = null) => {
    const id = nextId++;
    const promise = new Promise<unknown>((resolveRpc, rejectRpc) => {
      pending.set(id, { resolve: resolveRpc, reject: rejectRpc });
      send({ jsonrpc: "2.0", id, method, params });
    });
    return withTimeout(promise, quotaRpcTimeoutMs, `${method} timed out`);
  };

  try {
    await rpc("initialize", {
      clientInfo: { name: "threadex", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
    send({ jsonrpc: "2.0", method: "initialized" });
    const result = await callback(rpc);
    const updatedAuthRaw = readFileSync(tempAuthPath, "utf8");
    const updatedIdentityError = accountAuthIdentityError(updatedAuthRaw, {
      externalAccountId: account.externalAccountId,
      externalUserId: account.externalUserId
    });
    if (updatedIdentityError) {
      throw new Error(`Refusing to store rotated auth for account ${account.id}: ${updatedIdentityError}.`);
    }
    const authWrite = await sessionStore.compareAndSetAccountAuth(
      account.id,
      storedAuth.version,
      updatedAuthRaw,
      readOptionalTextFile(resolve(tempCodexHome, "config.toml"))
    );
    if (authWrite === "conflict") {
      throw new Error(`Account ${account.id} auth changed while its temporary Codex process was running.`);
    }
    return result;
  } finally {
    closed = true;
    rejectAll(new Error("codex app-server stopped"));
    child.stdin.end();
    child.kill("SIGTERM");
    rmSync(tempCodexHome, { recursive: true, force: true });
  }
}

function buildAppServerArgs() {
  return [
    "app-server",
    "-c",
    "approval_policy=\"never\"",
    "-c",
    "sandbox_mode=\"read-only\"",
    "-c",
    "features.memories=false"
  ];
}

function codexExecutable() {
  return agentCliExecutable();
}

function handleJsonRpcLine(line: string, pending: Map<number, JsonRpcRequest>) {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (typeof message.id !== "number") {
    return;
  }

  const request = pending.get(message.id);
  if (!request) {
    return;
  }
  pending.delete(message.id);
  if (message.error && typeof message.error === "object") {
    request.reject(new Error(readString((message.error as Record<string, unknown>).message) ?? JSON.stringify(message.error)));
  } else {
    request.resolve(message.result);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function pickCodexRateLimitSnapshot(payload: unknown) {
  const record = readObject(payload);
  if (!record) {
    return null;
  }
  const byLimitId = readObject(record.rateLimitsByLimitId) ?? readObject(record.rate_limits_by_limit_id);
  const codexLimit = byLimitId ? readObject(byLimitId.codex) : null;
  const snapshot = normalizeRateLimitSnapshot(codexLimit ?? record.rateLimits ?? record.rate_limits);
  if (!snapshot) {
    return null;
  }
  return {
    ...snapshot,
    rateLimitResetCredits: normalizeRateLimitResetCredits(
      record.rateLimitResetCredits ?? record.rate_limit_reset_credits
    )
  };
}

async function readQuotaPayloadAfterManualReset(
  rpc: (method: string, params?: unknown) => Promise<unknown>
) {
  let latestPayload: unknown = null;
  for (const delayMs of [0, 250, 750, 1500]) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    latestPayload = await rpc("account/rateLimits/read", null).catch(() => null);
    const snapshot = pickCodexRateLimitSnapshot(latestPayload);
    if (quotaSnapshotHasAvailableCapacity(snapshot)) {
      return latestPayload;
    }
  }
  return latestPayload;
}

function quotaSnapshotHasAvailableCapacity(snapshot: unknown) {
  const record = readObject(snapshot);
  return ["primary", "secondary"].some((key) => {
    const window = readObject(record?.[key]);
    const usedPercent = readNumber(window?.usedPercent) ?? readNumber(window?.used_percent);
    return usedPercent !== null && usedPercent < 100;
  });
}

function normalizeRateLimitResetCredits(value: unknown) {
  const record = readObject(value);
  if (!record) {
    return null;
  }
  const credits = Array.isArray(record.credits)
    ? record.credits.flatMap((value) => {
        const credit = readObject(value);
        const id = readString(credit?.id);
        if (!credit || !id) {
          return [];
        }
        return [{
          id,
          resetType: readString(credit.resetType) ?? readString(credit.reset_type) ?? "unknown",
          status: readString(credit.status) ?? "unknown",
          grantedAt: readNumber(credit.grantedAt) ?? readNumber(credit.granted_at),
          expiresAt: readNumber(credit.expiresAt) ?? readNumber(credit.expires_at),
          title: readString(credit.title),
          description: readString(credit.description)
        }];
      })
    : null;
  return {
    availableCount: readNumber(record.availableCount) ?? readNumber(record.available_count) ?? 0,
    credits
  };
}

function normalizeRateLimitSnapshot(value: unknown) {
  const record = readObject(value);
  if (!record) {
    return null;
  }
  return {
    limitId: readString(record.limitId) ?? readString(record.limit_id),
    limitName: readString(record.limitName) ?? readString(record.limit_name),
    primary: normalizeRateLimitWindow(record.primary),
    secondary: normalizeRateLimitWindow(record.secondary),
    credits: normalizeCredits(record.credits),
    planType: readString(record.planType) ?? readString(record.plan_type),
    individualLimit: record.individualLimit ?? record.individual_limit ?? null,
    spendControlReached: readBoolean(record.spendControlReached) ?? readBoolean(record.spend_control_reached),
    rateLimitReachedType: readString(record.rateLimitReachedType) ?? readString(record.rate_limit_reached_type)
  };
}

function normalizeRateLimitWindow(value: unknown) {
  const record = readObject(value);
  if (!record) {
    return null;
  }
  const usedPercent = readNumber(record.usedPercent) ?? readNumber(record.used_percent);
  if (usedPercent === null) {
    return null;
  }
  return {
    usedPercent,
    windowDurationMins:
      readNumber(record.windowDurationMins) ??
      readNumber(record.window_duration_mins) ??
      readNumber(record.windowMinutes) ??
      readNumber(record.window_minutes),
    resetsAt: readNumber(record.resetsAt) ?? readNumber(record.resets_at),
    manualResetCount:
      readNumber(record.manualResetCount) ??
      readNumber(record.manual_reset_count) ??
      readNumber(record.manualResets) ??
      readNumber(record.manual_resets) ??
      readNumber(record.manualResetsRemaining) ??
      readNumber(record.manual_resets_remaining)
  };
}

function normalizeCredits(value: unknown) {
  const record = readObject(value);
  if (!record) {
    return null;
  }
  return {
    hasCredits: readBoolean(record.hasCredits) ?? readBoolean(record.has_credits) ?? false,
    unlimited: readBoolean(record.unlimited) ?? false,
    balance: readString(record.balance)
  };
}

async function streamRunnerLog(
  res: Response,
  logPath: string,
  child: ChildProcess | null,
  options: { stopWhenProcessEnds?: boolean; runnerPid?: number | null } = {}
) {
  let offset = 0;
  let buffer = "";
  let completed = false;
  let sawDone = false;
  let closed = false;
  let childExited = false;
  let childExitCode: number | null = null;
  let jsonlIndex = 0;

  res.on("close", () => {
    closed = true;
  });

  child?.on("exit", (code) => {
    childExited = true;
    childExitCode = code;
  });

  while (!closed && !completed) {
    const entries = readNewRunnerEntries(logPath, offset, buffer, jsonlIndex);
    offset = entries.offset;
    buffer = entries.buffer;
    jsonlIndex = entries.jsonlIndex;

    for (const entry of entries.items) {
      await applyRunnerLogEntry(entry, logPath, "live");
      emitRunnerEntry(res, entry);
      if (entry.event === "done") {
        sawDone = true;
      }
      if (isRunnerTerminalEntry(entry)) {
        completed = true;
      }
    }

    if (completed || closed) {
      if (completed && !sawDone && !closed) {
        emit(res, "done", { ok: true });
        sawDone = true;
      }
      break;
    }

    const trackedRunnerExited =
      options.stopWhenProcessEnds && options.runnerPid ? !isProcessAlive(options.runnerPid) : false;
    if (childExited || trackedRunnerExited) {
      const finalEntries = readNewRunnerEntries(logPath, offset, buffer, jsonlIndex);
      offset = finalEntries.offset;
      buffer = finalEntries.buffer;
      jsonlIndex = finalEntries.jsonlIndex;
      for (const entry of finalEntries.items) {
        await applyRunnerLogEntry(entry, logPath, "live");
        emitRunnerEntry(res, entry);
        if (entry.event === "done") {
          sawDone = true;
        }
        if (isRunnerTerminalEntry(entry)) {
          completed = true;
        }
      }

      if (!completed) {
        emit(res, "error", {
          message: `Prompt runner exited before completion (${childExitCode ?? options.runnerPid ?? "unknown"}).`
        });
        emit(res, "done", { ok: true });
        sawDone = true;
      } else if (!sawDone) {
        emit(res, "done", { ok: true });
        sawDone = true;
      }
      break;
    }

    await sleep(runnerPollMs);
  }
}

function emitRunnerEntry(res: Response, entry: IndexedRunnerLogEntry) {
  if (shouldEmitRunnerEntryToClient(entry)) {
    emit(res, entry.event, entry.data);
  }
}

function buildRunnerStopEntries(turn: SessionTurnRecord, message: string): RunnerLogEntry[] {
  const now = new Date().toISOString();
  return [
    {
      id: crypto.randomUUID(),
      ts: now,
      sessionId: turn.sessionId,
      turnId: turn.id,
      event: "pending",
      data: {
        sessionId: turn.sessionId,
        turnId: turn.id,
        message,
        queued: true,
        stopped: true,
        reason: "stopped"
      }
    },
    {
      id: crypto.randomUUID(),
      ts: now,
      sessionId: turn.sessionId,
      turnId: turn.id,
      event: "done",
      data: { ok: true, stopped: true }
    }
  ];
}

function buildRunnerCancelEntries(turn: SessionTurnRecord, message: string): RunnerLogEntry[] {
  const now = new Date().toISOString();
  return [
    {
      id: crypto.randomUUID(),
      ts: now,
      sessionId: turn.sessionId,
      turnId: turn.id,
      event: "result",
      data: {
        sessionId: turn.sessionId,
        turnId: turn.id,
        reply: message,
        tokenIn: turn.tokenIn,
        tokenOut: turn.tokenOut,
        aborted: true
      }
    },
    {
      id: crypto.randomUUID(),
      ts: now,
      sessionId: turn.sessionId,
      turnId: turn.id,
      event: "done",
      data: { ok: true, stopped: true, aborted: true }
    }
  ];
}

function appendRunnerLogEntries(logPath: string, entries: RunnerLogEntry[]) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function shouldEmitRunnerEntryToClient(entry: IndexedRunnerLogEntry) {
  if (entry.event === "codex") {
    const method = readString(readObject(entry.data)?.method);
    return Boolean(method && !method.startsWith("item/"));
  }

  return (
    entry.event === "session" ||
    entry.event === "developer_instructions" ||
    entry.event === "item" ||
    entry.event === "delta" ||
    (entry.event === "approval.requested" && isApprovalRequestStillPending(entry.data)) ||
    entry.event === "approval.resolved" ||
    entry.event === "pending" ||
    entry.event === "result" ||
    entry.event === "done" ||
    entry.event === "error"
  );
}

function isApprovalRequestStillPending(data: unknown) {
  const approvalId = objectString(data, "approvalId");
  return Boolean(approvalId && pendingApprovals.has(approvalId));
}

function isRunnerTerminalEntry(entry: IndexedRunnerLogEntry) {
  return entry.event === "done" || entry.event === "result" || entry.event === "pending" || entry.event === "error";
}

async function replayPendingRunnerLogs() {
  if (!existsSync(pendingRunnerLogDir)) {
    return;
  }

  const files = readdirSync(pendingRunnerLogDir)
    .filter((file) => file.endsWith(".ndjson"))
    .sort();

  let applied = 0;
  let replayedFiles = 0;
  let failedFiles = 0;

  for (const file of files) {
    const pendingLogPath = resolve(pendingRunnerLogDir, file);
    try {
      const entries = readNewRunnerEntries(pendingLogPath, 0, "");
      for (const entry of entries.items) {
        const normalLogPath = objectString(entry.data, "logPath") ?? resolve(runnerLogDir, `${entry.turnId}.ndjson`);
        await applyRunnerLogEntry(entry, normalLogPath, "replay");
        applied += 1;
      }
      rmSync(pendingLogPath, { force: true });
      replayedFiles += 1;
    } catch (error) {
      failedFiles += 1;
      console.error(`Failed to replay pending runner log ${pendingLogPath}: ${errorMessage(error)}`);
    }
  }

  if (applied > 0 || failedFiles > 0) {
    console.log(
      `Pending runner log replay applied ${applied} entr${applied === 1 ? "y" : "ies"} from ${replayedFiles} file${replayedFiles === 1 ? "" : "s"}${failedFiles ? `; ${failedFiles} failed` : ""}.`
    );
  }
}

async function applyRunnerLogEntry(
  entry: IndexedRunnerLogEntry,
  logPath: string,
  mode: RunnerLogApplicationMode
) {
  try {
    await processRunnerUpdate({
      id: entry.id,
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      event: entry.event,
      jsonlIndex: entry.jsonlIndex,
      data: entry.data,
      runnerPid: objectNumber(entry.data, "pid"),
      logPath: objectString(entry.data, "logPath") ?? logPath
    }, { refreshRunnerHeartbeat: shouldRefreshRunnerHeartbeat(mode) });
    await annotateRunnerEntryForClient(entry);
  } catch (error) {
    console.error(`Failed to apply runner log entry ${entry.id}: ${errorMessage(error)}`);
    throw error;
  }
}

async function annotateRunnerEntryForClient(entry: IndexedRunnerLogEntry) {
  if (entry.event !== "error") {
    return;
  }

  const message = objectString(entry.data, "message");
  if (!isAccountLoginRequiredMessage(message)) {
    return;
  }

  const account = await markTurnAccountLoggedOut(entry.turnId);
  entry.data = {
    ...(readObject(entry.data) ?? {}),
    needsLogin: true,
    account
  };
}

function readNewRunnerEntries(logPath: string, offset: number, buffer: string, jsonlIndex = 0) {
  if (!existsSync(logPath)) {
    return { offset, buffer, jsonlIndex, items: [] as IndexedRunnerLogEntry[] };
  }

  const size = statSync(logPath).size;
  if (size <= offset) {
    return { offset, buffer, jsonlIndex, items: [] as IndexedRunnerLogEntry[] };
  }

  const fd = openSync(logPath, "r");
  try {
    const chunk = Buffer.alloc(Math.min(size - offset, runnerLogReadChunkBytes));
    const bytesRead = readSync(fd, chunk, 0, chunk.length, offset);
    const nextOffset = offset + bytesRead;
    let chunkText = chunk.subarray(0, bytesRead).toString("utf8");
    let raw: string;
    const skippedLine = buffer === runnerLogSkipOversizedLine;
    if (skippedLine) {
      const lineEnd = chunkText.indexOf("\n");
      if (lineEnd === -1) {
        return { offset: nextOffset, buffer: runnerLogSkipOversizedLine, jsonlIndex, items: [] as IndexedRunnerLogEntry[] };
      }
      chunkText = chunkText.slice(lineEnd + 1);
      raw = chunkText;
    } else {
      raw = buffer + chunkText;
    }

    if (!raw.includes("\n") && raw.length > runnerLogMaxLineChars) {
      return { offset: nextOffset, buffer: runnerLogSkipOversizedLine, jsonlIndex, items: [] as IndexedRunnerLogEntry[] };
    }

    const lines = raw.split("\n");
    let nextBuffer = lines.pop() ?? "";
    if (nextBuffer.length > runnerLogMaxLineChars) {
      nextBuffer = runnerLogSkipOversizedLine;
    }
    const items = lines.flatMap((line, lineOffset) => {
      if (line.length > runnerLogMaxLineChars) {
        return [];
      }
      try {
        const entry = JSON.parse(line) as RunnerLogEntry;
        const entryJsonlIndex = typeof entry.jsonlIndex === "number" ? entry.jsonlIndex : jsonlIndex + lineOffset;
        return [{ ...entry, jsonlIndex: entryJsonlIndex }];
      } catch {
        return [];
      }
    });
    return { offset: nextOffset, buffer: nextBuffer, jsonlIndex: jsonlIndex + lines.length, items };
  } finally {
    closeSync(fd);
  }
}

async function checkRunningTurns() {
  let turns: SessionTurnRecord[];
  try {
    turns = await sessionStore.listRunningSessionTurns();
  } catch (error) {
    console.error(`Runner watchdog failed to list running turns: ${errorMessage(error)}`);
    return;
  }

  const now = Date.now();
  for (const turn of turns) {
    try {
      if (await diagnoseRunningTurn(turn, "watchdog", now)) {
        void schedulePendingTurnsForSession(turn.sessionId).catch((error) => {
          console.warn(`Failed to schedule pending turns after watchdog released ${turn.id}: ${errorMessage(error)}`);
        });
      }
    } catch (error) {
      console.error(`Runner watchdog failed for turn ${turn.id}: ${errorMessage(error)}`);
    }
  }
}

async function releaseDeadRunningTurnsForDisplay(source: string) {
  let turns: SessionTurnRecord[];
  try {
    turns = await sessionStore.listRunningSessionTurns();
  } catch (error) {
    console.warn(`Failed to list running turns for ${source}: ${errorMessage(error)}`);
    return;
  }

  const now = Date.now();
  for (const turn of turns) {
    if (getRunnerLiveness(turn).alive) {
      continue;
    }
    try {
      if (await diagnoseRunningTurn(turn, source, now)) {
        void schedulePendingTurnsForSession(turn.sessionId).catch((error) => {
          console.warn(`Failed to schedule pending turns after ${source} released ${turn.id}: ${errorMessage(error)}`);
        });
      }
    } catch (error) {
      console.warn(`Failed to release dead running turn ${turn.id} for ${source}: ${errorMessage(error)}`);
    }
  }
}

async function diagnoseRunningTurn(turn: SessionTurnRecord, source: string, now = Date.now()) {
  const replayedTerminal = await replayRunnerLogForTurn(turn);
  if (replayedTerminal) {
    return true;
  }

  const liveness = getRunnerLiveness(turn);
  if (!liveness.alive) {
    if (runnerStartupIsWithinGrace(turn, now, runnerStartupGraceMs)) {
      return false;
    }
    const diagnostics = collectRunnerDiagnostics(turn);
    const agentResponse = `Prompt runner ${turn.runnerPid ?? "unknown"} stopped before completion. Saved as stopped pending turn. Check runner.watchdog.dead for log tail diagnostics.`;
    const stopped = await sessionStore.updateSessionTurn({
      id: turn.id,
      agentResponse,
      tokenIn: turn.tokenIn,
      tokenOut: turn.tokenOut,
      status: "todo",
      runnerExitCode: turn.runnerExitCode,
      pendingReason: "stopped",
      expectedStatus: "running",
      expectedRunnerPid: turn.runnerPid
    });
    if (!stopped) {
      return true;
    }
    await turnRingLog.appendAgentResponse({
      eventId: `response:${turn.id}:runner.watchdog.dead`,
      source: "runner.watchdog.dead",
      sessionId: turn.sessionId,
      turnId: turn.id,
      agentResponse,
      status: "todo"
    });
    await sessionStore.recordSessionTurnEvent({
      turnId: turn.id,
      sessionId: turn.sessionId,
      eventName: "runner.watchdog.dead",
      payload: {
        runnerPid: turn.runnerPid,
        runnerLogPath: turn.runnerLogPath,
        stdoutLogPath: runnerSidecarLogPath(turn.runnerLogPath, "stdout"),
        stderrLogPath: runnerSidecarLogPath(turn.runnerLogPath, "stderr"),
        lastEventName: turn.lastEventName,
        lastMovementAt: liveness.lastMovementAt ? new Date(liveness.lastMovementAt).toISOString() : null,
        source,
        diagnostics
      },
      refreshRunnerHeartbeat: false
    });
    return true;
  }

  if (await abandonRunnerTurnIfStale(turn, source, liveness, now)) {
    return true;
  }

  if (liveness.lastMovementAt && now - liveness.lastMovementAt > runnerStaleMs) {
    await sessionStore.recordSessionTurnEvent({
      turnId: turn.id,
      sessionId: turn.sessionId,
      eventName: "runner.watchdog.stale",
      payload: {
        runnerPid: turn.runnerPid,
        runnerLogPath: turn.runnerLogPath,
        lastEventName: turn.lastEventName,
        staleMs: now - liveness.lastMovementAt,
        lastMovementAt: new Date(liveness.lastMovementAt).toISOString(),
        source
      },
      refreshRunnerHeartbeat: false
    });
  }

  return false;
}

async function abandonStaleRunningTurns(turns: SessionTurnRecord[], source: string) {
  let abandoned = false;
  const now = Date.now();
  for (const turn of turns) {
    if (turn.status !== "running") {
      continue;
    }
    abandoned = (await abandonRunnerTurnIfStale(turn, source, undefined, now)) || abandoned;
  }
  return abandoned;
}

async function abandonRunnerTurnIfStale(
  turn: SessionTurnRecord,
  source: string,
  liveness = getRunnerLiveness(turn),
  now = Date.now()
) {
  if (!liveness.alive || !liveness.lastMovementAt || now - liveness.lastMovementAt <= runnerAbandonedMs) {
    return false;
  }

  const staleMs = now - liveness.lastMovementAt;
  const killed = terminateRunnerProcess(turn.runnerPid);
  const diagnostics = collectRunnerDiagnostics(turn);
  const agentResponse = `Prompt runner ${turn.runnerPid ?? "unknown"} had no new events for ${(staleMs / 60000).toFixed(1)} minutes. Saved as stopped pending turn.`;
  const stopped = await sessionStore.updateSessionTurn({
    id: turn.id,
    agentResponse,
    tokenIn: turn.tokenIn,
    tokenOut: turn.tokenOut,
    status: "todo",
    runnerExitCode: turn.runnerExitCode,
    pendingReason: "stopped",
    expectedStatus: "running",
    expectedRunnerPid: turn.runnerPid
  });
  if (!stopped) {
    return true;
  }
  await turnRingLog.appendAgentResponse({
    eventId: `response:${turn.id}:runner.watchdog.abandoned`,
    source: "runner.watchdog.abandoned",
    sessionId: turn.sessionId,
    turnId: turn.id,
    agentResponse,
    status: "todo"
  });
  await sessionStore.recordSessionTurnEvent({
    turnId: turn.id,
    sessionId: turn.sessionId,
    eventName: "runner.watchdog.abandoned",
    payload: {
      runnerPid: turn.runnerPid,
      runnerLogPath: turn.runnerLogPath,
      stdoutLogPath: runnerSidecarLogPath(turn.runnerLogPath, "stdout"),
      stderrLogPath: runnerSidecarLogPath(turn.runnerLogPath, "stderr"),
      lastEventName: turn.lastEventName,
      staleMs,
      lastMovementAt: new Date(liveness.lastMovementAt).toISOString(),
      killed,
      source,
      diagnostics
    },
    refreshRunnerHeartbeat: false
  });
  return true;
}

function getRunnerLiveness(turn: SessionTurnRecord) {
  const logMovementAt = getLogMovementAt(turn.runnerLogPath);
  const heartbeatAt = parseTimestamp(turn.runnerHeartbeat);
  const lastMovementAt = Math.max(logMovementAt ?? 0, heartbeatAt ?? 0);
  return {
    alive: turn.runnerPid ? isProcessAlive(turn.runnerPid) : false,
    lastMovementAt: lastMovementAt || null
  };
}

function shouldDiagnoseRunningTurnAfterSwitch(turn: SessionTurnRecord, now = Date.now()) {
  const liveness = getRunnerLiveness(turn);
  const healthy =
    liveness.alive &&
    liveness.lastMovementAt !== null &&
    now - liveness.lastMovementAt <= runnerSwitchReplayStaleMs;
  if (healthy) {
    return false;
  }

  const lastAttemptAt = runnerSwitchReplayAttempts.get(turn.id) ?? 0;
  if (now - lastAttemptAt < runnerSwitchReplayThrottleMs) {
    return false;
  }
  runnerSwitchReplayAttempts.set(turn.id, now);
  return true;
}

function scheduleBackgroundRunningTurnDiagnosis(turn: SessionTurnRecord, source: string) {
  if (backgroundRunningTurnDiagnostics.has(turn.id)) {
    return;
  }
  backgroundRunningTurnDiagnostics.add(turn.id);
  void diagnoseRunningTurn(turn, source)
    .then((changed) => {
      if (changed) {
        return schedulePendingTurnsForSession(turn.sessionId);
      }
      return undefined;
    })
    .catch((error) => {
      console.warn(`Background running turn diagnosis failed for ${turn.id}: ${errorMessage(error)}`);
    })
    .finally(() => {
      backgroundRunningTurnDiagnostics.delete(turn.id);
    });
}

function terminateRunnerProcess(pid: number | null) {
  if (!pid || !isProcessAlive(pid)) {
    return false;
  }
  try {
    process.kill(-pid, "SIGTERM");
    return true;
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

async function replayRunnerLogForTurn(turn: SessionTurnRecord) {
  if (!turn.runnerLogPath) {
    return false;
  }

  let terminal = false;
  await drainRunnerLogEntries(
    turn.runnerLogPath,
    initialRunnerLogReadState(),
    async (entries) => {
      for (const entry of entries) {
        await applyRunnerLogEntry(entry, turn.runnerLogPath ?? "", "replay");
        terminal ||= isRunnerTerminalEntry(entry);
      }
    }
  );

  return terminal;
}

function collectRunnerDiagnostics(turn: SessionTurnRecord) {
  return {
    runnerLogTail: tailFile(turn.runnerLogPath),
    stdoutTail: tailFile(runnerSidecarLogPath(turn.runnerLogPath, "stdout")),
    stderrTail: tailFile(runnerSidecarLogPath(turn.runnerLogPath, "stderr"))
  };
}

function runnerSidecarLogPath(logPath: string | null, stream: "stdout" | "stderr") {
  return logPath ? logPath.replace(/\.ndjson$/, `.${stream}.log`) : null;
}

function tailFile(path: string | null, maxBytes = 8192) {
  if (!path || !existsSync(path)) {
    return null;
  }

  const size = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    const bytesToRead = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    readSync(fd, buffer, 0, bytesToRead, Math.max(0, size - bytesToRead));
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function prepareEventStream(res: Response) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}

async function publishRingEvent(input: Omit<RingEvent, "pos" | "timestamp"> & { timestamp?: string }) {
  await eventRingLog.append(input);
}

async function publishRunnerUpdateEvent(update: Required<Pick<RunnerUpdateRequest, "id" | "sessionId" | "turnId" | "event">> & RunnerUpdateRequest) {
  const session = await sessionStore.getSession(update.sessionId);
  await publishRingEvent({
    eventId: update.id,
    type: `runner.${update.event}`,
    workspaceId: session?.workspaceId ?? null,
    sessionId: update.sessionId,
    turnId: update.turnId,
    payload: update.data ?? null,
    timestamp: update.ts
  });
}

async function publishTodoChanged(sessionId: string, todo: unknown) {
  const session = await sessionStore.getSession(sessionId);
  await publishRingEvent({
    eventId: crypto.randomUUID(),
    type: "todo.changed",
    workspaceId: session?.workspaceId ?? null,
    sessionId,
    turnId: null,
    payload: todo
  });
}

function emit(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function approvalFromRequest(body: ApprovalRequestBody): PendingApproval | null {
  if (
    typeof body.approvalId !== "string" ||
    typeof body.sessionId !== "string" ||
    typeof body.turnId !== "string" ||
    (typeof body.requestId !== "number" && typeof body.requestId !== "string") ||
    typeof body.method !== "string"
  ) {
    return null;
  }

  return {
    approvalId: body.approvalId,
    sessionId: body.sessionId,
    turnId: body.turnId,
    requestId: body.requestId,
    method: body.method,
    params: body.params ?? null,
    createdAt: new Date().toISOString()
  };
}

function publicApprovalRecord(approval: PendingApproval) {
  return {
    approvalId: approval.approvalId,
    sessionId: approval.sessionId,
    turnId: approval.turnId,
    requestId: approval.requestId,
    method: approval.method,
    params: approval.params,
    createdAt: approval.createdAt
  };
}

function pendingApprovalLiveItemsForSession(sessionId: string) {
  const itemsByTurn: Record<string, unknown[]> = {};
  for (const approval of pendingApprovals.values()) {
    if (approval.sessionId !== sessionId || approval.decision !== undefined) {
      continue;
    }

    itemsByTurn[approval.turnId] ??= [];
    itemsByTurn[approval.turnId].push({
      id: `approval:${approval.approvalId}`,
      eventType: "item.started",
      itemType: "approval",
      approvalId: approval.approvalId,
      method: approval.method,
      params: approval.params ?? null,
      status: "pending",
      sortCreated: approval.createdAt,
      sortEventId: approval.approvalId
    });
  }
  return itemsByTurn;
}

function mergeLiveItemsById(items: unknown[]) {
  const merged = new Map<string, unknown>();
  const anonymous: unknown[] = [];
  for (const item of items) {
    const id = objectString(item, "id");
    if (!id) {
      anonymous.push(item);
      continue;
    }
    merged.set(id, item);
  }
  return [...anonymous, ...merged.values()].sort(compareLiveItemsForSnapshot);
}

function compareLiveItemsForSnapshot(first: unknown, second: unknown) {
  const firstCreated = objectString(first, "sortCreated");
  const secondCreated = objectString(second, "sortCreated");
  if (firstCreated && secondCreated && firstCreated !== secondCreated) {
    return firstCreated.localeCompare(secondCreated);
  }
  if (firstCreated && !secondCreated) {
    return -1;
  }
  if (!firstCreated && secondCreated) {
    return 1;
  }

  const firstEventId = objectString(first, "sortEventId") ?? objectString(first, "id") ?? "";
  const secondEventId = objectString(second, "sortEventId") ?? objectString(second, "id") ?? "";
  return firstEventId.localeCompare(secondEventId);
}

function normalizeApprovalDecision(value: unknown): unknown | null {
  if (value === "accept" || value === "acceptForSession" || value === "decline" || value === "cancel") {
    return value;
  }

  const record = readObject(value);
  const amendment = readObject(record?.acceptWithExecpolicyAmendment);
  if (amendment && Array.isArray(amendment.execpolicy_amendment)) {
    const execpolicyAmendment = amendment.execpolicy_amendment.filter((part): part is string => typeof part === "string");
    if (execpolicyAmendment.length > 0) {
      return {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: execpolicyAmendment
        }
      };
    }
  }

  const networkAmendment = readObject(record?.applyNetworkPolicyAmendment);
  if (networkAmendment && readObject(networkAmendment.network_policy_amendment)) {
    return {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: networkAmendment.network_policy_amendment
      }
    };
  }

  return null;
}

function resolveApproval(approvalId: string, decision: unknown) {
  const approval = pendingApprovals.get(approvalId);
  if (!approval) {
    return;
  }

  approval.decision = decision;
  if (approval.resolve) {
    const resolveDecision = approval.resolve;
    approval.resolve = undefined;
    resolveDecision(decision);
  }
}

function resolveApprovalWithRelated(approvalId: string, decision: unknown) {
  const approval = pendingApprovals.get(approvalId);
  if (!approval) {
    return [];
  }

  const resolvedApprovalIds = [approvalId];
  resolveApproval(approvalId, decision);

  const amendment = execpolicyAmendmentFromDecision(decision);
  if (!amendment) {
    return resolvedApprovalIds;
  }

  for (const [relatedApprovalId, relatedApproval] of pendingApprovals) {
    if (
      relatedApprovalId !== approvalId &&
      relatedApproval.sessionId === approval.sessionId &&
      relatedApproval.turnId === approval.turnId &&
      stringArraysEqual(execpolicyAmendmentFromApproval(relatedApproval), amendment)
    ) {
      resolveApproval(relatedApprovalId, decision);
      resolvedApprovalIds.push(relatedApprovalId);
    }
  }

  return resolvedApprovalIds;
}

function execpolicyAmendmentFromDecision(decision: unknown) {
  const record = readObject(decision);
  const amendment = readObject(record?.acceptWithExecpolicyAmendment);
  return readStringArray(amendment?.execpolicy_amendment);
}

function execpolicyAmendmentFromApproval(approval: PendingApproval) {
  const params = readObject(approval.params);
  const directAmendment = readStringArray(params?.proposedExecpolicyAmendment);
  if (directAmendment) {
    return directAmendment;
  }

  const availableDecisions = Array.isArray(params?.availableDecisions) ? params.availableDecisions : [];
  for (const decision of availableDecisions) {
    const amendment = execpolicyAmendmentFromDecision(decision);
    if (amendment) {
      return amendment;
    }
  }

  return null;
}

function readStringArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function stringArraysEqual(left: string[] | null, right: string[] | null) {
  return Boolean(left && right && left.length === right.length && left.every((value, index) => value === right[index]));
}

function isRunnerUpdate(update: RunnerUpdateRequest): update is Required<Pick<RunnerUpdateRequest, "id" | "sessionId" | "turnId" | "event">> & RunnerUpdateRequest {
  return (
    typeof update.id === "string" &&
    typeof update.sessionId === "string" &&
    typeof update.turnId === "string" &&
    typeof update.event === "string"
  );
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function getLogMovementAt(logPath: string | null) {
  if (!logPath || !existsSync(logPath)) {
    return null;
  }

  return statSync(logPath).mtimeMs;
}

function parseTimestamp(value: string | null) {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value.replace(" ", "T")).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function objectString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function objectNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function sessionInspectInputFromQuery(query: Record<string, unknown>): SessionInspectInput {
  return {
    sessionId: queryString(query, "sessionId"),
    threadId: queryString(query, "threadId"),
    workspaceId: queryString(query, "workspaceId"),
    view: querySessionInspectView(query, "view"),
    turnId: queryString(query, "turnId"),
    status: querySessionTurnStatus(query, "status"),
    eventName: queryString(query, "eventName"),
    q: queryString(query, "q") ?? queryString(query, "query"),
    includeEvents: queryBoolean(query, "includeEvents"),
    includeLiveItems: queryBoolean(query, "includeLiveItems"),
    turnLimit: queryNumber(query, "turnLimit") ?? queryNumber(query, "limit"),
    turnOffset: queryNumber(query, "turnOffset") ?? queryNumber(query, "offset"),
    eventLimit: queryNumber(query, "eventLimit"),
    eventOffset: queryNumber(query, "eventOffset"),
    order: queryString(query, "order") === "desc" ? "desc" : "asc",
    maxTextChars: queryNumber(query, "maxTextChars")
  };
}

function querySessionInspectView(query: Record<string, unknown>, key: string): SessionInspectInput["view"] {
  const value = queryString(query, key);
  return value === "file_changes" || value === "turn_summary" || value === "full" ? value : undefined;
}

function sessionSearchInputFromQuery(query: Record<string, unknown>): SessionSearchInput {
  return {
    query: queryString(query, "query") ?? queryString(query, "q"),
    workspaceId: queryString(query, "workspaceId"),
    sessionId: queryString(query, "sessionId"),
    threadId: queryString(query, "threadId"),
    status: querySessionTurnStatus(query, "status"),
    limit: queryNumber(query, "limit"),
    offset: queryNumber(query, "offset"),
    maxTextChars: queryNumber(query, "maxTextChars")
  };
}

function queryString(query: Record<string, unknown>, key: string) {
  const value = query[key];
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function queryBoolean(query: Record<string, unknown>, key: string) {
  const value = queryString(query, key);
  if (value === undefined) {
    return undefined;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  return undefined;
}

function queryNumber(query: Record<string, unknown>, key: string) {
  const value = queryString(query, key);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function querySessionTurnStatus(query: Record<string, unknown>, key: string) {
  const value = queryString(query, key);
  return value === "done" || value === "todo" || value === "running" ? value : undefined;
}

function normalizeTodoItemStatus(value: unknown): TodoItemStatus | undefined {
  return value === "todo" ||
    value === "active" ||
    value === "paused" ||
    value === "hold" ||
    value === "skipped" ||
    value === "done" ||
    value === "blocked"
    ? value
    : undefined;
}

function normalizeTodoCommentType(value: unknown): TodoCommentType | undefined {
  return value === "status" || value === "blocker" || value === "note" ? value : undefined;
}

function normalizeThreadexReturnUrl(value: unknown, req: Request) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const allowedOrigins = [req.get("origin"), req.get("referer"), `${req.protocol}://${req.get("host") ?? ""}`]
      .flatMap((candidate) => {
        try { return candidate ? [new URL(candidate).origin] : []; } catch { return []; }
      });
    if (!allowedOrigins.includes(url.origin)) return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizeTodoMessageType(value: unknown): TodoMessageType | undefined {
  return value === "challenge" || value === "update" ? value : undefined;
}

function normalizeTodoActor(value: unknown): TodoActor {
  return value === "user" || value === "system" ? value : "agent";
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function readLinkPreviewBody(response: globalThis.Response, limit: number) {
  if (!response.body) {
    return (await response.text()).slice(0, limit);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text.slice(0, limit);
}

function extractLinkPreviewTitle(html: string) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return "";
  return decodeHtmlEntities(match[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()).slice(0, 180);
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_match, code: string) => {
      const parsed = code.toLowerCase().startsWith("x") ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : "";
    });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

function normalizeUploadedAttachmentMimeType(value: string) {
  const mimeType = value.trim().toLowerCase().split(";", 1)[0] ?? "";
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mimeType) ? mimeType : "application/octet-stream";
}

function isLoopbackClient(req: Request) {
  const address = req.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isSqlQueryClientError(message: string) {
  return (
    message.includes("read-only") ||
    message.includes("sql is required") ||
    message.includes("SQL statement") ||
    message.includes("SQL param") ||
    message.includes("params must") ||
    message.includes("accounts table is protected") ||
    message.includes("Parser Error") ||
    message.includes("Binder Error")
  );
}

async function startDuckDbUiDevServer() {
  const dbxliteCli = resolve(projectRoot, "node_modules/dbxlite-ui/dist/cli.js");
  if (!existsSync(dbxliteCli)) {
    console.error("ENABLE_DUCKDB_UI=true but dbxlite-ui is not installed. Run `npm install`.");
    return;
  }

  const assetServer = spawn(process.execPath, [dbxliteCli, "--port", String(duckDbUiAssetPort)], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  duckDbUiAssetServer = assetServer;

  assetServer.stdout.on("data", (chunk) => process.stdout.write(prefixLines("dbxlite", chunk)));
  assetServer.stderr.on("data", (chunk) => process.stderr.write(prefixLines("dbxlite", chunk)));
  assetServer.on("exit", (code, signal) => {
    if (duckDbUiAssetServer === assetServer) {
      duckDbUiAssetServer = null;
    }
    console.error(`dbxlite asset server exited (${signal ?? code}).`);
  });

  try {
    const assetUrl = `http://127.0.0.1:${duckDbUiAssetPort}`;
    await waitForHttp(`${assetUrl}/`, 10_000);
    await sessionStore.startDuckDbUi(assetUrl, duckDbUiPort);
    console.log(`Database admin UI listening on http://localhost:${duckDbUiPort}`);
  } catch (error) {
    console.error(`Failed to start database admin UI: ${errorMessage(error)}`);
    stopDuckDbUiAssetServer();
  }
}

function stopDuckDbUiAssetServer() {
  const assetServer = duckDbUiAssetServer;
  duckDbUiAssetServer = null;
  if (assetServer && !assetServer.killed) {
    assetServer.kill("SIGTERM");
  }
}

async function waitForHttp(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }

  throw new Error(`Timed out waiting for ${url}: ${errorMessage(lastError)}`);
}

function parsePort(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65_536) return parsed;
  throw new Error(`Invalid port: ${value}`);
}

function parseDurationMs(value: string | undefined, fallback: number, name: string) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw new Error(`Invalid duration for ${name}: ${value}`);
}

function parsePositiveBytes(value: string | undefined, fallback: number, name: string) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  throw new Error(`Invalid byte limit for ${name}: ${value}`);
}

function prefixLines(label: string, chunk: Buffer) {
  return String(chunk)
    .split(/(\r?\n)/)
    .map((part, index, parts) => {
      if (part === "\n" || part === "\r\n" || part.length === 0) return part;
      const previous = parts[index - 1];
      return index === 0 || previous === "\n" || previous === "\r\n" ? `[${label}] ${part}` : part;
    })
    .join("");
}
