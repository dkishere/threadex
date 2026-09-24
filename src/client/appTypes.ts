import type { ProcessMonitor, SessionPageState, SessionProjectPageState, WaitEvent, WaitSubscription, WorkspaceStatusMonitor } from "./eventStore";
import type { ResponseAnnotation, ResponseAnnotationSource } from "./responseAnnotations";

export type Role = "user" | "assistant" | "system";

export type MessageAttachment = {
  id: string;
  name: string;
  type: string;
  mimeType?: string;
  size: number;
  dataUrl?: string;
  fileUrl?: string;
  path?: string;
};

export type ComposerSessionLink = {
  id: string;
  uri: string;
  workspaceId?: string;
  target: string;
  lookupKind: "sessionId" | "threadId" | "url";
  status: "loading" | "ready";
  title: string;
  session?: SessionRecord;
};

export type ChatMessage = {
  id: string;
  role: Role;
  content: string;
  /** Original stored prompt text, including any hidden operational suffix. */
  rawContent?: string;
  turnId?: string;
  /** The model actually selected when this turn started. */
  model?: string;
  /** The reasoning effort actually selected when this turn started. */
  reasoningEffort?: string;
  /** True when the turn was submitted through the Auto gear. */
  autoModel?: boolean;
  /** Provider that selected an Auto turn's model. */
  autoModelProvider?: "typesafe" | "fallback";
  autoModelConfidence?: number;
  /** Token usage recorded for this turn, when the runner reports it. */
  tokenIn?: number;
  /** Cached portion of the input-token usage, when the runner reports it. */
  cachedInputTokens?: number;
  tokenOut?: number;
  kind?: "steer";
  pending?: boolean;
  liveItems?: LiveItem[];
  segments?: MessageSegment[];
  executionDurationMs?: number;
  createdAt?: string;
  completedAt?: string;
  conclusion?: string;
  turnStatus?: "done" | "todo" | "running";
  pendingReason?: "queued" | "rate_limit" | "auth" | "stopped" | null;
  queueSteerReserved?: boolean;
  /** False while the chat request is waiting for the backend to start a runner. */
  runnerStarted?: boolean;
  attachments?: MessageAttachment[];
  startupSnapshot?: string;
  developerInstructions?: DeveloperInstructionRecord[];
  forcePlan?: boolean;
  contextFork?: boolean;
  executionMode?: ExecutionMode;
};

export type DeveloperInstructionRecord = {
  target: string;
  phase: number | null;
  developerInstructions: string;
  created?: string;
};

export type ResponseQuotePopover = {
  text: string;
  left: number;
  top: number;
  source: ResponseAnnotationSource;
};

export type FileAnnotationComposerContextValue = {
  activeAnnotation: ResponseAnnotation | null;
  sessionId?: string;
  workspaceId?: string;
  sessionUrl?: string;
  askAboutFileAnnotation: (annotation: ResponseAnnotation) => void;
  removeFileAnnotation: (path?: string) => void;
};


export type MessageIndicatorTone = "user" | "steer" | "agent" | "cmd" | "edit" | "approval" | "subagent";

export type MessageIndicatorMark = {
  id: string;
  targetId: string;
  anchorId?: string;
  tone: MessageIndicatorTone;
  position: number;
  title: string;
};

export type QueuedPrompt = {
  requestSettings?: Record<string, unknown>;
  id: string;
  kind: "queue" | "steer";
  content: string;
  attachments: MessageAttachment[];
  executionMode?: ExecutionMode;
  skills?: SkillSuggestion[];
  contextFork?: boolean;
  forcePlan?: boolean;
};

export type ComposerMode = "queue" | "steer";
export type ExecutionMode = "default" | "plan" | "goal" | "loop";

export type SkillSuggestion = {
  name: string;
  path: string;
  description: string;
  scope: string;
};

export type SlashTrigger = {
  start: number;
  end: number;
  query: string;
};

export type ComposerSuggestion =
  | { kind: "mode"; mode: Exclude<ExecutionMode, "default">; name: string; description: string }
  | ({ kind: "skill" } & SkillSuggestion)
  | { kind: "path"; name: string; path: string; description: string; scope: "file" | "directory"; insertText: string }
  | { kind: "keyword"; name: string; description: string; scope: "keyword"; insertText: string };

/** @deprecated Use ComposerSuggestion. */
export type SlashSuggestion = ComposerSuggestion;

export type PromptEditorState =
  | {
      kind: "pending";
      turnId: string;
      title: string;
      value: string;
    }
  | {
      kind: "wait";
      subscriptionId: string;
      turnId: string | null;
      sessionId: string;
      title: string;
      value: string;
    };

export type StreamEvent =
  | {
      type: "session";
      data: {
        sessionId: string;
        turnId?: string;
        threadId?: string;
        message: string;
        activeAccount?: AccountRecord | null;
        startupSnapshot?: string;
      };
    }
  | { type: "codex"; data: CodexEventSummary }
  | {
      type: "developer_instructions";
      data: {
        sessionId: string;
        turnId: string;
        target: string;
        phase: number;
        developerInstructions: string;
      };
    }
  | { type: "item"; data: StreamItem }
  | { type: "delta"; data: { text: string } }
  | { type: "approval.requested"; data: ApprovalEventData }
  | { type: "approval.resolved"; data: ApprovalEventData & { decision?: unknown; error?: string } }
  | {
      type: "auto_model.selected";
      data: SessionAutoModelConfig & { turnId: string; provider: "typesafe" | "fallback"; reason: string; confidence?: number };
    }
  | {
      type: "auto_model.phase_transition";
      data: { to: SessionAutoModelConfig; from?: { model?: string; effort?: string; revision?: number } };
    }
  | {
      type: "pending";
      data: { sessionId: string; turnId?: string; threadId?: string; message: string; queued?: boolean; stopped?: boolean };
    }
  | { type: "result"; data: { sessionId: string; turnId?: string; threadId?: string; elapsedMs: number; reply: string } }
  | { type: "done"; data: { ok: true } }
  | { type: "error"; data: { message: string; needsLogin?: boolean; account?: AccountRecord } };

export type ItemEventType = "item.started" | "item.updated" | "item.completed";
export type StructuredCommentType = "answer" | "action" | "edit" | "verification" | "solution" | "wait";
export type StructuredComment = {
  extracts: Array<{ type: StructuredCommentType; shortMsg: string }>;
  detail: string;
  /** Issues newly discovered by this comment; the UI accumulates them for the turn. */
  issues?: string[];
  /** issueKey is the stable one-based index into the turn-wide issue ledger. */
  solutions?: Array<{ issueKey: number; solution: string }>;
  blockers?: Array<{ issueKey: number; blocker: string }>;
};

export type TurnIssueCopyPayload = {
  kind: "threadex-issue-context";
  cli: "codex";
  id: string;
  sessionUrl: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  issueKey: number;
  issue: string;
  resolved: boolean;
  solution: string | null;
  blocker?: string;
};
export type LiveItemOrigin = { originThreadId?: string; originTurnId?: string; sortCreated?: string };

export type LiveItem = LiveItemOrigin & (
  | {
      id: string;
      eventType: ItemEventType;
      itemType: "agent_message";
      text: string;
      phase?: string;
      delivery?: "async";
      questions?: Array<{ title: string; options?: string[] }>;
      comment?: StructuredComment;
    }
  | {
      id: string;
      eventType: ItemEventType;
      itemType: "reasoning";
      text: string;
    }
  | {
      id: string;
      eventType: ItemEventType;
      itemType: "command_execution";
      command: string;
      aggregatedOutput: string;
      outputTruncated?: boolean;
      omittedOutputChars?: number;
      exitCode?: number;
      status: string;
    }
  | {
      id: string;
      eventType: ItemEventType;
      itemType: "file_change";
      changes: FileChange[];
      status: string;
      sourceItemType?: "command_execution";
      /** Final net diff for the turn; supersedes individual edit actions. */
      authoritative?: boolean;
    }
  | {
      id: string;
      eventType: ItemEventType;
      itemType: "web_search";
      query: string;
    }
  | {
      id: string;
      eventType: ItemEventType;
      itemType: "todo_list";
      items: Array<{ text: string; completed: boolean; status?: "pending" | "in_progress" | "completed" }>;
    }
  | {
      id: string;
      eventType: ItemEventType;
      itemType: "context_compaction";
    }
  | {
      id: string;
      eventType: ItemEventType;
      itemType: "subagent";
      tool: string;
      status: string;
      label?: string;
      senderThreadId?: string;
      receiverThreadIds: string[];
      prompt?: string;
      model?: string;
      reasoningEffort?: string;
      agents: Array<{ id: string; name?: string; status: string; message?: string }>;
    }
  | {
      id: string;
      eventType: ItemEventType;
      itemType: "approval";
      approvalId: string;
      sessionId: string;
      turnId: string;
      method: string;
      params: unknown;
      status: "pending" | "resolved";
      decision?: unknown;
      error?: string;
    }
  | {
      id: string;
      eventType: ItemEventType;
      itemType: "error";
      message: string;
    });

export type StreamItem = LiveItemOrigin & (
  | {
      id: string;
      eventType: ItemEventType;
      itemType: "agent_message";
      text: string;
      phase?: string;
      comment?: StructuredComment;
    }
  | LiveItem);

export type MessageSegment =
  | {
      id: string;
      type: "text";
      sourceId?: string;
      createdAt?: string;
      text: string;
    }
  | {
      id: string;
      type: "live";
      item: LiveItem;
    }
  | {
      id: string;
      type: "steer";
      text: string;
      createdAt?: string;
      attachments?: MessageAttachment[];
      forcePlan?: boolean;
    };

export type CodexEventSummary = {
  type: string;
  method?: string;
  params?: unknown;
  thread_id?: string;
  usage?: unknown;
  error?: { message: string };
  item?: {
    type: string;
    command?: string;
    path?: string;
    text?: string;
    status?: string;
    changes?: FileChange[];
    query?: string;
    message?: string;
  };

};

export type FileChange = {
  path: string;
  kind: string;
  additions?: number;
  deletions?: number;
  movePath?: string;
  before?: string;
  after?: string;
  beforeText?: string;
  afterText?: string;
  beforeContent?: string;
  afterContent?: string;
  oldContent?: string;
  newContent?: string;
  previousContent?: string;
  currentContent?: string;
  original?: string;
  updated?: string;
  diff?: string;
  patch?: string;
  unifiedDiff?: string;
};

export type ApprovalDecisionAction = {
  key: "accept" | "acceptForSession" | "decline" | "cancel";
  decision: unknown;
};

export type ApprovalPolicy = "untrusted" | "on-request" | "granular" | "never";

export type ApprovalEventData = {
  approvalId: string;
  sessionId: string;
  turnId: string;
  requestId: number | string;
  method: string;
  params?: unknown;
  createdAt?: string;
};

export type StoredSession = {
  version: 1;
  messages: ChatMessage[];
  queuedPrompts?: QueuedPrompt[];
  queuedPromptsBySession?: Record<string, QueuedPrompt[]>;
  workspaceId?: string | null;
  sessionId: string | null;
  threadId: string | null;
  activeTurnId: string | null;
  resumeThreadId: string;
  status: string;
  selectedModel: string;
  selectedEffort: ModelReasoningEffort;
  approvalPolicy?: ApprovalPolicy;
  gearProfiles?: GearProfile[];
  activeGearIndex?: number;
  useLoadBalanceInWorkspace?: boolean;
};

export type StoredModelSelector = {
  version: 1;
  selectedModel: string;
  selectedEffort: ModelReasoningEffort;
  gearProfiles: GearProfile[];
  activeGearIndex: number;
};

export type StreamTarget = {
  turnId: string;
  assistantMessageId: string;
  sessionId: string | null;
  viewKey: number;
  textByItemId: Record<string, string>;
  liveItemEventRankById: Record<string, number>;
  replayTextSkipChars?: number;
  completed?: boolean;
};

export type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type GearProfile = {
  model: string;
  effort: ModelReasoningEffort;
};
export type WorkspaceModelPreferences = {
  workspaceId: string;
  selectedModel: string;
  selectedEffort: ModelReasoningEffort;
  gearProfiles: GearProfile[];
  activeGearIndex: number;
  updated: string;
};
export type AccountLoginMode = "api" | "chatgpt";
export type SettingsSection = "profile" | "accounts" | "browserBridge" | "security";
export type BackendConnectionState = "unknown" | "online" | "reconnecting";
export type SessionTitleSource = "initial" | "summarizer" | "user";

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
  keywordWeights: Record<string, number>;
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

export type SessionTreeNode = {
  record: SessionRecord;
  children: SessionTreeNode[];
  depth: number;
};

export type SessionBaseDirGroup = {
  cwd: string;
  label: string;
  count: number;
  baseSessionId: string;
  sessions: SessionTreeNode[];
  page?: SessionProjectPageState;
};

export type SessionSearchPage = Omit<SessionPageState, "sessions" | "projects"> & { total: number };

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

export type ProfileAnalytics = {
  workspace: WorkspaceRecord;
  accountId: string | null;
  accounts: Array<Pick<AccountRecord, "id" | "name" | "email" | "externalAccountId">>;
  summary: {
    lifetime_tokens?: number;
    total_tasks?: number;
    total_sessions?: number;
    active_days?: number;
    peak_tokens?: number;
    longest_task_seconds?: number;
    models_used?: number;
  };
  activity: Array<{ date: string; tokens: number; tasks: number }>;
  trend: Array<{
    date: string;
    model: string;
    tokens: number;
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
  }>;
  reasoning: Array<{ effort: string; uses: number }>;
  skills: Array<{ name: string; uses: number }>;
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
  liveItems?: StreamItem[];
  steerMessages?: Array<{
    id: string;
    content: string;
    attachments?: MessageAttachment[];
    forcePlan?: boolean;
    created?: string;
  }>;
  tokenIn: number;
  tokenOut: number;
  usageSample?: {
    id: string;
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
  } | null;
  status: "done" | "todo" | "running";
  runnerPid?: number | null;
  runnerStarted?: string | null;
  runnerHeartbeat?: string | null;
  /** Exact runner-reported duration, when the final result includes it. */
  executionDurationMs?: number | null;
  runnerLogPath?: string | null;
  created: string;
};

export type SessionsResponse = {
  sessions: SessionRecord[];
  page: { offset: number; limit: number; hasMore: boolean; nextOffset: number | null; total?: number };
};

export type WorkspacesResponse = {
  workspaces: WorkspaceRecord[];
  activeWorkspace: WorkspaceRecord;
  sessions?: SessionRecord[];
  activeSessionId?: string | null;
};

export type AccountsResponse = {
  accounts: AccountRecord[];
  activeAccount: AccountRecord | null;
  loadBalanceInWorkspace: boolean;
  workspaceAccounts: AccountRecord[];
  workspaceAccountIds: string[];
};

export type AccountPayload = Partial<AccountsResponse> & {
  activeAccount?: AccountRecord | null;
  loadBalanceInWorkspace?: boolean;
  activeSessionId?: string | null;
};

export type PendingAccountLogin = {
  loginId: string;
  loginUrl: string;
  userCode: string | null;
};

export type SwitchSessionResponse = {
  session: SessionRecord | null;
  autoModel?: SessionAutoModelConfig;
  modelPreferences?: WorkspaceModelPreferences;
  todo?: SessionTodoSnapshot;
  activeSessionId?: string | null;
  turns?: SessionTurnRecord[];
};

export type TodoItemStatus = "todo" | "active" | "paused" | "hold" | "skipped" | "done" | "blocked";
export type TodoPlanSection = "solution" | "verification";
export type TodoCommentType = "status" | "blocker" | "note";
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
  type: "update" | "challenge";
  author: TodoActor;
  title: string;
  body: string;
  challengeId: number | null;
  resolved: boolean;
  resolvedBy: TodoActor | null;
  resolvedAt: string | null;
  created: string;
};

export type SessionTodoSnapshot = {
  sessionId: string;
  control: {
    sessionId: string;
    paused: boolean;
    pauseReason: string | null;
    pausedBy: TodoActor | null;
    context: string;
    problem: string;
    objective: string;
    updated: string;
  };
  items: TodoItemRecord[];
  itemSessions: TodoItemSessionRecord[];
  itemTree?: unknown[];
  comments: TodoCommentRecord[];
  messages: TodoMessageRecord[];
};

export type SessionAutoModelConfig = {
  sessionId: string;
  enabled: boolean;
  model: string;
  effort: ModelReasoningEffort;
  revision: number;
  updated: string;
};

export type WorkspaceSnapshotResponse = AccountsResponse & {
  activeWorkspace: WorkspaceRecord;
  workspaces: WorkspaceRecord[];
  sessions: SessionRecord[];
  sessionPage: {
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset: number | null;
    projects: SessionProjectPageState[];
  };
  sessionExecutionStatuses: Record<string, "running">;
  pendingApprovalSessionIds: string[];
  approvals?: unknown[];
  activeSessionId: string | null;
  activeSession: SwitchSessionResponse | null;
  modelPreferences: WorkspaceModelPreferences;
  processMonitors: ProcessMonitor[];
  waitEvents: WaitEvent[];
  waitSubscriptions: WaitSubscription[];
  eventCursor: number;
};

export type ProcessMonitorLogDialog = {
  monitorId: string;
  label: string;
  status: "loading" | "ready" | "error";
  content: string;
  size: number;
  truncated: boolean;
  updatedAt: string | null;
  error: string | null;
};
