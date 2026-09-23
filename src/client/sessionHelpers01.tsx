// @ts-nocheck
export function appendSteerSegment(ctx, segments, message) {
    const { steerSegmentFromMessage } = ctx;
    const steer = steerSegmentFromMessage(message);
    if (segments.some((segment) => segment.id === steer.id)) return segments;
    const time = Date.parse(message.createdAt ?? "");
    const index = Number.isFinite(time) ? segments.findIndex((segment) =>
        Date.parse(segment.createdAt ?? segment.item?.sortCreated ?? "") > time) : -1;
    if (index !== -1) {
        return [...segments.slice(0, index), steer, ...segments.slice(index)];
    }
    return [
        ...segments,
        steer
    ];

}

export function steerSegmentFromMessage(ctx, message) {
    const {  } = ctx;
    return {
        id: `steer:${message.id}`,
        type: "steer",
        text: message.content,
        createdAt: message.createdAt,
        attachments: message.attachments,
        forcePlan: message.forcePlan
    };

}

export function mergeSnapshotSegmentsWithLocalSteers(ctx, snapshotSegments, existingSegments = [], preservedSteers = []) {
    const { appendSteerSegment, compareSteerMessages, isDisplayableMessageSegment, normalizeMessageSegments, steerSegmentFromMessage } = ctx;
    const displayExisting = existingSegments.filter(isDisplayableMessageSegment);
    if (displayExisting.length === 0) {
        return [...preservedSteers]
            .sort(compareSteerMessages)
            .reduce((currentSegments, steer) => appendSteerSegment(currentSegments, steer), snapshotSegments);
    }
    const snapshotSegmentById = new Map();
    const snapshotTextBySource = new Map();
    for (const segment of snapshotSegments) {
        snapshotSegmentById.set(segment.id, segment);
        if (segment.type === "text") {
            const sourceId = segment.sourceId ?? segment.id;
            snapshotTextBySource.set(sourceId, `${snapshotTextBySource.get(sourceId) ?? ""}${segment.text}`);
        }
    }
    const steerBySegmentId = new Map();
    for (const steer of preservedSteers) {
        steerBySegmentId.set(`steer:${steer.id}`, steer);
    }
    const existingTextCountBySource = new Map();
    for (const segment of displayExisting) {
        if (segment.type !== "text") {
            continue;
        }
        const sourceId = segment.sourceId ?? segment.id;
        existingTextCountBySource.set(sourceId, (existingTextCountBySource.get(sourceId) ?? 0) + 1);
    }
    const consumedSnapshotSegmentIds = new Set();
    const consumedSteerSegmentIds = new Set();
    const consumedTextSources = new Set();
    const textOffsetBySource = new Map();
    const textSeenBySource = new Map();
    let merged = [];
    for (const segment of displayExisting) {
        if (segment.type === "steer") {
            const steer = steerBySegmentId.get(segment.id);
            const nextSegment = steer ? steerSegmentFromMessage(steer) : segment;
            if (!consumedSteerSegmentIds.has(nextSegment.id)) {
                consumedSteerSegmentIds.add(nextSegment.id);
                merged.push(nextSegment);
            }
            continue;
        }
        if (segment.type === "text") {
            const sourceId = segment.sourceId ?? segment.id;
            const snapshotText = snapshotTextBySource.get(sourceId);
            if (snapshotText !== undefined) {
                const seenCount = textSeenBySource.get(sourceId) ?? 0;
                const totalCount = existingTextCountBySource.get(sourceId) ?? 1;
                const offset = textOffsetBySource.get(sourceId) ?? 0;
                const remainingText = snapshotText.slice(offset);
                const nextText = seenCount + 1 >= totalCount ? remainingText : remainingText.slice(0, segment.text.length);
                textSeenBySource.set(sourceId, seenCount + 1);
                textOffsetBySource.set(sourceId, offset + nextText.length);
                consumedTextSources.add(sourceId);
                if (nextText) {
                    merged.push({ ...segment, text: nextText });
                }
                continue;
            }
            merged.push(segment);
            continue;
        }
        const snapshotSegment = snapshotSegmentById.get(segment.id);
        if (snapshotSegment) {
            consumedSnapshotSegmentIds.add(segment.id);
            merged.push(snapshotSegment);
        }
        else {
            merged.push(segment);
        }
    }
    for (const segment of snapshotSegments) {
        if (segment.type === "text") {
            const sourceId = segment.sourceId ?? segment.id;
            if (existingTextCountBySource.has(sourceId)) {
                if (!consumedTextSources.has(sourceId)) {
                    merged.push(segment);
                    consumedTextSources.add(sourceId);
                }
                continue;
            }
            merged.push(segment);
            continue;
        }
        if (!consumedSnapshotSegmentIds.has(segment.id)) {
            merged.push(segment);
        }
    }
    for (const steer of [...preservedSteers].sort(compareSteerMessages)) {
        const segment = steerSegmentFromMessage(steer);
        if (!consumedSteerSegmentIds.has(segment.id)) {
            consumedSteerSegmentIds.add(segment.id);
            merged = appendSteerSegment(merged, steer);
        }
    }
    return normalizeMessageSegments(merged);

}

export function itemEventRank(ctx, eventType) {
    const {  } = ctx;
    if (eventType === "item.completed")
        return 3;
    if (eventType === "item.updated")
        return 2;
    return 1;

}

export function upsertLiveSegment(ctx, segments, item) {
    const { isDisplayableLiveItem, liveItemForDisplay, liveItemKey } = ctx;
    const displayItem = liveItemForDisplay(item);
    const segmentId = "live:" + liveItemKey(displayItem);
    const existingIndex = segments.findIndex((segment) => segment.type === "live" && segment.id === segmentId);
    if (!isDisplayableLiveItem(displayItem)) {
        return existingIndex === -1 ? segments : segments.filter((segment) => segment.id !== segmentId);
    }
    if (existingIndex === -1) {
        return [
            ...segments,
            {
                id: segmentId,
                type: "live",
                item: displayItem
            }
        ];
    }
    return segments.map((segment, index) => index === existingIndex && segment.type === "live" ? { ...segment, item: displayItem } : segment);

}

export function applyLiveItemToMessage(ctx, message, item) {
    const { finalizePendingReasoningItems, isDisplayableLiveItem, liveItemForDisplay, liveItemKey, normalizeLiveItems, normalizeMessageSegments, upsertLiveSegment } = ctx;
    const incomingDisplayItem = liveItemForDisplay(item);
    const terminal = message.turnStatus && message.turnStatus !== "running";
    const displayItem = terminal
        ? finalizePendingReasoningItems([incomingDisplayItem])[0]
        : incomingDisplayItem;
    if (!displayItem) {
        const itemKey = liveItemKey(incomingDisplayItem);
        return {
            ...message,
            liveItems: (message.liveItems ?? []).filter((liveItem) => liveItemKey(liveItem) !== itemKey),
            segments: (message.segments ?? []).filter((segment) => segment.type !== "live" || liveItemKey(segment.item) !== itemKey),
            pending: terminal ? false : message.pending
        };
    }
    const displayItemKey = liveItemKey(displayItem);
    const liveItems = message.liveItems ?? [];
    const existingIndex = liveItems.findIndex((liveItem) => liveItemKey(liveItem) === displayItemKey);
    const isDisplayable = isDisplayableLiveItem(displayItem);
    let nextItems = liveItems;
    if (!isDisplayable) {
        nextItems = liveItems.filter((liveItem) => liveItemKey(liveItem) !== displayItemKey);
    }
    else if (existingIndex === -1) {
        nextItems = [...liveItems, displayItem];
    }
    else {
        nextItems = liveItems.map((liveItem, index) => (index === existingIndex ? displayItem : liveItem));
    }
    const normalizedLiveItems = normalizeLiveItems(nextItems);
    const segments = normalizeMessageSegments(upsertLiveSegment(message.segments ?? [], displayItem));
    return {
        ...message,
        liveItems: normalizedLiveItems,
        segments,
        pending: terminal ? false : isDisplayable ? true : message.pending
    };

}

export function finalizeTerminalAssistantMessage(ctx, message, overrides = {}) {
    const { finalizePendingReasoningItems, finalizePendingReasoningSegments, normalizeLiveItems, normalizeMessageSegments } = ctx;
    const liveItems = finalizePendingReasoningItems(message.liveItems ?? []);
    const segments = finalizePendingReasoningSegments(message.segments ?? []);
    return {
        ...message,
        ...overrides,
        pending: false,
        ...(message.liveItems ? { liveItems: normalizeLiveItems(liveItems) } : {}),
        ...(message.segments ? { segments: normalizeMessageSegments(segments) } : {})
    };

}

export function approvalEventToLiveItem(ctx, event, status) {
    const {  } = ctx;
    return {
        id: `approval:${event.approvalId}`,
        eventType: status === "pending" ? "item.started" : "item.completed",
        itemType: "approval",
        approvalId: event.approvalId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        method: event.method,
        params: event.params ?? null,
        status,
        decision: event.decision,
        error: event.error
    };

}

export function streamItemsToSegments(ctx, items, rootThreadId) {
    const { appendTextSegment, liveItemKey, normalizeMessageSegments, upsertLiveSegment } = ctx;
    let segments = [];
    const textByItemId = {};
    for (const item of items) {
        if (item.itemType === "agent_message") {
            const itemKey = liveItemKey(item);
            const isChildOrigin = Boolean(item.originThreadId && item.originThreadId !== rootThreadId);
            if (item.comment || isChildOrigin) {
                segments = upsertLiveSegment(segments, item);
                continue;
            }
            const previous = textByItemId[itemKey] ?? "";
            const incoming = item.text ?? "";
            if (!incoming) {
                continue;
            }
            const appendText = incoming.startsWith(previous) ? incoming.slice(previous.length) : incoming;
            textByItemId[itemKey] = incoming.startsWith(previous) ? incoming : `${previous}${incoming}`;
            segments = appendTextSegment(segments, `agent:${itemKey}`, appendText);
            // Retain the stored event time when restoring plain text, so steers
            // can be interleaved with text as well as tool/commentary events.
            const last = segments.at(-1);
            if (last?.type === "text" && !last.createdAt && item.sortCreated) {
                segments = [...segments.slice(0, -1), { ...last, createdAt: item.sortCreated }];
            }
            continue;
        }
        segments = upsertLiveSegment(segments, item);
    }
    return normalizeMessageSegments(segments);

}

export function liveItemForDisplay(ctx, item) {
    const { fileChangeItemFromPatchCommand } = ctx;
    if (item.itemType !== "command_execution") {
        return item;
    }
    return fileChangeItemFromPatchCommand(item) ?? item;

}

export function normalizeLiveItems(ctx, items) {
    const { approvalCommandItemKey, isDisplayableLiveItem, isSuppressedCommandItem, liveItemForDisplay } = ctx;
    const displayItems = items.map(liveItemForDisplay);
    const pendingApprovalItemIds = new Set(displayItems
        .filter((item) => item.itemType === "approval" && item.status === "pending")
        .map(approvalCommandItemKey)
        .filter((itemId) => Boolean(itemId)));
    return displayItems.filter((item) => isDisplayableLiveItem(item) && !isSuppressedCommandItem(item, pendingApprovalItemIds));

}

export function normalizeMessageSegments(ctx, segments) {
    const { approvalCommandItemKey, isDisplayableLiveItem, isSuppressedCommandItem, liveItemForDisplay } = ctx;
    const displaySegments = segments.map((segment) => segment.type === "live" ? { ...segment, item: liveItemForDisplay(segment.item) } : segment);
    const pendingApprovalItemIds = new Set(displaySegments
        .filter((segment) => segment.type === "live")
        .map((segment) => segment.item)
        .filter((item) => item.itemType === "approval" && item.status === "pending")
        .map(approvalCommandItemKey)
        .filter((itemId) => Boolean(itemId)));
    return displaySegments.filter((segment) => {
        if (segment.type === "text" || segment.type === "steer") {
            return true;
        }
        if (segment.item.itemType === "file_change" && segment.item.authoritative === true) {
            return false;
        }
        return isDisplayableLiveItem(segment.item) && !isSuppressedCommandItem(segment.item, pendingApprovalItemIds);
    });

}

export function isSuppressedCommandItem(ctx, item, pendingApprovalItemIds) {
    const { liveItemKey } = ctx;
    return item.itemType === "command_execution" && pendingApprovalItemIds.has(liveItemKey(item));

}

export function approvalCommandItemKey(ctx, item) {
    const { liveItemKey, readRecord, readStringField } = ctx;
    const params = readRecord(item.params);
    const itemId = readStringField(params, "itemId");
    return itemId ? liveItemKey({ id: itemId, originThreadId: item.originThreadId }) : undefined;

}

export function summarizeTitle(ctx, value) {
    const {  } = ctx;
    const firstLine = value
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean);
    if (!firstLine) {
        return "New thread";
    }
    return firstLine.length > 34 ? `${firstLine.slice(0, 31)}...` : firstLine;

}

export function displaySessionTitle(ctx, value) {
    const {  } = ctx;
    return value.startsWith("**") ? value.slice(2) : value;

}

export function summarizeCommand(ctx, value) {
    const {  } = ctx;
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length > 96 ? `${compact.slice(0, 93)}...` : compact;

}

export function elementForSelectionNode(ctx, node) {
    const {  } = ctx;
    if (!node)
        return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;

}

export function shouldRenderMessageTimeline(ctx, message) {
    const { isDisplayableMessageSegment } = ctx;
    if (message.role === "assistant" && message.turnStatus === "running") {
        return true;
    }
    if (!message.segments || message.segments.length === 0) {
        return false;
    }
    return message.segments.some(isDisplayableMessageSegment);

}

export function LiveEventList(ctx, { items, anchorPrefix, sessionId: providedSessionId }) {
    const { FileAnnotationComposerContext, TimelineEntries, _jsx, compactTimelineEntries, isDisplayableLiveItem, liveItemKey, useContext } = ctx;
    const contextualSessionId = useContext(FileAnnotationComposerContext)?.sessionId;
    const sessionId = providedSessionId ?? contextualSessionId;
    const displayItems = items.filter((item) => item.itemType !== "reasoning" && !(item.itemType === "file_change" && item.authoritative === true) && isDisplayableLiveItem(item));
    if (displayItems.length === 0) {
        return null;
    }
    return (_jsx("div", { className: "live-items", "aria-label": "Codex live events", children: _jsx(TimelineEntries, { anchorPrefix: anchorPrefix, entries: compactTimelineEntries(displayItems.map((item) => ({
                id: `live:${liveItemKey(item)}`,
                type: "live",
                item
            }))), sessionId: sessionId }) }));

}

export function MessageTimeline(ctx, { segments, anchorPrefix, completed = false, running = false, statusText, codexSessionId, sessionId: providedSessionId, turnId, workspaceId: providedWorkspaceId }) {
    const { annotationContext, TimelineEntries, TurnIssueTracker, _jsx, _jsxs, compactTimelineEntries, finalizePendingReasoningSegments, isDisplayableMessageSegment, latestTurnIssueTracker, withTurnLevelStatus } = ctx;
    const contextualSessionId = annotationContext?.sessionId;
    const sessionId = providedSessionId ?? contextualSessionId;
    const workspaceId = providedWorkspaceId ?? annotationContext?.workspaceId;
    const terminalSegments = completed ? finalizePendingReasoningSegments(segments) : segments;
    const displaySegments = withTurnLevelStatus(terminalSegments, running, statusText).filter(isDisplayableMessageSegment);
    const issueTracker = latestTurnIssueTracker(terminalSegments);
    return (_jsxs("div", { className: "message-timeline", children: [issueTracker && _jsx(TurnIssueTracker, { tracker: issueTracker, codexSessionId: codexSessionId, sessionId: sessionId, turnId: turnId, workspaceId: workspaceId }, "issues"), _jsx("div", { style: { display: "contents" }, children: _jsx(TimelineEntries, { anchorPrefix: anchorPrefix, completed: completed, entries: compactTimelineEntries(displaySegments), sessionId: sessionId }) }, "steps")] }));

}

export function TimelineEntries(ctx, { entries, anchorPrefix, groupPlanSteps = true, completed = false, sessionId }) {
    const { ActionGroup, LiveEvent, MarkdownContent, PlanStepTimeline, SteerEvent, StructuredCommentEvent, _Fragment, _jsx, attachCommentaryActivities, groupTimelineEntriesByPlanSteps, timelineAnchorId } = ctx;
    const groupedEntries = groupPlanSteps ? groupTimelineEntriesByPlanSteps(entries, completed) : entries;
    const displayEntries = attachCommentaryActivities(groupedEntries);
    return (_jsx(_Fragment, { children: displayEntries.map((entry) => {
            const anchorId = anchorPrefix ? timelineAnchorId(anchorPrefix, entry.id) : undefined;
            if (entry.kind === "text") {
                return (_jsx(MarkdownContent, { className: "message-text", id: anchorId, children: entry.text }, entry.id));
            }
            if (entry.kind === "steer") {
                return _jsx(SteerEvent, { attachments: entry.attachments, forcePlan: entry.forcePlan, id: anchorId, text: entry.text }, entry.id);
            }
            if (entry.kind === "action_group") {
                return _jsx(ActionGroup, { groupType: entry.groupType, id: anchorId, items: entry.items, sessionId: sessionId }, entry.id);
            }
            if (entry.kind === "comment_activity") {
                return _jsx(StructuredCommentEvent, { activities: entry.activities, id: anchorId, item: entry.item, sessionId: sessionId }, entry.id);
            }
            if (entry.kind === "plan_steps") {
                return _jsx(PlanStepTimeline, { anchorPrefix: anchorPrefix, id: anchorId, steps: entry.steps, completed: completed, sessionId: sessionId }, entry.id);
            }
            return (_jsx("div", { className: "timeline-anchor", id: anchorId, children: _jsx(LiveEvent, { item: entry.item, sessionId: sessionId }) }, entry.id));
        }) }));

}

export function groupTimelineEntriesByPlanSteps(ctx, entries, completed) {
    const { groupTimelineEntriesByTextStepMarkers, groupTimelineEntriesByTodoList } = ctx;
    const todoListGroupedEntries = groupTimelineEntriesByTodoList(entries);
    return todoListGroupedEntries ?? groupTimelineEntriesByTextStepMarkers(entries, completed);

}

export function groupTimelineEntriesByTodoList(ctx, entries) {
    const { nextActivePlanStepIndex, syncPlanSteps, todoListItemFromEntry } = ctx;
    const firstPlanIndex = entries.findIndex((entry) => todoListItemFromEntry(entry));
    if (firstPlanIndex === -1) {
        return null;
    }
    const groupedEntries = entries.slice(0, firstPlanIndex);
    const steps = [];
    let planEntryId = entries[firstPlanIndex]?.id ?? "plan";
    let activeStepIndex = -1;
    for (let index = firstPlanIndex; index < entries.length; index += 1) {
        const entry = entries[index];
        const todoList = todoListItemFromEntry(entry);
        if (todoList) {
            if (steps.length === 0) {
                planEntryId = entry.id;
            }
            syncPlanSteps(steps, todoList);
            activeStepIndex = nextActivePlanStepIndex(steps);
            continue;
        }
        if (steps.length === 0) {
            groupedEntries.push(entry);
            continue;
        }
        const targetIndex = activeStepIndex >= 0 ? activeStepIndex : Math.max(steps.length - 1, 0);
        steps[targetIndex].entries.push(entry);
    }
    if (steps.length === 0) {
        return null;
    }
    groupedEntries.push({ kind: "plan_steps", id: `plan-steps:${planEntryId}`, steps });
    return groupedEntries;

}

export function groupTimelineEntriesByTextStepMarkers(ctx, entries, completed) {
    const { stepMarkerFromTimelineEntry } = ctx;
    const firstStepIndex = entries.findIndex((entry) => stepMarkerFromTimelineEntry(entry));
    if (firstStepIndex === -1) {
        return entries;
    }
    const groupedEntries = entries.slice(0, firstStepIndex);
    const steps = [];
    let activeStep = null;
    let activeStepNumber = null;
    for (let index = firstStepIndex; index < entries.length; index += 1) {
        const entry = entries[index];
        const marker = stepMarkerFromTimelineEntry(entry);
        if (marker && marker.stepNumber !== activeStepNumber) {
            activeStep = {
                id: `text-step:${entry.id}`,
                stepNumber: marker.stepNumber,
                text: marker.title,
                completed: false,
                entries: [entry]
            };
            activeStepNumber = marker.stepNumber;
            steps.push(activeStep);
            continue;
        }
        if (!activeStep) {
            groupedEntries.push(entry);
            continue;
        }
        activeStep.entries.push(entry);
    }
    steps.forEach((step, index) => {
        step.completed = completed || index < steps.length - 1;
    });
    groupedEntries.push({ kind: "plan_steps", id: `text-plan-steps:${entries[firstStepIndex]?.id ?? "plan"}`, steps });
    return groupedEntries;

}

export function stepMarkerFromTimelineEntry(ctx, entry) {
    const { stepMarkerFromText } = ctx;
    return entry.kind === "text" ? stepMarkerFromText(entry.text) : null;

}

export function syncPlanSteps(ctx, steps, item) {
    const {  } = ctx;
    for (const [index, todo] of item.items.entries()) {
        const existing = steps[index];
        if (existing) {
            existing.text = todo.text;
            existing.completed = todo.completed;
            existing.status = todo.status;
            continue;
        }
        steps.push({
            id: `plan-step:${item.id}:${index}`,
            text: todo.text,
            completed: todo.completed,
            status: todo.status,
            entries: []
        });
    }
    if (steps.length > item.items.length) {
        steps.splice(item.items.length);
    }

}

export function nextActivePlanStepIndex(ctx, steps) {
    const {  } = ctx;
    return steps.some((step) => step.status !== undefined)
        ? steps.findIndex((step) => step.status === "in_progress")
        : steps.findIndex((step) => !step.completed);

}

export function todoListItemFromEntry(ctx, entry) {
    const {  } = ctx;
    return entry.kind === "item" && entry.item.itemType === "todo_list" ? entry.item : null;

}

export function PlanStepTimeline(ctx, { id, steps, anchorPrefix, sessionId, completed = false }) {
    const { CheckCircle2, ChevronRight, Circle, TimelineEntries, _jsx, _jsxs, countTimelineLeafEntries, nextActivePlanStepIndex, planStepStatus, planStepStatusLabel } = ctx;
    const activeIndex = completed ? -1 : nextActivePlanStepIndex(steps);
    const doneCount = steps.filter((step) => step.completed).length;
    return (_jsxs("section", { className: "plan-step-timeline", id: id, "aria-label": "Plan steps", children: [
        _jsxs("div", { className: "plan-step-progress", children: [
            _jsx("strong", { children: "Steps" }),
            _jsxs("span", { children: [doneCount, "/", steps.length, " completed", completed && doneCount < steps.length ? " · Turn ended" : ""] }),
            _jsx("progress", { value: doneCount, max: Math.max(steps.length, 1), "aria-label": "Steps completed" })
        ] }), steps.map((step, index) => {
            const status = completed && !step.completed ? "incomplete" : planStepStatus(step, index, activeIndex);
            const entryCount = countTimelineLeafEntries(step.entries);
        return (_jsxs("details", { className: "plan-step-card", "data-status": status, open: status === "active", children: [_jsxs("summary", { className: "plan-step-summary", children: [_jsx(ChevronRight, { className: "command-chevron", "aria-hidden": "true" }), step.completed ? _jsx(CheckCircle2, { "aria-hidden": "true" }) : _jsx(Circle, { "aria-hidden": "true" }), _jsxs("span", { className: "plan-step-index", children: ["Step ", step.stepNumber ?? index + 1] }), _jsx("span", { className: "plan-step-title", children: step.text }), _jsx("span", { className: "plan-step-status", children: planStepStatusLabel(status) }), entryCount > 0 && (_jsxs("span", { className: "plan-step-count", children: [entryCount, " ", entryCount === 1 ? "event" : "events"] }))] }), _jsx("div", { className: "plan-step-details", children: step.entries.length > 0 ? (_jsx(TimelineEntries, { anchorPrefix: anchorPrefix, entries: step.entries, groupPlanSteps: false, completed: completed, sessionId: sessionId })) : (_jsx("span", { className: "plan-step-empty", children: "No messages or spans recorded for this step." })) })] }, step.id));
        })] }));

}

export function planStepStatus(ctx, step, index, activeIndex) {
    const {  } = ctx;
    if (step.completed)
        return "done";
    return index === activeIndex ? "active" : "pending";

}

export function planStepStatusLabel(ctx, status) {
    const {  } = ctx;
    if (status === "done")
        return "Done";
    if (status === "active")
        return "Active";
    if (status === "incomplete")
        return "Incomplete";
    return "Pending";

}

export function countTimelineLeafEntries(ctx, entries) {
    const {  } = ctx;
    return entries.reduce((total, entry) => {
        if (entry.kind === "action_group")
            return total + entry.items.length;
        if (entry.kind === "plan_steps")
            return total + entry.steps.reduce((stepTotal, step) => stepTotal + countTimelineLeafEntries(step.entries), 0);
        return total + 1;
    }, 0);

}

export function TodoPanel(ctx, { todo, ...props }) {
    const { SessionTodoPanel, _jsx } = ctx;
    return _jsx(SessionTodoPanel, { todo: todo, ...props });

}

export function timelineAnchorId(ctx, messageId, entryId) {
    const {  } = ctx;
    return `timeline:${messageId}:${entryId}`;

}

export function compactTimelineEntries(ctx, segments) {
    const { compactLiveItemGroup } = ctx;
    const entries = [];
    const subagentItems = segments.flatMap((segment) => segment.type === "live" && segment.item.itemType === "subagent"
        ? [{ id: segment.id, item: segment.item }]
        : []);
    let emittedSubagentGroup = false;
    let index = 0;
    while (index < segments.length) {
        const segment = segments[index];
        if (segment.type === "text") {
            entries.push({ kind: "text", id: segment.id, text: segment.text });
            index += 1;
            continue;
        }
        if (segment.type === "steer") {
            entries.push({ kind: "steer", id: segment.id, text: segment.text, attachments: segment.attachments, forcePlan: segment.forcePlan });
            index += 1;
            continue;
        }
        if (segment.item.itemType === "subagent") {
            if (!emittedSubagentGroup) {
                entries.push({
                    kind: "action_group",
                    id: `subagent-group:${subagentItems[0].id}`,
                    groupType: "subagent",
                    items: subagentItems
                });
                emittedSubagentGroup = true;
            }
            index += 1;
            continue;
        }
        const groupType = compactLiveItemGroup(segment.item);
        if (!groupType) {
            entries.push({ kind: "item", id: segment.id, item: segment.item });
            index += 1;
            continue;
        }
        const items = [];
        while (index < segments.length) {
            const candidate = segments[index];
            if (candidate.type !== "live" || compactLiveItemGroup(candidate.item) !== groupType) {
                break;
            }
            items.push({ id: candidate.id, item: candidate.item });
            index += 1;
        }
        entries.push({ kind: "action_group", id: `${groupType}-group:${items[0].id}`, groupType, items });
    }
    return entries;

}

export function removeLastTextSegment(ctx, segments) {
    const {  } = ctx;
    let lastTextIndex = -1;
    for (let index = segments.length - 1; index >= 0; index -= 1) {
        if (segments[index].type === "text") {
            lastTextIndex = index;
            break;
        }
    }
    return lastTextIndex < 0 ? segments : segments.filter((_, index) => index !== lastTextIndex);

}

export function ActionGroup(ctx, { id, groupType, items, sessionId }) {
    const { ChevronRight, FileEditIcon, LiveEvent, Search, TerminalSquare, UserPlus, _jsx, _jsxs, actionGroupTitle } = ctx;
    return (_jsxs("details", { className: `action-group ${groupType}-group`, id: id, children: [_jsxs("summary", { className: "action-group-summary", children: [_jsx(ChevronRight, { className: "command-chevron", "aria-hidden": "true" }), groupType === "edit" ? (_jsx(FileEditIcon, { "aria-hidden": "true" })) : groupType === "subagent" ? (_jsx(UserPlus, { "aria-hidden": "true" })) : groupType === "search" ? (_jsx(Search, { "aria-hidden": "true" })) : (_jsx(TerminalSquare, { "aria-hidden": "true" })), _jsx("span", { children: actionGroupTitle(items.map(({ item }) => item), groupType) })] }), _jsx("div", { className: "action-group-details", children: items.map(({ id, item }) => (_jsx(LiveEvent, { item: item, sessionId: sessionId }, id))) })] }));

}

export function SteerEvent(ctx, { id, text, attachments, forcePlan }) {
    const { AttachmentList, MarkdownContent, _jsx, _jsxs } = ctx;
    return (_jsxs("section", { className: "steer-event", id: id, children: [text && _jsx(MarkdownContent, { children: text }), attachments && attachments.length > 0 && _jsx(AttachmentList, { attachments: attachments })] }));

}

export function isCommandLiveItem(ctx, item) {
    const {  } = ctx;
    return item.itemType === "command_execution" || (item.itemType === "file_change" && item.sourceItemType === "command_execution");

}

export function compactLiveItemGroup(ctx, item) {
    const { isCommandLiveItem } = ctx;
    if (isCommandLiveItem(item)) {
        return "command";
    }
    if (item.itemType === "file_change") {
        return "edit";
    }
    if (item.itemType === "subagent") {
        return "subagent";
    }
    if (item.itemType === "web_search") {
        return "search";
    }
    return null;

}

export function actionGroupTitle(ctx, items, groupType) {
    const { collectFileChanges, subagentNames } = ctx;
    if (groupType === "subagent") {
        const names = [...new Set(items.flatMap((item) => item.itemType === "subagent" ? subagentNames(item) : []))];
        if (names.length === 1) {
            return `Subagent · ${names[0]}`;
        }
        const count = names.length || items.length;
        return `${count} ${count === 1 ? "subagent update" : "subagent updates"}`;
    }
    if (groupType === "edit") {
        const fileCount = collectFileChanges(items).length || items.length;
        return `Edited ${fileCount} ${fileCount === 1 ? "file" : "files"}`;
    }
    if (groupType === "search") {
        const searchCount = items.length;
        return `Searched ${searchCount} ${searchCount === 1 ? "query" : "queries"}`;
    }
    const commandCount = items.length;
    return `Ran ${commandCount} ${commandCount === 1 ? "command" : "commands"}`;

}

export function CompletedTurn(ctx, { message, steerMessages, codexSessionId, sessionId, workspaceId }) {
    const { MarkdownContent, TimelineEntries, TurnChangeList, TurnIssueTracker, _Fragment, _jsx, _jsxs, appendSteerSegment, collectFileChanges, compactTimelineEntries, compareSteerMessages, isDisplayableLiveItem, isDisplayableMessageSegment, latestTurnIssueTracker, liveItemKey, removeLastTextSegment, withTurnLevelStatus } = ctx;
    const conclusion = message.conclusion || message.content;
    const executionItems = (message.liveItems ?? []).filter(isDisplayableLiveItem);
    let baseSegments = message.segments && message.segments.length > 0
        ? message.segments
        : executionItems.map((item) => ({
            id: `live:${liveItemKey(item)}`,
            type: "live",
            item
        }));
    // A saved turn may have text segments but keep its native plan only in
    // liveItems. Preserve that plan in the completed transcript as well.
    const recordedPlanKeys = new Set(baseSegments
        .filter((segment) => segment.type === "live" && segment.item?.itemType === "todo_list")
        .map((segment) => liveItemKey(segment.item)));
    const missingPlans = executionItems.filter((item) => item.itemType === "todo_list" && !recordedPlanKeys.has(liveItemKey(item)));
    baseSegments = [
        ...missingPlans.map((item) => ({ id: `live:${liveItemKey(item)}`, type: "live", item })),
        ...baseSegments
    ];
    const segments = [...steerMessages]
        .sort(compareSteerMessages)
        .reduce((currentSegments, steer) => currentSegments.some((segment) => segment.type === "steer" && segment.id === `steer:${steer.id}`)
        ? currentSegments
        : appendSteerSegment(currentSegments, steer), baseSegments);
    const stepSegments = withTurnLevelStatus(removeLastTextSegment(segments), false).filter(isDisplayableMessageSegment);
    const changes = collectFileChanges(message.liveItems ?? []);
    const issueTracker = latestTurnIssueTracker([segments, message.liveItems ?? []]);
    return (_jsxs("div", { style: { display: "contents" }, children: [_jsx("span", { "data-copy-markdown": conclusion || "", hidden: true }), _jsx("div", { className: stepSegments.length > 0 ? "completed-turn-steps" : undefined, "aria-label": "Completed turn steps", children: _jsx(TimelineEntries, { anchorPrefix: message.id, completed: true, entries: compactTimelineEntries(stepSegments), sessionId: sessionId }) }, "steps"), _jsx(MarkdownContent, { className: "turn-conclusion", children: conclusion || "Turn completed without a final agent message." }, "conclusion"), issueTracker && _jsx(TurnIssueTracker, { tracker: issueTracker, codexSessionId: codexSessionId, sessionId: sessionId, turnId: message.turnId, workspaceId: workspaceId }, "issues"), changes.length > 0 && _jsx(TurnChangeList, { changes: changes, sessionId: sessionId, turnId: message.turnId }, "changes")] }));

}

export function latestTurnIssueTracker(ctx, values) {
    const {  } = ctx;
    const issues = [];
    const solutionByIssue = new Map();
    const blockerByIssue = new Map();
    const visit = (value) => {
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (!value || typeof value !== "object")
            return;
        const comment = value.comment;
        if (comment) {
            const incomingIssues = Array.isArray(comment.issues) ? comment.issues.filter((issue) => typeof issue === "string" && issue.trim()) : [];
            const isCumulativeSnapshot = issues.length > 0 && incomingIssues.length >= issues.length && issues.every((issue, index) => incomingIssues[index] === issue);
            if (isCumulativeSnapshot) {
                issues.splice(0, issues.length, ...incomingIssues);
            }
            else {
                const seen = new Set(issues);
                for (const issue of incomingIssues) {
                    if (!seen.has(issue)) {
                        seen.add(issue);
                        issues.push(issue);
                    }
                }
            }
            for (const entry of comment.blockers ?? []) {
                if (Number.isInteger(entry?.issueKey) && entry.issueKey >= 1 && typeof entry.blocker === "string" && entry.blocker.trim()) {
                    blockerByIssue.set(entry.issueKey, { issueKey: entry.issueKey, blocker: entry.blocker.trim() });
                    solutionByIssue.delete(entry.issueKey);
                }
            }
            if (Array.isArray(comment.solutions)) {
                for (const solution of comment.solutions) {
                    if (Number.isInteger(solution?.issueKey) && solution.issueKey >= 1 && typeof solution.solution === "string" && solution.solution.trim()) {
                        solutionByIssue.set(solution.issueKey, { issueKey: solution.issueKey, solution: solution.solution.trim() });
                        blockerByIssue.delete(solution.issueKey);
                    }
                }
            }
        }
        if (value.item)
            visit(value.item);
        if (value.items)
            visit(value.items);
        if (value.entries)
            visit(value.entries);
        if (value.steps)
            visit(value.steps);
    };
    visit(values);
    if (issues.length === 0)
        return null;
    return {
        issues,
        solutions: [...solutionByIssue.values()].filter((solution) => solution.issueKey <= issues.length).sort((left, right) => left.issueKey - right.issueKey),
        ...(blockerByIssue.size ? { blockers: [...blockerByIssue.values()].filter((entry) => entry.issueKey <= issues.length).sort((a, b) => a.issueKey - b.issueKey) } : {})
    };

}

export function TurnIssueTracker(ctx, { tracker, codexSessionId, sessionId, turnId, workspaceId }) {
    const { Copy, _jsx, _jsxs, serializeTurnIssueCopy, useState } = ctx;
    const [copyState, setCopyState] = useState(null);
    const solutionByIssue = new Map((tracker.solutions ?? []).map((solution) => [solution.issueKey, solution.solution]));
    const blockerByIssue = new Map((tracker.blockers ?? []).map((entry) => [entry.issueKey, entry.blocker]));
    const resolvedCount = tracker.issues.reduce((count, _issue, index) => count + (solutionByIssue.has(index + 1) ? 1 : 0), 0);
    const canCopy = Boolean(codexSessionId && workspaceId && sessionId && turnId);
    async function copyIssue(event, issueKey, issue, solution) {
        event.preventDefault();
        event.stopPropagation();
        if (!canCopy || !navigator.clipboard) {
            setCopyState({ issueKey, status: "error" });
            return;
        }
        try {
            await navigator.clipboard.writeText(serializeTurnIssueCopy({
                id: codexSessionId,
                workspaceId,
                sessionId,
                turnId,
                issueKey,
                issue,
                solution: solution ?? null,
                blocker: blockerByIssue.get(issueKey)
            }));
            setCopyState({ issueKey, status: "copied" });
        }
        catch {
            setCopyState({ issueKey, status: "error" });
        }
    }
    return (_jsxs("section", { className: "turn-issue-tracker", "aria-label": "Turn issues", children: [_jsxs("div", { className: "turn-issue-tracker-header", children: [_jsx("strong", { children: "Issues" }), _jsxs("span", { children: [resolvedCount, "/", tracker.issues.length, " resolved", blockerByIssue.size ? ` · ${blockerByIssue.size} blocked` : ""] })] }), _jsx("ol", { children: tracker.issues.map((issue, index) => {
                    const issueKey = index + 1;
                    const solution = solutionByIssue.get(issueKey);
                    const blocker = blockerByIssue.get(issueKey);
                    const currentCopyState = copyState?.issueKey === issueKey ? copyState.status : null;
                    const copyLabel = currentCopyState === "copied"
                        ? `Copied issue ${issueKey} as JSON`
                        : currentCopyState === "error"
                            ? `Unable to copy issue ${issueKey}`
                            : `Copy issue ${issueKey} as JSON`;
                    return (_jsxs("li", { "data-resolved": Boolean(solution), "data-blocked": Boolean(blocker), children: [_jsx("span", { className: "turn-issue-key", children: solution ? "✓" : issueKey }), _jsxs("div", { children: [_jsx("span", { className: "turn-issue-text", children: issue }), solution && _jsx("span", { className: "turn-issue-solution", children: solution }), blocker && _jsx("span", { className: "turn-issue-solution", children: `Blocker: ${blocker}` })] }), _jsx("button", { className: "thread-status-copy turn-issue-copy", type: "button", title: copyLabel, "aria-label": copyLabel, "data-copy-state": currentCopyState ?? undefined, disabled: !canCopy, onMouseDown: (event) => event.stopPropagation(), onClick: (event) => void copyIssue(event, issueKey, issue, solution), children: _jsx(Copy, { "aria-hidden": "true" }) })] }, `${issueKey}:${issue}`));
                }) })] }));

}

export function ServerPrefixPanels(ctx, { startupSnapshot, developerInstructions, showStartup = true }) {
    const { ServerPrefixPanel, _jsx, serverPrefixBlocks } = ctx;
    const blocks = serverPrefixBlocks(startupSnapshot, developerInstructions, showStartup);
    if (blocks.length === 0) {
        return null;
    }
    return (_jsx("div", { className: "server-prefix-panels", children: blocks.map((block, index) => (_jsx(ServerPrefixPanel, { block: block }, `${block.title}:${index}`))) }));

}
