// @ts-nocheck
import { UserInputRequestCard } from "./UserInputRequestCard";
import { USER_INPUT_METHOD } from "../userInputRequest";
export function ServerPrefixPanel(ctx, { block }) {
    const { ChevronRight, FileText, ListChecks, TerminalSquare, _jsx, _jsxs } = ctx;
    const Icon = block.kind === "startup" ? TerminalSquare : block.kind === "todo" ? ListChecks : FileText;
    return (_jsxs("details", {
        className: "startup-preflight server-prefix-panel",
        children: [
            _jsxs("summary", {
                className: "startup-preflight-summary",
                children: [
                    _jsx(ChevronRight, { className: "startup-preflight-chevron", "aria-hidden": "true" }),
                    _jsx(Icon, { "aria-hidden": "true" }),
                    _jsx("span", { children: block.title }),
                    _jsx("span", { className: "startup-preflight-meta", children: block.meta })
                ]
            }),
            _jsx("pre", { children: block.text })
        ]
    }));

}

export function serverPrefixBlocks(ctx, startupSnapshot, developerInstructions, showStartup = true) {
    const { extractServerProvidedBlocks, extractTodoMcpPromptBlocks, isTodoMcpPromptText, serverPrefixMetadata } = ctx;
    const blocks = [];
    const seen = new Set();
    const addBlock = (text, source) => {
        if (!text || seen.has(text)) {
            return;
        }
        const metadata = serverPrefixMetadata(text, source);
        if (!showStartup && metadata.kind === "startup") {
            return;
        }
        seen.add(text);
        blocks.push({ ...metadata, text });
    };
    if (showStartup) {
        addBlock(startupSnapshot, { target: "turn", phase: 0 });
    }
    for (const record of developerInstructions ?? []) {
        for (const block of extractServerProvidedBlocks(record.developerInstructions)) {
            if (isTodoMcpPromptText(block)) {
                continue;
            }
            addBlock(block, record);
        }
        for (const block of extractTodoMcpPromptBlocks(record.developerInstructions)) {
            addBlock(block, record);
        }
    }
    return blocks;

}

export function extractServerProvidedBlocks(ctx, value) {
    const {  } = ctx;
    if (!value) {
        return [];
    }
    const blocks = [];
    const patterns = [
        /^\[STARTUP\][\s\S]*?^\[END STARTUP\]/gm,
        /^\[SERVER-PROVIDED [^\]\n]+\][\s\S]*?^\[END SERVER-PROVIDED [^\]\n]+\]/gm
    ];
    for (const pattern of patterns) {
        for (const match of value.matchAll(pattern)) {
            if (match[0]) {
                blocks.push(match[0]);
            }
        }
    }
    return blocks;

}

export function serverPrefixMetadata(ctx, text, source) {
    const { isTodoMcpPromptText } = ctx;
    const meta = `sent to ${source.target}${source.phase === null || source.phase === undefined ? "" : ` phase ${source.phase}`}`;
    if (isTodoMcpPromptText(text)) {
        return { kind: "todo", title: "Todo plan", meta: "MCP prompt" };
    }
    if (text.includes("[STARTUP]") || text.includes("STARTUP PREFLIGHT")) {
        return { kind: "startup", title: "Startup", meta: "cwd/git" };
    }
    if (text.includes("CHILD TASK")) {
        return { kind: "context", title: "Child task context", meta };
    }
    if (text.includes("CONTEXT FORK")) {
        return { kind: "context", title: "Context fork", meta };
    }
    if (text.includes("LONG GOAL OBJECTIVE")) {
        return { kind: "context", title: "Long goal objective", meta };
    }
    if (text.includes("AUTO MODEL CONTINUATION")) {
        return { kind: "context", title: "Auto model continuation", meta };
    }
    if (text.includes("AUTO MODEL MODE")) {
        return { kind: "context", title: "Auto model mode", meta };
    }
    return { kind: "context", title: "Server context", meta };

}

export function TurnChangeList(ctx, { changes, sessionId, turnId }) {
    const { FileEditIcon, FileChangeList, Folder, openProjectFiles, _jsx, _jsxs } = ctx;
    const totals = changes.reduce((result, change) => {
        const stats = fileChangeLineStats({}, change);
        result.additions += stats.additions;
        result.deletions += stats.deletions;
        return result;
    }, { additions: 0, deletions: 0 });
    return (_jsxs("section", { className: "turn-changes", "aria-label": "Changes made", children: [_jsxs("div", { className: "turn-changes-header", children: [_jsx(FileEditIcon, { "aria-hidden": "true" }), _jsx("span", { children: "Changes" }), _jsxs("span", { className: "turn-changes-count", children: [changes.length, " ", changes.length === 1 ? "file" : "files"] }), _jsxs("span", { className: "turn-changes-line-totals", "aria-label": `${totals.additions} lines added, ${totals.deletions} lines deleted`, children: [_jsxs("span", { "data-tone": "add", children: ["+", totals.additions] }), _jsxs("span", { "data-tone": "delete", children: ["−", totals.deletions] })] }), sessionId && _jsxs("button", { className: "turn-changes-export", type: "button", onClick: () => openProjectFiles({ sessionId, turnId, changes }), title: "Open this turn as a source-level review session in Web VS Code", children: [_jsx(Folder, { "aria-hidden": "true" }), "Review in VS Code"] })] }), _jsx(FileChangeList, { changes: changes })] }));

}

export function FileChangeList(ctx, { changes }) {
    const { FileEditIcon, FileChangeDiffPopup, _Fragment, _jsx, _jsxs, compactFilePath, fileChangeLabel, fileChangeTone, useState } = ctx;
    const [selectedFileChange, setSelectedFileChange] = useState(null);
    return (_jsxs(_Fragment, { children: [_jsx("ul", { className: "file-change-list", children: changes.map((change) => {
        const stats = fileChangeLineStats({}, change);
        return (_jsx("li", { children: _jsxs("button", { className: "file-change-trigger", type: "button", onClick: () => setSelectedFileChange(change), children: [_jsx("span", { className: "file-change-badge", "data-operation": fileChangeTone(change.kind), children: fileChangeLabel(change.kind) }), _jsx("code", { className: "file-change-path", title: change.path, children: compactFilePath(change.path) }), _jsxs("span", { className: "file-change-lines", "aria-label": `${stats.additions} lines added, ${stats.deletions} lines deleted`, children: [_jsxs("span", { "data-tone": "add", children: ["+", stats.additions] }), _jsxs("span", { "data-tone": "delete", children: ["−", stats.deletions] })] }), _jsx(FileEditIcon, { "aria-hidden": "true" })] }) }, `${change.kind}:${change.path}`));
    }) }), selectedFileChange && _jsx(FileChangeDiffPopup, { change: selectedFileChange, onClose: () => setSelectedFileChange(null) })] }));

}

export function fileChangeLineStats(ctx, change) {
    const {  } = ctx;
    const explicitAdditions = validLineCount(change?.additions);
    const explicitDeletions = validLineCount(change?.deletions);
    if (explicitAdditions !== undefined || explicitDeletions !== undefined) {
        return {
            additions: explicitAdditions ?? 0,
            deletions: explicitDeletions ?? 0
        };
    }
    const diff = firstChangeText(change, ["unifiedDiff", "patch", "diff"]);
    if (diff !== undefined) {
        return lineStatsFromDiff(diff);
    }
    const before = firstChangeText(change, ["before", "beforeText", "beforeContent", "oldContent", "previousContent", "original"]);
    const after = firstChangeText(change, ["after", "afterText", "afterContent", "newContent", "currentContent", "updated"]);
    if (change?.kind === "add") {
        return { additions: textLineCount(after ?? ""), deletions: 0 };
    }
    if (change?.kind === "delete") {
        return { additions: 0, deletions: textLineCount(before ?? "") };
    }
    if (before !== undefined && after !== undefined) {
        return lineStatsFromTextPair(before, after);
    }
    return { additions: 0, deletions: 0 };

}

function validLineCount(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

}

function firstChangeText(change, keys) {
    for (const key of keys) {
        if (typeof change?.[key] === "string") {
            return change[key];
        }
    }
    return undefined;

}

function lineStatsFromDiff(diff) {
    let additions = 0;
    let deletions = 0;
    for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) {
            continue;
        }
        if (line.startsWith("+")) {
            additions += 1;
        }
        else if (line.startsWith("-")) {
            deletions += 1;
        }
    }
    return { additions, deletions };

}

function textLineCount(text) {
    if (!text) {
        return 0;
    }
    const lines = text.split(/\r?\n/);
    return /\r?\n$/.test(text) ? Math.max(0, lines.length - 1) : lines.length;

}

function lineStatsFromTextPair(before, after) {
    const beforeLines = before ? before.split(/\r?\n/) : [];
    const afterLines = after ? after.split(/\r?\n/) : [];
    let prefix = 0;
    while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
        prefix += 1;
    }
    let suffix = 0;
    while (suffix < beforeLines.length - prefix && suffix < afterLines.length - prefix && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]) {
        suffix += 1;
    }
    return {
        additions: Math.max(0, afterLines.length - prefix - suffix),
        deletions: Math.max(0, beforeLines.length - prefix - suffix)
    };

}

export function hasVisibleTodoPlan(ctx, todo) {
    const {  } = ctx;
    return Boolean(todo && (todo.lightweight || todo.items.length > 0 || todo.comments.length > 0 || (todo.messages?.length ?? 0) > 0 || Boolean(todo.control.context) || todo.control.paused));

}

export function LiveEvent(ctx, { item, sessionId }) {
    const { ApprovalEvent, CheckSquare2, ChevronRight, Circle, DeferredDetails, FileChangeEvent, Loader2, MarkdownContent, MessageSquare, Shrink, StatusUpdateIndicator, StructuredCommentEvent, SubagentEvent, _jsx, _jsxs, commandStatus, fileChangeItemFromPatchCommand } = ctx;
    if (item.itemType === "agent_message") {
        if (item.delivery === "async" && item.questions?.length) return null;
        if (item.comment) {
            return _jsx(StructuredCommentEvent, { item: item, sessionId: sessionId });
        }
        return (_jsxs("section", { className: "live-item live-item-message", children: [_jsxs("div", { className: "live-item-header", children: [_jsx(MessageSquare, { "aria-hidden": "true" }), _jsx("span", { children: "Message" })] }), item.text && _jsx(MarkdownContent, { children: item.text })] }));
    }
    if (item.itemType === "approval") {
        return _jsx(ApprovalEvent, { item: item });
    }
    if (item.itemType === "reasoning") {
        const statusUpdateText = item.text.trim();
        return _jsx(StatusUpdateIndicator, { text: statusUpdateText || "Thinking", spinning: item.eventType !== "item.completed" });
    }
    if (item.itemType === "command_execution") {
        const patchFileChangeItem = fileChangeItemFromPatchCommand(item);
        if (patchFileChangeItem) {
            return _jsx(FileChangeEvent, { item: patchFileChangeItem });
        }
        const status = commandStatus(item);
        const hasOutput = item.aggregatedOutput.trim().length > 0;
        return (_jsx(DeferredDetails, { className: `command-card ${status.tone}`, summary: _jsxs("summary", { className: "command-row", children: [_jsx(ChevronRight, { className: "command-chevron", "aria-hidden": "true" }), _jsx("code", { className: "command-label", children: item.command || "(command)" }), _jsx("span", { className: "command-status", children: status.label })] }), children: _jsxs("div", { className: "command-output-wrap", children: [_jsx("div", { className: "command-full-command", children: _jsx("code", { children: item.command || "(command)" }) }), _jsx("pre", { className: "command-output", children: hasOutput ? item.aggregatedOutput : "(no output yet)" })] }) }));
    }
    if (item.itemType === "file_change") {
        return _jsx(FileChangeEvent, { item: item });
    }
    if (item.itemType === "web_search") {
        return (_jsx("section", { className: "live-item", children: _jsxs("div", { className: "live-item-header", children: [_jsx(Loader2, { className: item.eventType === "item.completed" ? undefined : "spin", "aria-hidden": "true" }), _jsx("span", { children: "Searching" }), _jsx("code", { children: item.query })] }) }));
    }
    if (item.itemType === "todo_list") {
        return (_jsxs("section", { className: "live-item", children: [_jsxs("div", { className: "live-item-header", children: [_jsx(CheckSquare2, { "aria-hidden": "true" }), _jsx("span", { children: "Plan" })] }), _jsx("ul", { className: "todo-list", children: item.items.map((todo, index) => (_jsxs("li", { "data-completed": todo.completed, children: [_jsx(ChevronRight, { "aria-hidden": "true" }), _jsx("span", { children: todo.text })] }, `${index}:${todo.text}`))) })] }));
    }
    if (item.itemType === "context_compaction") {
        return _jsx(StatusUpdateIndicator, { text: item.eventType === "item.completed" ? "Context compacted" : "Compacting context", spinning: item.eventType !== "item.completed", completedIcon: Shrink });
    }
    if (item.itemType === "subagent") {
        return _jsx(SubagentEvent, { item: item, sessionId: sessionId });
    }
    return (_jsx("section", { className: "live-item live-item-error", children: _jsxs("div", { className: "live-item-header", children: [_jsx(Circle, { "aria-hidden": "true" }), _jsx("span", { children: item.message })] }) }));

}

export function StructuredCommentEvent(ctx, { item, activities = [], id, sessionId }) {
    const { ChevronRight, DeferredDetails, FileEditIcon, LiveEvent, MarkdownContent, Search, TerminalSquare, _jsx, _jsxs, commentaryActivityCounts, commentaryTypeForActivities, structuredCommentIcon, structuredCommentType } = ctx;
    const extracts = (item.comment.extracts ?? []).filter((extract) => !["trouble", "blocker", "error", "diagnosis"].includes(extract.type));
    if (extracts.length === 0 && activities.length === 0) return null;
    const displayExtracts = extracts.map((extract) => {
        const type = structuredCommentType(commentaryTypeForActivities(extract.type, activities));
        return { ...extract, type, Icon: structuredCommentIcon(type) };
    });
    const primaryType = displayExtracts[0]?.type ?? "action";
    const showDetail = displayExtracts.length !== 1 || item.comment.detail.trim() !== displayExtracts[0]?.shortMsg.trim();
    const { commandCount, editCount, searchCount } = commentaryActivityCounts(activities);
    const expandable = showDetail || activities.length > 0;
    const extractRows = displayExtracts.map((extract, index) => (_jsxs("div", {
        className: "structured-comment-extract",
        "data-comment-type": extract.type,
        children: [
            _jsx("span", { className: "structured-comment-icon", title: extract.type, "aria-label": extract.type, children: _jsx(extract.Icon, { "aria-hidden": "true" }) }),
            _jsx("strong", { className: "structured-comment-short", children: extract.shortMsg })
        ]
    }, `${index}:${extract.type}:${extract.shortMsg}`)));
    const summary = (_jsxs("div", {
        className: "structured-comment-summary",
        children: [
            _jsx("div", { className: "structured-comment-extracts", children: extractRows }),
            _jsxs("div", { className: "structured-comment-meta", children: [
                commandCount > 0 && (_jsxs("span", { className: "structured-comment-activity-count", title: `Ran ${commandCount} ${commandCount === 1 ? "command" : "commands"}`, "aria-label": `Ran ${commandCount} ${commandCount === 1 ? "command" : "commands"}`, children: [_jsx(TerminalSquare, { "aria-hidden": "true" }), _jsx("span", { children: commandCount })] })),
                editCount > 0 && (_jsxs("span", { className: "structured-comment-activity-count", title: `Edited ${editCount} ${editCount === 1 ? "file" : "files"}`, "aria-label": `Edited ${editCount} ${editCount === 1 ? "file" : "files"}`, children: [_jsx(FileEditIcon, { "aria-hidden": "true" }), _jsx("span", { children: editCount })] })),
                searchCount > 0 && (_jsxs("span", { className: "structured-comment-activity-count", title: `Searched ${searchCount} ${searchCount === 1 ? "query" : "queries"}`, "aria-label": `Searched ${searchCount} ${searchCount === 1 ? "query" : "queries"}`, children: [_jsx(Search, { "aria-hidden": "true" }), _jsx("span", { children: searchCount })] })),
                expandable && _jsx(ChevronRight, { className: "structured-comment-chevron", "aria-hidden": "true" })
            ] })
        ]
    }));
    if (!expandable) {
        return (_jsx("section", { className: "live-item structured-comment structured-comment-static", "data-comment-type": primaryType, id: id, children: summary }));
    }
    return (_jsxs(DeferredDetails, { className: "live-item structured-comment", "data-comment-type": primaryType, id: id, summary: _jsx("summary", { children: summary }), children: [showDetail && _jsx(MarkdownContent, { className: "structured-comment-detail", children: item.comment.detail }), activities.length > 0 && (_jsx("div", { className: "structured-comment-activity-details", children: activities.map((activity) => (_jsx(LiveEvent, { item: activity.item, sessionId: sessionId }, `${activity.groupType}:${activity.id}`))) }))] }));

}

export function structuredCommentType(ctx, type) {
    const {  } = ctx;
    const value = String(type ?? "").toLowerCase();
    if (value === "answer" || value === "edit" || value === "verification" || value === "trouble" || value === "solution")
        return value;
    if (value === "response" || value === "reply")
        return "answer";
    if (value === "blocker" || value === "error" || value === "diagnosis")
        return "trouble";
    if (value === "fix" || value === "resolution" || value === "workaround")
        return "solution";
    return "action";

}

export function structuredCommentIcon(ctx, type) {
    const { CheckCircle2, Lightbulb, MessageSquare, Pencil, Search, TriangleAlert } = ctx;
    if (type === "answer")
        return MessageSquare;
    if (type === "edit")
        return Pencil;
    if (type === "verification")
        return CheckCircle2;
    if (type === "trouble")
        return TriangleAlert;
    if (type === "solution")
        return Lightbulb;
    return Search;

}

export function StatusUpdateIndicator(ctx, { text, spinning = true, completedIcon }) {
    const { CheckCircle2, Loader2, _jsx, _jsxs } = ctx;
    const Icon = spinning ? Loader2 : (completedIcon ?? CheckCircle2);
    return (_jsx("section", { className: "live-item live-item-status-update", "data-state": spinning ? "running" : "completed", children: _jsxs("div", { className: "live-item-header", children: [_jsx(Icon, { className: spinning ? "spin" : undefined, "aria-hidden": "true" }), _jsx("span", { className: "status-update-subheader", children: text })] }) }));

}

export function SubagentEvent(ctx, { item, sessionId }) {
    const { ChevronRight, MarkdownContent, SubagentTranscript, UserPlus, _Fragment, _jsx, _jsxs, fetchSubagentTranscript, formatSubagentStatus, subagentNames, subagentStatusTone, subagentToolLabel, useEffect, useRef, useState, visibleSubagentAgents } = ctx;
    const [isExpanded, setIsExpanded] = useState(false);
    const [transcripts, setTranscripts] = useState({});
    const requestedThreadIdsRef = useRef(new Set());
    const requestScopeRef = useRef("");
    const names = subagentNames(item);
    const threadIds = [...new Set(item.receiverThreadIds.filter(Boolean))];
    const displayAgents = visibleSubagentAgents(item);
    const canViewWork = Boolean(sessionId && threadIds.length > 0);
    const hasDetails = Boolean(item.prompt || item.model || item.reasoningEffort || threadIds.length || displayAgents.length);
    requestScopeRef.current = sessionId ?? "";
    useEffect(() => {
        requestedThreadIdsRef.current = new Set();
        setTranscripts({});
    }, [sessionId]);
    async function loadTranscript(threadId, force = false) {
        if (!sessionId || !threadId || (requestedThreadIdsRef.current.has(threadId) && !force)) {
            return;
        }
        requestedThreadIdsRef.current.add(threadId);
        setTranscripts((current) => ({
            ...current,
            [threadId]: { status: "loading", error: "", payload: null }
        }));
        const requestScope = sessionId;
        try {
            const payload = await fetchSubagentTranscript(sessionId, threadId, force);
            if (requestScopeRef.current !== requestScope) {
                return;
            }
            setTranscripts((current) => ({
                ...current,
                [threadId]: { status: "loaded", error: "", payload }
            }));
        }
        catch (error) {
            if (requestScopeRef.current !== requestScope) {
                return;
            }
            setTranscripts((current) => ({
                ...current,
                [threadId]: {
                    status: "error",
                    error: error instanceof Error ? error.message : "Could not load the subagent transcript.",
                    payload: null
                }
            }));
        }
    }
    const header = _jsxs(_Fragment, { children: [hasDetails && _jsx(ChevronRight, { className: "command-chevron", "aria-hidden": "true" }), _jsx(UserPlus, { "aria-hidden": "true" }), _jsx("span", { children: subagentToolLabel(item.tool) }), names.length > 0 && _jsx("strong", { children: names.join(", ") }), canViewWork && _jsx("span", { className: "subagent-event-view-work", children: isExpanded ? "Hide work" : "View work" }), _jsx("span", { className: "subagent-event-status", children: formatSubagentStatus(item.status) })] });
    if (!hasDetails) {
        return (_jsx("section", { className: "subagent-event", "data-status": subagentStatusTone(item.status), children: _jsx("div", { className: "subagent-event-header", children: header }) }));
    }
    return (_jsxs("details", { className: "subagent-event", "data-status": subagentStatusTone(item.status), onToggle: (event) => {
            if (event.target !== event.currentTarget) {
                return;
            }
            const open = event.currentTarget.open;
            setIsExpanded(open);
            if (open && canViewWork) {
                threadIds.forEach((childThreadId) => void loadTranscript(childThreadId));
            }
        }, children: [_jsx("summary", { className: "subagent-event-header", children: header }), _jsxs("div", { className: "subagent-event-body", children: [(item.model || item.reasoningEffort || threadIds.length > 0) && (_jsxs("div", { className: "subagent-event-meta", children: [item.model && _jsxs("span", { children: ["Model: ", item.model] }), item.reasoningEffort && _jsxs("span", { children: ["Reasoning: ", item.reasoningEffort] }), threadIds.map((threadId) => _jsx("code", { children: threadId }, threadId))] })), item.prompt && (_jsxs("div", { className: "subagent-event-prompt", children: [_jsx("span", { children: "Delegated task" }), _jsx(MarkdownContent, { children: item.prompt })] })), displayAgents.length > 0 && (_jsx("div", { className: "subagent-agent-list", children: displayAgents.map((agent) => (_jsxs("section", { className: "subagent-agent", "data-status": subagentStatusTone(agent.status), children: [_jsxs("div", { className: "subagent-agent-header", children: [_jsx("span", { children: agent.name || agent.id }), _jsx("strong", { children: formatSubagentStatus(agent.status) })] }), agent.message && _jsx(MarkdownContent, { children: agent.message })] }, agent.id))) })), canViewWork && (_jsx("div", { className: "subagent-transcript-list", children: threadIds.map((threadId) => (_jsx(SubagentTranscript, { anchorPrefix: `${item.id}:${threadId}`, onRetry: () => void loadTranscript(threadId, true), sessionId: sessionId, state: transcripts[threadId] ?? { status: "loading", error: "", payload: null }, threadId: threadId }, threadId))) }))] })] }));

}

export function SubagentTranscript(ctx, { anchorPrefix, onRetry, state, threadId, sessionId, workspaceId }) {
    const { Loader2, MessageSquare, MessageTimeline, TriangleAlert, _jsx, _jsxs, isStreamItem, shortId, streamItemsToSegments, subagentStatusTone } = ctx;
    if (state.status === "loading") {
        return (_jsxs("section", { className: "subagent-transcript", "aria-live": "polite", children: [_jsxs("div", { className: "subagent-transcript-header", children: [_jsx(Loader2, { className: "spin", "aria-hidden": "true" }), _jsx("span", { children: "Loading child work…" }), _jsx("code", { children: shortId(threadId) })] }), _jsx("span", { className: "subagent-transcript-note", children: "Messages and tool activity load only when this card is opened." })] }));
    }
    if (state.status === "error") {
        return (_jsxs("section", { className: "subagent-transcript subagent-transcript-error", role: "alert", children: [_jsxs("div", { className: "subagent-transcript-header", children: [_jsx(TriangleAlert, { "aria-hidden": "true" }), _jsx("span", { children: "Couldn’t load child work" }), _jsx("code", { children: shortId(threadId) })] }), _jsx("span", { className: "subagent-transcript-note", children: state.error }), _jsx("button", { type: "button", onClick: onRetry, children: "Retry" })] }));
    }
    const turns = state.payload?.turns ?? [];
    const timelines = turns.map((turn) => {
        const items = turn.items.filter(isStreamItem);
        const completed = subagentStatusTone(turn.status) !== "running";
        return {
            turn,
            items,
            completed,
            segments: streamItemsToSegments(items, threadId)
        };
    });
    const itemCount = timelines.reduce((count, timeline) => count + timeline.items.length, 0);
    const visibleTimelines = timelines.filter((timeline) => timeline.segments.length > 0 || !timeline.completed);
    return (_jsxs("section", { className: "subagent-transcript", children: [_jsxs("div", { className: "subagent-transcript-header", children: [_jsx(MessageSquare, { "aria-hidden": "true" }), _jsx("span", { children: "Child work" }), _jsx("code", { title: threadId, children: shortId(threadId) }), itemCount > 0 && _jsxs("span", { className: "subagent-transcript-count", children: [itemCount, " ", itemCount === 1 ? "event" : "events"] })] }), visibleTimelines.length > 0 ? visibleTimelines.map((timeline) => (_jsx(MessageTimeline, { anchorPrefix: `${anchorPrefix}:${timeline.turn.id}`, completed: timeline.completed, running: !timeline.completed, segments: timeline.segments, codexSessionId: threadId, sessionId: sessionId, turnId: timeline.turn.id, workspaceId: workspaceId }, timeline.turn.id))) : (_jsx("span", { className: "subagent-transcript-note", children: "No messages or tool activity were recorded for this child." }))] }));

}

export function subagentNames(ctx, item) {
    const {  } = ctx;
    const agentNames = item.agents.map((agent) => agent.name || agent.id).filter(Boolean);
    return [...new Set([...(item.label ? [item.label] : []), ...agentNames])];

}

export function subagentToolLabel(ctx, tool) {
    const {  } = ctx;
    const normalized = tool.replace(/_/g, "").toLocaleLowerCase();
    if (normalized === "spawnagent")
        return "Spawned subagent";
    if (normalized === "sendinput" || normalized === "sendmessage" || normalized === "followuptask")
        return "Sent to subagent";
    if (normalized === "resumeagent")
        return "Resumed subagent";
    if (normalized === "closeagent" || normalized === "interruptagent")
        return "Stopped subagent";
    if (normalized === "wait" || normalized === "waitagent")
        return "Subagent status";
    if (normalized === "listagents")
        return "Subagents";
    if (normalized === "activity")
        return "Subagent activity";
    return tool || "Subagent";

}

export function formatSubagentStatus(ctx, status) {
    const {  } = ctx;
    const normalized = status.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").trim();
    return normalized ? normalized[0].toLocaleUpperCase() + normalized.slice(1) : "Unknown";

}

export function subagentStatusTone(ctx, status) {
    const {  } = ctx;
    const normalized = status.toLocaleLowerCase();
    if (normalized.includes("error") || normalized.includes("fail") || normalized.includes("interrupt"))
        return "error";
    if (normalized.includes("complete") || normalized.includes("done") || normalized.includes("shutdown"))
        return "done";
    return "running";

}

export function FileChangeEvent(ctx, { item }) {
    const { ChevronRight, FileChangeList, _Fragment, _jsx, _jsxs, summarizeFileChangeItem } = ctx;
    const summary = summarizeFileChangeItem(item);
    return (_jsx(_Fragment, { children: _jsxs("details", { className: "file-change-card", open: true, children: [_jsxs("summary", { className: "file-change-row", children: [_jsx(ChevronRight, { className: "command-chevron", "aria-hidden": "true" }), _jsx("span", { className: "file-change-summary-label", children: summary.label }), _jsx("span", { className: "file-change-summary-status", children: summary.status })] }), _jsx("div", { className: "file-change-panel", children: _jsx(FileChangeList, { changes: item.changes }) })] }) }));

}

export function ApprovalEvent(ctx, { item, onDecisionSubmitted, compact = false }) {
    if (item.method === USER_INPUT_METHOD) return ctx._jsx(UserInputRequestCard, { item, onDecisionSubmitted });
    const { FileEditIcon, TerminalSquare, _jsx, _jsxs, approvalAvailableDecisions, approvalDecisionLabel, readRecord, readStringField, summarizeCommand, useState } = ctx;
    const [submittingDecision, setSubmittingDecision] = useState(null);
    const [isStale, setIsStale] = useState(false);
    const params = readRecord(item.params);
    const isCommandApproval = item.method === "item/commandExecution/requestApproval";
    const title = isCommandApproval ? "Command approval" : "File approval";
    const command = readStringField(params, "command");
    const cwd = readStringField(params, "cwd");
    const reason = readStringField(params, "reason");
    const grantRoot = readStringField(params, "grantRoot");
    const networkContext = readRecord(params?.networkApprovalContext);
    const networkHost = readStringField(networkContext, "host");
    const networkProtocol = readStringField(networkContext, "protocol");
    const availableDecisions = approvalAvailableDecisions(params);
    const acceptDecision = availableDecisions.find((decision) => decision.key === "accept");
    const acceptForSessionDecision = availableDecisions.find((decision) => decision.key === "acceptForSession");
    const declineDecision = availableDecisions.find((decision) => decision.key === "decline");
    const cancelDecision = availableDecisions.find((decision) => decision.key === "cancel");
    const resolved = item.status === "resolved";
    async function decide(action) {
        if (resolved || submittingDecision === action.key) {
            return;
        }
        setSubmittingDecision(action.key);
        try {
            const response = await fetch(`/api/approvals/${encodeURIComponent(item.approvalId)}/decision`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ decision: action.decision })
            });
            if (!response.ok) {
                const payload = (await response.json().catch(() => null));
                if ((response.status === 404 || response.status === 409) && payload?.stale) {
                    setIsStale(true);
                    onDecisionSubmitted?.(item.approvalId);
                    return;
                }
                throw new Error(`API returned ${response.status}`);
            }
            onDecisionSubmitted?.(item.approvalId);
        }
        catch {
            // Keep the approval actionable if the request fails or the stream is stale.
        }
        finally {
            setSubmittingDecision(null);
        }
    }
    if (isStale) {
        return null;
    }
    if (resolved && !item.error) {
        return (_jsx("section", { className: "approval-card approval-record", "data-status": item.status, children: _jsxs("div", { className: "approval-header", children: [isCommandApproval ? _jsx(TerminalSquare, { "aria-hidden": "true" }) : _jsx(FileEditIcon, { "aria-hidden": "true" }), _jsx("span", { children: title }), command && _jsx("code", { children: summarizeCommand(command) }), _jsx("strong", { children: approvalDecisionLabel(item.decision) })] }) }));
    }
    return (_jsxs("section", { className: `approval-card${compact ? " approval-card-compact" : ""}`, "data-status": item.status, children: [!compact && (_jsxs("div", { className: "approval-header", children: [isCommandApproval ? _jsx(TerminalSquare, { "aria-hidden": "true" }) : _jsx(FileEditIcon, { "aria-hidden": "true" }), _jsx("span", { children: title }), _jsx("strong", { children: resolved ? approvalDecisionLabel(item.decision) : "Waiting" })] })), reason && _jsx("p", { children: reason }), networkHost && (_jsxs("p", { children: ["Network: ", _jsx("code", { children: networkProtocol ? `${networkProtocol}://${networkHost}` : networkHost })] })), command && _jsx("pre", { className: "approval-command", children: command }), cwd && _jsx("code", { className: "approval-meta", children: cwd }), grantRoot && _jsx("code", { className: "approval-meta", children: grantRoot }), !resolved && (_jsxs("div", { className: "approval-actions", children: [acceptDecision && (_jsx("button", { type: "button", "data-action": "approve", onClick: () => void decide(acceptDecision), disabled: submittingDecision === acceptDecision.key, children: "Approve" })), acceptForSessionDecision && (_jsx("button", { type: "button", "data-action": "approve", onClick: () => void decide(acceptForSessionDecision), disabled: submittingDecision === acceptForSessionDecision.key, children: "Approve session" })), declineDecision && (_jsx("button", { type: "button", onClick: () => void decide(declineDecision), disabled: submittingDecision === declineDecision.key, children: "Decline" })), cancelDecision && (_jsx("button", { type: "button", onClick: () => void decide(cancelDecision), disabled: submittingDecision === cancelDecision.key, children: "Cancel" }))] })), item.error && _jsx("small", { className: "approval-error", children: item.error })] }));

}

export function FileChangeDiffPopup(ctx, { change, onClose }) {
    const { FileAnnotationComposerContext, MonacoDiffEditor, X, _jsx, _jsxs, buildDiffTextPair, fileChangeLabel, fileChangeTone, getFileName, hasChangeText, useContext, useEffect, useMemo, useState } = ctx;
    const annotationComposer = useContext(FileAnnotationComposerContext);
    const [previewText, setPreviewText] = useState(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const previewChange = useMemo(() => (previewText === null || hasChangeText(change) ? change : { ...change, after: previewText }), [change, previewText]);
    const textPair = useMemo(() => buildDiffTextPair(previewChange), [previewChange]);
    const fileName = getFileName(change.path);
    useEffect(() => {
        setPreviewText(null);
        setPreviewLoading(false);
        if (hasChangeText(change) || change.kind === "delete") {
            return;
        }
        let cancelled = false;
        setPreviewLoading(true);
        void fetch(`/api/workspaces/file-preview?path=${encodeURIComponent(change.path)}`)
            .then(async (response) => {
            if (!response.ok) {
                return null;
            }
            return (await response.json().catch(() => null));
        })
            .then((payload) => {
            if (!cancelled && payload?.exists !== false && typeof payload?.text === "string") {
                setPreviewText(payload.text);
            }
        })
            .catch(() => undefined)
            .finally(() => {
            if (!cancelled) {
                setPreviewLoading(false);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [change]);
    useEffect(() => {
        return () => annotationComposer?.removeFileAnnotation(change.path);
    }, [annotationComposer?.removeFileAnnotation, change.path]);
    useEffect(() => {
        function closeOnEscape(event) {
            if (event.key === "Escape") {
                onClose();
            }
        }
        window.addEventListener("keydown", closeOnEscape);
        return () => window.removeEventListener("keydown", closeOnEscape);
    }, [onClose]);
    return (_jsx("div", { className: "file-diff-backdrop", role: "presentation", onMouseDown: onClose, children: _jsxs("section", { className: "file-diff-popup", role: "dialog", "aria-modal": "true", "aria-label": `Diff for ${fileName}`, onMouseDown: (event) => event.stopPropagation(), children: [_jsxs("header", { className: "file-diff-header", children: [_jsxs("div", { className: "file-diff-title", children: [_jsx("span", { className: "file-change-badge", "data-operation": fileChangeTone(change.kind), children: fileChangeLabel(change.kind) }), _jsxs("div", { children: [_jsx("strong", { children: fileName }), _jsx("code", { children: change.path })] })] }), _jsx("button", { className: "icon-button", type: "button", onClick: onClose, "aria-label": "Close diff", children: _jsx(X, { "aria-hidden": "true" }) })] }), textPair ? (_jsx(MonacoDiffEditor, { before: textPair.before, after: textPair.after, filePath: change.path, activeAnnotation: annotationComposer?.activeAnnotation, workspaceId: annotationComposer?.workspaceId, sessionUrl: annotationComposer?.sessionUrl, onAsk: annotationComposer?.askAboutFileAnnotation, onRemoveAnnotation: () => annotationComposer?.removeFileAnnotation(change.path) })) : (_jsx("div", { className: "file-diff-state", children: previewLoading ? "Loading file…" : "No comparable text was included for this file change." }))] }) }));

}

export function fileChangeItemFromPatchCommand(ctx, item) {
    const { parseApplyPatchChanges } = ctx;
    const changes = parseApplyPatchChanges(item.command);
    if (changes.length === 0) {
        return null;
    }
    return {
        id: item.id,
        originThreadId: item.originThreadId,
        originTurnId: item.originTurnId,
        eventType: item.eventType,
        itemType: "file_change",
        changes,
        status: item.status,
        sourceItemType: "command_execution"
    };

}

export function parseApplyPatchChanges(ctx, command) {
    const { applyPatchLinesToTextPair, readApplyPatchBody } = ctx;
    const patch = readApplyPatchBody(command);
    if (!patch) {
        return [];
    }
    const changes = [];
    let current = null;
    function finishCurrent() {
        if (!current) {
            return;
        }
        const patchText = current.lines.join("\n").replace(/\n$/, "");
        const change = { path: current.path, kind: current.kind };
        if (current.kind === "add") {
            change.after = current.lines
                .filter((line) => line.startsWith("+"))
                .map((line) => line.slice(1))
                .join("\n");
        }
        else if (current.kind === "update") {
            const textPair = applyPatchLinesToTextPair(current.lines);
            if (textPair) {
                change.before = textPair.before;
                change.after = textPair.after;
            }
            else if (patchText) {
                change.patch = patchText;
            }
        }
        else if (patchText) {
            change.patch = patchText;
        }
        changes.push(change);
        current = null;
    }
    for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
        const addMatch = /^\*\*\* Add File: (.+)$/.exec(line);
        const updateMatch = /^\*\*\* Update File: (.+)$/.exec(line);
        const deleteMatch = /^\*\*\* Delete File: (.+)$/.exec(line);
        if (addMatch || updateMatch || deleteMatch) {
            finishCurrent();
            current = {
                path: (addMatch?.[1] ?? updateMatch?.[1] ?? deleteMatch?.[1] ?? "").trim(),
                kind: addMatch ? "add" : deleteMatch ? "delete" : "update",
                lines: []
            };
            continue;
        }
        if (line.startsWith("*** End Patch")) {
            finishCurrent();
            continue;
        }
        if (current && !line.startsWith("*** Begin Patch")) {
            current.lines.push(line);
        }
    }
    finishCurrent();
    return changes.filter((change) => change.path);

}

export function readApplyPatchBody(ctx, command) {
    const {  } = ctx;
    if (typeof command !== "string") {
        return "";
    }
    const begin = command.indexOf("*** Begin Patch");
    const end = command.lastIndexOf("*** End Patch");
    if (begin === -1 || end === -1 || end < begin) {
        return "";
    }
    return command.slice(begin, end + "*** End Patch".length);

}

export function applyPatchLinesToTextPair(ctx, lines) {
    const {  } = ctx;
    const before = [];
    const after = [];
    let hasPatchLine = false;
    for (const line of lines) {
        if (line.startsWith("@@") || line.startsWith("*** ")) {
            continue;
        }
        if (line.startsWith("+")) {
            after.push(line.slice(1));
            hasPatchLine = true;
            continue;
        }
        if (line.startsWith("-")) {
            before.push(line.slice(1));
            hasPatchLine = true;
            continue;
        }
        if (line.startsWith(" ")) {
            const text = line.slice(1);
            before.push(text);
            after.push(text);
            hasPatchLine = true;
        }
    }
    return hasPatchLine ? { before: before.join("\n"), after: after.join("\n") } : null;

}

export function commandStatus(ctx, item) {
    const {  } = ctx;
    if (item.status === "in_progress" || item.status === "inProgress") {
        return { label: "Running", tone: "cmd-status-running" };
    }
    if (item.status === "completed" && (item.exitCode === undefined || item.exitCode === 0)) {
        return { label: "Completed", tone: "cmd-status-ok" };
    }
    if (item.status === "completed") {
        return { label: `Exit ${item.exitCode ?? "?"}`, tone: "cmd-status-error" };
    }
    return { label: item.status || "Failed", tone: "cmd-status-error" };

}

export function collectFileChanges(ctx, items) {
    const {  } = ctx;
    const authoritativeItems = items.filter((item) => item.itemType === "file_change" && item.authoritative === true && Array.isArray(item.changes));
    const selectedItems = authoritativeItems.length > 0 ? [authoritativeItems.at(-1)] : items;
    const changesByPath = new Map();
    for (const item of selectedItems) {
        if (item.itemType !== "file_change") {
            continue;
        }
        for (const change of item.changes) {
            if (change.path) {
                changesByPath.set(change.path, change);
            }
        }
    }
    return [...changesByPath.values()];

}

export function formatTurnDuration(ctx, durationMs) {
    const {  } = ctx;
    if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
        return "unknown";
    }
    if (durationMs < 1_000) {
        return `${Math.max(1, Math.round(durationMs))}ms`;
    }
    if (durationMs < 60_000) {
        return `${(durationMs / 1_000).toFixed(1).replace(/\.0$/, "")}s`;
    }
    const minutes = Math.floor(durationMs / 60_000);
    const seconds = Math.round((durationMs % 60_000) / 1_000);
    return seconds === 60 ? `${minutes + 1}m` : `${minutes}m ${seconds}s`;

}

export function messageTimingLabel(ctx, message, now) {
    const { formatMessageTimestamp, formatTurnDuration } = ctx;
    if (message.role === "user") {
        return message.createdAt ? `Sent ${formatMessageTimestamp(message.createdAt)}` : "";
    }
    if (message.role !== "assistant") {
        return "";
    }
    if (message.turnStatus === "running") {
        const startedAt = Date.parse(message.createdAt ?? "");
        return Number.isFinite(startedAt) ? `Running for ${formatTurnDuration(Math.max(0, now - startedAt))}` : "Running";
    }
    if (message.turnStatus === "done") {
        const duration = formatTurnDuration(message.executionDurationMs);
        return message.completedAt ? `Completed ${formatMessageTimestamp(message.completedAt)} cost ${duration}` : `Completed cost ${duration}`;
    }
    return "";

}

export function formatMessageTimestamp(ctx, timestamp) {
    const {  } = ctx;
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
        return "";
    }
    return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    }).format(date);

}

export function summarizeFileChangeItem(ctx, item) {
    const { fileChangeStatusLabel } = ctx;
    const counts = item.changes.reduce((acc, change) => {
        if (change.kind === "add")
            acc.added += 1;
        else if (change.kind === "delete")
            acc.deleted += 1;
        else
            acc.edited += 1;
        return acc;
    }, { added: 0, deleted: 0, edited: 0 });
    const parts = [
        counts.edited > 0 ? `${counts.edited} edited` : "",
        counts.added > 0 ? `${counts.added} added` : "",
        counts.deleted > 0 ? `${counts.deleted} deleted` : ""
    ].filter(Boolean);
    const countLabel = item.changes.length === 1 ? "1 file changed" : `${item.changes.length} files changed`;
    return {
        label: parts.length > 0 ? `${countLabel} · ${parts.join(", ")}` : countLabel,
        status: fileChangeStatusLabel(item.status)
    };

}

export function fileChangeStatusLabel(ctx, status) {
    const {  } = ctx;
    if (status === "completed")
        return "Ready";
    if (status === "in_progress" || status === "inProgress")
        return "Editing";
    if (status === "failed")
        return "Failed";
    return status || "Updated";

}

export function fileChangeLabel(ctx, kind) {
    const {  } = ctx;
    if (kind === "add")
        return "Added";
    if (kind === "delete")
        return "Deleted";
    return "Edited";

}

export function fileChangeTone(ctx, kind) {
    const {  } = ctx;
    if (kind === "add")
        return "add";
    if (kind === "delete")
        return "delete";
    return "update";

}

export function hasChangeText(ctx, change) {
    const { readChangeText } = ctx;
    return (readChangeText(change, ["before", "beforeText", "beforeContent", "oldContent", "previousContent", "original"]) !== undefined ||
        readChangeText(change, ["after", "afterText", "afterContent", "newContent", "currentContent", "updated"]) !== undefined ||
        readChangeText(change, ["diff", "patch", "unifiedDiff"]) !== undefined);

}
