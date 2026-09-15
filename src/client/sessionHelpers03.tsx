// @ts-nocheck
const CONTEXT_FORK_SUFFIX_START = "Required for this turn: create exactly one new Threadex child task for the user's request.";
const CONTEXT_FORK_SUFFIX_END = "This appended suffix is operational metadata; it must not influence the language of the handoff or response.";

export function promptDisplayMetadata(ctx, value) {
    const { } = ctx;
    const raw = typeof value === "string" ? value : "";
    const suffixStart = raw.indexOf(CONTEXT_FORK_SUFFIX_START);
    const suffixEnd = suffixStart >= 0 ? raw.indexOf(CONTEXT_FORK_SUFFIX_END, suffixStart) : -1;
    const contextFork = suffixStart >= 0 && suffixEnd >= suffixStart;
    const visible = contextFork ? raw.slice(0, suffixStart).trimEnd() : raw;
    return {
        raw,
        visible,
        contextFork,
        goalMode: /^\s*\/goal(?:\s|$)/i.test(visible)
    };
}

export function buildDiffTextPair(ctx, change) {
    const { diffTextToTextPair, readChangeText } = ctx;
    const before = readChangeText(change, [
        "before",
        "beforeText",
        "beforeContent",
        "oldContent",
        "previousContent",
        "original"
    ]);
    const after = readChangeText(change, ["after", "afterText", "afterContent", "newContent", "currentContent", "updated"]);
    if (before !== undefined || after !== undefined) {
        return { before: before ?? "", after: after ?? "" };
    }
    const unifiedDiff = readChangeText(change, ["diff", "patch", "unifiedDiff"]);
    if (unifiedDiff) {
        return diffTextToTextPair(unifiedDiff);
    }
    return null;

}

export function diffTextToTextPair(ctx, value) {
    const {  } = ctx;
    const before = [];
    const after = [];
    let hasContent = false;
    for (const line of value.replace(/\r\n/g, "\n").split("\n")) {
        if (line.startsWith("@@") ||
            line.startsWith("diff ") ||
            line.startsWith("index ") ||
            line.startsWith("---") ||
            line.startsWith("+++") ||
            line.startsWith("*** ") ||
            line === "\\ No newline at end of file") {
            continue;
        }
        if (line.startsWith("-")) {
            before.push(line.slice(1));
            hasContent = true;
            continue;
        }
        if (line.startsWith("+")) {
            after.push(line.slice(1));
            hasContent = true;
            continue;
        }
        if (line.startsWith(" ")) {
            const text = line.slice(1);
            before.push(text);
            after.push(text);
            hasContent = true;
        }
    }
    return hasContent ? { before: before.join("\n"), after: after.join("\n") } : null;

}

export function readChangeText(ctx, change, keys) {
    const {  } = ctx;
    for (const key of keys) {
        const value = change[key];
        if (typeof value === "string") {
            return value;
        }
    }
    return undefined;

}

export function getFileName(ctx, path) {
    const {  } = ctx;
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts.at(-1) ?? path;

}

export function createSystemMessage(ctx, content = "Codex app-server backend connected through /api/chat. Start a turn to create or resume a session.") {
    const {  } = ctx;
    return {
        id: crypto.randomUUID(),
        role: "system",
        content
    };

}

export function developerInstructionRecordFromPayload(ctx, payload) {
    const {  } = ctx;
    if (!payload || typeof payload !== "object") {
        return null;
    }
    const record = payload;
    if (typeof record.developerInstructions !== "string" || record.developerInstructions.length === 0) {
        return null;
    }
    return {
        target: typeof record.target === "string" && record.target.length > 0 ? record.target : "turn",
        phase: typeof record.phase === "number" && Number.isFinite(record.phase) ? record.phase : null,
        developerInstructions: record.developerInstructions,
        created: typeof record.created === "string" ? record.created : undefined
    };

}

export function normalizeDeveloperInstructionRecords(ctx, value) {
    const { developerInstructionRecordFromPayload, mergeDeveloperInstructionRecords } = ctx;
    if (!Array.isArray(value)) {
        return undefined;
    }
    const records = value.flatMap((item) => {
        const record = developerInstructionRecordFromPayload(item);
        return record ? [record] : [];
    });
    return records.length > 0 ? mergeDeveloperInstructionRecords(records) : undefined;

}

export function mergeDeveloperInstructionRecords(ctx, ...groups) {
    const { developerInstructionRecordFromPayload } = ctx;
    const merged = [];
    const seen = new Set();
    for (const group of groups) {
        for (const record of group ?? []) {
            const normalized = developerInstructionRecordFromPayload(record);
            if (!normalized) {
                continue;
            }
            const key = `${normalized.target}:${normalized.phase ?? ""}:${normalized.developerInstructions}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            merged.push(normalized);
        }
    }
    return merged;

}

export function sessionTurnsToMessages(ctx, turns, title, existingMessages = [], rootThreadId) {
    const { createSystemMessage, developerInstructionsIndicateForcePlan, finalizePendingReasoningItems, finalizePendingReasoningSegments, isLiveItem, isStreamItem, mergeDeveloperInstructionRecords, mergeSnapshotLiveItems, mergeSnapshotSegmentsWithLocalSteers, normalizeLiveItems, normalizeStoredUserInput, streamItemsToSegments, turnDurationMs } = ctx;
    if (turns.length === 0) {
        return [createSystemMessage(`Switched to "${title}". The next message resumes this session.`)];
    }
    return turns.flatMap((turn, index) => {
        const storedUserInput = normalizeStoredUserInput(turn.userInput, turn.id);
        const promptMetadata = promptDisplayMetadata({}, storedUserInput.content);
        const inheritedContextForkTurn = promptMetadata.contextFork
            ? turns.slice(0, index).reverse().find((candidate) => {
                const candidateInput = normalizeStoredUserInput(candidate.userInput, candidate.id);
                const candidateMetadata = promptDisplayMetadata({}, candidateInput.content);
                return candidateMetadata.visible === promptMetadata.visible &&
                    candidate.developerInstructions?.some((instruction) =>
                        instruction?.developerInstructions?.includes("[SERVER-PROVIDED CONTEXT FORK REQUEST]")
                    );
            })
            : undefined;
        const streamItems = turn.liveItems?.filter(isStreamItem) ?? [];
        const localSteers = existingMessages.filter((message) => message.role === "user" && message.kind === "steer" && message.turnId === turn.id);
        const persistedSteers = snapshotSteerMessages(turn.steerMessages, turn.id);
        const steerById = new Map();
        for (const steer of localSteers) {
            steerById.set(steer.id, steer);
        }
        for (const steer of persistedSteers) {
            steerById.set(steer.id, steer);
        }
        const preservedSteers = [...steerById.values()].sort((left, right) => {
            const leftTime = left.createdAt ? Date.parse(left.createdAt) : Number.MAX_SAFE_INTEGER;
            const rightTime = right.createdAt ? Date.parse(right.createdAt) : Number.MAX_SAFE_INTEGER;
            return leftTime - rightTime;
        });
        const existingUserMessage = existingMessages.find((message) => message.role === "user" && message.kind !== "steer" && message.turnId === turn.id);
        const existingAssistantMessage = existingMessages.find((message) => message.role === "assistant" && message.turnId === turn.id);
        const mergedLiveItems = normalizeLiveItems(mergeSnapshotLiveItems(streamItems.filter(isLiveItem), existingAssistantMessage?.liveItems ?? []));
        const mergedSegments = mergeSnapshotSegmentsWithLocalSteers(streamItemsToSegments(streamItems, rootThreadId), existingAssistantMessage?.segments, preservedSteers);
        const liveItems = turn.status === "running" ? mergedLiveItems : finalizePendingReasoningItems(mergedLiveItems);
        const segments = turn.status === "running" ? mergedSegments : finalizePendingReasoningSegments(mergedSegments);
        const developerInstructions = mergeDeveloperInstructionRecords(
            turn.developerInstructions,
            inheritedContextForkTurn?.developerInstructions,
            existingUserMessage?.developerInstructions
        );
        const inferredGoalMode = developerInstructions.some((instruction) =>
            instruction?.developerInstructions?.includes("Goal mode is active.")
        );
        const inferredContextFork = developerInstructions.some((instruction) =>
            instruction?.developerInstructions?.includes("[SERVER-PROVIDED CONTEXT FORK REQUEST]")
        );
        const hasGoalMode = existingUserMessage?.executionMode === "goal" || inferredGoalMode || promptMetadata.goalMode;
        return [
            {
                id: `${turn.id}:user`,
                role: "user",
                content: promptMetadata.visible,
                rawContent: promptMetadata.raw,
                turnId: turn.id,
                model: turn.model ?? existingUserMessage?.model,
                reasoningEffort: turn.reasoningEffort ?? existingUserMessage?.reasoningEffort,
                tokenIn: Number.isFinite(turn.tokenIn) ? turn.tokenIn : existingUserMessage?.tokenIn,
                tokenOut: Number.isFinite(turn.tokenOut) ? turn.tokenOut : existingUserMessage?.tokenOut,
                executionDurationMs: turnDurationMs(turn),
                turnStatus: turn.status,
                createdAt: turn.created,
                attachments: storedUserInput.attachments.length > 0 ? storedUserInput.attachments : existingUserMessage?.attachments,
                startupSnapshot: index === 0 ? existingUserMessage?.startupSnapshot : undefined,
                developerInstructions,
                forcePlan: existingUserMessage?.forcePlan === true || developerInstructionsIndicateForcePlan(developerInstructions),
                contextFork: existingUserMessage?.contextFork === true || inferredContextFork || promptMetadata.contextFork,
                executionMode: hasGoalMode ? "goal" : existingUserMessage?.executionMode
            },
            {
                id: `${turn.id}:assistant`,
                role: "assistant",
                content: turn.agentResponse || (turn.status === "todo" ? "Queued for retry after usage limit reset." : ""),
                turnId: turn.id,
                createdAt: turn.runnerStarted ?? turn.created,
                pending: turn.status === "running",
                liveItems,
                segments: segments.length > 0 ? segments : undefined,
                executionDurationMs: turnDurationMs(turn),
                completedAt: turn.status === "done" ? turn.runnerHeartbeat ?? undefined : undefined,
                conclusion: turn.status === "done" ? turn.agentResponse : undefined,
                turnStatus: turn.status,
                runnerStarted: turn.status === "running"
                    ? Boolean(turn.runnerStarted || turn.runnerPid || turn.runnerLogPath)
                    : true
            },
            ...preservedSteers
        ];
    });

}

export function snapshotSteerMessages(value, turnId) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object") {
            return [];
        }
        const steer = candidate;
        if (typeof steer.id !== "string" || !steer.id || typeof steer.content !== "string" || !steer.content) {
            return [];
        }
        return [{
                id: steer.id,
                role: "user",
                kind: "steer",
                content: steer.content,
                turnId,
                createdAt: typeof steer.created === "string" ? steer.created : undefined,
                attachments: Array.isArray(steer.attachments) ? steer.attachments : undefined,
                forcePlan: steer.forcePlan === true
            }];
    });
}

export function turnDurationMs(ctx, turn) {
    const {  } = ctx;
    if (Number.isFinite(turn.executionDurationMs) && turn.executionDurationMs >= 0) {
        return turn.executionDurationMs;
    }
    if (!turn.runnerStarted || !turn.runnerHeartbeat) {
        return undefined;
    }
    const startedAt = Date.parse(turn.runnerStarted);
    const finishedAt = Date.parse(turn.runnerHeartbeat);
    if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
        return undefined;
    }
    return finishedAt - startedAt;

}

export function compareSteerMessages(ctx, left, right) {
    const {  } = ctx;
    const leftTime = left.createdAt ? Date.parse(left.createdAt) : Number.MAX_SAFE_INTEGER;
    const rightTime = right.createdAt ? Date.parse(right.createdAt) : Number.MAX_SAFE_INTEGER;
    return (Number.isFinite(leftTime) ? leftTime : Number.MAX_SAFE_INTEGER) -
        (Number.isFinite(rightTime) ? rightTime : Number.MAX_SAFE_INTEGER);

}

export function buildMessageIndicatorMarks(ctx, messages, allMessages = messages) {
    const { actionGroupTitle, appendSteerSegment, compactIndicatorTitle, compactTimelineEntries, compareSteerMessages, isDisplayableMessageSegment, liveItemKey, messageIndicatorItemTitle, messageIndicatorTitle, messageIndicatorToneForGroup, messageIndicatorToneForItem, removeLastTextSegment, timelineAnchorId } = ctx;
    if (messages.length === 0) {
        return [];
    }
    return messages.flatMap((message, messageIndex) => {
        const tones = [];
        const titles = [];
        const anchorIds = [];
        if (message.role === "user") {
            tones.push("user");
            titles.push(compactIndicatorTitle(message.content, "User"));
            anchorIds.push(undefined);
        }
        else {
            const steerMessages = message.turnId
                ? allMessages.filter((candidate) => candidate.role === "user" && candidate.kind === "steer" && candidate.turnId === message.turnId)
                : [];
            const segments = steerMessages
                .sort(compareSteerMessages)
                .reduce((currentSegments, steer) => currentSegments.some((segment) => segment.type === "steer" && segment.id === `steer:${steer.id}`)
                ? currentSegments
                : appendSteerSegment(currentSegments, steer), message.segments ?? []);
            const railSegments = message.turnStatus === "done" ? removeLastTextSegment(segments) : segments;
            if (railSegments.length > 0) {
                for (const entry of compactTimelineEntries(railSegments.filter(isDisplayableMessageSegment))) {
                    if (entry.kind === "text") {
                        tones.push("agent");
                        titles.push(compactIndicatorTitle(entry.text, "Agent"));
                        anchorIds.push(entry.id);
                    }
                    else if (entry.kind === "steer") {
                        tones.push("steer");
                        titles.push(compactIndicatorTitle(entry.text, "Steer"));
                        anchorIds.push(entry.id);
                    }
                    else if (entry.kind === "action_group") {
                        tones.push(messageIndicatorToneForGroup(entry.groupType));
                        titles.push(actionGroupTitle(entry.items.map(({ item }) => item), entry.groupType));
                        anchorIds.push(entry.id);
                    }
                    else if (entry.kind === "plan_steps") {
                        tones.push("agent");
                        titles.push(`Plan · ${entry.steps.length} ${entry.steps.length === 1 ? "step" : "steps"}`);
                        anchorIds.push(entry.id);
                    }
                    else {
                        tones.push(messageIndicatorToneForItem(entry.item));
                        titles.push(messageIndicatorItemTitle(entry.item));
                        anchorIds.push(entry.id);
                    }
                }
            }
            else {
                tones.push("agent");
                titles.push(compactIndicatorTitle(message.content, "Agent"));
                anchorIds.push(undefined);
                const liveSegments = (message.liveItems ?? []).map((item) => ({
                    id: `live:${liveItemKey(item)}`,
                    type: "live",
                    item
                }));
                for (const entry of compactTimelineEntries(liveSegments)) {
                    if (entry.kind === "steer") {
                        tones.push("steer");
                        titles.push(compactIndicatorTitle(entry.text, "Steer"));
                        anchorIds.push(entry.id);
                    }
                    else if (entry.kind === "action_group") {
                        tones.push(messageIndicatorToneForGroup(entry.groupType));
                        titles.push(actionGroupTitle(entry.items.map(({ item }) => item), entry.groupType));
                        anchorIds.push(entry.id);
                    }
                    else if (entry.kind === "item") {
                        tones.push(messageIndicatorToneForItem(entry.item));
                        titles.push(messageIndicatorItemTitle(entry.item));
                        anchorIds.push(entry.id);
                    }
                }
            }
            if (tones.length === 0) {
                tones.push("agent");
                titles.push("Agent");
                anchorIds.push(undefined);
            }
        }
        return tones.map((tone, toneIndex) => ({
            id: `${message.id}:${toneIndex}`,
            targetId: message.id,
            anchorId: anchorIds[toneIndex] ? timelineAnchorId(message.id, anchorIds[toneIndex]) : undefined,
            tone,
            title: titles[toneIndex] ?? messageIndicatorTitle(tone),
            position: messageIndex === 0 && toneIndex === 0
                ? 0
                : ((messageIndex + (toneIndex + 1) / (tones.length + 1)) / messages.length) * 100
        }));
    });

}

export function messageIndicatorTitle(ctx, tone) {
    const {  } = ctx;
    if (tone === "user")
        return "User";
    if (tone === "steer")
        return "Steer";
    if (tone === "cmd")
        return "Cmd";
    if (tone === "edit")
        return "Edit";
    if (tone === "approval")
        return "Approval";
    if (tone === "subagent")
        return "Subagent";
    return "Agent";

}

export function messageIndicatorMarkTop(ctx, position) {
    const {  } = ctx;
    if (!Number.isFinite(position) || position <= 0) {
        return "8px";
    }
    if (position >= 100) {
        return "calc(100% - 8px)";
    }
    return `${position}%`;

}

export function compactIndicatorTitle(ctx, value, fallback) {
    const {  } = ctx;
    const compact = value.replace(/\s+/g, " ").trim();
    if (!compact) {
        return fallback;
    }
    return compact.length > 18 ? `${compact.slice(0, 17)}…` : compact;

}

export function messageIndicatorItemTitle(ctx, item) {
    const { approvalShortText, compactIndicatorTitle, subagentNames, subagentToolLabel, summarizeFileChangeItem } = ctx;
    if (item.itemType === "agent_message") {
        return compactIndicatorTitle(item.text, "Message");
    }
    if (item.itemType === "approval") {
        return compactIndicatorTitle(approvalShortText(item), "Approval");
    }
    if (item.itemType === "command_execution") {
        return compactIndicatorTitle(item.command, "Cmd");
    }
    if (item.itemType === "file_change") {
        return compactIndicatorTitle(item.changes[0]?.path ?? summarizeFileChangeItem(item).label, "Edit");
    }
    if (item.itemType === "reasoning") {
        return compactIndicatorTitle(item.text, "Agent");
    }
    if (item.itemType === "web_search") {
        return compactIndicatorTitle(item.query, "Search");
    }
    if (item.itemType === "todo_list") {
        return compactIndicatorTitle(item.items[0]?.text ?? "Plan", "Plan");
    }
    if (item.itemType === "context_compaction") {
        return "Context compacted";
    }
    if (item.itemType === "subagent") {
        return compactIndicatorTitle(subagentNames(item).join(", ") || subagentToolLabel(item.tool), "Subagent");
    }
    return compactIndicatorTitle(item.message, "Error");

}

export function messageIndicatorToneForItem(ctx, item) {
    const { fileChangeItemFromPatchCommand } = ctx;
    if (item.itemType === "approval") {
        return "approval";
    }
    if (item.itemType === "file_change") {
        return "edit";
    }
    if (item.itemType === "command_execution") {
        return fileChangeItemFromPatchCommand(item) ? "edit" : "cmd";
    }
    if (item.itemType === "subagent") {
        return "subagent";
    }
    return "agent";

}

export function messageIndicatorToneForGroup(ctx, groupType) {
    const {  } = ctx;
    if (groupType === "edit")
        return "edit";
    if (groupType === "subagent")
        return "subagent";
    return "cmd";

}

export function shortId(ctx, value) {
    const {  } = ctx;
    return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;

}

export function getSessionExecutionStatus(ctx, sessionId, sessionExecutionStatuses, pendingApprovalSessionIds) {
    const {  } = ctx;
    if (pendingApprovalSessionIds.has(sessionId)) {
        return "awaiting_approval";
    }
    return sessionExecutionStatuses[sessionId] === "running" ? "running" : "completed";

}

export function sessionExecutionStatusLabel(ctx, status) {
    const {  } = ctx;
    if (status === "running")
        return "Running";
    if (status === "awaiting_approval")
        return "Waiting for approval";
    return "Completed";

}

export function getWorkspaceTabSummary(ctx, workspaceId, isActive, statusMonitorById, sessions, sessionExecutionStatuses, pendingApprovalSessionIds) {
    const { displaySessionTitle, shortId } = ctx;
    if (!isActive) {
        const monitoredSessions = statusMonitorById.get(workspaceId)?.active_sessions ?? [];
        const approvalCount = monitoredSessions.reduce((total, session) => total + session.asking_approvals.length, 0);
        return {
            status: approvalCount > 0 ? "awaiting_approval" : monitoredSessions.length > 0 ? "running" : "idle",
            approvalCount,
            sessions: monitoredSessions.map((session) => ({
                id: session.id,
                name: displaySessionTitle(session.name),
                approvalCount: session.asking_approvals.length,
                approvals: session.asking_approvals
            }))
        };
    }
    const activeSessionIds = new Set([
        ...Object.entries(sessionExecutionStatuses)
            .filter(([, executionStatus]) => executionStatus === "running")
            .map(([sessionId]) => sessionId),
        ...pendingApprovalSessionIds
    ]);
    const sessionNameById = new Map(sessions.map((session) => [session.id, displaySessionTitle(session.title)]));
    const activeSessions = [...activeSessionIds].map((sessionId) => ({
        id: sessionId,
        name: sessionNameById.get(sessionId) ?? shortId(sessionId),
        approvalCount: pendingApprovalSessionIds.has(sessionId) ? 1 : 0,
        approvals: []
    }));
    const approvalCount = activeSessions.reduce((total, session) => total + session.approvalCount, 0);
    return {
        status: approvalCount > 0 ? "awaiting_approval" : activeSessions.length > 0 ? "running" : "idle",
        approvalCount,
        sessions: activeSessions
    };

}

export function approvalShortText(ctx, item) {
    const { readRecord, readStringField, summarizeCommand } = ctx;
    const params = readRecord(item.params);
    if (item.method === "item/tool/requestUserInput") return `Question: ${params?.questions?.[0]?.question || "Your input requested"}`;
    const command = readStringField(params, "command");
    const reason = readStringField(params, "reason");
    const path = readStringField(params, "grantRoot") || readStringField(params, "cwd");
    const detail = command || reason || path || item.method;
    return `Approval: ${summarizeCommand(detail)}`;

}

export function isNoRolloutFoundMessage(ctx, value) {
    const {  } = ctx;
    return Boolean(value && value.toLowerCase().includes("no rollout found for thread id"));

}

export function cleanLoginUrlValue(ctx, value) {
    const {  } = ctx;
    const cleaned = value
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/[\u0000-\u001F\u007F]/g, "")
        .trim();
    try {
        return new URL(cleaned).toString();
    }
    catch {
        return cleaned.replace(/[^\w./:?=&%#+~-]+$/g, "");
    }

}

export function readStringField(ctx, record, key) {
    const {  } = ctx;
    const value = record?.[key];
    return typeof value === "string" && value.trim() ? value : "";

}

export function pendingPromptForSubscription(ctx, subscription) {
    const { readStringField, shortId } = ctx;
    const payload = subscription.actionPayload && typeof subscription.actionPayload === "object" && !Array.isArray(subscription.actionPayload)
        ? subscription.actionPayload
        : null;
    return readStringField(payload, "message") ||
        readStringField(payload, "prompt") ||
        (subscription.turnId ? `Retry pending turn ${shortId(subscription.turnId)}` : subscription.actionType.replaceAll("_", " "));

}

export function slugify(ctx, value) {
    const {  } = ctx;
    return (value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "workspace");

}

export function compareSessionRecordsByUpdated(ctx, left, right) {
    const {  } = ctx;
    const updated = right.updated.localeCompare(left.updated);
    if (updated !== 0) {
        return updated;
    }
    const created = right.created.localeCompare(left.created);
    if (created !== 0) {
        return created;
    }
    return right.id.localeCompare(left.id);

}

export function readStoredSession(ctx, ) {
    const { STORAGE_KEY, finalizeTerminalAssistantMessage, isModelReasoningEffort, isQueuedPrompt, normalizeGearIndex, normalizeGearProfiles, normalizeMessageStartupSnapshots, normalizeStoredApprovalPolicy, normalizeStoredModel, queuedPromptSessionKey, readRecord, toChatMessage } = ctx;
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return undefined;
        }
        const parsed = JSON.parse(raw);
        if (parsed.version !== 1 || !Array.isArray(parsed.messages)) {
            return undefined;
        }
        const activeTurnId = typeof parsed.activeTurnId === "string" ? parsed.activeTurnId : null;
        const messages = normalizeMessageStartupSnapshots(parsed.messages
            .map(toChatMessage)
            .filter((message) => message !== null)
            .map((message) => message.turnStatus === "running" && (!activeTurnId || message.turnId !== activeTurnId)
            ? finalizeTerminalAssistantMessage(message, { turnStatus: "done" })
            : message.role === "assistant" && message.turnStatus !== "running"
                ? finalizeTerminalAssistantMessage(message)
                : message));
        const selectedModel = normalizeStoredModel(parsed.selectedModel);
        const selectedEffort = isModelReasoningEffort(parsed.selectedEffort) ? parsed.selectedEffort : "low";
        const queuedPrompts = Array.isArray(parsed.queuedPrompts)
            ? parsed.queuedPrompts.filter(isQueuedPrompt).map((prompt) => ({ ...prompt, kind: prompt.kind ?? "queue" }))
            : [];
        const queuedPromptsBySession = Object.fromEntries(Object.entries(readRecord(parsed.queuedPromptsBySession) ?? {}).flatMap(([key, value]) => {
            if (!Array.isArray(value)) {
                return [];
            }
            const prompts = value
                .filter(isQueuedPrompt)
                .map((prompt) => ({ ...prompt, kind: prompt.kind ?? "queue" }));
            return prompts.length > 0 ? [[key, prompts]] : [];
        }));
        const currentQueueKey = queuedPromptSessionKey(typeof parsed.sessionId === "string" ? parsed.sessionId : null);
        if (queuedPrompts.length > 0 && !queuedPromptsBySession[currentQueueKey]) {
            queuedPromptsBySession[currentQueueKey] = queuedPrompts;
        }
        return {
            version: 1,
            messages,
            queuedPrompts: queuedPromptsBySession[currentQueueKey] ?? [],
            queuedPromptsBySession,
            workspaceId: typeof parsed.workspaceId === "string" ? parsed.workspaceId : null,
            sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
            threadId: typeof parsed.threadId === "string" ? parsed.threadId : null,
            activeTurnId,
            resumeThreadId: typeof parsed.resumeThreadId === "string" ? parsed.resumeThreadId : "",
            status: typeof parsed.status === "string" ? parsed.status : "Idle",
            selectedModel,
            selectedEffort,
            approvalPolicy: normalizeStoredApprovalPolicy(parsed.approvalPolicy),
            gearProfiles: normalizeGearProfiles(parsed.gearProfiles, selectedModel, selectedEffort),
            activeGearIndex: normalizeGearIndex(parsed.activeGearIndex),
            useLoadBalanceInWorkspace: typeof parsed.useLoadBalanceInWorkspace === "boolean" ? parsed.useLoadBalanceInWorkspace : undefined
        };
    }
    catch {
        return undefined;
    }

}

export function normalizeMessageStartupSnapshots(ctx, messages) {
    const {  } = ctx;
    let firstUserMessageSeen = false;
    return messages.map((message) => {
        if (message.role !== "user" || message.kind === "steer") {
            return message;
        }
        if (!firstUserMessageSeen) {
            firstUserMessageSeen = true;
            return message;
        }
        return message.startupSnapshot ? { ...message, startupSnapshot: undefined } : message;
    });

}

export function queuedPromptSessionKey(ctx, sessionId) {
    const { NEW_SESSION_QUEUE_KEY } = ctx;
    return sessionId ?? NEW_SESSION_QUEUE_KEY;

}

export function readStoredComposerDraft(ctx, sessionId) {
    const { emptyComposerDraft, queuedPromptSessionKey, readStoredComposerDrafts } = ctx;
    try {
        return readStoredComposerDrafts()[queuedPromptSessionKey(sessionId)] ?? emptyComposerDraft();
    }
    catch {
        return emptyComposerDraft();
    }

}

export function patchStoredComposerDraft(ctx, sessionId, patch) {
    const { COMPOSER_DRAFT_STORAGE_KEY, emptyComposerDraft, isEmptyComposerDraft, normalizeComposerDraft, queuedPromptSessionKey, readStoredComposerDrafts } = ctx;
    try {
        const key = queuedPromptSessionKey(sessionId);
        const drafts = readStoredComposerDrafts();
        const next = normalizeComposerDraft({ ...(drafts[key] ?? emptyComposerDraft()), ...patch });
        if (isEmptyComposerDraft(next)) {
            delete drafts[key];
        }
        else {
            drafts[key] = next;
        }
        window.localStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, drafts }));
    }
    catch {
        // Composer drafts are opportunistic; storage failure should not block input.
    }

}

export function moveStoredComposerDraft(ctx, fromSessionId, toSessionId) {
    const { COMPOSER_DRAFT_STORAGE_KEY, isEmptyComposerDraft, queuedPromptSessionKey, readStoredComposerDrafts } = ctx;
    try {
        const fromKey = queuedPromptSessionKey(fromSessionId);
        const toKey = queuedPromptSessionKey(toSessionId);
        if (fromKey === toKey) {
            return;
        }
        const drafts = readStoredComposerDrafts();
        const draft = drafts[fromKey];
        delete drafts[fromKey];
        if (draft && !isEmptyComposerDraft(draft)) {
            drafts[toKey] = draft;
        }
        window.localStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, drafts }));
    }
    catch {
        // Composer drafts are opportunistic; storage failure should not block input.
    }

}

export function readStoredComposerDrafts(ctx, ) {
    const { COMPOSER_DRAFT_STORAGE_KEY, isEmptyComposerDraft, normalizeComposerDraft, readRecord } = ctx;
    const raw = window.localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
    if (!raw) {
        return {};
    }
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1) {
        return {};
    }
    return Object.fromEntries(Object.entries(readRecord(parsed.drafts) ?? {}).flatMap(([key, value]) => {
        const draft = normalizeComposerDraft(value);
        return isEmptyComposerDraft(draft) ? [] : [[key, draft]];
    }));

}

export function emptyComposerDraft(ctx, ) {
    const {  } = ctx;
    return {
        input: "",
        forcePlanNextPrompt: false,
        executionMode: "default",
        forkNextPrompt: false
    };

}

export function normalizeComposerDraft(ctx, value) {
    const { emptyComposerDraft } = ctx;
    if (typeof value === "string") {
        return { ...emptyComposerDraft(), input: value };
    }
    if (!value || typeof value !== "object") {
        return emptyComposerDraft();
    }
    const candidate = value;
    const executionMode = candidate.executionMode === "plan" || candidate.executionMode === "goal" || candidate.executionMode === "default"
        ? candidate.executionMode
        : "default";
    return {
        input: typeof candidate.input === "string" ? candidate.input : "",
        forcePlanNextPrompt: candidate.forcePlanNextPrompt === true,
        executionMode,
        forkNextPrompt: candidate.forkNextPrompt === true
    };

}

export function isEmptyComposerDraft(ctx, draft) {
    const {  } = ctx;
    return (draft.input.length === 0 &&
        draft.forcePlanNextPrompt === false &&
        draft.executionMode === "default" &&
        draft.forkNextPrompt === false);

}

export function writeStoredSession(ctx, session) {
    const { STORAGE_KEY, normalizeMessageStartupSnapshots } = ctx;
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
            ...session,
            messages: normalizeMessageStartupSnapshots(session.messages)
        }));
    }
    catch {
        // Losing the local snapshot should not interrupt an active Codex turn.
  }

}
