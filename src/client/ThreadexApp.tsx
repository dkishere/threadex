// @ts-nocheck
// The legacy app shell is now a TypeScript/TSX source module. Feature-sized
// pieces are migrated out of this file incrementally; the temporary directive
// keeps the existing UI buildable while those boundaries gain strict types.
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Activity, ArrowDown, ArrowLeft, ArrowUp, BetweenHorizontalStart, CheckCircle2, CheckSquare2, ChevronDown, ChevronRight, Circle, Clock3, Copy, Cpu, Database, Diff, ExternalLink, FileText, Folder, GitFork, Lightbulb, ListChecks, Loader2, MessageSquare, Pencil, Plus, Quote, Search, Send, ShieldCheck, Settings, RotateCcw, Shrink, Square, Target, TerminalSquare, TriangleAlert, Trash2, User, UserPlus, X } from "lucide-react";
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { eventStore, useEventStore } from "./eventStore";
import { MonacoDiffEditor } from "./MonacoDiffEditor";
import { FileEditIcon } from "./FileEditIcon";
import { MarkdownContent } from "./MarkdownContent";
import { DeferredDetails } from "./DeferredDetails";
import { sameTimelineItems } from "./timelineMemo";
import { InlineLinkComposer } from "./InlineLinkComposer";
import { SessionTodoPanel } from "./SessionTodoPanel";
import { formatResponseAnnotationsPrompt, parseResponseAnnotations } from "./responseAnnotations";
import { buildCodexReference, parseCodexReference } from "../codexReference";
import { isAccountLoginRequiredMessage } from "../codexAuth";
import { finalizePendingReasoningItems, finalizePendingReasoningSegments, liveItemKey, mergeSnapshotLiveItems, withTurnLevelStatus } from "./liveItemMerge";
import { navigationUrl, readNavigationTarget, readOptionalNavigationTarget } from "./navigation";
import { APPROVAL_POLICY_OPTIONS, AUTO_MODEL_VALUE, COMPOSER_DRAFT_STORAGE_KEY, CONTEXT_FORK_TAG_LABEL, EFFORT_OPTIONS, FORCE_PLAN_TAG_LABEL, GOAL_MODE_TAG_LABEL, MAX_ATTACHMENTS, MESSAGE_BOTTOM_THRESHOLD, MODEL_OPTIONS, MODEL_SELECTOR_STORAGE_KEY, NEW_SESSION_QUEUE_KEY, STORAGE_KEY, ULTRA_EFFORT_OPTIONS } from "./appConstants";
import { ProfileSettingsPanel } from "./ProfileSettingsPanel";
import { AttachmentList, formatBytes, nextPastedTextFileName, normalizeStoredUserInput, readAttachment, shouldCompactPastedText } from "./attachments";
import { browserBridgeContextAttachmentName, parseBrowserBridgeContext } from "./browserBridgeContext";
import { ResponseAnnotationList, annotationLabel } from "./ResponseAnnotationList";
import { groupTranscriptByStepMarkers, stepMarkerFromText } from "./transcriptSteps";
import { attachCommentaryActivities, commentaryActivityCounts, commentaryTypeForActivities } from "./commentaryActivity";
import { isExactRootSubagentActivity, visibleSubagentAgents } from "./subagentTranscript";
import { fetchSubagentTranscript } from "./subagentTranscriptClient";
import { findAssistantMessageId, findUserMessageForTurn, groupSessionsByBaseDir, moveQueuedPromptInList, moveQueuedPromptToTarget, pendingAssistantMessages, promoteQueuedPromptToSteer, reorderPendingTurnMessages, toSessionPageState } from "./sessionUtils";
import { developerInstructionsIndicateForcePlan, extractTodoMcpPromptBlocks, isTodoMcpPromptText } from "./todoPrompt";
import { isTodoPlanAwaitingClarification } from "../todoPlan";
import { formatTimestamp, formatTimestampShort, formatTokenCount } from "./formatters";
import { compactFilePath } from "./filePathDisplay";
import { getCodexEventName, isCodexTurnCompletedEvent, isLiveItem, isStreamItem, parseEvent, readApiError, readEventStream, readRecord } from "./appStreamProtocol";
import { accountIdentityLabel, formatAccountOptionLabel, formatAccountSelectLabel, accountNeedsLogin, formatAccountQuotaPair, formatLoadBalanceAccountLabel, combinedQuotaPercent, formatQuotaPercent, formatQuotaRemaining, formatQuotaStatus, accountResetCredits, earliestExpiringResetCredit, formatResetCreditExpiry, resetOutcomeLabel, formatQuotaReset, quotaWindowPair, quotaWindows, quotaWindowsByDuration, isFiveHourQuotaWindow, isWeeklyQuotaWindow, readQuotaWindow, readNumberField } from "./accountFormatters";
import * as appActions01 from "./sessionActions01";
import * as appActions02 from "./sessionActions02";
import * as appActions03 from "./sessionActions03";
import * as appActions04 from "./sessionActions04";
import * as appActions05 from "./sessionActions05";
import * as appActions06 from "./sessionActions06";
import { useSessionEffects } from "./useSessionEffects";
import * as sessionHelpers01 from "./sessionHelpers01";
import * as sessionHelpers02 from "./sessionHelpers02";
import * as sessionHelpers03 from "./sessionHelpers03";
import * as sessionHelpers04 from "./sessionHelpers04";
import { ThreadexShell } from "./ThreadexShell";
import { openProjectFiles } from "./ProjectFilesViewer";
import { serializeTurnIssueCopy } from "./turnIssueCopy";
const FileAnnotationComposerContext = createContext(null);
function setsEqual(left, right) {
    if (left.size !== right.size)
        return false;
    for (const value of left) {
        if (!right.has(value))
            return false;
    }
    return true;
}
export function App() { return ThreadexShell({ APPROVAL_POLICY_OPTIONS, AUTO_MODEL_VALUE, Activity, ApprovalEvent, ArrowDown, ArrowLeft, ArrowUp, BetweenHorizontalStart, AttachmentList, CONTEXT_FORK_TAG_LABEL, CheckCircle2, CheckSquare2, ChevronDown, ChevronRight, Circle, Clock3, CompletedTurn, Copy, Cpu, Database, Diff, EFFORT_OPTIONS, ExternalLink, FileAnnotationComposerContext, FileText, Folder, FORCE_PLAN_TAG_LABEL, GOAL_MODE_TAG_LABEL, GitFork, InlineLinkComposer, ListChecks, LiveEventList, Loader2, MAX_ATTACHMENTS, MESSAGE_BOTTOM_THRESHOLD, MODEL_OPTIONS, MarkdownContent, MessageTimeline, Pencil, Plus, ProfileSettingsPanel, Quote, ResponseAnnotationList, RotateCcw, Search, Send, ServerPrefixPanels, Settings, ShieldCheck, Square, StatusUpdateIndicator, Target, TerminalSquare, TodoPanel, Trash2, ULTRA_EFFORT_OPTIONS, User, UserPlus, X, _Fragment, _jsx, _jsxs, accountIdentityLabel, accountNeedsLogin, accountResetCredits, annotationLabel, appActions01, appActions02, appActions03, appActions04, appActions05, appActions06, approvalEventToLiveItem, browserBridgeContextAttachmentName, buildCodexReference, buildMessageIndicatorMarks, capitalize, compareSessionRecordsByUpdated, createSystemMessage, displaySessionTitle, earliestExpiringResetCredit, fileChangeItemFromPatchCommand, findSlashTrigger, formatAccountSelectLabel, formatBytes, formatLoadBalanceAccountLabel, formatQuotaPercent, formatQuotaRemaining, formatQuotaReset, formatQuotaStatus, formatResetCreditExpiry, formatTimestamp, formatTimestampShort, formatTokenCount, getSessionExecutionStatus, getWorkspaceTabSummary, groupSessionsByBaseDir, groupTranscriptByStepMarkers, hasVisibleTodoPlan, highlightSessionSearchText, isTodoPlanAwaitingClarification, latestTurnIssueTracker, messageIndicatorMarkTop, messageTimingLabel, modelOptionLabel, movePendingModelPreferences, moveStoredComposerDraft, normalizeComposerDraft, normalizeSessionModelPreferences, normalizeStoredApprovalPolicy, parseBrowserBridgeContext, parseResponseAnnotations, patchStoredComposerDraft, pendingPromptForSubscription, promptDisplayMetadata, queuedPromptSessionKey, quotaWindowsByDuration, readOptionalNavigationTarget, readPendingModelPreferences, readStoredComposerDraft, readStoredModelSelector, readStoredSession, removePendingModelPreferencesIfMatches, sessionExecutionStatusLabel, shortId, shouldRenderMessageTimeline, summarizeTitle, supportsUltraEffort, useCallback, useEventStore, useMemo, useRef, useSessionEffects, useState, writePendingModelPreferences, appendSteerSegment, appendTextSegment, applyLiveItemToMessage, approvalDecisionLabel, approvalRecordToLiveItem, cleanLoginUrlValue, composerLinkToken, describeCodexEvent, describeStreamItem, developerInstructionRecordFromPayload, developerInstructionsIndicateForcePlan, elementForSelectionNode, eventStore, finalizeTerminalAssistantMessage, findAssistantMessageId, findUserMessageForTurn, formatComposerLinkMarkdown, formatResponseAnnotationsPrompt, getCodexEventName, isAccountLoginRequiredMessage, isApprovalLiveItem, isCodexTurnCompletedEvent, isInactiveSteerResponse, isLikelyBackendDisconnect, isNoRolloutFoundMessage, itemEventRank, liveItemKey, mergeDeveloperInstructionRecords, moveQueuedPromptInList, moveQueuedPromptToTarget, navigationUrl, nextPastedTextFileName, parseCodexReference, parsePastedHttpUrl, pendingAssistantMessages, promoteQueuedPromptToSteer, readApiError, readAttachment, readEventStream, readNavigationTarget, readRecord, readStringField, reorderPendingTurnMessages, replaceComposerLinkTokens, resetOutcomeLabel, resizeEditor, sessionTurnsToMessages, setsEqual, shouldCompactPastedText, sleep, slugify, toSessionPageState, upsertPendingApprovalItem, writeStoredSession }); }
function appendTextSegment(segments, sourceId, text) {
    if (!text) {
        return segments;
    }
    const lastSegment = segments.at(-1);
    if (lastSegment?.type === "text" && (lastSegment.sourceId ?? lastSegment.id) === sourceId) {
        return [
            ...segments.slice(0, -1),
            {
                ...lastSegment,
                text: `${lastSegment.text}${text}`
            }
        ];
    }
    const matchingCount = segments.filter((segment) => segment.type === "text" && (segment.sourceId ?? segment.id) === sourceId).length;
    return [
        ...segments,
        {
            id: `${sourceId}:${matchingCount}`,
            sourceId,
            type: "text",
            text
        }
    ];
}
function appendSteerSegment(segments, message) { return sessionHelpers01.appendSteerSegment({ steerSegmentFromMessage }, segments, message); }
function steerSegmentFromMessage(message) { return sessionHelpers01.steerSegmentFromMessage({  }, message); }
function mergeSnapshotSegmentsWithLocalSteers(snapshotSegments, existingSegments = [], preservedSteers = []) { return sessionHelpers01.mergeSnapshotSegmentsWithLocalSteers({ appendSteerSegment, compareSteerMessages, isDisplayableMessageSegment, normalizeMessageSegments, steerSegmentFromMessage }, snapshotSegments, existingSegments, preservedSteers); }
function itemEventRank(eventType) { return sessionHelpers01.itemEventRank({  }, eventType); }
function upsertLiveSegment(segments, item) { return sessionHelpers01.upsertLiveSegment({ isDisplayableLiveItem, liveItemForDisplay, liveItemKey }, segments, item); }
function applyLiveItemToMessage(message, item) { return sessionHelpers01.applyLiveItemToMessage({ finalizePendingReasoningItems, isDisplayableLiveItem, liveItemForDisplay, liveItemKey, normalizeLiveItems, normalizeMessageSegments, upsertLiveSegment }, message, item); }
function finalizeTerminalAssistantMessage(message, overrides = {}) { return sessionHelpers01.finalizeTerminalAssistantMessage({ finalizePendingReasoningItems, finalizePendingReasoningSegments, normalizeLiveItems, normalizeMessageSegments }, message, overrides); }
function approvalEventToLiveItem(event, status) { return sessionHelpers01.approvalEventToLiveItem({  }, event, status); }
function streamItemsToSegments(items, rootThreadId) { return sessionHelpers01.streamItemsToSegments({ appendTextSegment, liveItemKey, normalizeMessageSegments, upsertLiveSegment }, items, rootThreadId); }
function liveItemForDisplay(item) { return sessionHelpers01.liveItemForDisplay({ fileChangeItemFromPatchCommand }, item); }
function normalizeLiveItems(items) { return sessionHelpers01.normalizeLiveItems({ approvalCommandItemKey, isDisplayableLiveItem, isSuppressedCommandItem, liveItemForDisplay }, items); }
function normalizeMessageSegments(segments) { return sessionHelpers01.normalizeMessageSegments({ approvalCommandItemKey, isDisplayableLiveItem, isSuppressedCommandItem, liveItemForDisplay }, segments); }
function isSuppressedCommandItem(item, pendingApprovalItemIds) { return sessionHelpers01.isSuppressedCommandItem({ liveItemKey }, item, pendingApprovalItemIds); }
function approvalCommandItemKey(item) { return sessionHelpers01.approvalCommandItemKey({ liveItemKey, readRecord, readStringField }, item); }
function summarizeTitle(value) { return sessionHelpers01.summarizeTitle({  }, value); }
function displaySessionTitle(value) { return sessionHelpers01.displaySessionTitle({  }, value); }
function summarizeCommand(value) { return sessionHelpers01.summarizeCommand({  }, value); }
function elementForSelectionNode(node) { return sessionHelpers01.elementForSelectionNode({  }, node); }
function shouldRenderMessageTimeline(message) { return sessionHelpers01.shouldRenderMessageTimeline({ isDisplayableMessageSegment }, message); }
const LiveEventList = memo(function LiveEventList({ items, anchorPrefix, sessionId: providedSessionId }) { return sessionHelpers01.LiveEventList({ FileAnnotationComposerContext, TimelineEntries, _jsx, compactTimelineEntries, isDisplayableLiveItem, liveItemKey, useContext }, { items, anchorPrefix, sessionId: providedSessionId }); });
export const MessageTimeline = memo(function MessageTimeline(props) {
    const annotationContext = useContext(FileAnnotationComposerContext);
    if (props.message) return sessionHelpers01.CompletedTurn({ MarkdownContent, TimelineEntries, TurnChangeList, TurnIssueTracker, _Fragment, _jsx, _jsxs, appendSteerSegment, collectFileChanges, compactTimelineEntries, compareSteerMessages, isDisplayableLiveItem, isDisplayableMessageSegment, latestTurnIssueTracker, liveItemKey, removeLastTextSegment, withTurnLevelStatus }, props);
    return sessionHelpers01.MessageTimeline({ annotationContext, TimelineEntries, TurnIssueTracker, _jsx, _jsxs, compactTimelineEntries, finalizePendingReasoningSegments, isDisplayableMessageSegment, latestTurnIssueTracker, withTurnLevelStatus }, props);
}, (previous, next) => {
    if (previous.message && next.message) return previous.message === next.message && previous.codexSessionId === next.codexSessionId && previous.sessionId === next.sessionId && previous.workspaceId === next.workspaceId && previous.steerMessages.length === next.steerMessages.length && previous.steerMessages.every((message, index) => message === next.steerMessages[index]);
    return Object.keys(previous).length === Object.keys(next).length && Object.keys(previous).every((key) => Object.is(previous[key], next[key]));
});
function TimelineEntries({ entries, anchorPrefix, groupPlanSteps = true, completed = false, sessionId }) { return sessionHelpers01.TimelineEntries({ ActionGroup, LiveEvent, MarkdownContent, PlanStepTimeline, SteerEvent, StructuredCommentEvent, _Fragment, _jsx, attachCommentaryActivities, groupTimelineEntriesByPlanSteps, timelineAnchorId }, { entries, anchorPrefix, groupPlanSteps, completed, sessionId }); }
function groupTimelineEntriesByPlanSteps(entries, completed) { return sessionHelpers01.groupTimelineEntriesByPlanSteps({ groupTimelineEntriesByTextStepMarkers, groupTimelineEntriesByTodoList }, entries, completed); }
function groupTimelineEntriesByTodoList(entries) { return sessionHelpers01.groupTimelineEntriesByTodoList({ nextActivePlanStepIndex, syncPlanSteps, todoListItemFromEntry }, entries); }
function groupTimelineEntriesByTextStepMarkers(entries, completed) { return sessionHelpers01.groupTimelineEntriesByTextStepMarkers({ stepMarkerFromTimelineEntry }, entries, completed); }
function stepMarkerFromTimelineEntry(entry) { return sessionHelpers01.stepMarkerFromTimelineEntry({ stepMarkerFromText }, entry); }
function syncPlanSteps(steps, item) { return sessionHelpers01.syncPlanSteps({  }, steps, item); }
function nextActivePlanStepIndex(steps) { return sessionHelpers01.nextActivePlanStepIndex({  }, steps); }
function todoListItemFromEntry(entry) { return sessionHelpers01.todoListItemFromEntry({  }, entry); }
function PlanStepTimeline({ id, steps, anchorPrefix, sessionId, completed = false }) { return sessionHelpers01.PlanStepTimeline({ CheckCircle2, ChevronRight, Circle, TimelineEntries, _jsx, _jsxs, countTimelineLeafEntries, nextActivePlanStepIndex, planStepStatus, planStepStatusLabel }, { id, steps, anchorPrefix, sessionId, completed }); }
function planStepStatus(step, index, activeIndex) { return sessionHelpers01.planStepStatus({  }, step, index, activeIndex); }
function planStepStatusLabel(status) { return sessionHelpers01.planStepStatusLabel({  }, status); }
function countTimelineLeafEntries(entries) { return sessionHelpers01.countTimelineLeafEntries({  }, entries); }
function TodoPanel({ todo, ...props }) { return sessionHelpers01.TodoPanel({ SessionTodoPanel, _jsx }, { todo, ...props }); }
function timelineAnchorId(messageId, entryId) { return sessionHelpers01.timelineAnchorId({  }, messageId, entryId); }
function compactTimelineEntries(segments) { return sessionHelpers01.compactTimelineEntries({ compactLiveItemGroup }, segments); }
function removeLastTextSegment(segments) { return sessionHelpers01.removeLastTextSegment({  }, segments); }
const ActionGroup = memo(function ActionGroup({ id, groupType, items, sessionId }) { return sessionHelpers01.ActionGroup({ ChevronRight, FileEditIcon, LiveEvent, Search, TerminalSquare, UserPlus, _jsx, _jsxs, actionGroupTitle }, { id, groupType, items, sessionId }); }, (previous, next) => previous.id === next.id && previous.groupType === next.groupType && previous.sessionId === next.sessionId && sameTimelineItems(previous.items, next.items));
function SteerEvent({ id, text, attachments, forcePlan }) { return sessionHelpers01.SteerEvent({ AttachmentList, MarkdownContent, User, _jsx, _jsxs }, { id, text, attachments, forcePlan }); }
function isCommandLiveItem(item) { return sessionHelpers01.isCommandLiveItem({  }, item); }
function compactLiveItemGroup(item) { return sessionHelpers01.compactLiveItemGroup({ isCommandLiveItem }, item); }
function actionGroupTitle(items, groupType) { return sessionHelpers01.actionGroupTitle({ collectFileChanges, subagentNames }, items, groupType); }
// Use the same React component through the running -> completed transition.
export const CompletedTurn = MessageTimeline;
function latestTurnIssueTracker(values) { return sessionHelpers01.latestTurnIssueTracker({  }, values); }
function TurnIssueTracker({ tracker, codexSessionId, sessionId, turnId, workspaceId }) { return sessionHelpers01.TurnIssueTracker({ Copy, _jsx, _jsxs, serializeTurnIssueCopy, useState }, { tracker, codexSessionId, sessionId, turnId, workspaceId }); }
function ServerPrefixPanels({ startupSnapshot, developerInstructions, showStartup = true }) {
    // Prompt metadata belongs in the Detail popup so the transcript only shows
    // the user-visible prompt. The arguments remain accepted for old callers.
    void startupSnapshot;
    void developerInstructions;
    void showStartup;
    return null;
}
function ServerPrefixPanel({ block }) { return sessionHelpers02.ServerPrefixPanel({ ChevronRight, FileText, ListChecks, TerminalSquare, _jsx, _jsxs }, { block }); }
function serverPrefixBlocks(startupSnapshot, developerInstructions, showStartup = true) { return sessionHelpers02.serverPrefixBlocks({ extractServerProvidedBlocks, extractTodoMcpPromptBlocks, isTodoMcpPromptText, serverPrefixMetadata }, startupSnapshot, developerInstructions, showStartup); }
function extractServerProvidedBlocks(value) { return sessionHelpers02.extractServerProvidedBlocks({  }, value); }
function serverPrefixMetadata(text, source) { return sessionHelpers02.serverPrefixMetadata({ isTodoMcpPromptText }, text, source); }
function TurnChangeList({ changes, sessionId, turnId }) { return sessionHelpers02.TurnChangeList({ FileEditIcon, FileChangeList, Folder, openProjectFiles, _jsx, _jsxs }, { changes, sessionId, turnId }); }
function FileChangeList({ changes }) { return sessionHelpers02.FileChangeList({ FileEditIcon, FileChangeDiffPopup, _Fragment, _jsx, _jsxs, compactFilePath, fileChangeLabel, fileChangeTone, useState }, { changes }); }
function hasVisibleTodoPlan(todo) { return sessionHelpers02.hasVisibleTodoPlan({  }, todo); }
const LiveEvent = memo(function LiveEvent({ item, sessionId }) { return sessionHelpers02.LiveEvent({ ApprovalEvent, CheckSquare2, ChevronRight, Circle, DeferredDetails, FileChangeEvent, Loader2, MarkdownContent, MessageSquare, Shrink, StatusUpdateIndicator, StructuredCommentEvent, SubagentEvent, _jsx, _jsxs, commandStatus, fileChangeItemFromPatchCommand }, { item, sessionId }); });
const StructuredCommentEvent = memo(function StructuredCommentEvent({ item, activities = [], id, sessionId }) { return sessionHelpers02.StructuredCommentEvent({ ChevronRight, DeferredDetails, FileEditIcon, LiveEvent, MarkdownContent, Search, TerminalSquare, _jsx, _jsxs, commentaryActivityCounts, commentaryTypeForActivities, structuredCommentIcon, structuredCommentType }, { item, activities, id, sessionId }); }, (previous, next) => previous.item === next.item && previous.id === next.id && previous.sessionId === next.sessionId && sameTimelineItems(previous.activities ?? [], next.activities ?? []));
function structuredCommentType(type) { return sessionHelpers02.structuredCommentType({  }, type); }
function structuredCommentIcon(type) { return sessionHelpers02.structuredCommentIcon({ CheckCircle2, Lightbulb, MessageSquare, Pencil, Search, TriangleAlert }, type); }
function StatusUpdateIndicator({ text, spinning = true, completedIcon }) { return sessionHelpers02.StatusUpdateIndicator({ CheckCircle2, Loader2, _jsx, _jsxs }, { text, spinning, completedIcon }); }
function SubagentEvent({ item, sessionId }) { return sessionHelpers02.SubagentEvent({ ChevronRight, MarkdownContent, SubagentTranscript, UserPlus, _Fragment, _jsx, _jsxs, fetchSubagentTranscript, formatSubagentStatus, subagentNames, subagentStatusTone, subagentToolLabel, useEffect, useRef, useState, visibleSubagentAgents }, { item, sessionId }); }
function SubagentTranscript({ anchorPrefix, onRetry, state, threadId, sessionId }) {
    const workspaceId = useContext(FileAnnotationComposerContext)?.workspaceId;
    return sessionHelpers02.SubagentTranscript({ Loader2, MessageSquare, MessageTimeline, TriangleAlert, _jsx, _jsxs, isStreamItem, shortId, streamItemsToSegments, subagentStatusTone }, { anchorPrefix, onRetry, state, threadId, sessionId, workspaceId });
}
function subagentNames(item) { return sessionHelpers02.subagentNames({  }, item); }
function subagentToolLabel(tool) { return sessionHelpers02.subagentToolLabel({  }, tool); }
function formatSubagentStatus(status) { return sessionHelpers02.formatSubagentStatus({  }, status); }
function subagentStatusTone(status) { return sessionHelpers02.subagentStatusTone({  }, status); }
function FileChangeEvent({ item }) { return sessionHelpers02.FileChangeEvent({ ChevronRight, FileChangeList, _Fragment, _jsx, _jsxs, summarizeFileChangeItem }, { item }); }
function ApprovalEvent({ item, onDecisionSubmitted, compact = false }) { return sessionHelpers02.ApprovalEvent({ FileEditIcon, TerminalSquare, _jsx, _jsxs, approvalAvailableDecisions, approvalDecisionLabel, readRecord, readStringField, summarizeCommand, useState }, { item, onDecisionSubmitted, compact }); }
function FileChangeDiffPopup({ change, onClose }) { return sessionHelpers02.FileChangeDiffPopup({ FileAnnotationComposerContext, MonacoDiffEditor, X, _jsx, _jsxs, buildDiffTextPair, fileChangeLabel, fileChangeTone, getFileName, hasChangeText, useContext, useEffect, useMemo, useState }, { change, onClose }); }
function fileChangeItemFromPatchCommand(item) { return sessionHelpers02.fileChangeItemFromPatchCommand({ parseApplyPatchChanges }, item); }
function parseApplyPatchChanges(command) { return sessionHelpers02.parseApplyPatchChanges({ applyPatchLinesToTextPair, readApplyPatchBody }, command); }
function readApplyPatchBody(command) { return sessionHelpers02.readApplyPatchBody({  }, command); }
function applyPatchLinesToTextPair(lines) { return sessionHelpers02.applyPatchLinesToTextPair({  }, lines); }
function commandStatus(item) { return sessionHelpers02.commandStatus({  }, item); }
function collectFileChanges(items) { return sessionHelpers02.collectFileChanges({  }, items); }
function formatTurnDuration(durationMs) { return sessionHelpers02.formatTurnDuration({  }, durationMs); }
function messageTimingLabel(message, now) { return sessionHelpers02.messageTimingLabel({ formatMessageTimestamp, formatTurnDuration }, message, now); }
function formatMessageTimestamp(timestamp) { return sessionHelpers02.formatMessageTimestamp({  }, timestamp); }
function summarizeFileChangeItem(item) { return sessionHelpers02.summarizeFileChangeItem({ fileChangeStatusLabel }, item); }
function fileChangeStatusLabel(status) { return sessionHelpers02.fileChangeStatusLabel({  }, status); }
function fileChangeLabel(kind) { return sessionHelpers02.fileChangeLabel({  }, kind); }
function fileChangeTone(kind) { return sessionHelpers02.fileChangeTone({  }, kind); }
function hasChangeText(change) { return sessionHelpers02.hasChangeText({ readChangeText }, change); }
function buildDiffTextPair(change) { return sessionHelpers03.buildDiffTextPair({ diffTextToTextPair, readChangeText }, change); }
function diffTextToTextPair(value) { return sessionHelpers03.diffTextToTextPair({  }, value); }
function readChangeText(change, keys) { return sessionHelpers03.readChangeText({  }, change, keys); }
function getFileName(path) { return sessionHelpers03.getFileName({  }, path); }
function createSystemMessage(content = "Codex app-server backend connected through /api/chat. Start a turn to create or resume a session.") { return sessionHelpers03.createSystemMessage({  }, content); }
function developerInstructionRecordFromPayload(payload) { return sessionHelpers03.developerInstructionRecordFromPayload({  }, payload); }
function normalizeDeveloperInstructionRecords(value) { return sessionHelpers03.normalizeDeveloperInstructionRecords({ developerInstructionRecordFromPayload, mergeDeveloperInstructionRecords }, value); }
function mergeDeveloperInstructionRecords(...groups) { return sessionHelpers03.mergeDeveloperInstructionRecords({ developerInstructionRecordFromPayload }, ...groups); }
function sessionTurnsToMessages(turns, title, existingMessages = [], rootThreadId) { return sessionHelpers03.sessionTurnsToMessages({ createSystemMessage, developerInstructionsIndicateForcePlan, finalizePendingReasoningItems, finalizePendingReasoningSegments, isLiveItem, isStreamItem, mergeDeveloperInstructionRecords, mergeSnapshotLiveItems, mergeSnapshotSegmentsWithLocalSteers, normalizeLiveItems, normalizeStoredUserInput, streamItemsToSegments, turnDurationMs }, turns, title, existingMessages, rootThreadId); }
function promptDisplayMetadata(value) { return sessionHelpers03.promptDisplayMetadata({}, value); }
function turnDurationMs(turn) { return sessionHelpers03.turnDurationMs({  }, turn); }
function compareSteerMessages(left, right) { return sessionHelpers03.compareSteerMessages({  }, left, right); }
function buildMessageIndicatorMarks(messages, allMessages = messages) { return sessionHelpers03.buildMessageIndicatorMarks({ actionGroupTitle, appendSteerSegment, compactIndicatorTitle, compactTimelineEntries, compareSteerMessages, isDisplayableMessageSegment, liveItemKey, messageIndicatorItemTitle, messageIndicatorTitle, messageIndicatorToneForGroup, messageIndicatorToneForItem, removeLastTextSegment, timelineAnchorId }, messages, allMessages); }
function messageIndicatorTitle(tone) { return sessionHelpers03.messageIndicatorTitle({  }, tone); }
function messageIndicatorMarkTop(position) { return sessionHelpers03.messageIndicatorMarkTop({  }, position); }
function compactIndicatorTitle(value, fallback) { return sessionHelpers03.compactIndicatorTitle({  }, value, fallback); }
function messageIndicatorItemTitle(item) { return sessionHelpers03.messageIndicatorItemTitle({ approvalShortText, compactIndicatorTitle, subagentNames, subagentToolLabel, summarizeFileChangeItem }, item); }
function messageIndicatorToneForItem(item) { return sessionHelpers03.messageIndicatorToneForItem({ fileChangeItemFromPatchCommand }, item); }
function messageIndicatorToneForGroup(groupType) { return sessionHelpers03.messageIndicatorToneForGroup({  }, groupType); }
function shortId(value) { return sessionHelpers03.shortId({  }, value); }
function getSessionExecutionStatus(sessionId, sessionExecutionStatuses, pendingApprovalSessionIds) { return sessionHelpers03.getSessionExecutionStatus({  }, sessionId, sessionExecutionStatuses, pendingApprovalSessionIds); }
function sessionExecutionStatusLabel(status) { return sessionHelpers03.sessionExecutionStatusLabel({  }, status); }
function getWorkspaceTabSummary(workspaceId, isActive, statusMonitorById, sessions, sessionExecutionStatuses, pendingApprovalSessionIds) { return sessionHelpers03.getWorkspaceTabSummary({ displaySessionTitle, shortId }, workspaceId, isActive, statusMonitorById, sessions, sessionExecutionStatuses, pendingApprovalSessionIds); }
function approvalShortText(item) { return sessionHelpers03.approvalShortText({ readRecord, readStringField, summarizeCommand }, item); }
function isNoRolloutFoundMessage(value) { return sessionHelpers03.isNoRolloutFoundMessage({  }, value); }
function cleanLoginUrlValue(value) { return sessionHelpers03.cleanLoginUrlValue({  }, value); }
function readStringField(record, key) { return sessionHelpers03.readStringField({  }, record, key); }
function pendingPromptForSubscription(subscription) { return sessionHelpers03.pendingPromptForSubscription({ readStringField, shortId }, subscription); }
function slugify(value) { return sessionHelpers03.slugify({  }, value); }
function compareSessionRecordsByUpdated(left, right) { return sessionHelpers03.compareSessionRecordsByUpdated({  }, left, right); }
function readStoredSession() { return sessionHelpers03.readStoredSession({ STORAGE_KEY, finalizeTerminalAssistantMessage, isModelReasoningEffort, isQueuedPrompt, normalizeGearIndex, normalizeGearProfiles, normalizeMessageStartupSnapshots, normalizeStoredApprovalPolicy, normalizeStoredModel, queuedPromptSessionKey, readRecord, toChatMessage }); }
function normalizeMessageStartupSnapshots(messages) { return sessionHelpers03.normalizeMessageStartupSnapshots({  }, messages); }
function queuedPromptSessionKey(sessionId) { return sessionHelpers03.queuedPromptSessionKey({ NEW_SESSION_QUEUE_KEY }, sessionId); }
function readStoredComposerDraft(sessionId) { return sessionHelpers03.readStoredComposerDraft({ emptyComposerDraft, queuedPromptSessionKey, readStoredComposerDrafts }, sessionId); }
function patchStoredComposerDraft(sessionId, patch) { return sessionHelpers03.patchStoredComposerDraft({ COMPOSER_DRAFT_STORAGE_KEY, emptyComposerDraft, isEmptyComposerDraft, normalizeComposerDraft, queuedPromptSessionKey, readStoredComposerDrafts }, sessionId, patch); }
function moveStoredComposerDraft(fromSessionId, toSessionId) { return sessionHelpers03.moveStoredComposerDraft({ COMPOSER_DRAFT_STORAGE_KEY, isEmptyComposerDraft, queuedPromptSessionKey, readStoredComposerDrafts }, fromSessionId, toSessionId); }
function readStoredComposerDrafts() { return sessionHelpers03.readStoredComposerDrafts({ COMPOSER_DRAFT_STORAGE_KEY, isEmptyComposerDraft, normalizeComposerDraft, readRecord }); }
function emptyComposerDraft() { return sessionHelpers03.emptyComposerDraft({  }); }
function normalizeComposerDraft(value) { return sessionHelpers03.normalizeComposerDraft({ emptyComposerDraft }, value); }
function isEmptyComposerDraft(draft) { return sessionHelpers03.isEmptyComposerDraft({  }, draft); }
function writeStoredSession(session) { return sessionHelpers03.writeStoredSession({ STORAGE_KEY, normalizeMessageStartupSnapshots }, session); }
function normalizeSessionModelPreferences(value) { return sessionHelpers04.normalizeSessionModelPreferences({ MODEL_OPTIONS, isModelReasoningEffort, normalizeGearIndex, normalizeGearProfiles, normalizeStoredModel }, value); }
function readStoredModelSelector(restoredSession) { return sessionHelpers04.readStoredModelSelector({ isModelReasoningEffort, normalizeGearIndex, normalizeGearProfiles, normalizeStoredModel, readPendingModelPreferences }, restoredSession); }
function modelSelectorSessionKey(workspaceId) { return sessionHelpers04.modelSelectorSessionKey({ NEW_SESSION_QUEUE_KEY }, workspaceId); }
function readStoredModelSelectors() { return sessionHelpers04.readStoredModelSelectors({ MODEL_SELECTOR_STORAGE_KEY, NEW_SESSION_QUEUE_KEY, normalizeSessionModelPreferences }); }
function readPendingModelPreferences(workspaceId) { return sessionHelpers04.readPendingModelPreferences({ modelSelectorSessionKey, readStoredModelSelectors }, workspaceId); }
function writePendingModelPreferences(workspaceId, selector) { return sessionHelpers04.writePendingModelPreferences({ MODEL_SELECTOR_STORAGE_KEY, modelSelectorSessionKey, normalizeSessionModelPreferences, readStoredModelSelectors }, workspaceId, selector); }
function movePendingModelPreferences(fromWorkspaceId, toWorkspaceId) { return sessionHelpers04.movePendingModelPreferences({ MODEL_SELECTOR_STORAGE_KEY, modelSelectorSessionKey, readStoredModelSelectors }, fromWorkspaceId, toWorkspaceId); }
function removePendingModelPreferences(workspaceId) { return sessionHelpers04.removePendingModelPreferences({ MODEL_SELECTOR_STORAGE_KEY, modelSelectorSessionKey, readStoredModelSelectors }, workspaceId); }
function removePendingModelPreferencesIfMatches(workspaceId, preferences) { return sessionHelpers04.removePendingModelPreferencesIfMatches({ readPendingModelPreferences, removePendingModelPreferences, sameModelPreferences }, workspaceId, preferences); }
function sameModelPreferences(left, right) { return sessionHelpers04.sameModelPreferences({ normalizeSessionModelPreferences }, left, right); }
function normalizeStoredModel(value) { return sessionHelpers04.normalizeStoredModel({ AUTO_MODEL_VALUE, MODEL_OPTIONS }, value); }
function normalizeStoredApprovalPolicy(value) { return sessionHelpers04.normalizeStoredApprovalPolicy({  }, value); }
function normalizeGearProfiles(value, fallbackModel, fallbackEffort) { return sessionHelpers04.normalizeGearProfiles({ isModelReasoningEffort, normalizeEffortForModel, normalizeStoredModel }, value, fallbackModel, fallbackEffort); }
function normalizeGearIndex(value) { return sessionHelpers04.normalizeGearIndex({  }, value); }
function normalizeEffortForModel(effort, model) { return sessionHelpers04.normalizeEffortForModel({ AUTO_MODEL_VALUE, supportsUltraEffort }, effort, model); }
function supportsUltraEffort(model) { return sessionHelpers04.supportsUltraEffort({  }, model); }
function modelOptionLabel(model) { return sessionHelpers04.modelOptionLabel({ capitalize }, model); }
function toChatMessage(value) { return sessionHelpers04.toChatMessage({ isLiveItem, isMessageAttachment, isMessageSegment, normalizeDeveloperInstructionRecords, normalizeLiveItems, normalizeMessageSegments }, value); }
function isQueuedPrompt(value) { return sessionHelpers04.isQueuedPrompt({ isMessageAttachment, isSkillSuggestion }, value); }
function isSkillSuggestion(value) { return sessionHelpers04.isSkillSuggestion({  }, value); }
function isDisplayableMessageSegment(segment) { return sessionHelpers04.isDisplayableMessageSegment({ isDisplayableLiveItem }, segment); }
function isDisplayableLiveItem(item) { return sessionHelpers04.isDisplayableLiveItem({ isExactRootSubagentActivity }, item); }
function isMessageSegment(value) { return sessionHelpers04.isMessageSegment({ isLiveItem, isMessageAttachment }, value); }
function isMessageAttachment(value) { return sessionHelpers04.isMessageAttachment({  }, value); }
function parsePastedHttpUrl(value) { return sessionHelpers04.parsePastedHttpUrl({  }, value); }
function composerLinkToken(id) { return sessionHelpers04.composerLinkToken({  }, id); }
function replaceComposerLinkTokens(value, links) { return sessionHelpers04.replaceComposerLinkTokens({ formatComposerLinkMarkdown }, value, links); }
function formatComposerLinkMarkdown(link) { return sessionHelpers04.formatComposerLinkMarkdown({  }, link); }
function isModelReasoningEffort(value) { return sessionHelpers04.isModelReasoningEffort({  }, value); }
function findSlashTrigger(value, caret) { return sessionHelpers04.findSlashTrigger({  }, value, caret); }
function capitalize(value) { return sessionHelpers04.capitalize({  }, value); }
function approvalAvailableDecisions(params) { return sessionHelpers04.approvalAvailableDecisions({ readRecord }, params); }
function approvalRecordToLiveItem(value) { return sessionHelpers04.approvalRecordToLiveItem({ approvalEventToLiveItem, readRecord, readStringField }, value); }
function isApprovalLiveItem(item) { return sessionHelpers04.isApprovalLiveItem({  }, item); }
function upsertPendingApprovalItem(items, item) { return sessionHelpers04.upsertPendingApprovalItem({  }, items, item); }
function approvalDecisionLabel(decision) { return sessionHelpers04.approvalDecisionLabel({  }, decision); }
function resizeEditor(editor) { return sessionHelpers04.resizeEditor({  }, editor); }
function sleep(ms) { return sessionHelpers04.sleep({  }, ms); }
function isInactiveSteerResponse(status, message) { return sessionHelpers04.isInactiveSteerResponse({  }, status, message); }
function isLikelyBackendDisconnect(error) { return sessionHelpers04.isLikelyBackendDisconnect({  }, error); }
function highlightSessionSearchText(text, query) { return sessionHelpers04.highlightSessionSearchText({ _jsx, escapeRegExp, parseSessionSearchHighlightTerms }, text, query); }
function parseSessionSearchHighlightTerms(query) { return sessionHelpers04.parseSessionSearchHighlightTerms({  }, query); }
function escapeRegExp(value) { return sessionHelpers04.escapeRegExp({  }, value); }
function describeStreamItem(item) { return sessionHelpers04.describeStreamItem({ approvalDecisionLabel, subagentNames, subagentToolLabel }, item); }
function describeCodexEvent(event) { return sessionHelpers04.describeCodexEvent({ getCodexEventName }, event); }
