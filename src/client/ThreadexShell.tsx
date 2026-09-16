// @ts-nocheck
import { useEffect as useReactEffect } from "react";
import { Flame, FolderOpen } from "lucide-react";
import { TurnGrillPanel, useGrilledTurns } from "./TurnGrillPanel";
import { FileEditIcon } from "./FileEditIcon";
import { openProjectFiles } from "./ProjectFilesViewer";
import { SessionChangesPopover } from "./SessionChangesPopover";
import { SideChatPanel } from "./SideChatPanel";
import { ResponseQuotePopover } from "./ResponseQuotePopover";
import { ComposerFrame, ComposerGearSelector, ComposerSurface, ComposerToolbar } from "./ComposerFrame";
import { formatAccountTier, formatQuotaWindowReset } from "./accountFormatters";
import { BrowserBridgeSettingsPanel } from "./BrowserBridgeSettingsPanel";
import { SecuritySettingsPanel } from "./Security";
import { ComposerSuggestionMenu, ComposerSuggestionSettingsPanel, findComposerSuggestionTrigger, loadComposerSuggestionKeywords } from "./ComposerSuggestions";
import { registerBrowserContextReceiver, threadexBrowserContextReceiverName } from "./browserContextReceiver";
import { parseTurnIssueContext, turnIssueContextAttachmentName } from "./turnIssueCopy";
import { consumeVsCodeAnnotation } from "./vscodeAnnotationBridge";
import { collectFileChanges, formatTurnDuration } from "./sessionHelpers02";
import { turnDurationMs } from "./sessionHelpers03";
import { installGlobalFileDrop } from "./globalFileDrop";

function sessionPopoverPosition(bounds, width) {
    const gap = 4;
    if (bounds.right + gap + width <= window.innerWidth - 16) {
        const top = Math.max(16, Math.min(bounds.top, window.innerHeight - 240));
        return { top, left: bounds.right + gap, maxHeight: window.innerHeight - top - 16 };
    }
    const left = Math.max(16, Math.min(bounds.left, window.innerWidth - width - 16));
    const below = window.innerHeight - bounds.bottom - gap - 16;
    const above = bounds.top - gap - 16;
    return below >= above
        ? { top: bounds.bottom + gap, left, maxHeight: Math.max(0, below) }
        : { bottom: window.innerHeight - bounds.top + gap, left, maxHeight: Math.max(0, above) };
}

function shortReasoningEffort(effort) {
  const normalized = typeof effort === "string" ? effort.trim().toLowerCase() : "";
  if (normalized === "ultra") return "U";
  if (normalized === "xhigh") return "XH";
  if (normalized === "high") return "H";
  if (normalized === "medium") return "M";
  if (normalized === "low") return "L";
  return normalized ? normalized.slice(0, 2).toUpperCase() : "";
}

function formatPromptExecutionDuration(durationMs, isRunning) {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
        return isRunning ? "Running…" : "Not recorded";
    }
    return formatTurnDuration({}, durationMs);
}

export function ThreadexShell(ctx) {
  const { APPROVAL_POLICY_OPTIONS, AUTO_MODEL_VALUE, Activity, ApprovalEvent, ArrowDown, ArrowLeft, ArrowUp, BetweenHorizontalStart, AttachmentList, CONTEXT_FORK_TAG_LABEL, CheckCircle2, CheckSquare2, ChevronDown, ChevronRight, Circle, Clock3, CompletedTurn, Copy, Cpu, Database, Diff, EFFORT_OPTIONS, ExternalLink, FileAnnotationComposerContext, FileText, Folder, FORCE_PLAN_TAG_LABEL, GOAL_MODE_TAG_LABEL, GitFork, InlineLinkComposer, ListChecks, LiveEventList, Loader2, MAX_ATTACHMENTS, MESSAGE_BOTTOM_THRESHOLD, MODEL_OPTIONS, MarkdownContent, MessageTimeline, Pencil, Plus, ProfileSettingsPanel, Quote, ResponseAnnotationList, RotateCcw, Search, Send, ServerPrefixPanels, Settings, ShieldCheck, Square, StatusUpdateIndicator, Target, TerminalSquare, TodoPanel, Trash2, ULTRA_EFFORT_OPTIONS, User, UserPlus, X, _Fragment, _jsx, _jsxs, accountIdentityLabel, accountNeedsLogin, accountResetCredits, annotationLabel, appActions01, appActions02, appActions03, appActions04, appActions05, appActions06, approvalEventToLiveItem, browserBridgeContextAttachmentName, buildCodexReference, buildMessageIndicatorMarks, capitalize, compareSessionRecordsByUpdated, createSystemMessage, displaySessionTitle, earliestExpiringResetCredit, fileChangeItemFromPatchCommand, findSlashTrigger, formatAccountSelectLabel, formatBytes, formatLoadBalanceAccountLabel, formatQuotaPercent, formatQuotaRemaining, formatQuotaReset, formatQuotaStatus, formatResetCreditExpiry, formatTimestamp, formatTimestampShort, formatTokenCount, getSessionExecutionStatus, getWorkspaceTabSummary, groupSessionsByBaseDir, groupTranscriptByStepMarkers, hasVisibleTodoPlan, highlightSessionSearchText, isTodoPlanAwaitingClarification, latestTurnIssueTracker, messageIndicatorMarkTop, messageTimingLabel, modelOptionLabel, movePendingModelPreferences, moveStoredComposerDraft, normalizeComposerDraft, normalizeSessionModelPreferences, normalizeStoredApprovalPolicy, parseBrowserBridgeContext, parseResponseAnnotations, patchStoredComposerDraft, pendingPromptForSubscription, promptDisplayMetadata, queuedPromptSessionKey, quotaWindowsByDuration, readOptionalNavigationTarget, readPendingModelPreferences, readStoredComposerDraft, readStoredModelSelector, readStoredSession, removePendingModelPreferencesIfMatches, sessionExecutionStatusLabel, shortId, shouldRenderMessageTimeline, summarizeTitle, supportsUltraEffort, useCallback, useEventStore, useMemo, useRef, useSessionEffects, useState, writeStoredSession, writePendingModelPreferences, appendSteerSegment, appendTextSegment, applyLiveItemToMessage, approvalDecisionLabel, approvalRecordToLiveItem, cleanLoginUrlValue, composerLinkToken, describeCodexEvent, describeStreamItem, developerInstructionRecordFromPayload, developerInstructionsIndicateForcePlan, elementForSelectionNode, eventStore, finalizeTerminalAssistantMessage, findAssistantMessageId, findUserMessageForTurn, formatComposerLinkMarkdown, formatResponseAnnotationsPrompt, getCodexEventName, isAccountLoginRequiredMessage, isApprovalLiveItem, isCodexTurnCompletedEvent, isInactiveSteerResponse, isLikelyBackendDisconnect, isNoRolloutFoundMessage, itemEventRank, liveItemKey, mergeDeveloperInstructionRecords, moveQueuedPromptInList, moveQueuedPromptToTarget, navigationUrl, nextPastedTextFileName, parseCodexReference, parsePastedHttpUrl, pendingAssistantMessages, promoteQueuedPromptToSteer, readApiError, readAttachment, readEventStream, readNavigationTarget, readRecord, readStringField, reorderPendingTurnMessages, replaceComposerLinkTokens, resetOutcomeLabel, resizeEditor, sessionTurnsToMessages, setsEqual, shouldCompactPastedText, sleep, slugify, toSessionPageState, upsertPendingApprovalItem } = ctx;
    function renderPromptTags(prompt, className = "") {
        const metadata = promptDisplayMetadata(prompt?.rawContent ?? prompt?.content);
        const contextFork = prompt?.contextFork === true || metadata.contextFork;
        const goalMode = prompt?.executionMode === "goal" || metadata.goalMode;
        if (!prompt?.forcePlan && !contextFork && !goalMode) {
            return null;
        }
        return (_jsxs("div", { className: className ? `prompt-tags ${className}` : "prompt-tags", children: [
                prompt.forcePlan && _jsx("span", { className: "prompt-tag", "data-tone": "plan", children: FORCE_PLAN_TAG_LABEL }),
                contextFork && _jsx("span", { className: "prompt-tag", "data-tone": "fork", children: CONTEXT_FORK_TAG_LABEL }),
                goalMode && _jsx("span", { className: "prompt-tag", "data-tone": "goal", children: GOAL_MODE_TAG_LABEL })
            ] }));
    }
    const centralState = useEventStore();
    const restoredSession = useMemo(readStoredSession, []);
    const initialNavigationTarget = useMemo(readOptionalNavigationTarget, []);
    const restoredModelSelector = useMemo(() => readStoredModelSelector(restoredSession), [restoredSession]);
    const restoredComposerDraft = useMemo(() => readStoredComposerDraft(restoredSession?.sessionId ?? null), [restoredSession?.sessionId]);
    const [messages, setMessages] = useState(restoredSession?.messages.length ? restoredSession.messages : [createSystemMessage()]);
    const [input, setInputState] = useState(() => restoredComposerDraft.input);
    const [sessionId, setSessionId] = useState(restoredSession?.sessionId ?? null);
    const [threadId, setThreadId] = useState(restoredSession?.threadId ?? null);
    const [activeTurnId, setActiveTurnId] = useState(restoredSession?.activeTurnId ?? null);
    const [status, setStatus] = useState(restoredSession?.status ?? "Idle");
    const [clockNow, setClockNow] = useState(() => Date.now());
    const [runningTurnIds, setRunningTurnIds] = useState(() => new Set());
    const [stoppingTurnIds, setStoppingTurnIds] = useState(() => new Set());
    const [isSteering, setIsSteering] = useState(false);
    const [toastMessage, setToastMessage] = useState(null);
    const [gearProfiles, setGearProfiles] = useState(() => restoredModelSelector.gearProfiles);
    const [activeGearIndex, setActiveGearIndex] = useState(() => restoredModelSelector.activeGearIndex);
    const [sessionAutoModel, setSessionAutoModel] = useState(null);
    const [attachments, setAttachments] = useState([]);
    const [composerResponseQuote, setComposerResponseQuote] = useState(null);
    const [sessionTab, setSessionTab] = useState({ sessionId: null, value: "turns" });
    useReactEffect(() => { setSessionTab({ sessionId, value: "turns" }); }, [sessionId]);
    const [responseQuotePopover, setResponseQuotePopover] = useState(null);
    const [sideChatAnnotation, setSideChatAnnotation] = useState(null);
    useReactEffect(() => setSideChatAnnotation(null), [sessionId]);
    const [composerSessionLinks, setComposerSessionLinks] = useState([]);
    const [queuedPromptsBySession, setQueuedPromptsBySession] = useState(() => restoredSession?.queuedPromptsBySession ?? {});
    const [composerMode, setComposerMode] = useState("queue");
    const [forkNextPrompt, setForkNextPrompt] = useState(() => restoredComposerDraft.forkNextPrompt);
    const [forcePlanNextPrompt, setForcePlanNextPrompt] = useState(() => restoredComposerDraft.forcePlanNextPrompt);
    const [executionMode, setExecutionMode] = useState(() => restoredComposerDraft.executionMode);
    const [skillSuggestions, setSkillSuggestions] = useState([]);
    const [pathSuggestions, setPathSuggestions] = useState([]);
    const [pathSuggestionsScope, setPathSuggestionsScope] = useState(null);
    const [suggestionKeywords, setSuggestionKeywords] = useState([]);
    const [suggestionKeywordsWorkspaceId, setSuggestionKeywordsWorkspaceId] = useState(null);
    const [selectedSkills, setSelectedSkills] = useState([]);
    const [slashTrigger, setSlashTrigger] = useState(null);
    const [slashSuggestionIndex, setSlashSuggestionIndex] = useState(0);
    useReactEffect(() => {
        const receiveAnnotation = () => {
            const envelope = consumeVsCodeAnnotation();
            if (!envelope)
                return;
            setComposerResponseQuote(envelope.annotation);
            setResponseQuotePopover(null);
            showToast("VS Code annotation added to this session");
            window.requestAnimationFrame(() => inputEditorRef.current?.focus());
        };
        receiveAnnotation();
        window.addEventListener("focus", receiveAnnotation);
        window.addEventListener("hashchange", receiveAnnotation);
        return () => {
            window.removeEventListener("focus", receiveAnnotation);
            window.removeEventListener("hashchange", receiveAnnotation);
        };
    }, []);
    const [composerSuggestionTrigger, setComposerSuggestionTrigger] = useState(null);
    const [composerSuggestionIndex, setComposerSuggestionIndex] = useState(-1);
    const [isLoadingSkills, setIsLoadingSkills] = useState(false);
    const [isLoadingPathSuggestions, setIsLoadingPathSuggestions] = useState(false);
    const [promptEditor, setPromptEditor] = useState(null);
    const [promptDetails, setPromptDetails] = useState(null);
    const [turnDetailsTab, setTurnDetailsTab] = useState("input");
    const [turnRounds, setTurnRounds] = useState({
        turnId: null,
        status: "idle",
        events: [],
        total: 0,
        hasMore: false,
        error: ""
    });
    const [inlinePromptEditor, setInlinePromptEditor] = useState(null);
    const [messageIndicatorPositions, setMessageIndicatorPositions] = useState({});
    const [activePromptTurnIds, setActivePromptTurnIds] = useState(() => new Set());
    const [featuredPromptTurnId, setFeaturedPromptTurnId] = useState(null);
    const [isSessionSearchOpen, setIsSessionSearchOpen] = useState(false);
    const [isPendingWaitsOpen, setIsPendingWaitsOpen] = useState(false);
    const [sessionSearchQuery, setSessionSearchQuery] = useState("");
    const [sessionSearchResults, setSessionSearchResults] = useState([]);
    const [sessionSearchPage, setSessionSearchPage] = useState({
        offset: 0,
        limit: 20,
        hasMore: false,
        nextOffset: null,
        total: 0
    });
    const [isSearchingSessions, setIsSearchingSessions] = useState(false);
    const [newSessionProjectName, setNewSessionProjectName] = useState(null);
    const [newSessionProjectId, setNewSessionProjectId] = useState(null);
    const [resumeThreadId, setResumeThreadId] = useState(restoredSession?.resumeThreadId || restoredSession?.threadId || "");
    const sessionList = centralState.sessionPage.sessions;
    const [sessionExecutionStatuses, setSessionExecutionStatuses] = useState({});
    const [sessionTodo, setSessionTodo] = useState(null);
    const [parentSessionTodo, setParentSessionTodo] = useState(null);
    const activeWorkspaceId = centralState.workspaceSnapshot?.activeWorkspace?.id ?? null;
    const activeWorkspaceSessions = useMemo(() => activeWorkspaceId
        ? sessionList.filter((record) => record.workspaceId === activeWorkspaceId)
        : [], [activeWorkspaceId, sessionList]);
    const flatSessions = useMemo(() => [...activeWorkspaceSessions].sort(compareSessionRecordsByUpdated), [activeWorkspaceSessions]);
    const groupedSessions = useMemo(() => groupSessionsByBaseDir(sessionList, activeWorkspaceId), [activeWorkspaceId, sessionList]);
    const [collapsedSessionDirs, setCollapsedSessionDirs] = useState(() => new Set());
    const [selectedSessionIds, setSelectedSessionIds] = useState(() => new Set());
    const selectedSessionRecords = useMemo(() => flatSessions.filter((record) => selectedSessionIds.has(record.id)), [flatSessions, selectedSessionIds]);
    const [pendingApprovalSessionIds, setPendingApprovalSessionIds] = useState([]);
    const [processMonitorAction, setProcessMonitorAction] = useState(null);
    const [processMonitorLog, setProcessMonitorLog] = useState(null);
    const [waitSubscriptionAction, setWaitSubscriptionAction] = useState(null);
    const [activeSessionId, setActiveSessionId] = useState(null);
    const [workspaceList, setWorkspaceList] = useState([]);
    const [activeWorkspace, setActiveWorkspace] = useState(null);
    const [accountList, setAccountList] = useState([]);
    const [workspaceAccountList, setWorkspaceAccountList] = useState([]);
    const [workspaceAccountIds, setWorkspaceAccountIds] = useState([]);
    const [activeAccount, setActiveAccount] = useState(null);
    const [workspaceProjects, setWorkspaceProjects] = useState([]);
    const [isProjectPickerOpen, setIsProjectPickerOpen] = useState(false);
    const [isLoadingWorkspaceProjects, setIsLoadingWorkspaceProjects] = useState(false);
    const [workspaceProjectsError, setWorkspaceProjectsError] = useState("");
    const [approvalPolicy, setApprovalPolicy] = useState(() => normalizeStoredApprovalPolicy(restoredSession?.approvalPolicy));
    const [isAccountPopoverOpen, setIsAccountPopoverOpen] = useState(false);
    const [resettingAccountId, setResettingAccountId] = useState(null);
    const [deletingAccountId, setDeletingAccountId] = useState(null);
    const [pendingApprovalItems, setPendingApprovalItems] = useState([]);
    const [hoveredSession, setHoveredSession] = useState(null);
    const [achievingSessionIds, setAchievingSessionIds] = useState(() => new Set());
    const [hoveredProcessMonitor, setHoveredProcessMonitor] = useState(null);
    const [hoveredWorkspace, setHoveredWorkspace] = useState(null);
    const hoveredSessionCloseTimerRef = useRef(null);
    const hoveredProcessMonitorCloseTimerRef = useRef(null);
    const [bindAccountId, setBindAccountId] = useState("");
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [settingsSection, setSettingsSection] = useState("profile");
    const [profileWorkspaceId, setProfileWorkspaceId] = useState("");
    const [profileAccountId, setProfileAccountId] = useState("");
    const [profileAnalytics, setProfileAnalytics] = useState(null);
    const [profileAnalyticsError, setProfileAnalyticsError] = useState("");
    const [isLoadingProfileAnalytics, setIsLoadingProfileAnalytics] = useState(false);
    const [isAccountLoginOpen, setIsAccountLoginOpen] = useState(false);
    const [accountLoginMode, setAccountLoginMode] = useState("chatgpt");
    const [accountLoginTargetId, setAccountLoginTargetId] = useState(null);
    const [newAccountName, setNewAccountName] = useState("");
    const [apiAccountUrl, setApiAccountUrl] = useState("");
    const [apiAccountKey, setApiAccountKey] = useState("");
    const [pendingAccountLogin, setPendingAccountLogin] = useState(null);
    const [isSavingAccount, setIsSavingAccount] = useState(false);
    const [useLoadBalanceInWorkspace, setUseLoadBalanceInWorkspace] = useState(restoredSession?.useLoadBalanceInWorkspace ?? true);
    const [isLoadingSessions, setIsLoadingSessions] = useState(false);
    const [loadingSessionProjects, setLoadingSessionProjects] = useState(() => new Set());
    const [isBootstrapped, setIsBootstrapped] = useState(false);
    const [forkingTurnId, setForkingTurnId] = useState(null);
    const [switchingSessionTitle, setSwitchingSessionTitle] = useState(null);
    const [draggedQueuedPromptId, setDraggedQueuedPromptId] = useState(null);
    const [draggedPendingTurnId, setDraggedPendingTurnId] = useState(null);
    const [backendConnection, setBackendConnection] = useState("unknown");
    const activeTurnIdRef = useRef(restoredSession?.activeTurnId ?? null);
    const sessionIdRef = useRef(restoredSession?.sessionId ?? null);
    const sessionExecutionStatusesRef = useRef({});
    const newSessionProjectRef = useRef(null);
    const newSessionBaseSessionIdRef = useRef(null);
    const forcePlanNextPromptRef = useRef(restoredComposerDraft.forcePlanNextPrompt);
    const composerInputEditRevisionRef = useRef(0);
    const composerDraftSessionIdRef = useRef(restoredSession?.sessionId ?? null);
    const modelPreferencesWorkspaceIdRef = useRef(restoredSession?.workspaceId ?? null);
    const gearProfilesRef = useRef(restoredModelSelector.gearProfiles);
    const activeGearIndexRef = useRef(restoredModelSelector.activeGearIndex);
    const persistedModelPreferencesWorkspaceIdRef = useRef(null);
    const modelPreferencesHydratedRef = useRef(false);
    const modelPreferencesEditRevisionRef = useRef(0);
    const queuedModelPreferencesRevisionRef = useRef(0);
    const modelPreferencesSaveQueueRef = useRef(Promise.resolve());
    const latestMessagesRef = useRef(restoredSession?.messages.length ? restoredSession.messages : []);
    const queuedPromptsRef = useRef(restoredSession?.queuedPrompts ?? []);
    const queuedPromptEditRef = useRef(null);
    const inputEditorRef = useRef(null);
    const inlinePromptEditorRef = useRef(null);
    const messagesRef = useRef(null);
    const promptTurnsScrollRef = useRef(null);
    const messageScrollIndicatorRef = useRef(null);
    const messageViewportIndicatorRef = useRef(null);
    const messageRailDragRef = useRef(null);
    const accountPopoverRef = useRef(null);
    const stickToMessageBottomRef = useRef(true);
    const messageScrollTopRef = useRef(0);
    const messageElementsRef = useRef({});
    const viewKeyRef = useRef(0);
    const loadSessionsTimerRef = useRef(null);
    const backendConnectionRef = useRef("unknown");
    const threadIdRef = useRef(restoredSession?.threadId ?? null);
    const backendRestoreInFlightRef = useRef(false);
    const activeWorkspaceIdRef = useRef(null);
    const navigationTargetRef = useRef(initialNavigationTarget ?? { workspaceId: null, sessionId: null });
    const navigationRequestIdRef = useRef(0);
    const explicitNewSessionRef = useRef(false);
    const newSessionRequestInFlightRef = useRef(false);
    const reconnectingTurnIdsRef = useRef(new Set());
    const reconcilingTurnIdsRef = useRef(new Set());
    const pendingReconciliationTurnIdsRef = useRef(new Set());
    const toastTimerRef = useRef(null);
    const composerSessionLinkUrisRef = useRef(new Set());
    const escStopTimerRef = useRef(null);
    const escStopArmedRef = useRef(false);
    const didBootReconnectRef = useRef(false);
    const streamTargetsRef = useRef({});
    sessionExecutionStatusesRef.current = sessionExecutionStatuses;
    activeWorkspaceIdRef.current = activeWorkspace?.id ?? null;
    threadIdRef.current = threadId;
    const queuedPrompts = queuedPromptsBySession[queuedPromptSessionKey(sessionId)] ?? [];
    function setComposerInput(update) {
        setInputState((current) => {
            const next = typeof update === "function" ? update(current) : update;
            if (next !== current) {
                composerInputEditRevisionRef.current += 1;
            }
            if (!queuedPromptEditRef.current) {
                patchStoredComposerDraft(composerDraftSessionIdRef.current, { input: next });
            }
            return next;
        });
    }
    const { grilledTurns, markGrilled, pendingGrillTurns, pendingGrillSessions } = useGrilledTurns(sessionId);
    function clearNewSessionProjectSelection() {
        newSessionProjectRef.current = null;
        newSessionBaseSessionIdRef.current = null;
        setNewSessionProjectName(null);
        setNewSessionProjectId(null);
    }
    function setComposerForkNextPrompt(update) {
        setForkNextPrompt((current) => {
            const next = typeof update === "function" ? update(current) : update;
            patchStoredComposerDraft(composerDraftSessionIdRef.current, { forkNextPrompt: next });
            return next;
        });
    }
    function setComposerForcePlanNextPrompt(update) {
        const next = typeof update === "function" ? update(forcePlanNextPromptRef.current) : update;
        forcePlanNextPromptRef.current = next;
        patchStoredComposerDraft(composerDraftSessionIdRef.current, { forcePlanNextPrompt: next });
        setForcePlanNextPrompt(next);
    }
    function setComposerExecutionMode(update) {
        setExecutionMode((current) => {
            const next = typeof update === "function" ? update(current) : update;
            patchStoredComposerDraft(composerDraftSessionIdRef.current, { executionMode: next });
            return next;
        });
    }
    function currentModelPreferences() {
        const currentGearProfiles = gearProfilesRef.current;
        const currentGearIndex = activeGearIndexRef.current;
        const currentGear = currentGearProfiles[currentGearIndex] ?? currentGearProfiles[0];
        return {
            selectedModel: currentGear.model,
            selectedEffort: currentGear.effort,
            gearProfiles: currentGearProfiles,
            activeGearIndex: currentGearIndex
        };
    }
    function queueModelPreferencesSave(targetWorkspaceId, preferences) {
        if (!targetWorkspaceId) {
            return;
        }
        const normalized = normalizeSessionModelPreferences(preferences);
        writePendingModelPreferences(targetWorkspaceId, normalized);
        const save = async () => {
            const response = await fetch(`/api/workspace-model-preferences/${encodeURIComponent(targetWorkspaceId)}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(normalized)
            });
            if (!response.ok) {
                throw new Error(`Model preferences API returned ${response.status}`);
            }
            removePendingModelPreferencesIfMatches(targetWorkspaceId, normalized);
        };
        const queued = modelPreferencesSaveQueueRef.current.catch(() => undefined).then(save);
        modelPreferencesSaveQueueRef.current = queued.catch(() => undefined);
    }
    function persistModelPreferences(preferences) {
        const targetWorkspaceId = modelPreferencesWorkspaceIdRef.current;
        if (!targetWorkspaceId || persistedModelPreferencesWorkspaceIdRef.current !== targetWorkspaceId) {
            writePendingModelPreferences(targetWorkspaceId, preferences);
            return;
        }
        queueModelPreferencesSave(targetWorkspaceId, preferences);
    }
    function applyModelPreferencesState(preferences, targetWorkspaceId) {
        const previousWorkspaceId = modelPreferencesWorkspaceIdRef.current;
        const livePreferences = currentModelPreferences();
        const keepPreBootstrapEdits = !modelPreferencesHydratedRef.current &&
            previousWorkspaceId === null &&
            modelPreferencesEditRevisionRef.current > 0;
        modelPreferencesWorkspaceIdRef.current = targetWorkspaceId;
        modelPreferencesHydratedRef.current = true;
        const pendingPreferences = readPendingModelPreferences(targetWorkspaceId);
        const normalized = normalizeSessionModelPreferences(keepPreBootstrapEdits
            ? livePreferences
            : pendingPreferences ?? preferences);
        if (keepPreBootstrapEdits) {
            writePendingModelPreferences(targetWorkspaceId, normalized);
        }
        gearProfilesRef.current = normalized.gearProfiles;
        activeGearIndexRef.current = normalized.activeGearIndex;
        setGearProfiles(normalized.gearProfiles);
        setActiveGearIndex(normalized.activeGearIndex);
    }
    function prepareNewLocalModelPreferences(workspaceId = activeWorkspace?.id ?? null, preferences = undefined) {
        persistedModelPreferencesWorkspaceIdRef.current = workspaceId;
        if (preferences) {
            applyModelPreferencesState(preferences, workspaceId);
            return;
        }
        modelPreferencesWorkspaceIdRef.current = workspaceId;
    }
    function currentComposerDraft(inputValue, forcePlanValue, executionModeValue, forkValue) {
        return normalizeComposerDraft({
            input: inputValue,
            forcePlanNextPrompt: forcePlanValue,
            executionMode: executionModeValue,
            forkNextPrompt: forkValue
        });
    }
    function applyComposerDraftState(draft, draftSessionId) {
        queuedPromptEditRef.current = null;
        composerDraftSessionIdRef.current = draftSessionId;
        composerInputEditRevisionRef.current = 0;
        setInputState(draft.input);
        setForkNextPrompt(draft.forkNextPrompt && Boolean(draftSessionId));
        forcePlanNextPromptRef.current = draft.forcePlanNextPrompt;
        setForcePlanNextPrompt(draft.forcePlanNextPrompt);
        setExecutionMode(draft.executionMode);
        setSlashTrigger(null);
    }
    function replaceComposerDraftForSession(nextSessionId) {
        const draft = readStoredComposerDraft(nextSessionId);
        applyComposerDraftState(draft, nextSessionId);
    }
    function clearComposerInputDraft() {
        if (!queuedPromptEditRef.current) {
            patchStoredComposerDraft(composerDraftSessionIdRef.current, { input: "" });
        }
        setInputState("");
        setSlashTrigger(null);
    }
    function setQueuedPrompts(update) {
        const queueKey = queuedPromptSessionKey(sessionIdRef.current);
        setQueuedPromptsBySession((currentBySession) => {
            const current = currentBySession[queueKey] ?? [];
            const next = typeof update === "function" ? update(current) : update;
            if (next === current) {
                return currentBySession;
            }
            if (next.length === 0) {
                if (!(queueKey in currentBySession)) {
                    return currentBySession;
                }
                const nextBySession = { ...currentBySession };
                delete nextBySession[queueKey];
                return nextBySession;
            }
            return { ...currentBySession, [queueKey]: next };
        });
    }
    function migrateLocalQueuedPrompts(nextSessionId) {
        const previousSessionId = sessionIdRef.current;
        if (!previousSessionId?.startsWith("local_") || previousSessionId === nextSessionId) {
            return;
        }
        const previousQueueKey = queuedPromptSessionKey(previousSessionId);
        const nextQueueKey = queuedPromptSessionKey(nextSessionId);
        setQueuedPromptsBySession((currentBySession) => {
            const previousQueue = currentBySession[previousQueueKey];
            if (!previousQueue?.length) {
                return currentBySession;
            }
            const nextBySession = {
                ...currentBySession,
                [nextQueueKey]: [...previousQueue, ...(currentBySession[nextQueueKey] ?? [])]
            };
            delete nextBySession[previousQueueKey];
            return nextBySession;
        });
    }
    function migrateLocalComposerDraft(nextSessionId) {
        const previousSessionId = sessionIdRef.current;
        if (!previousSessionId?.startsWith("local_") || previousSessionId === nextSessionId) {
            return;
        }
        moveStoredComposerDraft(previousSessionId, nextSessionId);
        if (composerDraftSessionIdRef.current === previousSessionId) {
            composerDraftSessionIdRef.current = nextSessionId;
        }
    }
    const transcript = useMemo(() => messages.filter((message) => message.role !== "system" && message.kind !== "steer"), [messages]);
    const transcriptEntries = useMemo(() => groupTranscriptByStepMarkers(transcript), [transcript]);
    const promptTurns = useMemo(() => transcript.filter((message) => message.role === "user" && message.turnId).map((prompt, index) => {
        const response = transcript.find((message) => message.role === "assistant" && message.turnId === prompt.turnId);
        const liveItems = response?.liveItems ?? [];
        const editCount = collectFileChanges({}, liveItems.map((item) => item.itemType === "command_execution"
            ? fileChangeItemFromPatchCommand(item) ?? item
            : item)).length;
        const toolCount = liveItems.filter((item) => ["web_search", "todo_list", "subagent", "approval"].includes(item.itemType)).length;
        const agentRoundTripIds = new Set(liveItems.filter((item) => item.itemType === "agent_message" && (!threadId || !item.originThreadId || item.originThreadId === threadId)).map((item) => `agent:${liveItemKey(item)}`));
        for (const segment of response?.segments ?? []) {
            if (segment.type === "text" && segment.text.trim())
                agentRoundTripIds.add(segment.sourceId ?? segment.id);
        }
        const agentRoundTripCount = Math.max(agentRoundTripIds.size, response?.content.trim() || response?.conclusion?.trim() ? 1 : 0);
        const steerCount = messages.filter((message) => message.role === "user" && message.kind === "steer" && message.turnId === prompt.turnId).length;
        const issueTracker = latestTurnIssueTracker(liveItems);
        const issueCount = issueTracker?.issues.length ?? 0;
        const resolvedIssueCount = issueTracker
            ? new Set(issueTracker.solutions
                .map((solution) => solution.issueKey)
                .filter((issueKey) => Number.isInteger(issueKey) && issueKey >= 1 && issueKey <= issueCount)).size
            : 0;
        return { prompt, response, index, editCount, toolCount, agentRoundTripCount, steerCount, issueCount, resolvedIssueCount };
    }), [messages, threadId, transcript]);
    const turnNumberById = useMemo(() => {
        const numbers = new Map();
        for (const message of transcript) {
            if (message.role !== "assistant" || !message.turnId || numbers.has(message.turnId))
                continue;
            numbers.set(message.turnId, numbers.size + 1);
        }
        return numbers;
    }, [transcript]);
    const messageIndicatorMarks = useMemo(() => buildMessageIndicatorMarks(transcript, messages), [transcript, messages]);
    const visibleRunningTurnId = messages.find((message) => message.role === "assistant" && message.turnStatus === "running" && message.turnId)
        ?.turnId ?? null;
    const currentRunningTurnId = activeTurnId && runningTurnIds.has(activeTurnId) ? activeTurnId : visibleRunningTurnId;
    const currentSessionIsRunning = messages.some((message) => message.turnStatus === "running") ||
        Boolean(activeTurnId && runningTurnIds.has(activeTurnId));
    const currentSessionIsStopping = Boolean(currentRunningTurnId && stoppingTurnIds.has(currentRunningTurnId));
    const hasRunningTurn = messages.some((message) => message.role === "assistant" && message.turnStatus === "running");
    const runningSessionCount = Object.values(sessionExecutionStatuses).filter((executionStatus) => executionStatus === "running").length;
    const otherWorkspaceRunningSessionCount = useMemo(() => new Set(
        centralState.statusMonitor.flatMap((workspace) => workspace.active_sessions.map((session) => session.id))
    ).size, [centralState.statusMonitor]);
    const totalRunningSessionCount = runningSessionCount + otherWorkspaceRunningSessionCount;
    const selectedSessionIsReportedRunning = Boolean(sessionId && sessionExecutionStatuses[sessionId] === "running");
    const backgroundRunningCount = Math.max(0, runningSessionCount - (selectedSessionIsReportedRunning ? 1 : 0));
    const composerLinksReady = composerSessionLinks.every((link) => link.status === "ready");
    const canSend = isBootstrapped && composerLinksReady && (input.trim().length > 0 || attachments.length > 0 || composerSessionLinks.length > 0 ||
        Boolean(composerResponseQuote?.annotation?.trim()));
    const selectedGear = gearProfiles[activeGearIndex] ?? gearProfiles[0];
    gearProfilesRef.current = gearProfiles;
    activeGearIndexRef.current = activeGearIndex;
    const selectedModel = selectedGear.model;
    const selectedEffort = selectedGear.effort;
    const sendButtonIsStop = currentSessionIsRunning && !canSend;
    const selectedSessionSnapshot = centralState.selectedSessionSnapshot;
    const selectedSnapshotSession = selectedSessionSnapshot?.session ?? null;
    const fallbackActiveSessionId = sessionId ? null : activeSessionId;
    const activeSession = (selectedSnapshotSession && (selectedSnapshotSession.id === sessionId || selectedSnapshotSession.id === fallbackActiveSessionId)
        ? selectedSnapshotSession
        : null) ??
        sessionList.find((record) => record.id === sessionId || record.id === fallbackActiveSessionId) ??
        null;
    const effectiveParentSessionId = activeSession?.parentSessionId ?? null;
    const parentSession = effectiveParentSessionId
        ? sessionList.find((record) => record.id === effectiveParentSessionId) ?? null
        : null;
    const visibleSessionTodo = sessionTodo?.sessionId === sessionId ? sessionTodo : null;
    const hasPlanTab = Boolean(sessionId && hasVisibleTodoPlan(visibleSessionTodo));
    const activeSessionTab = sessionTab.sessionId === sessionId && (sessionTab.value !== "plan" || hasPlanTab) ? sessionTab.value : "turns";
    const visibleParentSessionTodo = parentSessionTodo?.sessionId === effectiveParentSessionId ? parentSessionTodo : null;
    const childSessions = sessionId
        ? sessionList.filter((record) => record.parentSessionId === sessionId)
        : [];
    const currentSessionIsTodoChild = Boolean(sessionId && visibleParentSessionTodo?.itemSessions?.some((itemSession) => itemSession.childSessionId === sessionId));
    const pendingApprovalSessionIdSet = useMemo(() => new Set(pendingApprovalSessionIds), [pendingApprovalSessionIds]);
    const workspaceStatusById = useMemo(() => new Map(centralState.statusMonitor.map((workspace) => [workspace.id, workspace])), [centralState.statusMonitor]);
    const activeWorkspacePendingApprovalSessionIdSet = useMemo(() => {
        const backgroundSessionIds = new Set(centralState.statusMonitor.flatMap((workspace) => workspace.active_sessions.map((backgroundSession) => backgroundSession.id)));
        return new Set(pendingApprovalSessionIds.filter((pendingSessionId) => !backgroundSessionIds.has(pendingSessionId)));
    }, [centralState.statusMonitor, pendingApprovalSessionIds]);
    const activeWorkspaceBackgroundSessions = useMemo(() => {
        const currentSessionId = sessionId ?? activeSessionId;
        const ids = new Set([
            ...Object.entries(sessionExecutionStatuses)
                .filter(([, executionStatus]) => executionStatus === "running")
                .map(([id]) => id),
            ...activeWorkspacePendingApprovalSessionIdSet
        ]);
        if (currentSessionId)
            ids.delete(currentSessionId);
        return [...ids];
    }, [activeSessionId, activeWorkspacePendingApprovalSessionIdSet, sessionExecutionStatuses, sessionId]);
    const firstUserMessage = transcript.find((message) => message.role === "user");
    const todoPlanClarificationPending = isTodoPlanAwaitingClarification(visibleSessionTodo);
    const composerTodoPlanModeAvailable = !currentSessionIsTodoChild;
    const composerTodoPlanModeEnabled = composerTodoPlanModeAvailable && forcePlanNextPrompt;
    const threadTitle = activeSession?.title
        ? displaySessionTitle(activeSession.title)
        : firstUserMessage
            ? summarizeTitle(firstUserMessage.content)
            : "New thread";
    useReactEffect(() => {
        document.title = totalRunningSessionCount > 0
            ? `(${totalRunningSessionCount}) Threadex`
            : "Threadex";
    }, [totalRunningSessionCount]);
    useReactEffect(() => registerBrowserContextReceiver(threadexBrowserContextReceiverName, (injectedContext) => {
        const contextText = JSON.stringify(injectedContext, null, 2);
        const context = parseBrowserBridgeContext(contextText);
        if (!context)
            return;
        void readAttachment(new File([contextText], browserBridgeContextAttachmentName(context), { type: "application/json" })).then((attachment) => {
            setAttachments((current) => current.length >= MAX_ATTACHMENTS ? current : [...current, attachment]);
            setStatus("Browser page context attached");
            window.requestAnimationFrame(() => inputEditorRef.current?.focus());
        });
    }), []);
    const mostRecentlyActiveProject = groupedSessions[0] ?? null;
    // A blank thread is always rooted in a project. Preserve the project that
    // opened it; otherwise default to the project with the most recent session
    // activity instead of exposing the workspace name as though it were one.
    const projectName = !sessionId
        ? newSessionProjectName ?? mostRecentlyActiveProject?.label ?? "Choose a project"
        : "Choose a project";
    // The blank composer displays the most recently used project as its default.
    // Use that project's saved session to preload its directory suggestions too.
    const autoSelectedProjectSessionId = !sessionId && !newSessionProjectId
        ? mostRecentlyActiveProject?.baseSessionId ?? null
        : null;
    function newSessionInProjectGroup(group) {
        return newSession(group ? { name: group.label } : null, group?.baseSessionId ?? null);
    }
    async function openProjectPicker() {
        if (!activeWorkspace?.id) {
            return;
        }
        const workspaceId = activeWorkspace.id;
        setIsProjectPickerOpen(true);
        setIsLoadingWorkspaceProjects(true);
        setWorkspaceProjectsError("");
        try {
            const response = await fetch(`/api/workspaces/projects?workspaceId=${encodeURIComponent(workspaceId)}`);
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload?.error || `API returned ${response.status}`);
            }
            if (payload.workspaceId !== workspaceId) {
                return;
            }
            setWorkspaceProjects(Array.isArray(payload.projects) ? payload.projects : []);
        }
        catch (error) {
            setWorkspaceProjects([]);
            setWorkspaceProjectsError(error instanceof Error ? error.message : "Could not load projects.");
        }
        finally {
            setIsLoadingWorkspaceProjects(false);
        }
    }
    function toggleProjectPicker() {
        if (isProjectPickerOpen) {
            setIsProjectPickerOpen(false);
            return;
        }
        void openProjectPicker();
    }
    useReactEffect(() => {
        setIsProjectPickerOpen(false);
        setWorkspaceProjects([]);
        setWorkspaceProjectsError("");
    }, [activeWorkspace?.id]);
    useReactEffect(() => {
        if (!input) {
            setComposerSuggestionTrigger(null);
        }
    }, [input]);
    useReactEffect(() => {
        const workspaceId = activeWorkspace?.id ?? null;
        setSuggestionKeywordsWorkspaceId(workspaceId);
        setSuggestionKeywords([]);
        if (!workspaceId) {
            return;
        }
        let cancelled = false;
        void loadComposerSuggestionKeywords(workspaceId)
            .then((keywords) => {
            if (!cancelled)
                setSuggestionKeywords(keywords);
        })
            .catch((error) => {
            if (!cancelled)
                setStatus(`Suggestion keywords failed: ${error instanceof Error ? error.message : "Unknown error"}`);
        });
        return () => {
            cancelled = true;
        };
    }, [activeWorkspace?.id]);
    useReactEffect(() => {
        const suggestionProjectId = sessionId ? null : newSessionProjectId;
        const suggestionSessionId = sessionId ?? autoSelectedProjectSessionId;
        if (!activeWorkspace?.id || (!suggestionSessionId && !suggestionProjectId)) {
            setPathSuggestions([]);
            setPathSuggestionsScope(null);
            setIsLoadingPathSuggestions(false);
            return;
        }
        const workspaceId = activeWorkspace.id;
        let cancelled = false;
        setPathSuggestions([]);
        setPathSuggestionsScope(null);
        setIsLoadingPathSuggestions(true);
        const params = new URLSearchParams({ workspaceId });
        if (suggestionSessionId) {
            params.set("sessionId", suggestionSessionId);
        }
        else if (suggestionProjectId) {
            params.set("projectId", suggestionProjectId);
        }
        void fetch(`/api/composer-suggestions?${params}`, { cache: "no-store" })
            .then(async (response) => {
            if (!response.ok)
                throw new Error(`API returned ${response.status}`);
            return response.json();
        })
            .then((payload) => {
            if (!cancelled) {
                setPathSuggestions(Array.isArray(payload.entries) ? payload.entries : []);
                setPathSuggestionsScope({ workspaceId, sessionId: suggestionSessionId, projectId: suggestionProjectId });
            }
        })
            .catch((error) => {
            if (!cancelled)
                setStatus(`Thread suggestions failed: ${error instanceof Error ? error.message : "Unknown error"}`);
        })
            .finally(() => {
            if (!cancelled)
                setIsLoadingPathSuggestions(false);
        });
        return () => {
            cancelled = true;
        };
    }, [activeWorkspace?.id, autoSelectedProjectSessionId, newSessionProjectId, sessionId]);
    const unboundAccounts = useMemo(() => accountList.filter((account) => !workspaceAccountIds.includes(account.id)), [accountList, workspaceAccountIds]);
    const visibleSlashSuggestions = useMemo(() => {
        if (!slashTrigger)
            return [];
        const query = slashTrigger.query.toLowerCase();
        const modes = [
            { kind: "mode", mode: "plan", name: "plan", description: "Toggle plan mode" },
            { kind: "mode", mode: "goal", name: "goal", description: "Toggle goal mode" }
        ];
        const skills = skillSuggestions.map((skill) => ({ kind: "skill", ...skill }));
        return [...modes, ...skills].filter((suggestion) => !query || suggestion.name.toLowerCase().includes(query) || suggestion.description.toLowerCase().includes(query));
    }, [skillSuggestions, slashTrigger]);
    const visibleComposerSuggestions = useMemo(() => {
        if (!composerSuggestionTrigger)
            return [];
        const query = composerSuggestionTrigger.query.toLowerCase();
        const activeWorkspaceId = activeWorkspace?.id ?? null;
        const paths = (pathSuggestionsScope?.workspaceId === activeWorkspaceId &&
            pathSuggestionsScope.sessionId === (sessionId ?? autoSelectedProjectSessionId) &&
            pathSuggestionsScope.projectId === (sessionId ? null : newSessionProjectId)
            ? pathSuggestions
            : []).map((entry) => ({
            kind: "path",
            name: entry.path,
            path: entry.path,
            description: entry.kind === "directory"
                ? pathSuggestionsScope?.projectId ? "Project directory" : "Thread directory"
                : pathSuggestionsScope?.projectId ? "Project file" : "Thread file",
            scope: entry.kind,
            insertText: `@${entry.path}${entry.kind === "directory" ? "/" : ""} `
        }));
        const keywords = (suggestionKeywordsWorkspaceId === activeWorkspaceId ? suggestionKeywords : []).map((keyword) => ({ kind: "keyword", name: keyword, description: "Saved suggestion keyword", scope: "keyword", insertText: `${keyword} ` }));
        return [...paths, ...keywords].filter((suggestion) => !query || suggestion.name.toLowerCase().includes(query));
    }, [activeWorkspace?.id, autoSelectedProjectSessionId, composerSuggestionTrigger, newSessionProjectId, pathSuggestions, pathSuggestionsScope, sessionId, suggestionKeywords, suggestionKeywordsWorkspaceId]);
    useReactEffect(() => {
        setComposerSuggestionIndex(-1);
    }, [composerSuggestionTrigger?.start, composerSuggestionTrigger?.end, composerSuggestionTrigger?.query]);
    useSessionEffects({ accountPopoverRef, activeGearIndex, activePromptTurnIds, activeTurnId, activeTurnIdRef, activeWorkspace, approvalPolicy, backendConnection, backendConnectionRef, bumpViewKey, composerDraftSessionIdRef, currentModelPreferences, currentRunningTurnId, currentSessionIsRunning, currentSessionIsStopping, didBootReconnectRef, effectiveParentSessionId, escStopArmedRef, escStopTimerRef, eventStore, executionMode, explicitNewSessionRef, findAssistantMessageId, forcePlanNextPrompt, forkNextPrompt, gearProfiles, handleDurableEvent, hasRunningTurn, inlinePromptEditor, inlinePromptEditorRef, isAccountLoginOpen, isAccountPopoverOpen, isBootstrapped, isLikelyBackendDisconnect, isSessionSearchOpen, isSettingsOpen, latestMessagesRef, loadContext, loadSessionSearchPage, loadSessionsTimerRef, loadWorkspaceSnapshot, messageIndicatorMarks, messageScrollIndicatorRef, messageScrollTopRef, messages, messagesRef, modelPreferencesEditRevisionRef, navigationTargetRef, noteBackendDisconnect, noteBackendRequestSucceeded, patchStoredComposerDraft, persistModelPreferences, profileAccountId, profileWorkspaceId, promptTurns, promptTurnsScrollRef, queuedModelPreferencesRevisionRef, queuedPrompts, queuedPromptsBySession, queuedPromptsRef, readNavigationTarget, reconnectRunner, reconnectingTurnIdsRef, refreshSelectedSessionSnapshot, resetAccountLoginDialog, resetEscStopPrompt, resizeEditor, responseQuotePopover, restoreBackendConnection, resumeThreadId, runQueuedPrompt, runningSessionCount, selectedEffort, selectedModel, sessionExecutionStatusesRef, sessionId, sessionIdRef, sessionSearchQuery, setActivePromptTurnIds, setClockNow, setComposerResponseQuote, setIsAccountPopoverOpen, setIsLoadingProfileAnalytics, setIsLoadingSkills, setIsSettingsOpen, setParentSessionTodo, setPendingApprovalSessionIds, setProfileAnalytics, setProfileAnalyticsError, setProfileWorkspaceId, setResponseQuotePopover, setSelectedSkills, setSessionExecutionStatuses, setSkillSuggestions, setSlashSuggestionIndex, setStatus, setsEqual, settingsSection, showToast, skillSuggestions, slashTrigger, status, stickToMessageBottomRef, stopCurrentTurn, switchingSessionTitle, threadId, toastTimerRef, updateMessageIndicatorPositions, updateMessageViewportIndicator, useLoadBalanceInWorkspace, viewKeyRef, writeStoredSession });
    function showToast(message) { return appActions01.showToast({ setToastMessage, toastTimerRef }, message); }
    async function copyUserPrompt(prompt) {
        if (!navigator.clipboard) {
            showToast("Clipboard is unavailable");
            return;
        }
        const visiblePrompt = promptDisplayMetadata(prompt.rawContent ?? prompt.content).visible;
        const content = parseResponseAnnotations(visiblePrompt)?.content || visiblePrompt || "Attachment prompt";
        try {
            await navigator.clipboard.writeText(content);
            showToast("User prompt copied");
        }
        catch {
            showToast("Could not copy user prompt");
        }
    }
    function toggleTodoPlanMode() { return appActions01.toggleTodoPlanMode({ composerTodoPlanModeAvailable, forcePlanNextPrompt, setComposerForcePlanNextPrompt, setStatus, todoPlanClarificationPending }); }
    async function copySessionReference(workspaceId, id) { return appActions01.copySessionReference({ buildCodexReference, showToast }, workspaceId, id); }
    function toggleSessionSelection(id) {
        setSelectedSessionIds((current) => {
            const next = new Set(current);
            if (next.has(id)) {
                next.delete(id);
            }
            else {
                next.add(id);
            }
            return next;
        });
    }
    function clearSessionSelection() { setSelectedSessionIds(new Set()); }
    async function copySelectedSessionReferences() {
        if (selectedSessionRecords.length === 0) {
            return;
        }
        if (!navigator.clipboard) {
            showToast("Clipboard is unavailable");
            return;
        }
        try {
            await navigator.clipboard.writeText(appActions01.selectedSessionReferences(selectedSessionRecords, buildCodexReference));
            clearSessionSelection();
            showToast(`Copied ${selectedSessionRecords.length} session URL${selectedSessionRecords.length === 1 ? "" : "s"}`);
        }
        catch {
            showToast("Unable to copy session URLs");
        }
    }
    function resetEscStopPrompt() { return appActions01.resetEscStopPrompt({ escStopArmedRef, escStopTimerRef }); }
    function markBackendConnection(state) { return appActions01.markBackendConnection({ backendConnectionRef, setBackendConnection }, state); }
    function noteBackendDisconnect() { return appActions01.noteBackendDisconnect({ backendConnectionRef, markBackendConnection, setStatus }); }
    function noteBackendRequestSucceeded() { return appActions01.noteBackendRequestSucceeded({ backendConnectionRef, markBackendConnection }); }
    async function restoreBackendConnection() { return appActions01.restoreBackendConnection({ backendRestoreInFlightRef, findReconnectTarget, loadContext, reconnectRunner, setStatus, streamTargetsRef, viewKeyRef }); }
    function findReconnectTarget() { return appActions01.findReconnectTarget({ activeTurnIdRef, findAssistantMessageId, latestMessagesRef, sessionIdRef }); }
    async function stopCurrentTurn(turnId = currentRunningTurnId) { return appActions01.stopCurrentTurn({ isLikelyBackendDisconnect, loadSessions, markTurnStopped, noteBackendDisconnect, noteBackendRequestSucceeded, sessionIdRef, setStatus, setStoppingTurnIds, showToast, stoppingTurnIds }, turnId); }
    function captureResponseQuoteSelection(event) { return appActions01.captureResponseQuoteSelection({ activeWorkspace, buildCodexReference, elementForSelectionNode, sessionId, setResponseQuotePopover, threadId }, event); }
    function askAboutResponseQuote(quote) { return appActions01.askAboutResponseQuote({ inputEditorRef, setComposerResponseQuote, setResponseQuotePopover }, quote); }
    const askAboutFileAnnotation = useCallback((annotation) => {
        setComposerResponseQuote(annotation);
        setResponseQuotePopover(null);
        if (!annotation.annotation) {
            window.requestAnimationFrame(() => inputEditorRef.current?.focus());
        }
    }, []);
    const removeFileAnnotation = useCallback((path) => {
        setComposerResponseQuote((current) => {
            const source = current?.source;
            return source?.type === "file" && (!path || source.path === path) ? null : current;
        });
    }, []);
    async function submit(event) { return appActions01.submit({ attachments, commitQueuedPromptEdit, composerLinkToken, composerMode, composerResponseQuote, composerSessionLinks, composerTodoPlanModeEnabled, currentSessionIsRunning, enqueuePrompt, executionMode, forkNextPrompt, formatComposerLinkMarkdown, formatResponseAnnotationsPrompt, input, queuePrompt, queuedPromptEditRef, replaceComposerLinkTokens, selectedSkills, sessionIdRef, setComposerExecutionMode, setComposerForkNextPrompt, startChatTurn, steerPrompt }, event); }
    async function startChatTurn(message, turnAttachments, turnExecutionMode = executionMode, turnSkills = selectedSkills, contextForkRequest = false, forcePlan = false, clearComposer = true, grillOrigin = undefined) { return appActions01.startChatTurn({ AUTO_MODEL_VALUE, activeAccount, activeWorkspace, activeWorkspaceIdRef, approvalPolicy, clearComposerInputDraft, clearComposerSessionLinks, composerDraftSessionIdRef, currentModelPreferences, explicitNewSessionRef, handleStreamEvent, isLikelyBackendDisconnect, markTurnFinished, markTurnRunning, modelPreferencesWorkspaceIdRef, moveStoredComposerDraft, newSessionBaseSessionIdRef, newSessionProjectRef, noteBackendDisconnect, noteBackendRequestSucceeded, patchAssistantMessage, persistedModelPreferencesWorkspaceIdRef, readEventStream, reconnectRunner, registerStreamTarget, restoreKnownActiveSessionBeforeSend, resumeThreadId, scheduleLoadSessions, selectedEffort, selectedModel, sessionAutoModel, sessionIdRef, setActiveSessionId, setActiveTurnId, setAttachments, setComposerResponseQuote, setMessages, setResponseQuotePopover, setSelectedSkills, setSessionId, setSlashTrigger, setStatus, stickToMessageBottomRef, streamTargetsRef, unregisterStreamTarget, updateNavigationUrl, useLoadBalanceInWorkspace, viewKeyRef }, message, turnAttachments, turnExecutionMode, turnSkills, contextForkRequest, forcePlan, clearComposer, grillOrigin); }
    function queuePrompt(message, mode = executionMode, skills = selectedSkills, forcePlan = composerTodoPlanModeEnabled) { return appActions01.queuePrompt({ attachments, enqueuePrompt }, message, mode, skills, forcePlan); }
    async function steerPrompt(message, steerAttachments = attachments, clearComposer = true, steerSkills = selectedSkills, forcePlan = false) { return appActions01.steerPrompt({ addSteerMessage, clearComposerInputDraft, clearComposerSessionLinks, currentRunningTurnId, enqueuePrompt, executionMode, isInactiveSteerResponse, isLikelyBackendDisconnect, isSteering, noteBackendDisconnect, noteBackendRequestSucceeded, parseResponseAnnotations, refreshSelectedSessionSnapshot, sessionIdRef, setAttachments, setComposerForcePlanNextPrompt, setComposerInput, setComposerResponseQuote, setIsSteering, setResponseQuotePopover, setSelectedSkills, setSlashTrigger, setStatus, showToast }, message, steerAttachments, clearComposer, steerSkills, forcePlan); }
    function addSteerMessage(targetSessionId, turnId, content, steerAttachments, createdAt = new Date().toISOString(), forcePlan = false, id) { return appActions01.addSteerMessage({ appendSteerSegment, sessionIdRef, setMessages }, targetSessionId, turnId, content, steerAttachments, createdAt, forcePlan, id); }
    function enqueuePrompt(message, kind, mode = executionMode, skills = selectedSkills, promptAttachments = attachments, contextFork = false, forcePlan = false, clearComposer = true) { return appActions01.enqueuePrompt({ clearComposerInputDraft, clearComposerSessionLinks, setAttachments, setComposerResponseQuote, setQueuedPrompts, setResponseQuotePopover, setSelectedSkills, setSlashTrigger, setStatus }, message, kind, mode, skills, promptAttachments, contextFork, forcePlan, clearComposer); }
    async function runQueuedPrompt() { return appActions01.runQueuedPrompt({ currentSessionIsRunning, queuedPromptsRef, setQueuedPrompts, startChatTurn }); }
    async function loadSessionSearchPage(offset = 0, signal) { return appActions01.loadSessionSearchPage({ sessionSearchQuery, setIsSearchingSessions, setSessionSearchPage, setSessionSearchResults, setStatus }, offset, signal); }
    async function loadSessions(offset = 0, append = false, cwd = null) { return appActions01.loadSessions({ centralState, eventStore, isLikelyBackendDisconnect, noteBackendDisconnect, noteBackendRequestSucceeded, setIsLoadingSessions, setLoadingSessionProjects, setStatus, toSessionPageState }, offset, append, cwd); }
    async function refreshSelectedSessionSnapshot(targetSessionId, turnId) { return appActions01.refreshSelectedSessionSnapshot({ applySelectedSessionSnapshot, isLikelyBackendDisconnect, noteBackendDisconnect, noteBackendRequestSucceeded, pendingReconciliationTurnIdsRef, reconcilingTurnIdsRef, sessionIdRef, setStatus }, targetSessionId, turnId); }
    async function loadContext() { return appActions01.loadContext({ loadWorkspaceSnapshot, readOptionalNavigationTarget }); }
    async function restoreSelectedSessionForWorkspace(workspaceId) { return appActions02.restoreSelectedSessionForWorkspace({ sessionIdRef }, workspaceId); }
    async function loadWorkspaceSnapshot(options = {}) { return appActions02.loadWorkspaceSnapshot({ activeTurnIdRef, activeWorkspaceIdRef, applyAccountPayload, applySelectedSessionSnapshot, approvalRecordToLiveItem, clearNewSessionProjectSelection, createSystemMessage, eventStore, isApprovalLiveItem, isLikelyBackendDisconnect, navigationRequestIdRef, noteBackendDisconnect, noteBackendRequestSucceeded, prepareNewLocalModelPreferences, replaceComposerDraftForSession, replaceNavigationUrl, replaceRunningTurns, restoreSelectedSessionForWorkspace, sessionIdRef, setActiveSessionId, setActiveTurnId, setActiveWorkspace, setIsBootstrapped, setMessages, setParentSessionTodo, setPendingApprovalItems, setPendingApprovalSessionIds, setSessionExecutionStatuses, setSessionId, setSessionTodo, setStatus, setThreadId, setWorkspaceList, toSessionPageState, updateNavigationUrl, viewKeyRef }, options); }
    function applySelectedSessionSnapshot(payload) { return appActions02.applySelectedSessionSnapshot({ activeTurnIdRef, applyModelPreferencesState, composerDraftSessionIdRef, composerInputEditRevisionRef, displaySessionTitle, eventStore, explicitNewSessionRef, modelPreferencesHydratedRef, modelPreferencesWorkspaceIdRef, moveStoredComposerDraft, persistedModelPreferencesWorkspaceIdRef, queueModelPreferencesSave, readPendingModelPreferences, replaceComposerDraftForSession, sessionIdRef, sessionTurnsToMessages, setActiveSessionId, setActiveTurnId, setMessages, setResumeThreadId, setRunningTurnIds, setSessionAutoModel, setSessionId, setSessionTodo, setThreadId }, payload); }
    function clearTodoPanelState() { return appActions02.clearTodoPanelState({ setParentSessionTodo, setSessionTodo }); }
    function applyTodoSnapshotForSession(targetSessionId, todo) { return appActions02.applyTodoSnapshotForSession({ sessionIdRef, setSessionTodo }, targetSessionId, todo); }
    async function handleDurableEvent(event) { return appActions02.handleDurableEvent({ activeTurnIdRef, applyDeveloperInstructionsToTurn, approvalEventToLiveItem, eventStore, finalizeTerminalAssistantMessage, isCodexTurnCompletedEvent, loadWorkspaceSnapshot, markTurnFinished, readRecord, readStringField, reconnectRunner, reconnectingTurnIdsRef, refreshSelectedSessionSnapshot, removePendingApprovalItem, scheduleLoadSessions, sessionIdRef, setActiveTurnId, setMessages, setPendingApprovalItems, setPendingApprovalSessionIds, setSessionExecutionStatuses, setSessionTodo, streamTargetsRef, upsertPendingApprovalItem, viewKeyRef }, event); }
    async function loadWorkspaces() { return appActions02.loadWorkspaces({ isLikelyBackendDisconnect, noteBackendDisconnect, noteBackendRequestSucceeded, setActiveWorkspace, setStatus, setWorkspaceList }); }
    async function loadAccounts() { return appActions02.loadAccounts({ applyAccountPayload, isLikelyBackendDisconnect, noteBackendDisconnect, noteBackendRequestSucceeded, setStatus }); }
    async function refreshApprovalState() { return appActions02.refreshApprovalState({ approvalRecordToLiveItem, isApprovalLiveItem, isLikelyBackendDisconnect, noteBackendDisconnect, readRecord, setPendingApprovalItems, setPendingApprovalSessionIds }); }
    async function restartProcessMonitor(monitor) { return appActions02.restartProcessMonitor({ eventStore, readApiError, setProcessMonitorAction, setStatus }, monitor); }
    async function openProcessMonitorLog(monitor) { return appActions02.openProcessMonitorLog({ readApiError, setHoveredProcessMonitor, setProcessMonitorLog }, monitor); }
    async function removeProcessMonitor(monitor) { return appActions02.removeProcessMonitor({ eventStore, readApiError, setProcessMonitorAction, setStatus }, monitor); }
    async function switchWorkspace(workspaceId, options = {}) { return appActions02.switchWorkspace({ activeWorkspace, applyAccountPayload, bumpViewKey, clearNewSessionProjectSelection, clearTodoPanelState, createSystemMessage, eventStore, explicitNewSessionRef, isCurrentViewKey, loadWorkspaceSnapshot, parentSessionTodo, replaceComposerDraftForSession, sessionIdRef, sessionTodo, setActiveSessionId, setActiveTurnId, setActiveWorkspace, setMessages, setParentSessionTodo, setQueuedPrompts, setResumeThreadId, setSessionExecutionStatuses, setSessionId, setSessionTodo, setStatus, setThreadId, setWorkspaceList, toSessionPageState, updateNavigationUrl, viewKeyRef, workspaceList }, workspaceId, options); }
    async function createWorkspace() { return appActions02.createWorkspace({ activeWorkspace, applyAccountPayload, bumpViewKey, clearNewSessionProjectSelection, clearTodoPanelState, createSystemMessage, eventStore, explicitNewSessionRef, isCurrentViewKey, loadWorkspaceSnapshot, parentSessionTodo, replaceComposerDraftForSession, sessionIdRef, sessionTodo, setActiveSessionId, setActiveTurnId, setActiveWorkspace, setMessages, setParentSessionTodo, setQueuedPrompts, setResumeThreadId, setSessionExecutionStatuses, setSessionId, setSessionTodo, setStatus, setThreadId, setWorkspaceList, slugify, toSessionPageState, updateNavigationUrl, viewKeyRef }); }
    async function switchAccount(accountId) { return appActions03.switchAccount({ accountIdentityLabel, accountList, accountNeedsLogin, activeWorkspace, applyAccountPayload, beginAccountRelogin, sessionId, setIsAccountPopoverOpen, setStatus, setUseLoadBalanceInWorkspace }, accountId); }
    async function resetAccountRateLimit(account) { return appActions03.resetAccountRateLimit({ accountIdentityLabel, accountResetCredits, applyAccountPayload, earliestExpiringResetCredit, resetOutcomeLabel, resettingAccountId, setResettingAccountId, setStatus, showToast }, account); }
    async function importCurrentAccount() { return appActions03.importCurrentAccount({ accountList, accountLoginTargetId, activeAccount, applyAccountPayload, setStatus }); }
    async function createApiAccount(event) { return appActions03.createApiAccount({ accountLoginTargetId, apiAccountKey, apiAccountUrl, applyAccountPayload, isSavingAccount, newAccountName, resetAccountLoginDialog, setIsSavingAccount, setStatus }, event); }
    async function startChatGptLogin(target) { return appActions03.startChatGptLogin({ accountLoginTargetId, cleanLoginUrlValue, isSavingAccount, newAccountName, pollChatGptLoginStatus, sessionId, setIsSavingAccount, setPendingAccountLogin, setStatus }, target); }
    async function pollChatGptLoginStatus(loginId) { return appActions03.pollChatGptLoginStatus({ applyAccountPayload, cleanLoginUrlValue, resetAccountLoginDialog, setPendingAccountLogin, setStatus, sleep }, loginId); }
    function resetAccountLoginDialog() { return appActions03.resetAccountLoginDialog({ setAccountLoginMode, setAccountLoginTargetId, setApiAccountKey, setApiAccountUrl, setIsAccountLoginOpen, setNewAccountName, setPendingAccountLogin }); }
    function openAccountLoginDialog(account) { return appActions03.openAccountLoginDialog({ setAccountLoginMode, setAccountLoginTargetId, setApiAccountKey, setApiAccountUrl, setIsAccountLoginOpen, setIsAccountPopoverOpen, setNewAccountName, setPendingAccountLogin }, account); }
    function beginAccountRelogin(account) { return appActions03.beginAccountRelogin({ openAccountLoginDialog, startChatGptLogin }, account); }
    function applyAccountPayload(payload) { return appActions03.applyAccountPayload({ setAccountList, setActiveAccount, setUseLoadBalanceInWorkspace, setWorkspaceAccountIds, setWorkspaceAccountList }, payload); }
    function scheduleLoadSessions(delayMs = 350) { return appActions03.scheduleLoadSessions({ loadSessions, loadSessionsTimerRef }, delayMs); }
    function bumpViewKey() { return appActions03.bumpViewKey({ viewKeyRef }); }
    function isCurrentViewKey(viewKey) { return appActions03.isCurrentViewKey({ viewKeyRef }, viewKey); }
    function updateNavigationUrl(target, mode) { return appActions03.updateNavigationUrl({ navigationTargetRef, navigationUrl }, target, mode); }
    function replaceNavigationUrl(target) { return appActions03.replaceNavigationUrl({ updateNavigationUrl }, target); }
    function registerStreamTarget(turnId, assistantMessageId, targetSessionId, viewKey) { return appActions03.registerStreamTarget({ streamTargetsRef }, turnId, assistantMessageId, targetSessionId, viewKey); }
    function unregisterStreamTarget(target, originalTurnId = target.turnId) { return appActions03.unregisterStreamTarget({ streamTargetsRef }, target, originalTurnId); }
    function markTurnRunning(turnId) { return appActions03.markTurnRunning({ setRunningTurnIds }, turnId); }
    function markTurnFinished(turnId) { return appActions03.markTurnFinished({ setRunningTurnIds }, turnId); }
    function markTurnStopped(turnId, message) { return appActions03.markTurnStopped({ activeTurnIdRef, markTurnFinished, setActiveTurnId, setMessages }, turnId, message); }
    function replaceRunningTurns(turnIds) { return appActions03.replaceRunningTurns({ setRunningTurnIds }, turnIds); }
    function isTargetVisible(target) { return appActions03.isTargetVisible({ sessionIdRef, viewKeyRef }, target); }
    function scrollToMessage(messageId, anchorId) { return appActions03.scrollToMessage({ messageElementsRef }, messageId, anchorId); }
    function updateMessageViewportIndicator(container = messagesRef.current) { return appActions03.updateMessageViewportIndicator({ messageScrollIndicatorRef, messageViewportIndicatorRef, setActivePromptTurnIds, setFeaturedPromptTurnId, setsEqual }, container); }
    function updateMessageIndicatorPositions(container = messagesRef.current) { return appActions03.updateMessageIndicatorPositions({ messageElementsRef, messageIndicatorMarks, setMessageIndicatorPositions }, container); }
    function scrollFromMessageRail(event) { return appActions03.scrollFromMessageRail({ messageScrollIndicatorRef, messageViewportIndicatorRef, messagesRef }, event); }
    function scrollFromMessageRailWheel(event) { return appActions03.scrollFromMessageRailWheel({ messagesRef }, event); }
    function startMessageRailDrag(event) { return appActions03.startMessageRailDrag({ messageRailDragRef, messageScrollIndicatorRef }, event); }
    function dragMessageRailViewport(event) { return appActions03.dragMessageRailViewport({ messageRailDragRef, messageScrollIndicatorRef, messagesRef }, event); }
    function finishMessageRailDrag(event) { return appActions03.finishMessageRailDrag({ messageRailDragRef }, event); }
    async function bindAccount(accountId = bindAccountId) { return appActions03.bindAccount({ activeWorkspace, applyAccountPayload, setBindAccountId, setStatus }, accountId); }
    async function unbindAccount(accountId) { return appActions03.unbindAccount({ activeWorkspace, applyAccountPayload, setStatus }, accountId); }
    async function deleteAccount(account) { return appActions03.deleteAccount({ accountIdentityLabel, applyAccountPayload, deletingAccountId, setBindAccountId, setDeletingAccountId, setProfileAccountId, setStatus, showToast }, account); }
    async function switchSession(record, options = {}) { return appActions03.switchSession({ applyComposerDraftState, applySelectedSessionSnapshot, bumpViewKey, clearTodoPanelState, currentComposerDraft, displaySessionTitle, executionMode, explicitNewSessionRef, forcePlanNextPrompt, forkNextPrompt, input, isCurrentViewKey, isLikelyBackendDisconnect, messages, noteBackendDisconnect, noteBackendRequestSucceeded, parentSessionTodo, reconnectRunner, replaceComposerDraftForSession, scheduleLoadSessions, sessionIdRef, sessionTodo, setMessages, setParentSessionTodo, setSessionTodo, setStatus, setSwitchingSessionTitle, stickToMessageBottomRef, updateNavigationUrl, viewKeyRef }, record, options); }
    async function openLinkedSession(record) { return appActions04.openLinkedSession({ activeWorkspace, switchSession, switchWorkspace }, record); }
    async function switchToSessionById(targetSessionId, options = {}) { return appActions04.switchToSessionById({ isCurrentViewKey, sessionList, setStatus, showToast, switchSession, viewKeyRef }, targetSessionId, options); }
    async function switchToParentSession(parentSessionId) { return appActions04.switchToParentSession({ switchToSessionById }, parentSessionId); }
    async function restoreKnownActiveSessionBeforeSend() { return appActions04.restoreKnownActiveSessionBeforeSend({ activeSessionId, eventStore, explicitNewSessionRef, navigationTargetRef, newSessionRequestInFlightRef, readOptionalNavigationTarget, sessionIdRef, sessionList, setStatus, switchSession, switchToSessionById }); }
    async function achieveSessionGoal(record) { return appActions04.achieveSessionGoal({ achievingSessionIds, centralState, eventStore, isLikelyBackendDisconnect, noteBackendDisconnect, noteBackendRequestSucceeded, scheduleLoadSessions, setAchievingSessionIds, setStatus, showToast }, record); }
    async function forkFromAgentMessage(message) { return appActions04.forkFromAgentMessage({ applySelectedSessionSnapshot, bumpViewKey, clearTodoPanelState, currentSessionIsRunning, isCurrentViewKey, messages, parentSessionTodo, scheduleLoadSessions, sessionId, sessionTodo, setForkingTurnId, setMessages, setParentSessionTodo, setQueuedPrompts, setSessionTodo, setStatus, setSwitchingSessionTitle, stickToMessageBottomRef, updateNavigationUrl, viewKeyRef }, message); }
    function handleStreamEvent(event, target) { return appActions04.handleStreamEvent({ activeAccount, activeTurnIdRef, activeWorkspaceIdRef, appendAssistantMessage, applyDeveloperInstructionsToTurn, applyStreamItem, approvalDecisionLabel, approvalEventToLiveItem, capitalize, describeCodexEvent, finishStreamTarget, getCodexEventName, isAccountLoginRequiredMessage, isNoRolloutFoundMessage, isTargetVisible, loadAccounts, loadSessions, markTurnFinished, markTurnRunning, migrateLocalComposerDraft, migrateLocalQueuedPrompts, modelOptionLabel, openAccountLoginDialog, patchAssistantMessage, patchAssistantTurn, readNavigationTarget, removePendingApprovalItem, scheduleLoadSessions, sessionIdRef, setActiveAccount, setActiveTurnId, setMessages, setPendingApprovalItems, setPendingApprovalSessionIds, setResumeThreadId, setSessionAutoModel, setSessionId, setStatus, setThreadId, streamTargetsRef, threadIdRef, updateNavigationUrl, upsertLiveItem, upsertPendingApprovalItem }, event, target); }
    function finishStreamTarget(target, turnId = target.turnId) { return appActions04.finishStreamTarget({ activeTurnIdRef, finalizeTerminalAssistantMessage, isTargetVisible, markTurnFinished, setActiveTurnId, setMessages }, target, turnId); }
    function patchAssistantMessage(target, content, pending, turnStatus, options = {}) { return appActions04.patchAssistantMessage({ isTargetVisible, setMessages }, target, content, pending, turnStatus, options); }
    function appendAssistantMessage(target, content, pending, turnStatus, textSegmentId = "agent:delta") { return appActions04.appendAssistantMessage({ appendTextSegment, isTargetVisible, setMessages }, target, content, pending, turnStatus, textSegmentId); }
    function patchAssistantTurn(target, turnId, pending, turnStatus) { return appActions04.patchAssistantTurn({ isTargetVisible, setMessages }, target, turnId, pending, turnStatus); }
    function applyDeveloperInstructionsToTurn(turnId, payload) { return appActions04.applyDeveloperInstructionsToTurn({ developerInstructionRecordFromPayload, developerInstructionsIndicateForcePlan, mergeDeveloperInstructionRecords, setMessages }, turnId, payload); }
    function applyStreamItem(target, item) { return appActions04.applyStreamItem({ appendAssistantMessage, describeStreamItem, isTargetVisible, liveItemKey, readAgentMessageAppendText, setStatus, threadIdRef, upsertLiveItem }, target, item); }
    function upsertLiveItem(target, item) { return appActions04.upsertLiveItem({ applyLiveItemToMessage, isTargetVisible, itemEventRank, liveItemKey, setMessages }, target, item); }
    function removePendingApprovalItem(approvalId) { return appActions04.removePendingApprovalItem({ refreshApprovalState, setPendingApprovalItems }, approvalId); }
    async function newSession(project = null, baseSessionId = null) { return appActions04.newSession({ activeWorkspace, applyComposerDraftState, bumpViewKey, clearTodoPanelState, createSystemMessage, currentComposerDraft, eventStore, executionMode, explicitNewSessionRef, forcePlanNextPrompt, forkNextPrompt, input, isCurrentViewKey, isLikelyBackendDisconnect, navigationRequestIdRef, newSessionBaseSessionIdRef, newSessionProjectRef, newSessionRequestInFlightRef, noteBackendDisconnect, noteBackendRequestSucceeded, parentSessionTodo, prepareNewLocalModelPreferences, replaceComposerDraftForSession, sessionIdRef, sessionTodo, setActiveSessionId, setActiveTurnId, setComposerInput, setIsBootstrapped, setMessages, setNewSessionProjectId, setNewSessionProjectName, setParentSessionTodo, setPendingApprovalItems, setQueuedPrompts, setResumeThreadId, setSessionAutoModel, setSessionId, setSessionTodo, setStatus, setThreadId, updateNavigationUrl, viewKeyRef }, project, baseSessionId); }
    function focusComposer() { window.requestAnimationFrame(() => inputEditorRef.current?.focus()); }
    function editQueuedPrompt(promptId) { return appActions04.editQueuedPrompt({ focusComposer, input, queuedPromptEditRef, queuedPromptsRef, setComposerInput, setQueuedPrompts, setStatus }, promptId); }
    function commitQueuedPromptEdit(content) { return appActions04.commitQueuedPromptEdit({ focusComposer, queuedPromptEditRef, setComposerInput, setQueuedPrompts, setStatus }, content); }
    function focusInlinePromptEditorAtEnd() { return appActions04.focusInlinePromptEditorAtEnd({ inlinePromptEditorRef }); }
    function startInlineUserPromptEdit(message) {
        return appActions04.startInlineUserPromptEdit({ focusInlinePromptEditorAtEnd, setInlinePromptEditor, setStatus }, {
            ...message,
            content: promptDisplayMetadata(message.rawContent ?? message.content).visible
        });
    }
    function cancelInlineUserPromptEdit() { return appActions04.cancelInlineUserPromptEdit({ setInlinePromptEditor, setStatus }); }
    async function submitInlineUserPromptEdit(event, message) { return appActions05.submitInlineUserPromptEdit({ inlinePromptEditor, resendUserPrompt, setInlinePromptEditor }, event, message); }
    function handleInlinePromptEditorKeyDown(event, message) { return appActions05.handleInlinePromptEditorKeyDown({ submitInlineUserPromptEdit }, event, message); }
    async function resendUserPrompt(message) {
        return appActions05.resendUserPrompt({ currentSessionIsRunning, enqueuePrompt, setStatus, startChatTurn }, {
            ...message,
            content: promptDisplayMetadata(message.rawContent ?? message.content).visible
        });
    }
    async function openPromptDetails(prompt) {
        setPromptDetails(prompt);
        setTurnDetailsTab("input");
        setTurnRounds({
            turnId: prompt.turnId ?? null,
            status: "idle",
            events: [],
            total: 0,
            hasMore: false,
            error: ""
        });
        const detailSessionId = sessionIdRef.current ?? sessionId;
        if (!detailSessionId || !prompt.turnId) {
            return;
        }
        try {
            const response = await fetch(`/api/sessions/${encodeURIComponent(detailSessionId)}/snapshot`, { cache: "no-store" });
            if (!response.ok) {
                return;
            }
            const snapshot = await response.json();
            const persistedTurn = snapshot.turns?.find((turn) => turn.id === prompt.turnId);
            if (!persistedTurn) {
                return;
            }
            const persistedDeveloperInstructions = Array.isArray(persistedTurn.developerInstructions)
                ? persistedTurn.developerInstructions
                : [];
            setPromptDetails((current) => current?.turnId === prompt.turnId
                ? {
                    ...current,
                    rawContent: typeof persistedTurn.userInput === "string" ? persistedTurn.userInput : current.rawContent,
                    model: typeof persistedTurn.model === "string" ? persistedTurn.model : current.model,
                    reasoningEffort: typeof persistedTurn.reasoningEffort === "string"
                        ? persistedTurn.reasoningEffort
                        : current.reasoningEffort,
                    tokenIn: Number.isFinite(persistedTurn.tokenIn) ? persistedTurn.tokenIn : current.tokenIn,
                    tokenOut: Number.isFinite(persistedTurn.tokenOut) ? persistedTurn.tokenOut : current.tokenOut,
                    executionDurationMs: turnDurationMs({}, persistedTurn) ?? current.executionDurationMs,
                    turnStatus: persistedTurn.status ?? current.turnStatus,
                    developerInstructions: persistedDeveloperInstructions.length > 0
                        ? persistedDeveloperInstructions
                        : current.developerInstructions
                }
                : current);
        }
        catch {
            // The details already show the in-memory prompt if this refresh is unavailable.
        }
    }
    async function loadTurnRounds(loadMore = false) {
        const detailSessionId = sessionIdRef.current ?? sessionId;
        const detailTurnId = promptDetails?.turnId;
        if (!detailSessionId || !detailTurnId) {
            return;
        }
        const current = turnRounds.turnId === detailTurnId
            ? turnRounds
            : { turnId: detailTurnId, status: "idle", events: [], total: 0, hasMore: false, error: "" };
        if (current.status === "loading" || (loadMore && !current.hasMore) || (!loadMore && current.status === "ready")) {
            return;
        }
        const offset = loadMore ? current.events.length : 0;
        setTurnRounds((previous) => previous.turnId === detailTurnId
            ? { ...previous, status: "loading", error: "" }
            : previous);
        try {
            const query = new URLSearchParams({
                sessionId: detailSessionId,
                turnId: detailTurnId,
                eventName: "codex",
                includeEvents: "true",
                eventLimit: "250",
                eventOffset: String(offset),
                order: "asc"
            });
            const response = await fetch(`/api/session-inspector/session?${query.toString()}`, { cache: "no-store" });
            if (!response.ok) {
                throw new Error(`Raw round I/O returned ${response.status}`);
            }
            const payload = await response.json();
            const events = Array.isArray(payload.events) ? payload.events : [];
            const eventPage = payload.eventPage && typeof payload.eventPage === "object" ? payload.eventPage : {};
            setTurnRounds((previous) => {
                if (previous.turnId !== detailTurnId) {
                    return previous;
                }
                const existingIds = new Set(loadMore ? previous.events.map((event) => event.id) : []);
                const mergedEvents = loadMore
                    ? [...previous.events, ...events.filter((event) => !existingIds.has(event.id))]
                    : events;
                return {
                    ...previous,
                    status: "ready",
                    events: mergedEvents,
                    total: Number.isFinite(eventPage.total) ? eventPage.total : mergedEvents.length,
                    hasMore: eventPage.hasMore === true,
                    error: ""
                };
            });
        }
        catch (error) {
            setTurnRounds((previous) => previous.turnId === detailTurnId
                ? {
                    ...previous,
                    status: "error",
                    error: error instanceof Error ? error.message : "Could not load raw round I/O."
                }
                : previous);
        }
    }
    function selectTurnDetailsTab(tab) {
        setTurnDetailsTab(tab);
        if (tab === "rounds") {
            void loadTurnRounds();
        }
    }
    function renderPromptActionButtons(prompt, className = "prompt-turn-actions") {
        const isLatestPrompt = promptTurns.at(-1)?.prompt.id === prompt.id;
        const stop = (event) => event.stopPropagation();
        return (_jsxs("span", { className: className, children: [
                _jsx("button", { className: "message-action-icon", type: "button", title: "Copy prompt", "aria-label": "Copy prompt", onClick: (event) => {
                        stop(event);
                        void copyUserPrompt(prompt);
                    }, children: _jsx(Copy, { "aria-hidden": "true" }) }),
                _jsx("button", { className: "message-action-icon", type: "button", title: "Turn details", "aria-label": "Turn details", onClick: (event) => {
                        stop(event);
                        void openPromptDetails(prompt);
                    }, children: _jsx(FileText, { "aria-hidden": "true" }) }),
                isLatestPrompt && _jsx("button", { className: "message-action-icon", type: "button", title: "Resend prompt", "aria-label": "Resend prompt", disabled: isSteering, onClick: (event) => {
                        stop(event);
                        void resendUserPrompt(prompt);
                    }, children: _jsx(RotateCcw, { "aria-hidden": "true" }) }),
                isLatestPrompt && _jsx("button", { className: "message-action-icon", type: "button", title: "Edit prompt", "aria-label": "Edit prompt", onClick: (event) => {
                        stop(event);
                        startInlineUserPromptEdit(prompt);
                    }, children: _jsx(Pencil, { "aria-hidden": "true" }) })
            ] }));
    }
    function moveQueuedPrompt(promptId, direction) { return appActions05.moveQueuedPrompt({ moveQueuedPromptInList, setQueuedPrompts }, promptId, direction); }
    async function toggleQueuedPromptSteer(promptId) { return appActions05.toggleQueuedPromptSteer({ promoteQueuedPromptToSteer, queuedPromptsRef, setQueuedPrompts, setStatus, steerPrompt }, promptId); }
    function removeQueuedPrompt(promptId) { return appActions05.removeQueuedPrompt({ setQueuedPrompts, setStatus }, promptId); }
    function dropQueuedPrompt(targetPromptId) { return appActions05.dropQueuedPrompt({ draggedQueuedPromptId, moveQueuedPromptToTarget, setDraggedQueuedPromptId, setQueuedPrompts }, targetPromptId); }
    async function editPendingTurn(message) { return appActions05.editPendingTurn({ findUserMessageForTurn, latestMessagesRef, sessionId, setPromptEditor }, message); }
    function editWaitSubscription(subscription) { return appActions05.editWaitSubscription({ pendingPromptForSubscription, setPromptEditor }, subscription); }
    async function removeWaitSubscription(subscription) { return appActions05.removeWaitSubscription({ eventStore, isLikelyBackendDisconnect, noteBackendDisconnect, noteBackendRequestSucceeded, readApiError, setWaitSubscriptionAction, showToast }, subscription); }
    async function savePromptEditor(event) { return appActions05.savePromptEditor({ eventStore, findUserMessageForTurn, isLikelyBackendDisconnect, latestMessagesRef, noteBackendDisconnect, noteBackendRequestSucceeded, promptEditor, scheduleLoadSessions, sessionId, sessionIdRef, setMessages, setPromptEditor, setStatus, setWaitSubscriptionAction, showToast }, event); }
    async function movePendingTurn(turnId, direction) { return appActions05.movePendingTurn({ isLikelyBackendDisconnect, latestMessagesRef, noteBackendDisconnect, noteBackendRequestSucceeded, reorderPendingTurnMessages, scheduleLoadSessions, sessionId, setMessages, setStatus, showToast }, turnId, direction); }
    async function dropPendingTurn(targetTurnId) { return appActions05.dropPendingTurn({ draggedPendingTurnId, latestMessagesRef, movePendingTurn, pendingAssistantMessages, setDraggedPendingTurnId }, targetTurnId); }
    async function reconnectRunner(turnId, assistantMessageId, targetSessionId = sessionIdRef.current, viewKey = viewKeyRef.current) { return appActions05.reconnectRunner({ handleStreamEvent, isLikelyBackendDisconnect, markTurnFinished, markTurnRunning, noteBackendDisconnect, noteBackendRequestSucceeded, prepareAssistantMessageForReplay, readEventStream, reconnectingTurnIdsRef, registerStreamTarget, sleep, streamTargetsRef, unregisterStreamTarget }, turnId, assistantMessageId, targetSessionId, viewKey); }
    function prepareAssistantMessageForReplay(target) { return appActions05.prepareAssistantMessageForReplay({ isTargetVisible, latestMessagesRef, seedReplayTargetFromMessage, setMessages }, target); }
    function readAgentMessageAppendText(target, item) { return appActions05.readAgentMessageAppendText({ consumeReplayText, liveItemKey }, target, item); }
    function seedReplayTargetFromMessage(target, message) { return appActions05.seedReplayTargetFromMessage({ itemEventRank, liveItemKey }, target, message); }
    function consumeReplayText(target, text) { return appActions05.consumeReplayText({  }, target, text); }
    async function addFiles(fileList) { return appActions05.addFiles({ MAX_ATTACHMENTS, attachments, readAttachment, setAttachments, setStatus }, fileList); }
    useReactEffect(() => installGlobalFileDrop(addFiles), [attachments]);
    async function addPastedText(value) { return appActions05.addPastedText({ MAX_ATTACHMENTS, nextPastedTextFileName, readAttachment, setAttachments, setStatus }, value); }
    async function addPastedBrowserBridgeContext(context) { return appActions05.addPastedBrowserBridgeContext({ MAX_ATTACHMENTS, browserBridgeContextAttachmentName, readAttachment, setAttachments, setStatus }, context); }
    async function addPastedTurnIssueContext(context) { return appActions05.addPastedTurnIssueContext({ MAX_ATTACHMENTS, readAttachment, setAttachments, setStatus, turnIssueContextAttachmentName }, context); }
    function removeAttachment(id) { return appActions05.removeAttachment({ setAttachments }, id); }
    function clearComposerSessionLinks() { return appActions05.clearComposerSessionLinks({ composerSessionLinkUrisRef, setComposerSessionLinks }); }
    function removeComposerSessionLink(id) { return appActions05.removeComposerSessionLink({ composerSessionLinkUrisRef, setComposerSessionLinks }, id); }
    function pruneComposerLinks(value) { return appActions05.pruneComposerLinks({ composerSessionLinkUrisRef, setComposerSessionLinks }, value); }
    function addComposerSessionLink(reference) { return appActions05.addComposerSessionLink({ composerSessionLinkUrisRef, displaySessionTitle, setComposerSessionLinks, setStatus, showToast }, reference); }
    function addComposerUrlLink(url) { return appActions05.addComposerUrlLink({ composerSessionLinkUrisRef, setComposerSessionLinks, setStatus, showToast }, url); }
    function addPastedComposerLink(pastedText) { return appActions05.addPastedComposerLink({ addComposerSessionLink, addComposerUrlLink, parseCodexReference, parsePastedHttpUrl }, pastedText); }
    function activateGearProfile(index) { return appActions05.activateGearProfile({ activeGearIndex, modelPreferencesEditRevisionRef, setActiveGearIndex }, index); }
    function updateGearProfile(index, update) { return appActions05.updateGearProfile({ AUTO_MODEL_VALUE, modelPreferencesEditRevisionRef, setGearProfiles, supportsUltraEffort }, index, update); }
    function handleEditorPaste(event) { return appActions05.handleEditorPaste({ MAX_ATTACHMENTS, addFiles, addPastedBrowserBridgeContext, addPastedText, addPastedTurnIssueContext, attachments, parseBrowserBridgeContext, parseTurnIssueContext, setStatus, shouldCompactPastedText }, event); }
    function handleEditorKeyDown(event) { return appActions05.handleEditorKeyDown({ canSend, composerSuggestionIndex, composerSuggestionTrigger, selectComposerSuggestion, selectSlashSuggestion, setComposerSuggestionIndex, setComposerSuggestionTrigger, setSlashSuggestionIndex, setSlashTrigger, slashSuggestionIndex, slashTrigger, visibleComposerSuggestions, visibleSlashSuggestions }, event); }
    function selectSlashSuggestion(suggestion) { return appActions06.selectSlashSuggestion({ capitalize, executionMode, input, inputEditorRef, setComposerExecutionMode, setComposerInput, setSelectedSkills, setSlashTrigger, setStatus, slashTrigger }, suggestion); }
    function selectComposerSuggestion(suggestion) { return appActions06.selectComposerSuggestion({ composerSuggestionTrigger, input, inputEditorRef, setComposerInput, setComposerSuggestionTrigger }, suggestion); }
    function clearInput() { return appActions06.clearInput({ clearComposerInputDraft, inputEditorRef, setComposerResponseQuote, setResponseQuotePopover, setSelectedSkills, setSlashTrigger, setComposerSuggestionTrigger }); }
    function cancelHoveredSessionClose() { return appActions06.cancelHoveredSessionClose({ hoveredSessionCloseTimerRef }); }
    function scheduleHoveredSessionClose() { return appActions06.scheduleHoveredSessionClose({ cancelHoveredSessionClose, hoveredSessionCloseTimerRef, setHoveredSession }); }
    function cancelHoveredProcessMonitorClose() { return appActions06.cancelHoveredProcessMonitorClose({ hoveredProcessMonitorCloseTimerRef }); }
    function scheduleHoveredProcessMonitorClose() { return appActions06.scheduleHoveredProcessMonitorClose({ cancelHoveredProcessMonitorClose, hoveredProcessMonitorCloseTimerRef, setHoveredProcessMonitor }); }
    async function updateTodoItem(itemId, patch) { return appActions06.updateTodoItem({ applyTodoSnapshotForSession, sessionIdRef, setStatus }, itemId, patch); }
    async function createTodoItem(parentId) { return appActions06.createTodoItem({ applyTodoSnapshotForSession, sessionIdRef, setStatus }, parentId); }
    async function setTodoPaused(paused) { return appActions06.setTodoPaused({ applyTodoSnapshotForSession, sessionIdRef, setStatus }, paused); }
    async function setTodoContext(context) { return appActions06.setTodoContext({ applyTodoSnapshotForSession, sessionIdRef, setStatus, visibleSessionTodo }, context); }
    async function addTodoComment(itemId, type, bodyOverride = null) { return appActions06.addTodoComment({ applyTodoSnapshotForSession, sessionIdRef, setStatus }, itemId, type, bodyOverride); }
    async function resolveTodoChallenge(challengeId) { return appActions06.resolveTodoChallenge({ applyTodoSnapshotForSession, sessionIdRef, setStatus }, challengeId); }
    const sessionTitleById = new Map(sessionList.map((session) => [session.id, session.title]));
    const waitEventById = new Map(centralState.waitEvents.map((event) => [event.id, event]));
    const activeWaitRows = centralState.waitSubscriptions.flatMap((subscription) => {
        if (subscription.status !== "waiting" && subscription.status !== "dispatching" && subscription.status !== "error") {
            return [];
        }
        const event = waitEventById.get(subscription.eventId);
        return event ? [{ subscription, event }] : [];
    });
    const activeWaitCount = activeWaitRows.length;
    const annotationSessionTarget = threadId ?? sessionId;
    const fileAnnotationContextValue = useMemo(() => ({
        activeAnnotation: composerResponseQuote,
        sessionId,
        workspaceId: activeWorkspace?.id,
        sessionUrl: activeWorkspace?.id && annotationSessionTarget
            ? buildCodexReference(activeWorkspace.id, annotationSessionTarget)
            : undefined,
        askAboutFileAnnotation,
        removeFileAnnotation
    }), [
        activeWorkspace?.id,
        annotationSessionTarget,
        askAboutFileAnnotation,
        composerResponseQuote,
        removeFileAnnotation,
        sessionId
    ]);
    const effectiveFeaturedPromptTurnId = currentRunningTurnId ?? featuredPromptTurnId;
    function renderMessageArticle(message) {
        const isPendingAssistant = message.role === "assistant" && message.turnStatus === "todo" && Boolean(message.turnId);
        const userPromptMetadata = message.role === "user"
            ? promptDisplayMetadata(message.rawContent ?? message.content)
            : null;
        const responseAnnotations = message.role === "user" ? parseResponseAnnotations(userPromptMetadata.visible) : null;
        const visibleMessageContent = responseAnnotations?.content ?? userPromptMetadata?.visible ?? message.content;
        const canReuseUserPrompt = message.role === "user" &&
            message.kind !== "steer" &&
            (message.content.trim().length > 0 || (message.attachments?.length ?? 0) > 0);
        const isEditingUserPrompt = inlinePromptEditor?.messageId === message.id;
        const turnNumber = message.turnId ? turnNumberById.get(message.turnId) : undefined;
        const timingLabel = messageTimingLabel(message, clockNow);
        const userTimingLabel = message.role === "user" ? timingLabel : "";
        const assistantActionTimingLabel = message.role === "assistant" && message.turnStatus === "done" ? timingLabel : "";
        const messageTimestamp = message.role === "user" || assistantActionTimingLabel ? "" : timingLabel;
        const firstUserMessageId = messages.find((candidate) => candidate.role === "user" && candidate.kind !== "steer")?.id;
        const startupSnapshot = message.id === firstUserMessageId ? message.startupSnapshot : undefined;
        const steerMessages = message.turnId
            ? messages.filter((candidate) => candidate.role === "user" && candidate.kind === "steer" && candidate.turnId === message.turnId)
            : [];
        const promptTurnIndex = message.turnId ? promptTurns.findIndex((turn) => turn.prompt.turnId === message.turnId) : -1;
        const associatedPrompt = promptTurnIndex >= 0 ? promptTurns[promptTurnIndex].prompt : null;
        const associatedPromptMetadata = associatedPrompt
            ? promptDisplayMetadata(associatedPrompt.rawContent ?? associatedPrompt.content)
            : null;
        const associatedPromptAnnotations = associatedPromptMetadata ? parseResponseAnnotations(associatedPromptMetadata.visible) : null;
        const turnAccent = promptTurnIndex >= 0 ? `var(--turn-accent-${(promptTurnIndex % 6) + 1})` : undefined;
        const isFeaturedPromptTurn = effectiveFeaturedPromptTurnId === message.turnId;
        const turnPromptPadding = promptTurnIndex >= 0
            ? isFeaturedPromptTurn ? "16px" : "calc(16px + 4em)"
            : undefined;
        return (_jsx("article", { className: `message ${message.role}`, style: turnAccent ? { "--turn-accent": turnAccent, "--turn-prompt-padding": turnPromptPadding } : undefined, onClick: (event) => {
                if (!event.target.closest("summary")) {
                    return;
                }
                // Once the user opens/collapses a detail panel, preserve that viewport
                // instead of forcing the live transcript back to its bottom on updates.
                stickToMessageBottomRef.current = false;
                if (messagesRef.current) {
                    messageScrollTopRef.current = messagesRef.current.scrollTop;
                }
            }, "data-dragging": isPendingAssistant && draggedPendingTurnId === message.turnId ? "true" : undefined, "data-message-id": message.id, "data-message-timestamp": messageTimestamp || undefined, "data-turn-id": message.turnId, "data-turn-number": turnNumber, draggable: isPendingAssistant, onDragStart: isPendingAssistant
                ? () => setDraggedPendingTurnId(message.turnId ?? null)
                : undefined, onDragOver: isPendingAssistant
                ? (event) => {
                    event.preventDefault();
                }
                : undefined, onDrop: isPendingAssistant
                ? (event) => {
                    event.preventDefault();
                    void dropPendingTurn(message.turnId);
                }
                : undefined, onDragEnd: isPendingAssistant ? () => setDraggedPendingTurnId(null) : undefined, ref: (element) => {
                messageElementsRef.current[message.id] = element;
            }, children: _jsxs("div", { className: "message-content", children: [
message.role === "assistant" && associatedPrompt && (_jsxs("div", { className: "agent-turn-prompt", children: [associatedPrompt.attachments && associatedPrompt.attachments.length > 0 && _jsx(AttachmentList, { attachments: associatedPrompt.attachments }), associatedPromptAnnotations && _jsx(ResponseAnnotationList, { annotations: associatedPromptAnnotations.annotations }), _jsx(MarkdownContent, { children: associatedPromptAnnotations?.content || associatedPromptMetadata?.visible || "Attachment prompt" }), _jsxs("div", { className: "agent-turn-prompt-footer", children: [renderPromptTags(associatedPrompt), renderPromptActionButtons(associatedPrompt, "prompt-turn-actions agent-turn-prompt-actions")] })] })),
message.turnStatus === "todo" && (_jsx("span", { className: "turn-status", children: "Todo" })), message.role === "user" && renderPromptTags(message), message.role === "user" && (_jsx(ServerPrefixPanels, { startupSnapshot: startupSnapshot, developerInstructions: message.developerInstructions, showStartup: message.id === firstUserMessageId })), message.attachments && message.attachments.length > 0 && _jsx(AttachmentList, { attachments: message.attachments }), responseAnnotations && !isEditingUserPrompt && _jsx(ResponseAnnotationList, { annotations: responseAnnotations.annotations }), message.role === "assistant" && message.turnStatus === "done" && message.turnId ? (_jsx(CompletedTurn, { message: message, codexSessionId: threadId, sessionId: sessionId, steerMessages: steerMessages, workspaceId: activeWorkspace?.id })) : shouldRenderMessageTimeline(message) ? (_jsx(MessageTimeline, { anchorPrefix: message.id, completed: message.turnStatus === "done", running: message.turnStatus === "running", statusText: message.runnerStarted === false ? "Connecting" : undefined, segments: message.segments ?? [], codexSessionId: threadId, sessionId: sessionId, turnId: message.turnId, workspaceId: activeWorkspace?.id })) : (_jsxs(_Fragment, { children: [isEditingUserPrompt ? (_jsxs("form", { className: "user-prompt-inline-editor", onSubmit: (event) => void submitInlineUserPromptEdit(event, message), children: [_jsx("textarea", { ref: inlinePromptEditorRef, className: "composer-editor", "aria-label": "Edit prompt", value: inlinePromptEditor?.value ?? "", onChange: (event) => {
                                    const value = event.currentTarget.value;
                                    setInlinePromptEditor((current) => current?.messageId === message.id ? { ...current, value } : current);
                                }, onKeyDown: (event) => handleInlinePromptEditorKeyDown(event, message) }), _jsxs("div", { className: "user-prompt-inline-actions", children: [_jsx("button", { className: "message-action-icon", type: "button", title: "Cancel edit", "aria-label": "Cancel edit", onClick: cancelInlineUserPromptEdit, children: _jsx(X, { "aria-hidden": "true" }) }), _jsx("button", { className: "message-action-icon", type: "submit", title: "Resend edited prompt", "aria-label": "Resend edited prompt", disabled: !(inlinePromptEditor?.value.trim() || (inlinePromptEditor?.attachments.length ?? 0) > 0) || isSteering, children: _jsx(Send, { "aria-hidden": "true" }) })] })] })) : visibleMessageContent ? (_jsx(MarkdownContent, { children: visibleMessageContent })) : (!message.liveItems?.length && !responseAnnotations && _jsx(StatusUpdateIndicator, { text: "Waiting for Codex..." })), message.liveItems && message.liveItems.length > 0 && (_jsx(LiveEventList, { anchorPrefix: message.id, items: message.liveItems }))] })), message.pending && _jsx("span", { className: "cursor", "aria-hidden": "true" }), canReuseUserPrompt && !isEditingUserPrompt && (_jsxs("div", { className: "message-actions user-prompt-actions", children: [userTimingLabel && _jsx("span", { className: "message-inline-timestamp", children: userTimingLabel }), _jsx("button", { className: "message-action-icon", type: "button", title: "Resend prompt", "aria-label": "Resend prompt", disabled: isSteering, onClick: () => void resendUserPrompt(message), children: _jsx(RotateCcw, { "aria-hidden": "true" }) }), _jsx("button", { className: "message-action-icon", type: "button", title: "Edit prompt", "aria-label": "Edit prompt", onClick: () => startInlineUserPromptEdit(message), children: _jsx(Pencil, { "aria-hidden": "true" }) })] })), isPendingAssistant && (_jsxs("div", { className: "message-actions pending-turn-actions", children: [_jsx("button", { className: "message-action-icon", type: "button", title: "Edit queued prompt", "aria-label": "Edit queued prompt", onClick: () => void editPendingTurn(message), children: _jsx(Pencil, { "aria-hidden": "true" }) }), _jsx("button", { className: "message-action-icon", type: "button", title: "Move queued prompt up", "aria-label": "Move queued prompt up", onClick: () => void movePendingTurn(message.turnId, "up"), children: _jsx(ArrowUp, { "aria-hidden": "true" }) }), _jsx("button", { className: "message-action-icon", type: "button", title: "Move queued prompt down", "aria-label": "Move queued prompt down", onClick: () => void movePendingTurn(message.turnId, "down"), children: _jsx(ArrowDown, { "aria-hidden": "true" }) })] })), message.role === "assistant" && message.turnId && message.turnStatus === "done" && _jsx(TurnGrillPanel, { actionExtras: [assistantActionTimingLabel && _jsx("span", { className: "message-inline-timestamp", children: assistantActionTimingLabel }), _jsx("button", { className: "message-action-icon", type: "button", title: "Fork from this message", "aria-label": "Fork from this message", disabled: currentSessionIsRunning || forkingTurnId === message.turnId, onClick: () => void forkFromAgentMessage(message), children: forkingTurnId === message.turnId ? (_jsx(Loader2, { className: "spin", "aria-hidden": "true" })) : (_jsx(GitFork, { "aria-hidden": "true" })) })], onGrilled: markGrilled, sessionId, turnId: message.turnId, latest: messages.filter((item) => item.turnId).at(-1)?.turnId === message.turnId, mainBusy: currentSessionIsRunning, onImplement: async (prompt, origin) => { if (sessionIdRef.current !== sessionId) throw new Error("Return to the original thread before starting work."); await startChatTurn(prompt, [], executionMode, [], false, false, false, origin); } }, `${sessionId}:${message.turnId}`)] }) }, message.id));
    }
    function renderSessionTreeNode(node) {
        const record = node.record;
        const executionStatus = getSessionExecutionStatus(record.id, sessionExecutionStatuses, pendingApprovalSessionIdSet);
        const executionAccount = record.accountId
            ? accountList.find((account) => account.id === record.accountId) ?? { id: record.accountId }
            : null;
        const executionAccountLabel = executionAccount ? accountIdentityLabel(executionAccount) : "Not recorded";
        const sessionApprovals = pendingApprovalItems.filter((item) => item.sessionId === record.id);
        const keywords = Object.keys(record.keywordWeights ?? {});
        const modelTokenUsage = record.modelTokenUsage ?? [];
        const isAchievingGoal = achievingSessionIds.has(record.id);
        const canAchieveGoal = Boolean(record.threadId) && executionStatus === "completed" && !isAchievingGoal;
        return (_jsxs("div", { className: "session-tree-node", "data-depth": node.depth, style: { "--session-tree-depth": node.depth }, children: [_jsxs("div", { className: "session-list-item", onMouseEnter: (event) => {
                        cancelHoveredSessionClose();
                        const bounds = event.currentTarget.getBoundingClientRect();
                        setHoveredSession({
                            id: record.id,
                            position: sessionPopoverPosition(bounds, sessionApprovals.some((item) => item.method === "item/tool/requestUserInput") ? 420 : 360)
                        });
                    }, onMouseLeave: scheduleHoveredSessionClose, children: [_jsx("input", { className: "session-selection-checkbox", type: "checkbox", checked: selectedSessionIds.has(record.id), onChange: () => toggleSessionSelection(record.id), "aria-label": `Select ${displaySessionTitle(record.title)}` }), _jsxs("button", { className: "session-row", "data-session-id": record.id, "data-grill-await-ack": pendingGrillSessions.has(record.id) || undefined, title: pendingGrillSessions.has(record.id) ? "Grill: Await ack" : undefined, type: "button", onClick: () => void switchSession(record), onFocus: (event) => {
                                cancelHoveredSessionClose();
                                const bounds = event.currentTarget.getBoundingClientRect();
                                setHoveredSession({
                                    id: record.id,
                                    position: sessionPopoverPosition(bounds, sessionApprovals.some((item) => item.method === "item/tool/requestUserInput") ? 420 : 360)
                                });
                            }, onBlur: (event) => {
                                if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) {
                                    scheduleHoveredSessionClose();
                                }
}, disabled: record.id === sessionId, "data-active": record.id === sessionId || record.id === activeSessionId, "data-child-session": node.depth > 0 ? "true" : undefined, children: [_jsx("span", { className: "session-status-indicator", "data-status": executionStatus, "aria-hidden": "true", children: executionStatus === "running" ? _jsx(Loader2, { className: "spin" }) : _jsx(Circle, {}) }), _jsx("span", { className: "session-title", children: displaySessionTitle(record.title) }), _jsx("span", { className: "thread-time", children: formatTimestampShort(record.updated) })] }), hoveredSession?.id === record.id && sessionApprovals.length > 0 ? (_jsx("div", { className: `approval-mini-popover${sessionApprovals.some((item) => item.method === "item/tool/requestUserInput") ? " user-input-mini-popover" : ""}`, role: "dialog", "aria-label": "Session action requested", style: { ...hoveredSession.position, overflowY: "auto" }, onMouseEnter: cancelHoveredSessionClose, children: sessionApprovals.map((item) => (_jsx(ApprovalEvent, { compact: true, item: item, onDecisionSubmitted: removePendingApprovalItem }, item.approvalId))) })) : hoveredSession?.id === record.id ? (_jsxs("section", { className: "thread-status-popover", role: "dialog", "aria-label": "Session details", style: { ...hoveredSession.position, overflowY: "auto" }, onMouseEnter: cancelHoveredSessionClose, children: [_jsxs("div", { className: "thread-status-popover-header", children: [_jsx("span", { className: "session-status-indicator", "data-status": executionStatus, "aria-hidden": "true", children: executionStatus === "running" ? _jsx(Loader2, { className: "spin" }) : _jsx(Circle, {}) }), _jsx("strong", { children: sessionExecutionStatusLabel(executionStatus) }), _jsx("button", { className: "thread-status-achieve", type: "button", title: canAchieveGoal ? "Achieve session" : record.threadId ? "Goal can be achieved when the session is idle" : "Session has no Codex thread", "aria-label": "Achieve session", disabled: !canAchieveGoal, onClick: (event) => {
                                                    event.preventDefault();
                                                    event.stopPropagation();
                                                    void achieveSessionGoal(record);
}, children: isAchievingGoal ? _jsx(Loader2, { className: "spin", "aria-hidden": "true" }) : _jsx(CheckCircle2, { "aria-hidden": "true" }) })] }), _jsx("span", { className: "thread-status-title", children: displaySessionTitle(record.title) }), _jsxs("div", { className: "thread-status-meta", children: [_jsx(Database, { "aria-hidden": "true" }), _jsx("span", { className: "thread-status-meta-value", children: record.id }), _jsx("button", { className: "thread-status-copy", type: "button", title: `Copy ${buildCodexReference(record.workspaceId, record.id)}`, "aria-label": `Copy ${buildCodexReference(record.workspaceId, record.id)}`, onClick: () => void copySessionReference(record.workspaceId, record.id), children: _jsx(Copy, { "aria-hidden": "true" }) })] }), _jsxs("div", { className: "thread-status-meta", children: [_jsx(Folder, { "aria-hidden": "true" }), _jsx("span", { children: record.cwd })] }), _jsxs("div", { className: "thread-status-meta", children: [_jsx(TerminalSquare, { "aria-hidden": "true" }), _jsx("span", { className: "thread-status-meta-value", children: record.threadId ?? "No Codex thread" }), record.threadId && (_jsx("button", { className: "thread-status-copy", type: "button", title: `Copy ${buildCodexReference(record.workspaceId, record.threadId)}`, "aria-label": `Copy ${buildCodexReference(record.workspaceId, record.threadId)}`, onClick: () => void copySessionReference(record.workspaceId, record.threadId), children: _jsx(Copy, { "aria-hidden": "true" }) }))] }), modelTokenUsage.length > 0 && (_jsxs("div", { className: "thread-status-meta thread-status-token-usage", children: [_jsx(Cpu, { "aria-hidden": "true" }), _jsxs("div", { className: "thread-status-token-list", children: [_jsx("span", { className: "thread-status-token-label", children: "Tokens used" }), modelTokenUsage.map((usage) => (_jsxs("span", { className: "thread-status-token-model", children: [_jsx("span", { children: usage.model }), _jsx("strong", { children: `In ${formatTokenCount(usage.inputTokenCount)} · Cached ${formatTokenCount(usage.cachedInputTokenCount)} · Out ${formatTokenCount(usage.outputTokenCount)}` })] }, `${record.id}:${usage.model}`)))] })] })), _jsxs("div", { className: "thread-status-meta", children: [_jsx(User, { "aria-hidden": "true" }), _jsxs("span", { title: record.accountId ?? undefined, children: ["Exec account: ", executionAccountLabel] })] }), _jsxs("div", { className: "thread-status-meta", children: [_jsx(Clock3, { "aria-hidden": "true" }), _jsxs("span", { children: ["Updated ", formatTimestamp(record.updated)] })] }), keywords.length > 0 && (_jsx("div", { className: "thread-status-keyword-list", children: keywords.map((keyword) => (_jsx("span", { children: keyword }, `${record.id}:${keyword}`))) }))] })) : null] }), node.children.length > 0 && (_jsx("div", { className: "session-tree-children", children: node.children.map((child) => renderSessionTreeNode(child)) }))] }, record.id));
    }
    function renderAccountLoginModal() {
        const title = accountLoginTargetId ? "Login account" : "Add account";
        const tabs = _jsxs("div", { className: "account-login-tabs", role: "tablist", "aria-label": "Account login method", children: [_jsx("button", { type: "button", role: "tab", "aria-selected": accountLoginMode === "api", "data-active": accountLoginMode === "api", onClick: () => {
                        setAccountLoginMode("api");
                        setPendingAccountLogin(null);
                    }, children: "API setting" }), _jsx("button", { type: "button", role: "tab", "aria-selected": accountLoginMode === "chatgpt", "data-active": accountLoginMode === "chatgpt", onClick: () => {
                        setAccountLoginMode("chatgpt");
                        setPendingAccountLogin(null);
                    }, children: "ChatGPT login" })] });
        const apiForm = _jsxs("form", { className: "account-login-form", onSubmit: (event) => void createApiAccount(event), children: [_jsxs("label", { children: [_jsx("span", { children: "Account name" }), _jsx("input", { value: newAccountName, onChange: (event) => setNewAccountName(event.target.value), placeholder: "Work API", autoFocus: true })] }), _jsxs("label", { children: [_jsx("span", { children: "API URL" }), _jsx("input", { value: apiAccountUrl, onChange: (event) => setApiAccountUrl(event.target.value), placeholder: "https://api.openai.com/v1" })] }), _jsxs("label", { children: [_jsx("span", { children: "API key" }), _jsx("input", { value: apiAccountKey, onChange: (event) => setApiAccountKey(event.target.value), type: "password", placeholder: "sk-..." })] }), _jsxs("div", { className: "account-login-actions", children: [_jsx("button", { className: "secondary", type: "button", onClick: () => void importCurrentAccount(), children: "Use workspace auth" }), _jsxs("button", { className: "secondary primary", type: "submit", disabled: !newAccountName.trim() || !apiAccountKey.trim() || isSavingAccount, children: [isSavingAccount ? _jsx(Loader2, { className: "spin", "aria-hidden": "true" }) : _jsx(UserPlus, { "aria-hidden": "true" }), "Save API account"] })] })] });
        const chatGptForm = _jsxs("div", { className: "account-login-form", children: [_jsxs("label", { children: [_jsx("span", { children: "Account name" }), _jsx("input", { value: newAccountName, onChange: (event) => setNewAccountName(event.target.value), placeholder: "ChatGPT Pro", autoFocus: true })] }), pendingAccountLogin ? (_jsxs("div", { className: "login-link-panel", children: [_jsx("span", { children: "Login link" }), _jsx("a", { href: pendingAccountLogin.loginUrl, target: "_blank", rel: "noreferrer", children: pendingAccountLogin.loginUrl }), pendingAccountLogin.userCode && (_jsxs("div", { className: "device-code-row", children: [_jsx("span", { children: "Device code" }), _jsx("strong", { children: pendingAccountLogin.userCode }), _jsx("button", { className: "secondary", type: "button", onClick: () => void navigator.clipboard?.writeText(pendingAccountLogin.userCode ?? ""), children: "Copy" })] })), !pendingAccountLogin.userCode && _jsx("span", { children: "Complete sign-in in the browser. This page will update automatically." })] })) : null, _jsxs("div", { className: "account-login-actions", children: [_jsx("button", { className: "secondary", type: "button", onClick: () => void importCurrentAccount(), children: "Use workspace auth" }), _jsxs("button", { className: "secondary", type: "button", onClick: () => void startChatGptLogin(), disabled: !newAccountName.trim() || isSavingAccount || Boolean(pendingAccountLogin), children: [isSavingAccount && !pendingAccountLogin ? _jsx(Loader2, { className: "spin", "aria-hidden": "true" }) : _jsx(UserPlus, { "aria-hidden": "true" }), "Sign in with ChatGPT"] })] })] });
        return (_jsx("div", { className: "modal-backdrop account-login-backdrop", role: "presentation", onMouseDown: () => resetAccountLoginDialog(), children: _jsxs("section", { className: "account-login-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "account-login-modal-title", onMouseDown: (event) => event.stopPropagation(), children: [_jsxs("div", { className: "settings-card-header account-login-modal-header", children: [_jsxs("div", { children: [_jsx("h3", { id: "account-login-modal-title", children: title }), _jsx("p", { children: "Save an API credential or connect a ChatGPT account." })] }), _jsx("button", { className: "ghost-icon", type: "button", onClick: () => resetAccountLoginDialog(), title: "Close", "aria-label": "Close", children: _jsx(X, { "aria-hidden": "true" }) })] }), tabs, accountLoginMode === "api" ? apiForm : chatGptForm] }) }));
    }
    function renderPromptDetailsModal() {
        if (!promptDetails) {
            return null;
        }
        const developerInstructions = promptDetails.developerInstructions ?? [];
        const rawPrompt = promptDetails.rawContent ?? promptDetails.content;
        const hasTokenUsage = Number.isFinite(promptDetails.tokenIn) || Number.isFinite(promptDetails.tokenOut);
        const tokenIn = Number.isFinite(promptDetails.tokenIn) ? promptDetails.tokenIn : 0;
        const tokenOut = Number.isFinite(promptDetails.tokenOut) ? promptDetails.tokenOut : 0;
        const tokenSummary = hasTokenUsage
            ? `In ${formatTokenCount(tokenIn)} · out ${formatTokenCount(tokenOut)} · total ${formatTokenCount(tokenIn + tokenOut)}`
            : "Not recorded";
        return (_jsx("div", { className: "modal-backdrop prompt-details-backdrop", role: "presentation", onMouseDown: () => setPromptDetails(null), children: _jsxs("section", { className: "prompt-details-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "prompt-details-title", onMouseDown: (event) => event.stopPropagation(), onKeyDown: (event) => {
                    if (event.key === "Escape") {
                        setPromptDetails(null);
                    }
                }, children: [_jsxs("div", { className: "modal-header", children: [_jsx("h2", { id: "prompt-details-title", children: "Turn details" }), _jsx("button", { className: "ghost-icon", type: "button", onClick: () => setPromptDetails(null), title: "Close turn details", "aria-label": "Close turn details", autoFocus: true, children: _jsx(X, { "aria-hidden": "true" }) })] }), _jsxs("div", { className: "prompt-details-content", children: [_jsxs("section", { className: "prompt-details-summary", "aria-label": "Run details", children: [_jsxs("div", { className: "prompt-details-stat", children: [_jsx("span", { children: "Run time" }), _jsx("strong", { children: formatPromptExecutionDuration(promptDetails.executionDurationMs, promptDetails.turnStatus === "running") })] }), _jsxs("div", { className: "prompt-details-stat", children: [_jsx("span", { children: "Tokens" }), _jsx("strong", { children: tokenSummary })] }), _jsxs("div", { className: "prompt-details-stat", children: [_jsx("span", { children: "Model" }), _jsx("strong", { children: promptDetails.model || "Not recorded" })] }), _jsxs("div", { className: "prompt-details-stat", children: [_jsx("span", { children: "Effort" }), _jsx("strong", { children: promptDetails.reasoningEffort || "Not recorded" })] })] }), _jsxs("section", { className: "prompt-details-section", children: [_jsx("h3", { children: "Raw prompt" }), _jsx("pre", { children: rawPrompt || "Attachment-only prompt" })] }), _jsxs("section", { className: "prompt-details-section", children: [_jsx("h3", { children: "Developer instructions" }), developerInstructions.length > 0 ? developerInstructions.map((instruction, index) => (_jsxs("article", { className: "prompt-details-instruction", children: [_jsxs("header", { children: [_jsxs("strong", { children: ["Instruction ", index + 1] }), _jsx("small", { children: [instruction.target || "turn", instruction.phase === null || instruction.phase === undefined ? "" : ` · phase ${instruction.phase}`].filter(Boolean).join("") })] }), _jsx(MarkdownContent, { className: "prompt-details-instruction-content", children: instruction.developerInstructions })] }, `${promptDetails.id}:developer:${index}`))) : _jsx("p", { className: "prompt-details-empty", children: "No developer instructions were recorded for this prompt." })] })] })] }) }));
    }
    function renderTurnDetailsModal() {
        if (!promptDetails) {
            return null;
        }
        const developerInstructions = promptDetails.developerInstructions ?? [];
        const rawPrompt = promptDetails.rawContent ?? promptDetails.content;
        const inputTokenCount = Number.isFinite(promptDetails.tokenIn) ? formatTokenCount(promptDetails.tokenIn) : "Not recorded";
        const outputTokenCount = Number.isFinite(promptDetails.tokenOut) ? formatTokenCount(promptDetails.tokenOut) : "Not recorded";
        const tabIdBase = `turn-details-${promptDetails.turnId ?? promptDetails.id}`;
        const roundsAvailable = Boolean(promptDetails.turnId);
        const roundsJson = JSON.stringify(turnRounds.events, null, 2);
        return (
            <div className="modal-backdrop prompt-details-backdrop" role="presentation" onMouseDown={() => setPromptDetails(null)}>
                <section
                    className="prompt-details-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="prompt-details-title"
                    onMouseDown={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") setPromptDetails(null);
                    }}
                >
                    <div className="modal-header">
                        <h2 id="prompt-details-title">Turn details</h2>
                        <button className="ghost-icon" type="button" onClick={() => setPromptDetails(null)} title="Close turn details" aria-label="Close turn details" autoFocus>
                            <X aria-hidden="true" />
                        </button>
                    </div>
                    <div className="prompt-details-content">
                        <section className="prompt-details-summary" aria-label="Run details">
                            <div className="prompt-details-stat"><span>Run time</span><strong>{formatPromptExecutionDuration(promptDetails.executionDurationMs, promptDetails.turnStatus === "running")}</strong></div>
                            <div className="prompt-details-stat"><span>Input tokens</span><strong>{inputTokenCount}</strong></div>
                            <div className="prompt-details-stat"><span>Output tokens</span><strong>{outputTokenCount}</strong></div>
                            <div className="prompt-details-stat"><span>Model</span><strong>{promptDetails.model || "Not recorded"}</strong></div>
                            <div className="prompt-details-stat"><span>Effort</span><strong>{promptDetails.reasoningEffort || "Not recorded"}</strong></div>
                        </section>
                        <div className="prompt-details-tabs" role="tablist" aria-label="Turn details">
                            <button
                                id={`${tabIdBase}-input-tab`}
                                className="prompt-details-tab"
                                type="button"
                                role="tab"
                                aria-selected={turnDetailsTab === "input"}
                                aria-controls={`${tabIdBase}-input-panel`}
                                onClick={() => selectTurnDetailsTab("input")}
                            >
                                Input
                            </button>
                            <button
                                id={`${tabIdBase}-rounds-tab`}
                                className="prompt-details-tab"
                                type="button"
                                role="tab"
                                aria-selected={turnDetailsTab === "rounds"}
                                aria-controls={`${tabIdBase}-rounds-panel`}
                                onClick={() => selectTurnDetailsTab("rounds")}
                            >
                                Rounds
                            </button>
                        </div>
                        {turnDetailsTab === "input" ? (
                            <div id={`${tabIdBase}-input-panel`} className="prompt-details-input-content" role="tabpanel" aria-labelledby={`${tabIdBase}-input-tab`}>
                                <section className="prompt-details-section">
                                    <h3>User prompt</h3>
                                    <pre>{rawPrompt || "Attachment-only prompt"}</pre>
                                </section>
                                <section className="prompt-details-section">
                                    <h3>Developer instructions</h3>
                                    {developerInstructions.length > 0 ? developerInstructions.map((instruction, index) => (
                                        <article className="prompt-details-instruction" key={`${promptDetails.id}:developer:${index}`}>
                                            <header>
                                                <strong>Instruction {index + 1}</strong>
                                                <small>{[instruction.target || "turn", instruction.phase === null || instruction.phase === undefined ? "" : ` · phase ${instruction.phase}`].filter(Boolean).join("")}</small>
                                            </header>
                                            <MarkdownContent className="prompt-details-instruction-content">{instruction.developerInstructions}</MarkdownContent>
                                        </article>
                                    )) : <p className="prompt-details-empty">No developer instructions were recorded for this prompt.</p>}
                                </section>
                            </div>
                        ) : (
                            <section id={`${tabIdBase}-rounds-panel`} className="prompt-details-rounds" role="tabpanel" aria-labelledby={`${tabIdBase}-rounds-tab`}>
                                {!roundsAvailable ? <p className="prompt-details-empty">Raw round I/O is unavailable until this prompt has a turn ID.</p> : (
                                    <>
                                        <header className="prompt-details-rounds-header">
                                            <div>
                                                <h3>Raw round I/O</h3>
                                                <p>{turnRounds.total > 0 ? `Showing ${turnRounds.events.length.toLocaleString()} of ${turnRounds.total.toLocaleString()} recorded Codex events.` : "Recorded Codex events are loaded on demand."}</p>
                                            </div>
                                            {turnRounds.hasMore && <button type="button" onClick={() => void loadTurnRounds(true)} disabled={turnRounds.status === "loading"}>Load more</button>}
                                        </header>
                                        {turnRounds.status === "loading" && turnRounds.events.length === 0 ? <p className="prompt-details-empty">Loading raw round I/O…</p> : null}
                                        {turnRounds.status === "error" ? <div className="prompt-details-rounds-error" role="alert"><span>{turnRounds.error}</span><button type="button" onClick={() => void loadTurnRounds()}>Retry</button></div> : null}
                                        {turnRounds.status === "ready" && turnRounds.events.length === 0 ? <p className="prompt-details-empty">No raw Codex events were recorded for this turn.</p> : null}
                                        {turnRounds.events.length > 0 ? <pre className="prompt-details-rounds-json" aria-label="Raw round I/O JSON">{roundsJson}</pre> : null}
                                    </>
                                )}
                            </section>
                        )}
                    </div>
                </section>
            </div>
        );
    }
    const pendingCommandApprovals = pendingApprovalItems.filter((item) => item.method !== "item/tool/requestUserInput");
    const commandApprovalModal = pendingCommandApprovals.length > 0 ? (_jsx("div", { className: "modal-backdrop approval-backdrop", role: "presentation", children: _jsxs("section", { className: "approval-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "approval-modal-title", onMouseDown: (event) => event.stopPropagation(), children: [_jsxs("div", { className: "modal-header", children: [_jsx("h2", { id: "approval-modal-title", children: "Approval required" }), _jsx("span", { children: pendingCommandApprovals.length })] }), _jsx("div", { className: "approval-modal-list", children: pendingCommandApprovals.map((item) => (_jsx(ApprovalEvent, { item: item, onDecisionSubmitted: removePendingApprovalItem }, item.approvalId))) })] }) })) : null;
    const approvalModal = commandApprovalModal;
    const promptDetailsModal = _jsxs(_Fragment, { children: [renderTurnDetailsModal(), _jsx(SessionChangesPopover, { sessionId: sessionId })] });
    return (_jsx(FileAnnotationComposerContext.Provider, { value: fileAnnotationContextValue, children: _jsxs("main", { className: "shell", children: [approvalModal, promptDetailsModal, _jsxs("header", { className: "workspace-header", "aria-label": "Workspaces", children: [_jsxs("div", { className: "workspace-tabs", role: "tablist", "aria-label": "Workspaces", children: [workspaceList.length === 0 && (_jsxs("span", { className: "workspace-tab", "data-active": "true", children: [_jsx(Folder, { "aria-hidden": "true" }), _jsx("span", { children: "Default" })] })), workspaceList.map((workspace) => {
                                    const isActive = workspace.id === activeWorkspace?.id;
                                    const summary = getWorkspaceTabSummary(workspace.id, isActive, workspaceStatusById, sessionList, sessionExecutionStatuses, isActive ? activeWorkspacePendingApprovalSessionIdSet : pendingApprovalSessionIdSet);
                                    return (_jsxs("div", { className: "workspace-tab-wrap", onMouseEnter: (event) => {
                                            if (isActive || summary.sessions.length === 0)
                                                return;
                                            const bounds = event.currentTarget.getBoundingClientRect();
                                            setHoveredWorkspace({
                                                id: workspace.id,
                                                top: bounds.bottom - 1,
                                                left: Math.max(8, Math.min(bounds.left, window.innerWidth - 368))
                                            });
                                        }, onMouseLeave: () => setHoveredWorkspace(null), children: [_jsxs("button", { className: "workspace-tab", type: "button", role: "tab", "aria-selected": isActive, "data-active": isActive, "data-status": summary.status, onClick: () => void switchWorkspace(workspace.id), children: [_jsx("span", { className: "workspace-tab-status", "aria-hidden": "true", children: summary.status === "running" ? _jsx(Loader2, { className: "spin" }) : _jsx(Circle, {}) }), _jsx("span", { className: "workspace-tab-name", children: workspace.name }), summary.sessions.length > 0 && (_jsx("span", { className: "workspace-tab-count", title: `${summary.sessions.length} active session${summary.sessions.length === 1 ? "" : "s"}${summary.approvalCount > 0 ? `, ${summary.approvalCount} approval required` : ""}`, children: summary.sessions.length > 99 ? "99+" : summary.sessions.length }))] }), hoveredWorkspace?.id === workspace.id && summary.sessions.length > 0 && (_jsxs("section", { className: "workspace-status-popover", role: "tooltip", style: { top: hoveredWorkspace.top, left: hoveredWorkspace.left }, children: [_jsx("strong", { children: workspace.name }), _jsxs("span", { className: "workspace-status-summary", children: [summary.sessions.length, " background session", summary.sessions.length === 1 ? "" : "s"] }), _jsx("div", { className: "workspace-status-sessions", children: summary.sessions.map((backgroundSession) => (_jsxs("div", { className: "workspace-status-session-group", children: [_jsxs("div", { className: "workspace-status-session", children: [_jsx("span", { className: "session-status-indicator", "data-status": backgroundSession.approvalCount > 0 ? "awaiting_approval" : "running", "aria-hidden": "true", children: backgroundSession.approvalCount > 0 ? _jsx(Circle, {}) : _jsx(Loader2, { className: "spin" }) }), _jsx("span", { children: backgroundSession.name }), backgroundSession.approvalCount > 0 && (_jsxs("small", { children: [backgroundSession.approvalCount, " approval"] }))] }), backgroundSession.approvals.map((approval) => (_jsx(ApprovalEvent, { item: approvalEventToLiveItem(approval, "pending"), onDecisionSubmitted: removePendingApprovalItem }, approval.approvalId)))] }, backgroundSession.id))) })] }))] }, workspace.id));
                                })] }), _jsx("button", { className: "ghost-icon workspace-add", type: "button", onClick: () => void createWorkspace(), title: "Add workspace", "aria-label": "Add workspace", children: _jsx(Plus, { "aria-hidden": "true" }) }), _jsxs("div", { className: "workspace-header-controls", children: [_jsxs("div", { className: "header-approval-policy-wrap", title: "How should Codex actions be approved?", children: [_jsx(ShieldCheck, { "aria-hidden": "true" }), _jsx("select", { className: "header-approval-policy", "aria-label": "How should Codex actions be approved?", value: approvalPolicy, onChange: (event) => setApprovalPolicy(event.target.value), children: APPROVAL_POLICY_OPTIONS.map((option) => (_jsx("option", { value: option.value, children: option.label }, option.value))) })] }), _jsxs("div", { className: "header-account-popover-wrap", ref: accountPopoverRef, children: [_jsxs("button", { className: "header-account-control", type: "button", "aria-label": "Account", "aria-haspopup": "dialog", "aria-expanded": isAccountPopoverOpen, onClick: () => setIsAccountPopoverOpen((open) => !open), children: [_jsx(User, { "aria-hidden": "true" }), _jsx("span", { children: useLoadBalanceInWorkspace
                                                        ? formatLoadBalanceAccountLabel(activeAccount, workspaceAccountList)
                                                        : activeAccount ? formatAccountSelectLabel(activeAccount) : "No account" }), _jsx(ChevronDown, { "aria-hidden": "true" })] }), isAccountPopoverOpen && (_jsxs("section", { className: "header-account-popover", role: "dialog", "aria-label": "Choose account", children: [_jsxs("button", { className: "account-popover-load-balance", type: "button", "data-selected": useLoadBalanceInWorkspace, onClick: () => void switchAccount("__load_balance__"), children: [_jsx("strong", { children: "Load balance" }), _jsx("span", { children: "Automatically choose from checked accounts" })] }), _jsxs("div", { className: "account-popover-list", children: [accountList.map((account) => {
                                                            const tier = formatAccountTier(account);
                                                            const windows = quotaWindowsByDuration(account);
                                                            const resetCredits = accountResetCredits(account);
                                                            const earliestCredit = earliestExpiringResetCredit(resetCredits.credits);
                                                            const selected = workspaceAccountIds.includes(account.id) || (!useLoadBalanceInWorkspace && activeAccount?.id === account.id);
                                                            const resetting = resettingAccountId === account.id;
                                                            return (_jsxs("article", { className: "account-popover-card", "data-selected": selected, children: [_jsxs("button", { className: "account-popover-select", type: "button", onClick: () => void switchAccount(account.id), children: [_jsxs("span", { className: "account-popover-identity", children: [_jsx("strong", { children: accountIdentityLabel(account) }), _jsxs("small", { children: [account.email || account.externalAccountId || account.id, tier ? ` · ${tier}` : ""] })] }), _jsxs("span", { className: "account-popover-quota", children: [windows.fiveHour && _jsxs("span", { children: ["5hr ", _jsx("strong", { children: formatQuotaPercent(windows.fiveHour) }), _jsxs("small", { children: ["Auto reset: ", formatQuotaWindowReset(windows.fiveHour, "relative")] })] }), windows.weekly && _jsxs("span", { children: ["Weekly ", _jsx("strong", { children: formatQuotaPercent(windows.weekly) }), _jsxs("small", { children: ["Reset: ", formatQuotaWindowReset(windows.weekly, "dateTime")] })] }), !windows.fiveHour && !windows.weekly && _jsx("span", { children: "Usage unavailable" })] })] }), _jsxs("div", { className: "account-popover-reset", children: [_jsxs("span", { children: [_jsx("strong", { children: resetCredits.availableCount }), " reset", resetCredits.availableCount === 1 ? "" : "s", _jsxs("small", { children: ["Earliest expiry: ", formatResetCreditExpiry(earliestCredit, resetCredits.availableCount)] })] }), _jsxs("button", { type: "button", onClick: () => void resetAccountRateLimit(account), disabled: resetCredits.availableCount <= 0 || Boolean(resettingAccountId) || accountNeedsLogin(account), title: resetCredits.availableCount > 0 ? "Use one rate-limit reset" : "No reset available", children: [_jsx(RotateCcw, { className: resetting ? "spin" : undefined, "aria-hidden": "true" }), resetting ? "Resetting" : "Use reset"] })] }), account.quotaError && (_jsxs("div", { className: "account-popover-error-row", children: [_jsx("small", { className: "account-popover-error", children: account.quotaError }), accountNeedsLogin(account) && (_jsx("button", { className: "account-popover-login", type: "button", onClick: () => beginAccountRelogin(account), children: "Relogin" }))] }))] }, account.id));
                }), accountList.length === 0 && _jsx("p", { className: "account-popover-empty", children: "No accounts" })] })] }))] }), _jsx("button", { className: "ghost-icon header-settings", type: "button", "data-active": isSettingsOpen, onClick: () => setIsSettingsOpen((open) => !open), title: "Settings", "aria-label": "Settings", children: _jsx(Settings, { "aria-hidden": "true" }) })] })] }), _jsxs("aside", { className: "sidebar", "aria-label": "Sessions", children: [_jsxs("div", { className: "sidebar-toolbar", children: [_jsx("button", { className: "ghost-icon", type: "button", onClick: () => {
                                        setSessionSearchQuery("");
                                        setSessionSearchResults([]);
                                        setSessionSearchPage({ offset: 0, limit: 20, hasMore: false, nextOffset: null, total: 0 });
                                        setIsSearchingSessions(true);
                                        setIsSessionSearchOpen(true);
                                    }, title: "Search sessions", "aria-label": "Search sessions", children: _jsx(Search, { "aria-hidden": "true" }) }), selectedSessionRecords.length > 0 && (_jsxs("div", { className: "session-selection-actions", children: [_jsx("button", { className: "ghost-icon", type: "button", onClick: () => void copySelectedSessionReferences(), title: `Copy ${selectedSessionRecords.length} selected session URL${selectedSessionRecords.length === 1 ? "" : "s"}`, "aria-label": `Copy ${selectedSessionRecords.length} selected session URL${selectedSessionRecords.length === 1 ? "" : "s"}`, children: _jsx(Copy, { "aria-hidden": "true" }) }), _jsx("button", { className: "ghost-icon", type: "button", onClick: clearSessionSelection, title: "Clear selected sessions", "aria-label": "Clear selected sessions", children: _jsx(X, { "aria-hidden": "true" }) })] })), _jsxs("button", { className: "ghost-icon pending-waits-trigger", type: "button", onClick: () => {
                                        setIsSessionSearchOpen(false);
                                        setIsPendingWaitsOpen(true);
                                    }, title: "Pending waits", "aria-label": `Pending waits${activeWaitCount > 0 ? ` (${activeWaitCount})` : ""}`, children: [_jsx(Clock3, { "aria-hidden": "true" }), activeWaitCount > 0 && (_jsx("span", { className: "pending-waits-badge", "aria-hidden": "true", children: activeWaitCount > 99 ? "99+" : activeWaitCount }))] }), _jsx("button", { className: "ghost-icon", type: "button", onClick: () => void newSessionInProjectGroup(mostRecentlyActiveProject), title: mostRecentlyActiveProject ? `New thread in ${mostRecentlyActiveProject.label}` : "New thread", "aria-label": mostRecentlyActiveProject ? `New thread in ${mostRecentlyActiveProject.label}` : "New thread", children: _jsx(Plus, { "aria-hidden": "true" }) })] }), _jsx("section", { className: "thread-tree", "aria-label": "Saved sessions", children: _jsxs("div", { className: "session-list", "data-has-selection": selectedSessionRecords.length > 0 ? "true" : undefined, children: [sessionList.length === 0 ? (_jsx("p", { className: "session-empty", children: "No saved sessions yet." })) : (groupedSessions.map((group) => {
                                        const isCollapsed = collapsedSessionDirs.has(group.cwd);
                                        const launchSessionId = sessionId && flatSessions.some((record) => record.id === sessionId && record.cwd === group.cwd)
                                            ? sessionId
                                            : group.baseSessionId;
                                        const projectPage = centralState.sessionPage.projects.find((project) => project.cwd === group.cwd);
                                        const isLoadingProject = loadingSessionProjects.has(group.cwd);
                                        return (_jsxs("section", { className: "session-dir-group", children: [_jsxs("div", { className: "session-dir-heading", children: [_jsxs("button", { className: "session-dir-toggle", type: "button", title: group.cwd, "aria-expanded": !isCollapsed, onClick: () => setCollapsedSessionDirs((current) => {
                                                                    const next = new Set(current);
                                                                    if (next.has(group.cwd))
                                                                        next.delete(group.cwd);
                                                                    else
                                                                        next.add(group.cwd);
                                                                    return next;
                                                                }), children: [isCollapsed ? _jsx(ChevronRight, { "aria-hidden": "true" }) : _jsx(ChevronDown, { "aria-hidden": "true" }), _jsx(Folder, { "aria-hidden": "true" }), _jsx("span", { children: group.label })] }), _jsx("button", { className: "session-dir-open", type: "button", title: `Open ${group.label} in Web VS Code`, "aria-label": `Open ${group.label} in Web VS Code`, onClick: () => void openProjectFiles({ sessionId: launchSessionId }), children: _jsx(FolderOpen, { "aria-hidden": "true" }) }), _jsx("button", { className: "session-dir-add", type: "button", title: `New thread in ${group.label}`, "aria-label": `New thread in ${group.label}`, onClick: () => void newSessionInProjectGroup(group), children: _jsx(Plus, { "aria-hidden": "true" }) })] }), !isCollapsed && (_jsxs("div", { className: "session-dir-items", children: [group.sessions.map((node) => renderSessionTreeNode(node)), projectPage?.hasMore && (_jsx("button", { className: "session-load-more", type: "button", disabled: isLoadingProject || projectPage.nextOffset === null, onClick: () => void loadSessions(projectPage.nextOffset ?? 0, true, group.cwd), children: isLoadingProject ? "Loading…" : "Load more" }))] }))] }, group.cwd));
                                    }))] }) }), _jsxs("section", { className: "process-monitor-panel", "aria-label": "Process monitors", children: [_jsxs("div", { className: "process-monitor-header", children: [_jsxs("span", { children: [_jsx(TerminalSquare, { "aria-hidden": "true" }), " Process monitors"] }), centralState.processMonitors.length > 0 && _jsx("small", { children: centralState.processMonitors.length })] }), centralState.processMonitors.length === 0 ? (_jsx("p", { className: "process-monitor-empty", children: "No monitored processes." })) : (_jsx("div", { className: "process-monitor-list", children: centralState.processMonitors.map((monitor) => {
                                        const isBusy = processMonitorAction?.endsWith(`:${monitor.id}`) ?? false;
                                        const dockerRunArgs = Array.isArray(monitor.dockerRunArgs) ? monitor.dockerRunArgs : [];
                                        const launchLabel = monitor.dockerImage
                                            ? ["docker", "run", "--rm", ...dockerRunArgs, monitor.dockerImage, ...monitor.args].join(" ")
                                            : monitor.executable
                                                ? [monitor.executable, ...monitor.args].join(" ")
                                                : monitor.command ?? `PID ${monitor.pid ?? "—"}`;
                                        const entryPoints = Array.isArray(monitor.entryPoints) ? monitor.entryPoints : [];
                                        return (_jsxs("div", { className: "process-monitor-item", onMouseEnter: (event) => {
                                                cancelHoveredProcessMonitorClose();
                                                const bounds = event.currentTarget.getBoundingClientRect();
                                                setHoveredProcessMonitor({
                                                    id: monitor.id,
                                                    bottom: window.innerHeight - bounds.bottom,
                                                    left: Math.max(16, Math.min(bounds.right - 2, window.innerWidth - 376))
                                                });
                                            }, onMouseLeave: scheduleHoveredProcessMonitorClose, onBlur: (event) => {
                                                if (!event.currentTarget.contains(event.relatedTarget)) {
                                                    scheduleHoveredProcessMonitorClose();
                                                }
                                            }, children: [_jsxs("button", { className: "process-monitor-row", type: "button", "aria-haspopup": "dialog", "aria-expanded": hoveredProcessMonitor?.id === monitor.id, onFocus: (event) => {
                                                        cancelHoveredProcessMonitorClose();
                                                        const bounds = event.currentTarget.getBoundingClientRect();
                                                        setHoveredProcessMonitor({
                                                            id: monitor.id,
                                                            bottom: window.innerHeight - bounds.bottom,
                                                            left: Math.max(16, Math.min(bounds.right - 2, window.innerWidth - 376))
                                                        });
                                                    }, children: [_jsx("span", { className: "process-monitor-dot", "data-status": monitor.status, "aria-hidden": "true" }), _jsx("span", { className: "process-monitor-label", title: monitor.label, children: monitor.label }), _jsx("small", { children: monitor.status })] }), hoveredProcessMonitor?.id === monitor.id && (_jsxs("section", { className: "thread-status-popover process-monitor-popover", role: "dialog", "aria-label": `${monitor.label} process details`, style: {
                                                        bottom: hoveredProcessMonitor.bottom,
                                                        left: hoveredProcessMonitor.left,
                                                        maxHeight: `calc(100vh - ${hoveredProcessMonitor.bottom + 16}px)`
                                                    }, onMouseEnter: cancelHoveredProcessMonitorClose, children: [_jsxs("div", { className: "thread-status-popover-header", children: [_jsx("span", { className: "process-monitor-dot", "data-status": monitor.status, "aria-hidden": "true" }), _jsx("strong", { children: capitalize(monitor.status) })] }), _jsx("span", { className: "thread-status-title", children: monitor.label }), _jsxs("div", { className: "thread-status-meta", children: [_jsx(TerminalSquare, { "aria-hidden": "true" }), _jsx("span", { children: launchLabel })] }), _jsxs("div", { className: "thread-status-meta", children: [_jsx(Folder, { "aria-hidden": "true" }), _jsx("span", { children: monitor.cwd })] }), monitor.logFile && (_jsxs("div", { className: "thread-status-meta", children: [_jsx(FileText, { "aria-hidden": "true" }), _jsxs("span", { title: monitor.logFile, children: ["Log: ", monitor.logFile] })] })), monitor.pid && (_jsxs("div", { className: "thread-status-meta", children: [_jsx(Cpu, { "aria-hidden": "true" }), _jsxs("span", { children: ["PID ", monitor.pid] })] })), entryPoints.length > 0 && (_jsx("div", { className: "process-monitor-entry-points", children: entryPoints.map((entryPoint) => (_jsxs("a", { className: "process-monitor-entry-link", href: entryPoint, target: "_blank", rel: "noreferrer", title: `Open ${entryPoint}`, children: [_jsx(ExternalLink, { "aria-hidden": "true" }), _jsx("span", { children: entryPoint })] }, entryPoint))) })), monitor.wakePrompt && (_jsxs("div", { className: "thread-status-meta", children: [_jsx(Clock3, { "aria-hidden": "true" }), _jsxs("span", { children: ["Wake-up: ", monitor.wakeStatus] })] })), monitor.error && _jsx("small", { className: "process-monitor-error", children: monitor.error }), monitor.readOnly && _jsx("small", { children: monitor.restartable ? "Restartable via local supervisor" : "Managed externally" }), _jsxs("div", { className: "process-monitor-popover-actions", children: [_jsxs("button", { type: "button", onClick: () => void openProcessMonitorLog(monitor), disabled: isBusy, title: "View process output", children: [_jsx(FileText, { "aria-hidden": "true" }), "Logs"] }), _jsxs("button", { type: "button", onClick: () => void restartProcessMonitor(monitor), disabled: isBusy || (!monitor.managed && !monitor.restartable) || (monitor.readOnly && !monitor.restartable), title: monitor.restartable ? "Restart via supervisor" : monitor.readOnly ? "This process is restarted by its external supervisor" : monitor.managed ? "Restart process" : "PID monitors cannot be restarted", children: [_jsx(RotateCcw, { className: processMonitorAction === `restart:${monitor.id}` ? "spin" : undefined, "aria-hidden": "true" }), "Restart"] }), _jsxs("button", { type: "button", "data-danger": "true", onClick: () => void removeProcessMonitor(monitor), disabled: isBusy || monitor.readOnly, title: monitor.readOnly ? "Built-in process records cannot be removed" : "Remove process monitor", children: [_jsx(X, { "aria-hidden": "true" }), "Remove"] })] })] }))] }, monitor.id));
                                    }) }))] }), _jsx("div", { className: "sidebar-spacer" })] }), _jsxs("section", { className: "chat", "data-session-tab": activeSessionTab, "aria-label": "Codex chat", children: [_jsxs("header", { className: "content-header", children: [_jsxs("div", { className: "content-header-heading", children: [effectiveParentSessionId ? (_jsxs("div", { className: "session-title-stack", children: [_jsxs("button", { className: "parent-session-link", type: "button", onClick: () => void switchToParentSession(effectiveParentSessionId), title: `Back to main agent ${effectiveParentSessionId}`, children: [_jsx(ArrowLeft, { "aria-hidden": "true" }), _jsx("span", { children: parentSession
                                                        ? displaySessionTitle(parentSession.title)
                                                        : "Main agent" })] }), _jsx("h1", { children: threadTitle })] })) : (_jsx("h1", { children: threadTitle }))] }), _jsxs("div", { className: "content-header-actions", children: [childSessions.length > 0 && (_jsxs("button", { className: "parent-session-link", type: "button", onClick: () => void switchSession(childSessions[0]), title: `Open latest child task: ${displaySessionTitle(childSessions[0].title)}`, children: [_jsx(GitFork, { "aria-hidden": "true" }), _jsxs("span", { children: [childSessions.length, " child task", childSessions.length === 1 ? "" : "s"] })] }))] })] }),
_jsx("div", { className: "session-view-tabs", role: "tablist", "aria-label": "Session views", children: [
    ["turns", "Turns"], ...(sessionId ? [["side-chat", "Side chat"]] : []), ...(hasPlanTab ? [["plan", "Plan"]] : [])
].map(([value, label]) => _jsx("button", {
    type: "button", role: "tab", id: `session-tab-${value}`, "aria-selected": activeSessionTab === value,
    "aria-controls": `session-panel-${value}`, tabIndex: activeSessionTab === value ? 0 : -1,
    onClick: () => setSessionTab({ sessionId, value }),
    onKeyDown: (event) => {
        const tabs = Array.from(event.currentTarget.parentElement.querySelectorAll('[role="tab"]'));
        const index = tabs.indexOf(event.currentTarget);
        const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
        if (next >= 0) { event.preventDefault(); tabs[next].focus(); tabs[next].click(); }
    }, children: label
}, value)) }),
        sessionId && _jsx("div", { className: "session-side-chat-view", id: "session-panel-side-chat", role: "tabpanel", "aria-labelledby": "session-tab-side-chat", hidden: activeSessionTab !== "side-chat", children: _jsx(SideChatPanel, { codexSessionId: threadId ?? undefined, sessionId, sessionReady: activeSession?.id === sessionId, workspaceId: activeWorkspace?.id, CompletedTurn, annotation: sideChatAnnotation, onClearAnnotation: () => setSideChatAnnotation(null) }, sessionId) }),
hasPlanTab && _jsx("div", { className: "session-plan-view", id: "session-panel-plan", role: "tabpanel", "aria-labelledby": "session-tab-plan", hidden: activeSessionTab !== "plan", children: _jsx(TodoPanel, { todo: visibleSessionTodo, sessionExecutionStatuses: sessionExecutionStatuses, pendingApprovalSessionIds: pendingApprovalSessionIdSet, onOpenSession: (targetSessionId) => void switchToSessionById(targetSessionId, { label: "subtask" }), onPause: setTodoPaused, onCreateItem: createTodoItem, onUpdateItem: updateTodoItem, onSetContext: setTodoContext, onComment: addTodoComment, onResolveChallenge: resolveTodoChallenge }) }),
_jsxs("div", { className: "messages-pane", children: [
_jsxs("aside", { className: "prompt-turns", id: "session-panel-turns", role: "tabpanel", "aria-labelledby": "session-tab-turns", children: [_jsx("div", { ref: promptTurnsScrollRef, className: "prompt-turns-scroll", children: promptTurns.map(({ prompt, response, index, editCount, toolCount, agentRoundTripCount, steerCount, issueCount, resolvedIssueCount }) => {
                                            const accent = `var(--turn-accent-${(index % 6) + 1})`;
                                            const isRunning = response?.turnStatus === "running";
                                            const isEditing = inlinePromptEditor?.messageId === prompt.id;
                                            const openTurn = () => {
                                                    setActivePromptTurnIds(new Set([prompt.turnId]));
                                                    setFeaturedPromptTurnId(prompt.turnId);
                                                    messagesRef.current?.querySelector(`.message.assistant[data-turn-id="${prompt.turnId}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                                            };
                                            const promptMetadata = promptDisplayMetadata(prompt.rawContent ?? prompt.content);
                                            const promptText = parseResponseAnnotations(promptMetadata.visible)?.content || promptMetadata.visible || "Attachment prompt";
                                            const copyPrompt = (event) => {
                                                event.stopPropagation();
                                                void copyUserPrompt(prompt);
                                            };
                                            const promptActions = renderPromptActionButtons(prompt);
                                            const hasGrill = grilledTurns.has(`${sessionId}:${prompt.turnId}`);
                                            const hasPromptStats = hasGrill || editCount > 0 || toolCount > 0 || agentRoundTripCount > 0 || steerCount > 0 || issueCount > 0;
                                            return (_jsxs("div", { className: "prompt-turn-card", role: "button", tabIndex: 0, "data-turn-id": prompt.turnId, "data-active": activePromptTurnIds.has(prompt.turnId) ? "true" : undefined, "data-featured": effectiveFeaturedPromptTurnId === prompt.turnId ? "true" : undefined, style: { "--turn-accent": accent }, onClick: openTurn, onKeyDown: (event) => {
                                                    if (event.key === "Enter" || event.key === " ") {
                                                        event.preventDefault();
                                                        openTurn();
                                                    }
                                                }, children: [
                                                    _jsx("span", { className: "prompt-turn-meta", children: isRunning ? _jsx(Loader2, { className: "spin prompt-turn-spinner", "aria-label": "Running" }) : _jsx("b", { children: String(index + 1).padStart(2, "0") }) }),
                                                    isEditing ? (_jsxs("form", { className: "prompt-turn-inline-editor", onClick: (event) => event.stopPropagation(), onSubmit: (event) => void submitInlineUserPromptEdit(event, prompt), children: [
                                                        _jsx("textarea", { ref: inlinePromptEditorRef, value: inlinePromptEditor?.value ?? "", "aria-label": "Edit prompt", onChange: (event) => {
                                                                const value = event.currentTarget.value;
                                                                setInlinePromptEditor((current) => current?.messageId === prompt.id ? { ...current, value } : current);
                                                            }, onKeyDown: (event) => handleInlinePromptEditorKeyDown(event, prompt) }),
                                                        _jsxs("span", { className: "prompt-turn-actions", children: [
                                                            _jsx("button", { className: "message-action-icon", type: "button", title: "Copy prompt", "aria-label": "Copy prompt", onClick: copyPrompt, children: _jsx(Copy, { "aria-hidden": "true" }) }),
                                                            _jsx("button", { className: "message-action-icon", type: "button", title: "Cancel edit", "aria-label": "Cancel edit", onClick: cancelInlineUserPromptEdit, children: _jsx(X, { "aria-hidden": "true" }) }),
                                                            _jsx("button", { className: "message-action-icon", type: "submit", title: "Resend edited prompt", "aria-label": "Resend edited prompt", disabled: !(inlinePromptEditor?.value.trim() || (inlinePromptEditor?.attachments.length ?? 0) > 0) || isSteering, children: _jsx(Send, { "aria-hidden": "true" }) })
                                                        ] })
                                                    ] })) : (_jsxs("div", { className: "prompt-turn-summary", children: [prompt.model && (_jsx("span", { className: "prompt-turn-model", title: `Model used: ${prompt.model}`, children: modelOptionLabel(prompt.model) })), _jsx(MarkdownContent, { className: "prompt-turn-copy", children: promptText }), renderPromptTags(prompt, "prompt-turn-tags")] })),
                                                    (!isEditing || hasPromptStats) && (_jsxs("span", { className: "prompt-turn-details", children: [
                                                        hasGrill && _jsx("span", { className: "prompt-turn-stat prompt-turn-grill-tag", "data-await-ack": pendingGrillTurns.has(`${sessionId}:${prompt.turnId}`) || undefined, title: pendingGrillTurns.has(`${sessionId}:${prompt.turnId}`) ? "Grill: Await ack" : "Grill review", "aria-label": pendingGrillTurns.has(`${sessionId}:${prompt.turnId}`) ? "Grill: Await ack" : "Grilled", children: _jsx(Flame, { "aria-hidden": "true" }) }),
                                                        prompt.model && (_jsx("span", { className: "prompt-turn-model prompt-turn-toolbar-model", title: `Model used: ${prompt.model}${prompt.reasoningEffort ? ` · reasoning effort: ${prompt.reasoningEffort}` : ""}`, children: [modelOptionLabel(prompt.model), prompt.reasoningEffort ? ` · ${shortReasoningEffort(prompt.reasoningEffort)}` : ""] })),
                                                        editCount > 0 && (_jsxs("span", { className: "prompt-turn-stat", title: `${editCount} edited file${editCount === 1 ? "" : "s"}`, children: [_jsx(FileEditIcon, { "aria-hidden": "true" }), editCount] })),
                                                        issueCount > 0 && (_jsxs("span", { className: "prompt-turn-stat prompt-turn-issues", "data-resolved": resolvedIssueCount === issueCount ? "true" : undefined, title: `${resolvedIssueCount}/${issueCount} issues resolved`, children: [resolvedIssueCount === issueCount ? _jsx(CheckCircle2, { "aria-hidden": "true" }) : _jsx(Circle, { "aria-hidden": "true" }), resolvedIssueCount, "/", issueCount] })),
                                                        agentRoundTripCount > 0 && (_jsxs("span", { className: "prompt-turn-stat", title: `${agentRoundTripCount} agent round trip${agentRoundTripCount === 1 ? "" : "s"}`, children: [_jsx(RotateCcw, { "aria-hidden": "true" }), agentRoundTripCount] })),
                                                        steerCount > 0 && (_jsxs("span", { className: "prompt-turn-stat", title: `${steerCount} steer${steerCount === 1 ? "" : "s"}`, children: [_jsx(BetweenHorizontalStart, { "aria-hidden": "true" }), steerCount] })),
                                                        toolCount > 0 && (_jsxs("span", { className: "prompt-turn-stat", title: `${toolCount} tool${toolCount === 1 ? "" : "s"}`, children: [_jsx(TerminalSquare, { "aria-hidden": "true" }), toolCount] })),
                                                        !isEditing && promptActions
                                                    ] }))
                                                ] }, prompt.id));
                                        }) }), queuedPrompts.length > 0 && (_jsx("div", { className: "prompt-turn-queue", "aria-label": "Queued prompts", children: queuedPrompts.map((queuedPrompt, queueIndex) => {
                                            const queuedPreview = parseResponseAnnotations(queuedPrompt.content)?.content || queuedPrompt.content || "Attachment prompt";
                                            const accent = `var(--turn-accent-${((promptTurns.length + queueIndex) % 6) + 1})`;
                                            return (_jsxs("div", { className: "prompt-turn-card prompt-turn-card-queued", style: { "--turn-accent": accent }, "data-kind": queuedPrompt.kind, children: [_jsxs("span", { className: "prompt-turn-meta", children: [queuedPrompt.kind === "steer" ? _jsx(BetweenHorizontalStart, { "aria-label": "Steer" }) : _jsx("b", { children: String(promptTurns.length + queueIndex + 1).padStart(2, "0") })] }), _jsx("span", { className: "prompt-turn-copy", children: queuedPreview }), _jsxs("span", { className: "prompt-turn-actions prompt-turn-queue-actions", children: [_jsx("button", { className: "message-action-icon", type: "button", title: "Edit queued prompt", "aria-label": "Edit queued prompt", onClick: () => editQueuedPrompt(queuedPrompt.id), children: _jsx(Pencil, { "aria-hidden": "true" }) }), _jsx("button", { className: "message-action-icon", type: "button", title: queuedPrompt.kind === "steer" ? "Send as queued prompt" : "Steer next", "aria-label": queuedPrompt.kind === "steer" ? "Send as queued prompt" : "Steer next", disabled: queuedPrompt.contextFork === true, onClick: () => void toggleQueuedPromptSteer(queuedPrompt.id), children: _jsx(BetweenHorizontalStart, { "aria-hidden": "true" }) }), _jsx("button", { className: "message-action-icon", type: "button", title: "Move queued prompt up", "aria-label": "Move queued prompt up", onClick: () => moveQueuedPrompt(queuedPrompt.id, "up"), children: _jsx(ArrowUp, { "aria-hidden": "true" }) }), _jsx("button", { className: "message-action-icon", type: "button", title: "Move queued prompt down", "aria-label": "Move queued prompt down", onClick: () => moveQueuedPrompt(queuedPrompt.id, "down"), children: _jsx(ArrowDown, { "aria-hidden": "true" }) }), _jsx("button", { className: "message-action-icon", type: "button", title: "Remove queued prompt", "aria-label": "Remove queued prompt", onClick: () => removeQueuedPrompt(queuedPrompt.id), children: _jsx(X, { "aria-hidden": "true" }) })] })] }, queuedPrompt.id));
                                        }) }))] }),
_jsxs("div", { ref: messageScrollIndicatorRef, className: "message-scroll-indicator", onClick: scrollFromMessageRail, onWheel: scrollFromMessageRailWheel, children: [_jsx("span", { className: "message-scroll-indicator-track", "aria-hidden": "true" }), _jsx("span", { ref: messageViewportIndicatorRef, className: "message-scroll-indicator-viewport", "aria-hidden": "true", onClick: (event) => event.stopPropagation(), onPointerDown: startMessageRailDrag, onPointerMove: dragMessageRailViewport, onPointerUp: finishMessageRailDrag, onPointerCancel: finishMessageRailDrag }), messageIndicatorMarks.map((mark) => (_jsx("button", { className: "message-scroll-indicator-mark", "data-tone": mark.tone, "data-tooltip": mark.title, type: "button", "aria-label": `Jump to ${mark.title}`, onClick: () => scrollToMessage(mark.targetId, mark.anchorId), style: { top: messageIndicatorMarkTop(messageIndicatorPositions[mark.id] ?? mark.position) } }, mark.id)))] }), _jsx("div", { ref: messagesRef, className: "messages", onScroll: (event) => {
                                        setResponseQuotePopover(null);
                                        const container = event.currentTarget;
                                        messageScrollTopRef.current = container.scrollTop;
                                        stickToMessageBottomRef.current =
                                            container.scrollHeight - container.scrollTop - container.clientHeight <= MESSAGE_BOTTOM_THRESHOLD;
                                        updateMessageViewportIndicator(container);
                                    }, onMouseUp: captureResponseQuoteSelection, children: transcript.length === 0 ? (_jsx("div", { className: "empty", children: switchingSessionTitle ? (_jsxs(_Fragment, { children: [_jsx(Loader2, { className: "spin", "aria-hidden": "true" }), _jsx("h2", { children: "Loading session" })] })) : (_jsxs(_Fragment, { children: [_jsx("h2", { children: "Let's build" }), _jsxs("div", { className: "project-picker-menu", children: [_jsxs("button", { className: "project-picker", type: "button", onClick: toggleProjectPicker, "aria-expanded": isProjectPickerOpen, "aria-haspopup": "listbox", children: [_jsx("span", { children: projectName }), _jsx(ChevronRight, { "aria-hidden": "true" })] }), isProjectPickerOpen && (_jsx("div", { className: "project-picker-options", role: "listbox", "aria-label": "Projects in active workspace", children: isLoadingWorkspaceProjects ? (_jsx("p", { children: "Loading projects…" })) : workspaceProjectsError ? (_jsx("p", { className: "project-picker-error", children: workspaceProjectsError })) : workspaceProjects.length === 0 ? (_jsx("p", { children: "No projects in this workspace." })) : (workspaceProjects.map((project) => (_jsx("button", { type: "button", role: "option", onClick: () => {
                                                            setIsProjectPickerOpen(false);
                                                            void newSession(project);
                                                        }, children: project.name }, project.name)))) }))] })] })) })) : (transcriptEntries.map((entry) => {
                                        if (entry.kind === "message") {
                                            return renderMessageArticle(entry.message);
                                        }
                                        return (_jsx("section", { className: "message-step-group", children: _jsxs("details", { className: "message-step-card", open: entry.open, children: [_jsxs("summary", { className: "message-step-summary", children: [_jsx(ChevronRight, { className: "command-chevron", "aria-hidden": "true" }), _jsx(CheckSquare2, { "aria-hidden": "true" }), _jsxs("span", { className: "message-step-index", children: ["Step ", entry.stepNumber] }), _jsx("span", { className: "message-step-title", children: entry.title }), _jsxs("span", { className: "message-step-count", children: [entry.messages.length, " ", entry.messages.length === 1 ? "message" : "messages"] })] }), _jsx("div", { className: "message-step-details", children: entry.messages.map(renderMessageArticle) })] }) }, entry.id));
                                    })) })] }), _jsxs("form", { className: "composer", onSubmit: submit, children: [queuedPrompts.length > 0 && (_jsx("div", { className: "queued-prompts", "aria-label": "Queued prompts", children: queuedPrompts.map((prompt, index) => {
                                        const queuedResponseAnnotations = parseResponseAnnotations(prompt.content);
                                        const queuedPromptPreview = queuedResponseAnnotations?.content || prompt.content;
                                        const queuedMetadata = [
                                            queuedResponseAnnotations ? annotationLabel(queuedResponseAnnotations.annotations[0]) : "",
                                            prompt.attachments.length > 0
                                                ? `${prompt.attachments.length} attachment${prompt.attachments.length === 1 ? "" : "s"}`
                                                : ""
                                        ].filter(Boolean).join(" · ");
                                        return (_jsxs("div", { className: "queued-prompt", "data-dragging": draggedQueuedPromptId === prompt.id ? "true" : undefined, draggable: true, onDragStart: () => setDraggedQueuedPromptId(prompt.id), onDragOver: (event) => event.preventDefault(), onDrop: (event) => {
                                                event.preventDefault();
                                                dropQueuedPrompt(prompt.id);
                                            }, onDragEnd: () => setDraggedQueuedPromptId(null), "data-kind": prompt.kind, "data-context-fork": prompt.contextFork ? "true" : undefined, children: [_jsx("span", { className: "queued-prompt-index", children: prompt.contextFork ? _jsx(GitFork, { "aria-hidden": "true" }) : prompt.kind === "steer" ? _jsx(BetweenHorizontalStart, { "aria-hidden": "true" }) : index + 1 }), _jsxs("div", { className: "queued-prompt-text", children: [_jsx("strong", { children: prompt.contextFork ? "Create child task" : prompt.kind === "steer" ? "Steer" : "Queue" }), _jsx("span", { children: queuedPromptPreview }), queuedMetadata && _jsx("small", { children: queuedMetadata })] }), _jsxs("div", { className: "queued-prompt-actions", children: [_jsx("button", { className: "message-action-icon", type: "button", title: "Edit queued prompt", "aria-label": "Edit queued prompt", onClick: () => editQueuedPrompt(prompt.id), children: _jsx(Pencil, { "aria-hidden": "true" }) }), _jsx("button", { className: "message-action-icon", type: "button", title: prompt.kind === "steer" ? "Send as queued prompt" : "Steer next", "aria-label": prompt.kind === "steer" ? "Send as queued prompt" : "Steer next", disabled: prompt.contextFork === true, onClick: () => void toggleQueuedPromptSteer(prompt.id), children: _jsx(BetweenHorizontalStart, { "aria-hidden": "true" }) }), _jsx("button", { className: "message-action-icon", type: "button", title: "Move queued prompt up", "aria-label": "Move queued prompt up", onClick: () => moveQueuedPrompt(prompt.id, "up"), children: _jsx(ArrowUp, { "aria-hidden": "true" }) }), _jsx("button", { className: "message-action-icon", type: "button", title: "Move queued prompt down", "aria-label": "Move queued prompt down", onClick: () => moveQueuedPrompt(prompt.id, "down"), children: _jsx(ArrowDown, { "aria-hidden": "true" }) }), _jsx("button", { className: "message-action-icon", type: "button", title: "Remove queued prompt", "aria-label": "Remove queued prompt", onClick: () => removeQueuedPrompt(prompt.id), children: _jsx(X, { "aria-hidden": "true" }) })] })] }, prompt.id));
                                    }) })), _jsxs(ComposerFrame, { children: [_jsx(ComposerGearSelector, { idPrefix: "main-composer-gear", label: "Model gears", gears: gearProfiles, activeGearIndex: activeGearIndex, modelOptions: MODEL_OPTIONS, effortOptions: EFFORT_OPTIONS, ultraEffortOptions: ULTRA_EFFORT_OPTIONS, supportsUltraEffort: supportsUltraEffort, modelOptionLabel: modelOptionLabel, effortOptionLabel: capitalize, onActivateGear: activateGearProfile, onModelChange: (index, model) => updateGearProfile(index, { model }), onEffortChange: (index, effort) => updateGearProfile(index, { effort }), autoModelValue: AUTO_MODEL_VALUE, autoEffort: sessionAutoModel?.enabled ? sessionAutoModel.effort : undefined }), _jsxs(ComposerSurface, { onDropFiles: addFiles, children: [slashTrigger ? (_jsx(ComposerSuggestionMenu, { suggestions: visibleSlashSuggestions, activeIndex: slashSuggestionIndex, onSelect: selectSlashSuggestion, loading: isLoadingSkills })) : composerSuggestionTrigger && (visibleComposerSuggestions.length > 0 || isLoadingPathSuggestions) && (_jsx(ComposerSuggestionMenu, { suggestions: visibleComposerSuggestions, activeIndex: composerSuggestionIndex, onSelect: selectComposerSuggestion, loading: isLoadingPathSuggestions })), composerResponseQuote && (_jsxs("div", { className: "composer-response-quote", "aria-label": annotationLabel(composerResponseQuote), children: [_jsx("span", { className: "composer-response-quote-icon", "aria-hidden": "true", children: _jsx(Quote, {}) }), _jsxs("div", { children: [_jsx("strong", { children: annotationLabel(composerResponseQuote) }), _jsx("span", { children: composerResponseQuote.text }), composerResponseQuote.annotation && _jsx("small", { children: composerResponseQuote.annotation })] }), _jsx("button", { type: "button", onClick: () => setComposerResponseQuote(null), title: composerResponseQuote.source?.type === "file" ? "Remove file annotation" : "Remove quote", "aria-label": composerResponseQuote.source?.type === "file" ? "Remove file annotation" : "Remove quote", children: _jsx(X, { "aria-hidden": "true" }) })] })), attachments.length > 0 && (_jsx(AttachmentList, { attachments: attachments, onRemove: removeAttachment })), _jsx(InlineLinkComposer, { ref: inputEditorRef, value: input, links: composerSessionLinks, placeholder: currentSessionIsRunning ? "Type to queue or steer…" : "Type a message…", onChange: (value, caret) => {
                                                        pruneComposerLinks(value);
                                                        setComposerInput(value);
                                                        setSlashTrigger(findSlashTrigger(value, caret ?? value.length));
                                                        setComposerSuggestionTrigger(findComposerSuggestionTrigger(value, caret));
                                                    }, onPasteLink: addPastedComposerLink, onRemoveLink: removeComposerSessionLink, onOpenLink: (link) => link.session && void openLinkedSession(link.session), onUnhandledPaste: handleEditorPaste, onKeyDown: handleEditorKeyDown, onBlur: () => { setSlashTrigger(null); setComposerSuggestionTrigger(null); } }), _jsxs(ComposerToolbar, { children: [_jsxs("label", { className: "composer-icon", title: "Attach files", "aria-label": "Attach files", children: [_jsx(Plus, { "aria-hidden": "true" }), _jsx("input", { type: "file", multiple: true, onChange: (event) => {
                                                                        void addFiles(event.currentTarget.files);
                                                                        event.currentTarget.value = "";
                                                                    }, disabled: attachments.length >= MAX_ATTACHMENTS })] }), composerTodoPlanModeAvailable && (_jsx("button", { className: "composer-icon composer-plan-prefix", type: "button", "aria-label": "Track outcomes", "aria-pressed": composerTodoPlanModeEnabled, "data-active": composerTodoPlanModeEnabled ? "true" : undefined, title: composerTodoPlanModeEnabled ? "Outcome tracking is on" : "Track outcomes with automatic status updates", onClick: toggleTodoPlanMode, children: _jsx(ListChecks, { "aria-hidden": "true" }) })), _jsx("button", { className: "composer-icon composer-goal-mode", type: "button", "aria-label": "Run next prompt as a goal", "aria-pressed": executionMode === "goal", "data-active": executionMode === "goal" ? "true" : undefined, title: executionMode === "goal" ? "Next prompt will run as a goal" : "Run next prompt as a goal", onClick: () => setExecutionMode((mode) => mode === "goal" ? "default" : "goal"), children: _jsx(Target, { "aria-hidden": "true" }) }), sessionId && (_jsx("button", { className: "composer-icon composer-fork-toggle", type: "button", "aria-label": "Fork next prompt into a new thread", "aria-pressed": forkNextPrompt, "data-active": forkNextPrompt ? "true" : undefined, title: forkNextPrompt ? "Next prompt will open in a child thread" : "Fork next prompt into a new thread", onClick: () => setForkNextPrompt((enabled) => !enabled), children: _jsx(GitFork, { "aria-hidden": "true" }) })), executionMode !== "default" && executionMode !== "goal" && (_jsxs("button", { className: "composer-chip composer-execution-mode", type: "button", onClick: () => setExecutionMode("default"), title: `Turn off ${executionMode} mode`, children: [capitalize(executionMode), " mode", _jsx(X, { "aria-hidden": "true" })] })), _jsx("span", { className: "composer-fill" }), currentSessionIsRunning && (_jsx("span", { className: "composer-steer-control", children: _jsx("button", { className: "composer-icon composer-steer-toggle", type: "button", "aria-label": "Steer mode", "aria-pressed": composerMode === "steer", "data-active": composerMode === "steer" ? "true" : undefined, title: composerMode === "steer" ? "Steer mode is on" : "Steer mode", onClick: () => setComposerMode((mode) => mode === "steer" ? "queue" : "steer"), children: _jsx(BetweenHorizontalStart, { "aria-hidden": "true" }) }) })), _jsx("button", { className: "composer-icon", type: "button", onClick: clearInput, disabled: !input && !composerResponseQuote, title: "Clear", "aria-label": "Clear", children: _jsx(X, { "aria-hidden": "true" }) }), _jsx("button", { className: `send-button${sendButtonIsStop ? " stop-button" : ""}`, type: sendButtonIsStop ? "button" : "submit", disabled: sendButtonIsStop ? currentSessionIsStopping : !canSend || isSteering, title: sendButtonIsStop ? "Stop agent" : currentSessionIsRunning ? capitalize(composerMode) : "Send", "aria-label": sendButtonIsStop ? "Stop agent" : currentSessionIsRunning ? capitalize(composerMode) : "Send", onClick: sendButtonIsStop ? () => void stopCurrentTurn() : undefined, children: isSteering ? (_jsx(Loader2, { className: "spin", "aria-hidden": "true" })) : sendButtonIsStop && currentSessionIsStopping ? (_jsx(Loader2, { className: "spin", "aria-hidden": "true" })) : sendButtonIsStop ? (_jsx(Square, { "aria-hidden": "true" })) : (_jsx(Send, { "aria-hidden": "true" })) })] })] })] })] })] }), responseQuotePopover && (_jsx(ResponseQuotePopover, { quote: responseQuotePopover, onChange: setResponseQuotePopover, onAsk: () => askAboutResponseQuote(responseQuotePopover), onAskSideChat: sessionId ? () => { setSideChatAnnotation({ text: responseQuotePopover.text, source: responseQuotePopover.source, annotation: responseQuotePopover.annotation?.trim() }); setSessionTab({ sessionId, value: "side-chat" }); setResponseQuotePopover(null); window.getSelection()?.removeAllRanges(); } : undefined })), toastMessage && (_jsx("div", { className: "toast", role: "status", "aria-live": "polite", children: toastMessage })), processMonitorLog && (_jsx("div", { className: "modal-backdrop process-monitor-log-backdrop", role: "presentation", onMouseDown: () => setProcessMonitorLog(null), children: _jsxs("section", { className: "process-monitor-log-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "process-monitor-log-title", onMouseDown: (event) => event.stopPropagation(), onKeyDown: (event) => {
                            if (event.key === "Escape")
                                setProcessMonitorLog(null);
                        }, children: [_jsxs("div", { className: "process-monitor-log-header", children: [_jsx(TerminalSquare, { "aria-hidden": "true" }), _jsxs("div", { children: [_jsx("strong", { id: "process-monitor-log-title", children: processMonitorLog.label }), _jsxs("small", { children: ["Process output", processMonitorLog.status === "ready" ? ` · ${formatBytes(processMonitorLog.size)}` : ""] })] }), _jsx("button", { className: "ghost-icon", type: "button", onClick: () => setProcessMonitorLog(null), title: "Close logs", "aria-label": "Close logs", autoFocus: true, children: _jsx(X, { "aria-hidden": "true" }) })] }), _jsx("div", { className: "process-monitor-log-content", "aria-live": "polite", children: processMonitorLog.status === "loading" ? (_jsxs("div", { className: "process-monitor-log-state", children: [_jsx(Loader2, { className: "spin", "aria-hidden": "true" }), " Loading logs\u2026"] })) : processMonitorLog.status === "error" ? (_jsx("div", { className: "process-monitor-log-state", "data-error": "true", children: processMonitorLog.error })) : processMonitorLog.content ? (_jsx("pre", { children: processMonitorLog.content })) : (_jsx("div", { className: "process-monitor-log-state", children: "No output captured yet." })) }), _jsxs("div", { className: "process-monitor-log-footer", children: [_jsxs("small", { children: [processMonitorLog.truncated ? "Showing the latest 256 KB" : "Complete captured output", processMonitorLog.updatedAt ? ` · Updated ${formatTimestamp(processMonitorLog.updatedAt)}` : ""] }), _jsxs("button", { className: "secondary", type: "button", onClick: () => void openProcessMonitorLog({ id: processMonitorLog.monitorId, label: processMonitorLog.label }), disabled: processMonitorLog.status === "loading", children: [_jsx(RotateCcw, { className: processMonitorLog.status === "loading" ? "spin" : undefined, "aria-hidden": "true" }), "Refresh"] })] })] }) })), isPendingWaitsOpen && (_jsx("div", { className: "modal-backdrop session-search-backdrop", role: "presentation", onMouseDown: () => setIsPendingWaitsOpen(false), children: _jsxs("section", { className: "session-search-modal pending-waits-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "pending-waits-title", onMouseDown: (event) => event.stopPropagation(), onKeyDown: (event) => {
                            if (event.key === "Escape")
                                setIsPendingWaitsOpen(false);
                        }, children: [_jsxs("div", { className: "pending-waits-modal-header", children: [_jsx(Clock3, { "aria-hidden": "true" }), _jsxs("div", { children: [_jsx("strong", { id: "pending-waits-title", children: "Pending waits" }), _jsxs("small", { children: [activeWaitCount, " active subscription", activeWaitCount === 1 ? "" : "s"] })] }), _jsx("button", { className: "ghost-icon session-search-close", type: "button", onClick: () => setIsPendingWaitsOpen(false), title: "Close pending waits", "aria-label": "Close pending waits", autoFocus: true, children: _jsx(X, { "aria-hidden": "true" }) })] }), _jsx("div", { className: "session-search-results pending-waits-results", "aria-live": "polite", children: activeWaitRows.length === 0 ? (_jsx("p", { className: "session-search-empty", children: "No pending waits." })) : (_jsx("div", { className: "session-search-table-wrap pending-waits-table-wrap", children: _jsxs("table", { className: "session-search-table pending-waits-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Session" }), _jsx("th", { children: "Pending prompt" }), _jsx("th", { children: "Event" }), _jsx("th", { children: "Created" })] }) }), _jsx("tbody", { children: activeWaitRows.map(({ subscription, event }) => {
                                                    const prompt = pendingPromptForSubscription(subscription);
                                                    return (_jsxs("tr", { children: [_jsxs("td", { className: "pending-waits-session", children: [_jsx("strong", { children: displaySessionTitle(sessionTitleById.get(subscription.sessionId) ?? shortId(subscription.sessionId)) }), _jsx("small", { children: shortId(subscription.sessionId) })] }), _jsxs("td", { className: "pending-waits-prompt", title: prompt, children: [_jsx("span", { children: prompt }), _jsxs("div", { className: "pending-waits-actions", children: [_jsx("button", { className: "ghost-icon", type: "button", onClick: () => editWaitSubscription(subscription), disabled: subscription.status === "dispatching" ||
                                                                                    subscription.actionType === "notify" ||
                                                                                    waitSubscriptionAction !== null, title: subscription.actionType === "notify" ? "Notify-only wait has no prompt" : "Edit pending prompt", "aria-label": "Edit pending prompt", children: _jsx(Pencil, { "aria-hidden": "true" }) }), _jsx("button", { className: "ghost-icon danger", type: "button", onClick: () => void removeWaitSubscription(subscription), disabled: subscription.status === "dispatching" || waitSubscriptionAction !== null, title: subscription.status === "dispatching" ? "Wait is already dispatching" : "Remove pending wait", "aria-label": "Remove pending wait", children: waitSubscriptionAction === `remove:${subscription.id}` ? (_jsx(Loader2, { className: "spin", "aria-hidden": "true" })) : (_jsx(Trash2, { "aria-hidden": "true" })) })] })] }), _jsxs("td", { className: "pending-waits-event", title: event.subjectKey, children: [_jsx("strong", { children: event.topic }), _jsx("small", { children: event.subjectKey }), _jsx("span", { "data-status": subscription.status, children: subscription.status })] }), _jsx("td", { children: formatTimestamp(subscription.created) })] }, subscription.id));
                                                }) })] }) })) })] }) })), isSessionSearchOpen && (_jsx("div", { className: "modal-backdrop session-search-backdrop", role: "presentation", onMouseDown: () => setIsSessionSearchOpen(false), children: _jsxs("section", { className: "session-search-modal", role: "dialog", "aria-modal": "true", "aria-label": "Search sessions", onMouseDown: (event) => event.stopPropagation(), onKeyDown: (event) => {
                            if (event.key === "Escape")
                                setIsSessionSearchOpen(false);
                        }, children: [_jsxs("div", { className: "session-search-input-wrap", children: [_jsx(Search, { "aria-hidden": "true" }), _jsx("input", { value: sessionSearchQuery, onChange: (event) => setSessionSearchQuery(event.target.value), onKeyDown: (event) => {
                                            if (event.key === "Enter" && sessionSearchResults[0]) {
                                                event.preventDefault();
                                                setIsSessionSearchOpen(false);
                                                void switchSession(sessionSearchResults[0]);
                                            }
                                        }, placeholder: "Search sessions\u2026", "aria-label": "Search sessions", autoFocus: true }), _jsxs("div", { className: "session-search-actions", children: [isSearchingSessions ? _jsx(Loader2, { className: "spin", "aria-label": "Searching" }) : null, sessionSearchQuery ? (_jsx("button", { className: "session-search-clear", type: "button", onClick: () => setSessionSearchQuery(""), children: "Clear" })) : null, _jsx("button", { className: "ghost-icon session-search-close", type: "button", onClick: () => setIsSessionSearchOpen(false), title: "Close search", "aria-label": "Close search", children: _jsx(X, { "aria-hidden": "true" }) })] })] }), _jsx("div", { className: "session-search-results", "aria-live": "polite", children: !isSearchingSessions && sessionSearchResults.length === 0 ? (_jsx("p", { className: "session-search-empty", children: "No matching sessions." })) : (_jsx("div", { className: "session-search-table-wrap", children: _jsxs("table", { className: "session-search-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Name" }), _jsx("th", { children: "Time" }), _jsx("th", { children: "Turns" }), _jsx("th", { children: "Tokens" })] }) }), _jsx("tbody", { children: sessionSearchResults.map((record) => (_jsxs("tr", { tabIndex: 0, onClick: () => {
                                                        setIsSessionSearchOpen(false);
                                                        void switchSession(record);
                                                    }, onKeyDown: (event) => {
                                                        if (event.key === "Enter" || event.key === " ") {
                                                            event.preventDefault();
                                                            setIsSessionSearchOpen(false);
                                                            void switchSession(record);
                                                        }
                                                    }, children: [_jsxs("td", { className: "session-search-name", children: [_jsx("strong", { children: highlightSessionSearchText(displaySessionTitle(record.title), sessionSearchQuery) }), _jsxs("span", { className: "session-search-keyword-list", children: [Object.keys(record.keywordWeights).slice(0, 4).map((keyword) => (_jsx("span", { children: keyword }, `${record.id}:${keyword}`))), Object.keys(record.keywordWeights).length === 0 && _jsx("span", { children: "\u2014" })] }), sessionSearchQuery.trim() && (_jsx("small", { children: highlightSessionSearchText(record.matchedTurn || record.description || record.cwd, sessionSearchQuery) }))] }), _jsx("td", { children: formatTimestamp(record.updated) }), _jsx("td", { children: record.turnCount ?? 0 }), _jsx("td", { children: formatTokenCount(record.tokenCount ?? 0) })] }, record.id))) })] }) })) }), _jsxs("div", { className: "session-search-pagination", children: [_jsx("button", { type: "button", onClick: () => void loadSessionSearchPage(Math.max(0, sessionSearchPage.offset - sessionSearchPage.limit)), disabled: isSearchingSessions || sessionSearchPage.offset === 0, children: "Previous" }), _jsxs("span", { children: ["Page ", Math.floor(sessionSearchPage.offset / sessionSearchPage.limit) + 1, " /", " ", Math.max(1, Math.ceil(sessionSearchPage.total / sessionSearchPage.limit))] }), _jsx("button", { type: "button", onClick: () => void loadSessionSearchPage(sessionSearchPage.nextOffset ?? sessionSearchPage.offset), disabled: isSearchingSessions || !sessionSearchPage.hasMore || sessionSearchPage.nextOffset === null, children: "Next" })] })] }) })), promptEditor && (_jsx("div", { className: "modal-backdrop", role: "presentation", onMouseDown: () => setPromptEditor(null), children: _jsxs("section", { className: "prompt-editor-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "prompt-editor-title", onMouseDown: (event) => event.stopPropagation(), children: [_jsxs("div", { className: "modal-header", children: [_jsx("h2", { id: "prompt-editor-title", children: promptEditor.title }), _jsx("button", { className: "ghost-icon", type: "button", onClick: () => setPromptEditor(null), title: "Close", "aria-label": "Close", children: _jsx(X, { "aria-hidden": "true" }) })] }), _jsxs("form", { className: "prompt-editor-form", onSubmit: (event) => void savePromptEditor(event), children: [_jsx("textarea", { value: promptEditor.value, onChange: (event) => setPromptEditor((current) => (current ? { ...current, value: event.target.value } : current)), autoFocus: true }), _jsxs("div", { className: "account-login-actions", children: [_jsx("button", { className: "secondary", type: "button", onClick: () => setPromptEditor(null), children: "Cancel" }), _jsxs("button", { className: "secondary primary", type: "submit", disabled: !promptEditor.value.trim(), children: [_jsx(CheckSquare2, { "aria-hidden": "true" }), "Save"] })] })] })] }) })), isAccountLoginOpen && !isSettingsOpen && renderAccountLoginModal(), isSettingsOpen && (_jsxs("section", { className: "settings-page", "aria-label": "Settings", children: [_jsxs("header", { className: "settings-header", children: [_jsxs("div", { children: [_jsx("h1", { children: "Settings" }), _jsx("p", { children: "Review workspace activity and manage Codex accounts." })] }), _jsx("button", { className: "ghost-icon", type: "button", onClick: () => setIsSettingsOpen(false), title: "Close settings", "aria-label": "Close settings", children: _jsx(X, { "aria-hidden": "true" }) })] }), _jsxs("div", { className: "settings-layout", children: [_jsxs("nav", { className: "settings-tabs", "aria-label": "Settings sections", children: [_jsx("button", { type: "button", role: "tab", "aria-selected": settingsSection === "security", "data-active": settingsSection === "security", onClick: () => setSettingsSection("security"), children: "Security" }), _jsxs("button", { type: "button", role: "tab", "aria-selected": settingsSection === "profile", "data-active": settingsSection === "profile", onClick: () => setSettingsSection("profile"), children: [_jsx(Activity, { "aria-hidden": "true" }), "Profile"] }), _jsxs("button", { type: "button", role: "tab", "aria-selected": settingsSection === "suggestions", "data-active": settingsSection === "suggestions", onClick: () => setSettingsSection("suggestions"), children: [_jsx(Search, { "aria-hidden": "true" }), "Suggestions"] }), _jsxs("button", { type: "button", role: "tab", "aria-selected": settingsSection === "accounts", "data-active": settingsSection === "accounts", onClick: () => setSettingsSection("accounts"), children: [_jsx(User, { "aria-hidden": "true" }), "Accounts"] }), _jsxs("button", { type: "button", role: "tab", "aria-selected": settingsSection === "browserBridge", "data-active": settingsSection === "browserBridge", onClick: () => setSettingsSection("browserBridge"), children: [_jsx(TerminalSquare, { "aria-hidden": true }), "Browser Bridge"] })] }), settingsSection === "profile" ? (_jsx(ProfileSettingsPanel, { analytics: profileAnalytics, error: profileAnalyticsError, isLoading: isLoadingProfileAnalytics, workspaceId: profileWorkspaceId, workspaces: workspaceList, accountId: profileAccountId, onWorkspaceChange: (workspaceId) => {
                                        setProfileWorkspaceId(workspaceId);
                                        setProfileAccountId("");
                                        setProfileAnalytics(null);
                                    }, onAccountChange: setProfileAccountId })) : settingsSection === "suggestions" ? (_jsx(ComposerSuggestionSettingsPanel, { workspaceId: activeWorkspace?.id, keywords: suggestionKeywords, onKeywordsChange: async (keywords) => {
                                        const workspaceId = activeWorkspace?.id;
                                        if (!workspaceId)
                                            return;
                                        const response = await fetch("/api/composer-suggestion-keywords", {
                                            method: "PUT",
                                            headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify({ workspaceId, keywords })
                                        });
                                        if (!response.ok)
                                            throw new Error(`API returned ${response.status}`);
                                        const payload = await response.json();
                                        setSuggestionKeywords(Array.isArray(payload.keywords) ? payload.keywords : []);
                                    } })) : settingsSection === "security" ? (_jsx(SecuritySettingsPanel, {})) : settingsSection === "browserBridge" ? (_jsx(BrowserBridgeSettingsPanel, {})) : (_jsxs("div", { className: "settings-content", role: "tabpanel", "aria-label": "Accounts", children: [_jsxs("div", { className: "settings-section-heading", children: [_jsxs("div", { children: [_jsx("h2", { children: "Accounts" }), _jsx("p", { children: "Choose which accounts this workspace can use for load balancing." })] }), _jsxs("button", { className: "secondary settings-add-account", type: "button", onClick: () => openAccountLoginDialog(), children: [_jsx(UserPlus, { "aria-hidden": "true" }), "Add account"] })] }), isAccountLoginOpen && (_jsxs("section", { className: "settings-card account-login-panel", "aria-label": "Add account", children: [_jsxs("div", { className: "settings-card-header", children: [_jsxs("div", { children: [_jsx("h3", { children: accountLoginTargetId ? "Login account" : "Add account" }), _jsx("p", { children: "Save an API credential or connect a ChatGPT account." })] }), _jsx("button", { className: "ghost-icon", type: "button", onClick: () => resetAccountLoginDialog(), title: "Close", "aria-label": "Close", children: _jsx(X, { "aria-hidden": "true" }) })] }), _jsxs("div", { className: "account-login-tabs", role: "tablist", "aria-label": "Account login method", children: [_jsx("button", { type: "button", role: "tab", "aria-selected": accountLoginMode === "api", "data-active": accountLoginMode === "api", onClick: () => {
                                                                setAccountLoginMode("api");
                                                                setPendingAccountLogin(null);
                                                            }, children: "API setting" }), _jsx("button", { type: "button", role: "tab", "aria-selected": accountLoginMode === "chatgpt", "data-active": accountLoginMode === "chatgpt", onClick: () => {
                                                                setAccountLoginMode("chatgpt");
                                                                setPendingAccountLogin(null);
                                                            }, children: "ChatGPT login" })] }), accountLoginMode === "api" ? (_jsxs("form", { className: "account-login-form", onSubmit: (event) => void createApiAccount(event), children: [_jsxs("label", { children: [_jsx("span", { children: "Account name" }), _jsx("input", { value: newAccountName, onChange: (event) => setNewAccountName(event.target.value), placeholder: "Work API", autoFocus: true })] }), _jsxs("label", { children: [_jsx("span", { children: "API URL" }), _jsx("input", { value: apiAccountUrl, onChange: (event) => setApiAccountUrl(event.target.value), placeholder: "https://api.openai.com/v1" })] }), _jsxs("label", { children: [_jsx("span", { children: "API key" }), _jsx("input", { value: apiAccountKey, onChange: (event) => setApiAccountKey(event.target.value), type: "password", placeholder: "sk-..." })] }), _jsxs("div", { className: "account-login-actions", children: [_jsx("button", { className: "secondary", type: "button", onClick: () => void importCurrentAccount(), children: "Use workspace auth" }), _jsxs("button", { className: "secondary primary", type: "submit", disabled: !newAccountName.trim() || !apiAccountKey.trim() || isSavingAccount, children: [isSavingAccount ? _jsx(Loader2, { className: "spin", "aria-hidden": "true" }) : _jsx(UserPlus, { "aria-hidden": "true" }), "Save API account"] })] })] })) : (_jsxs("div", { className: "account-login-form", children: [_jsxs("label", { children: [_jsx("span", { children: "Account name" }), _jsx("input", { value: newAccountName, onChange: (event) => setNewAccountName(event.target.value), placeholder: "ChatGPT Pro", autoFocus: true })] }), pendingAccountLogin ? (_jsxs("div", { className: "login-link-panel", children: [_jsx("span", { children: "Login link" }), _jsx("a", { href: pendingAccountLogin.loginUrl, target: "_blank", rel: "noreferrer", children: pendingAccountLogin.loginUrl }), pendingAccountLogin.userCode && (_jsxs("div", { className: "device-code-row", children: [_jsx("span", { children: "Device code" }), _jsx("strong", { children: pendingAccountLogin.userCode }), _jsx("button", { className: "secondary", type: "button", onClick: () => void navigator.clipboard?.writeText(pendingAccountLogin.userCode ?? ""), children: "Copy" })] })), !pendingAccountLogin.userCode && _jsx("span", { children: "Complete sign-in in the browser. This page will update automatically." })] })) : null, _jsxs("div", { className: "account-login-actions", children: [_jsx("button", { className: "secondary", type: "button", onClick: () => void importCurrentAccount(), children: "Use workspace auth" }), _jsxs("button", { className: "secondary", type: "button", onClick: () => void startChatGptLogin(), disabled: !newAccountName.trim() || isSavingAccount || Boolean(pendingAccountLogin), children: [isSavingAccount && !pendingAccountLogin ? _jsx(Loader2, { className: "spin", "aria-hidden": "true" }) : _jsx(UserPlus, { "aria-hidden": "true" }), "Sign in with ChatGPT"] })] })] }))] })), _jsxs("section", { className: "settings-card", "aria-labelledby": "workspace-accounts-title", children: [_jsxs("div", { className: "settings-card-header settings-account-map-header", children: [_jsxs("div", { children: [_jsx("h3", { id: "workspace-accounts-title", children: "Workspace accounts" }), _jsxs("p", { children: [activeWorkspace?.name ?? "Default", " \u00B7 ", workspaceAccountList.length, " bound"] })] }), _jsxs("div", { className: "settings-bind-account", children: [_jsxs("select", { value: bindAccountId, onChange: (event) => setBindAccountId(event.target.value), disabled: unboundAccounts.length === 0, "aria-label": "Account to bind", children: [_jsx("option", { value: "", children: unboundAccounts.length ? "Choose account" : "All accounts bound" }), unboundAccounts.map((account) => (_jsx("option", { value: account.id, children: accountIdentityLabel(account) }, account.id)))] }), _jsxs("button", { className: "secondary", type: "button", onClick: () => void bindAccount(), disabled: !bindAccountId, children: [_jsx(Plus, { "aria-hidden": "true" }), "Bind"] })] })] }), _jsxs("div", { className: "load-balance-table", role: "table", "aria-label": "Workspace account map", children: [_jsxs("div", { className: "load-balance-row load-balance-head", role: "row", children: [_jsx("span", { children: "Candidate of LB" }), _jsx("span", { children: "Account" }), _jsx("span", { children: "Remaining" }), _jsx("span", { children: "Reset" }), _jsx("span", { children: "Status" })] }), accountList.map((account) => {
                                                            const tier = formatAccountTier(account);
                                                            const mapped = workspaceAccountIds.includes(account.id);
                                                            return (_jsxs("div", { className: "load-balance-row", role: "row", children: [_jsx("span", { children: _jsx("input", { type: "checkbox", checked: mapped, "aria-label": `${mapped ? "Unbind" : "Bind"} ${accountIdentityLabel(account)}`, onChange: (event) => {
                                                                                if (event.currentTarget.checked) {
                                                                                    void bindAccount(account.id);
                                                                                }
                                                                                else {
                                                                                    void unbindAccount(account.id);
                                                                                }
                                                                            } }) }), _jsxs("span", { children: [_jsx("strong", { children: account.name }), _jsxs("small", { children: [account.email || account.externalAccountId || account.id, tier ? ` · ${tier}` : ""] })] }), _jsx("span", { children: formatQuotaRemaining(account) }), _jsx("span", { children: formatQuotaReset(account) }), _jsx("span", { children: formatQuotaStatus(account, activeAccount?.id ?? null) }), _jsx("span", { className: "settings-account-actions", children: _jsx("button", { className: "settings-delete-account", type: "button", onClick: () => void deleteAccount(account), disabled: Boolean(deletingAccountId), title: `Delete ${accountIdentityLabel(account)}`, "aria-label": `Delete ${accountIdentityLabel(account)}`, children: deletingAccountId === account.id ? _jsx(Loader2, { className: "spin", "aria-hidden": "true" }) : _jsx(Trash2, { "aria-hidden": "true" }) }) })] }, account.id));
                                                        }), accountList.length === 0 && _jsx("p", { className: "settings-empty", children: "No accounts yet. Add one to get started." })] })] })] }))] })] }))] }) }));

}
