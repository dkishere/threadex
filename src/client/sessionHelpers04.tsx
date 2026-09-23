// @ts-nocheck
import { normalizeModelId, modelLabel, supportsUltraEffort as catalogSupportsUltraEffort, defaultGearProfiles } from "../modelCatalog";
export function normalizeSessionModelPreferences(ctx, value) {
    const { MODEL_OPTIONS, isModelReasoningEffort, normalizeGearIndex, normalizeGearProfiles, normalizeStoredModel } = ctx;
    const fallbackModel = MODEL_OPTIONS[0];
    const fallbackEffort = "low";
    const candidate = value && typeof value === "object" ? value : {};
    const selectedModel = normalizeStoredModel(candidate.selectedModel ?? fallbackModel);
    const selectedEffort = isModelReasoningEffort(candidate.selectedEffort)
        ? candidate.selectedEffort
        : fallbackEffort;
    const gearProfiles = normalizeGearProfiles(candidate.gearProfiles, selectedModel, selectedEffort);
    const activeGearIndex = normalizeGearIndex(candidate.activeGearIndex);
    return {
        version: 1,
        selectedModel: gearProfiles[activeGearIndex]?.model ?? selectedModel,
        selectedEffort: gearProfiles[activeGearIndex]?.effort ?? selectedEffort,
        gearProfiles,
        activeGearIndex
    };

}

export function readStoredModelSelector(ctx, restoredSession) {
    const { isModelReasoningEffort, normalizeGearIndex, normalizeGearProfiles, normalizeStoredModel, readPendingModelPreferences } = ctx;
    const fallbackModel = normalizeStoredModel(restoredSession?.selectedModel);
    const fallbackEffort = isModelReasoningEffort(restoredSession?.selectedEffort)
        ? restoredSession.selectedEffort
        : "low";
    const fallbackProfiles = normalizeGearProfiles(restoredSession?.gearProfiles, fallbackModel, fallbackEffort);
    const fallbackIndex = normalizeGearIndex(restoredSession?.activeGearIndex);
    const pendingPreferences = readPendingModelPreferences(restoredSession?.workspaceId ?? null) ??
        readPendingModelPreferences(restoredSession?.sessionId ?? null);
    if (pendingPreferences) {
        return pendingPreferences;
    }
    return {
        version: 1,
        selectedModel: fallbackProfiles[fallbackIndex]?.model ?? fallbackModel,
        selectedEffort: fallbackProfiles[fallbackIndex]?.effort ?? fallbackEffort,
        gearProfiles: fallbackProfiles,
        activeGearIndex: fallbackIndex
    };

}

export function modelSelectorSessionKey(ctx, workspaceId) {
    const { NEW_SESSION_QUEUE_KEY } = ctx;
    return workspaceId ?? NEW_SESSION_QUEUE_KEY;

}

export function readStoredModelSelectors(ctx, ) {
    const { MODEL_SELECTOR_STORAGE_KEY, NEW_SESSION_QUEUE_KEY, normalizeSessionModelPreferences } = ctx;
    try {
        const raw = window.localStorage.getItem(MODEL_SELECTOR_STORAGE_KEY);
        if (!raw) {
            return {};
        }
        const parsed = JSON.parse(raw);
        if (parsed.version === 1) {
            return { [NEW_SESSION_QUEUE_KEY]: normalizeSessionModelPreferences(parsed) };
        }
        if ((parsed.version !== 2 && parsed.version !== 3) || !parsed.selectors || typeof parsed.selectors !== "object") {
            return {};
        }
        return Object.fromEntries(Object.entries(parsed.selectors).flatMap(([key, value]) => {
            const selector = normalizeSessionModelPreferences(value);
            return [[key, selector]];
        }));
    }
    catch {
        return {};
    }

}

export function readPendingModelPreferences(ctx, workspaceId) {
    const { modelSelectorSessionKey, readStoredModelSelectors } = ctx;
    return readStoredModelSelectors()[modelSelectorSessionKey(workspaceId)] ?? null;

}

export function writePendingModelPreferences(ctx, workspaceId, selector) {
    const { MODEL_SELECTOR_STORAGE_KEY, modelSelectorSessionKey, normalizeSessionModelPreferences, readStoredModelSelectors } = ctx;
    try {
        const selectors = readStoredModelSelectors();
        selectors[modelSelectorSessionKey(workspaceId)] = normalizeSessionModelPreferences(selector);
        window.localStorage.setItem(MODEL_SELECTOR_STORAGE_KEY, JSON.stringify({ version: 3, selectors }));
    }
    catch {
        // The preference outbox is opportunistic; storage failure is non-fatal.
    }

}

export function movePendingModelPreferences(ctx, fromWorkspaceId, toWorkspaceId) {
    const { MODEL_SELECTOR_STORAGE_KEY, modelSelectorSessionKey, readStoredModelSelectors } = ctx;
    try {
        const selectors = readStoredModelSelectors();
        const fromKey = modelSelectorSessionKey(fromWorkspaceId);
        const toKey = modelSelectorSessionKey(toWorkspaceId);
        if (fromKey !== toKey && selectors[fromKey]) {
            selectors[toKey] = selectors[fromKey];
            delete selectors[fromKey];
            window.localStorage.setItem(MODEL_SELECTOR_STORAGE_KEY, JSON.stringify({ version: 2, selectors }));
        }
    }
    catch {
        // The preference outbox is opportunistic; storage failure is non-fatal.
    }

}

export function removePendingModelPreferences(ctx, workspaceId) {
    const { MODEL_SELECTOR_STORAGE_KEY, modelSelectorSessionKey, readStoredModelSelectors } = ctx;
    try {
        const selectors = readStoredModelSelectors();
        const key = modelSelectorSessionKey(workspaceId);
        if (!(key in selectors)) {
            return;
        }
        delete selectors[key];
        window.localStorage.setItem(MODEL_SELECTOR_STORAGE_KEY, JSON.stringify({ version: 2, selectors }));
    }
    catch {
        // The preference outbox is opportunistic; storage failure is non-fatal.
    }

}

export function removePendingModelPreferencesIfMatches(ctx, workspaceId, preferences) {
    const { readPendingModelPreferences, removePendingModelPreferences, sameModelPreferences } = ctx;
    const pending = readPendingModelPreferences(workspaceId);
    if (pending && sameModelPreferences(pending, preferences)) {
        removePendingModelPreferences(workspaceId);
    }

}

export function sameModelPreferences(ctx, left, right) {
    const { normalizeSessionModelPreferences } = ctx;
    return JSON.stringify(normalizeSessionModelPreferences(left)) ===
        JSON.stringify(normalizeSessionModelPreferences(right));

}

export function normalizeStoredModel(ctx, value) {
    const { AUTO_MODEL_VALUE, MODEL_OPTIONS } = ctx;
    if (value === AUTO_MODEL_VALUE) {
        return AUTO_MODEL_VALUE;
    }
    if (typeof value !== "string") {
        return MODEL_OPTIONS[0];
    }
    const normalized = normalizeModelId(value);
    return MODEL_OPTIONS.some((model) => model === normalized) ? normalized : MODEL_OPTIONS[0];

}

export function normalizeStoredApprovalPolicy(ctx, value) {
    const {  } = ctx;
    if (value === "on-failure") {
        return "granular";
    }
    return value === "untrusted" || value === "on-request" || value === "granular" || value === "never"
        ? value
        : "on-request";

}

export function normalizeGearProfiles(ctx, value, fallbackModel, fallbackEffort) {
    const { isModelReasoningEffort, normalizeEffortForModel, normalizeStoredModel } = ctx;
    const defaults = defaultGearProfiles();
    defaults[0] = { model: fallbackModel, effort: normalizeEffortForModel(fallbackEffort, fallbackModel) };
    // Trim the briefly supported seventh Auto slot without losing manual presets.
    if (!Array.isArray(value) || ![3, 6, 7].includes(value.length)) {
        return defaults;
    }
    return defaults.map((_, index) => {
        const candidate = value[index];
        if (!candidate || typeof candidate !== "object") {
            return defaults[index];
        }
        const profile = candidate;
        const model = normalizeStoredModel(profile.model);
        const effort = isModelReasoningEffort(profile.effort) ? profile.effort : defaults[index].effort;
        return { model, effort: normalizeEffortForModel(effort, model) };
    });

}

export function normalizeGearIndex(ctx, value) {
    const {  } = ctx;
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 6 ? value : 0;

}

export function normalizeEffortForModel(ctx, effort, model) {
    const { AUTO_MODEL_VALUE, supportsUltraEffort } = ctx;
    if (model === AUTO_MODEL_VALUE)
        return "high";
    return (effort === "max" || effort === "ultra") && !supportsUltraEffort(model) ? "xhigh" : effort;

}

export function supportsUltraEffort(ctx, model) {
    return catalogSupportsUltraEffort(model);
}

export function modelOptionLabel(ctx, model) {
    return modelLabel(model);
}

export function toChatMessage(ctx, value) {
    const { isLiveItem, isMessageAttachment, isMessageSegment, normalizeDeveloperInstructionRecords, normalizeLiveItems, normalizeMessageSegments } = ctx;
    if (!value || typeof value !== "object") {
        return null;
    }
    const candidate = value;
    const id = candidate.id;
    const role = candidate.role;
    const content = candidate.content;
    const isValid = typeof id === "string" &&
        (role === "user" || role === "assistant" || role === "system") &&
        typeof content === "string" &&
        (candidate.pending === undefined || typeof candidate.pending === "boolean") &&
        (candidate.turnStatus === undefined ||
            candidate.turnStatus === "done" ||
            candidate.turnStatus === "todo" ||
            candidate.turnStatus === "running");
    if (!isValid) {
        return null;
    }
    return {
        id,
        role,
        content,
        rawContent: typeof candidate.rawContent === "string" ? candidate.rawContent : undefined,
        turnId: typeof candidate.turnId === "string" ? candidate.turnId : undefined,
        cachedInputTokens: typeof candidate.cachedInputTokens === "number" && Number.isFinite(candidate.cachedInputTokens)
            ? candidate.cachedInputTokens
            : undefined,
        kind: candidate.kind === "steer" ? "steer" : undefined,
        pending: candidate.pending,
        liveItems: Array.isArray(candidate.liveItems) ? normalizeLiveItems(candidate.liveItems.filter(isLiveItem)) : undefined,
        segments: Array.isArray(candidate.segments) ? normalizeMessageSegments(candidate.segments.filter(isMessageSegment)) : undefined,
        executionDurationMs: typeof candidate.executionDurationMs === "number" && Number.isFinite(candidate.executionDurationMs)
            ? candidate.executionDurationMs
            : undefined,
        createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : undefined,
        completedAt: typeof candidate.completedAt === "string" ? candidate.completedAt : undefined,
        conclusion: typeof candidate.conclusion === "string" ? candidate.conclusion : undefined,
        turnStatus: candidate.turnStatus,
        attachments: Array.isArray(candidate.attachments) ? candidate.attachments.filter(isMessageAttachment) : undefined,
        developerInstructions: normalizeDeveloperInstructionRecords(candidate.developerInstructions),
        forcePlan: candidate.forcePlan === true,
        contextFork: candidate.contextFork === true,
        executionMode: candidate.executionMode === "plan" || candidate.executionMode === "goal" || candidate.executionMode === "loop" || candidate.executionMode === "default"
            ? candidate.executionMode
            : undefined
    };

}

export function isQueuedPrompt(ctx, value) {
    const { isMessageAttachment, isSkillSuggestion } = ctx;
    if (!value || typeof value !== "object") {
        return false;
    }
    const candidate = value;
    return (typeof candidate.id === "string" &&
        typeof candidate.content === "string" &&
        (candidate.kind === undefined || candidate.kind === "queue" || candidate.kind === "steer") &&
        Array.isArray(candidate.attachments) &&
        candidate.attachments.every(isMessageAttachment) &&
        (candidate.executionMode === undefined ||
            candidate.executionMode === "default" ||
            candidate.executionMode === "plan" ||
            candidate.executionMode === "goal" ||
            candidate.executionMode === "loop") &&
        (candidate.contextFork === undefined || typeof candidate.contextFork === "boolean") &&
        (candidate.forcePlan === undefined || typeof candidate.forcePlan === "boolean") &&
        (candidate.skills === undefined ||
            (Array.isArray(candidate.skills) && candidate.skills.every(isSkillSuggestion))));

}

export function isSkillSuggestion(ctx, value) {
    const {  } = ctx;
    if (!value || typeof value !== "object")
        return false;
    const skill = value;
    return (typeof skill.name === "string" &&
        typeof skill.path === "string" &&
        typeof skill.description === "string" &&
        typeof skill.scope === "string");

}

export function isDisplayableMessageSegment(ctx, segment) {
    const { isDisplayableLiveItem } = ctx;
    return segment.type === "text" || segment.type === "steer" || (segment.item.itemType === "file_change" && segment.item.authoritative === true
        ? false
        : isDisplayableLiveItem(segment.item));

}

export function isDisplayableLiveItem(ctx, item) {
    const { isExactRootSubagentActivity } = ctx;
    // The full final answer is rendered as the turn conclusion. Its compact
    // tracker reconciliation comment must stay available to the issue ledger,
    // but should not render a second copy in the timeline.
    if (item.itemType === "agent_message" && item.phase === "final_answer") {
        return false;
    }
    if (item.itemType === "subagent" && isExactRootSubagentActivity(item)) {
        return false;
    }
    if (item.itemType === "approval") {
        return true;
    }
    if (item.itemType === "reasoning" && item.eventType === "item.completed") {
        return item.text.trim().length > 0;
    }
    return true;

}

export function isMessageSegment(ctx, value) {
    const { isLiveItem, isMessageAttachment } = ctx;
    if (!value || typeof value !== "object") {
        return false;
    }
    const segment = value;
    if (segment.type === "text") {
        return (typeof segment.id === "string" &&
            (segment.sourceId === undefined || typeof segment.sourceId === "string") &&
            typeof segment.text === "string");
    }
    if (segment.type === "steer") {
        return (typeof segment.id === "string" &&
            typeof segment.text === "string" &&
            (segment.createdAt === undefined || typeof segment.createdAt === "string") &&
            (segment.attachments === undefined || segment.attachments.every(isMessageAttachment)) &&
            (segment.forcePlan === undefined || typeof segment.forcePlan === "boolean"));
    }
    return segment.type === "live" && typeof segment.id === "string" && isLiveItem(segment.item);

}

export function isMessageAttachment(ctx, value) {
    const {  } = ctx;
    if (!value || typeof value !== "object") {
        return false;
    }
    const attachment = value;
    return (typeof attachment.id === "string" &&
        typeof attachment.name === "string" &&
        (typeof attachment.type === "string" || typeof attachment.mimeType === "string") &&
        typeof attachment.size === "number" &&
        Number.isFinite(attachment.size) &&
        (attachment.dataUrl === undefined || typeof attachment.dataUrl === "string") &&
        (attachment.fileUrl === undefined || typeof attachment.fileUrl === "string") &&
        (attachment.path === undefined || typeof attachment.path === "string"));

}

export function parsePastedHttpUrl(ctx, value) {
    const {  } = ctx;
    const candidate = value.trim();
    if (!candidate || /\s/.test(candidate)) {
        return null;
    }
    try {
        const url = new URL(candidate);
        return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    }
    catch {
        return null;
    }

}

export function composerLinkToken(ctx, id) {
    const {  } = ctx;
    return `\uFFFC${id}\uFFFC`;

}

export function replaceComposerLinkTokens(ctx, value, links) {
    const { formatComposerLinkMarkdown } = ctx;
    const linkById = new Map(links.map((link) => [link.id, link]));
    return value.replace(/\uFFFC([^\uFFFC]+)\uFFFC/g, (token, id) => {
        const link = linkById.get(id);
        return link ? formatComposerLinkMarkdown(link) : token;
    });

}

export function formatComposerLinkMarkdown(ctx, link) {
    const {  } = ctx;
    const label = (link.title || link.target || link.uri).replace(/[\\[\\]]/g, "").trim() || link.uri;
    return `[${label}](${link.uri})`;

}

export function isModelReasoningEffort(ctx, value) {
    const {  } = ctx;
    return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra";

}

export function findSlashTrigger(ctx, value, caret) {
    const {  } = ctx;
    const end = caret ?? value.length;
    const prefix = value.slice(0, end);
    const match = prefix.match(/(^|\s)\/([^\s/]*)$/);
    if (!match || match.index === undefined)
        return null;
    const start = match.index + match[1].length;
    return { start, end, query: match[2] };

}

export function capitalize(ctx, value) {
    const {  } = ctx;
    return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;

}

export function approvalAvailableDecisions(ctx, params) {
    const { readRecord } = ctx;
    const fallback = [
        { key: "accept", decision: "accept" },
        { key: "acceptForSession", decision: "acceptForSession" },
        { key: "decline", decision: "decline" },
        { key: "cancel", decision: "cancel" }
    ];
    const rawDecisions = Array.isArray(params?.availableDecisions) ? params.availableDecisions : fallback.map((item) => item.decision);
    const actions = rawDecisions.flatMap((decision) => {
        if (decision === "accept" || decision === "decline" || decision === "cancel") {
            return [{ key: decision, decision }];
        }
        if (decision === "acceptForSession") {
            return [{ key: "acceptForSession", decision }];
        }
        const record = readRecord(decision);
        if (record?.acceptWithExecpolicyAmendment || record?.applyNetworkPolicyAmendment) {
            return [{ key: "acceptForSession", decision }];
        }
        return [];
    });
    const uniqueActions = new Map();
    for (const action of actions) {
        uniqueActions.set(action.key, action);
    }
    return uniqueActions.size > 0 ? [...uniqueActions.values()] : fallback;

}

export function approvalRecordToLiveItem(ctx, value) {
    const { approvalEventToLiveItem, readRecord, readStringField } = ctx;
    const record = readRecord(value);
    if (!record) {
        return null;
    }
    const approvalId = readStringField(record, "approvalId");
    const sessionId = readStringField(record, "sessionId");
    const turnId = readStringField(record, "turnId");
    const method = readStringField(record, "method");
    const requestId = record.requestId;
    if (!approvalId || !sessionId || !turnId || !method || (typeof requestId !== "number" && typeof requestId !== "string")) {
        return null;
    }
    return approvalEventToLiveItem({
        approvalId,
        sessionId,
        turnId,
        requestId,
        method,
        params: record.params,
        createdAt: readStringField(record, "createdAt") || undefined
    }, "pending");

}

export function isApprovalLiveItem(ctx, item) {
    const {  } = ctx;
    return Boolean(item);

}

export function upsertPendingApprovalItem(ctx, items, item) {
    const {  } = ctx;
    const existingIndex = items.findIndex((existing) => existing.approvalId === item.approvalId);
    if (existingIndex === -1) {
        return [...items, item];
    }
    return items.map((existing, index) => (index === existingIndex ? item : existing));

}

export function approvalDecisionLabel(ctx, decision) {
    const {  } = ctx;
    if (decision === "accept")
        return "approved";
    if (decision === "acceptForSession")
        return "approved for session";
    if (decision === "decline")
        return "declined";
    if (decision === "cancel")
        return "cancelled";
    if (decision && typeof decision === "object")
        return "approved";
    return "resolved";

}

export function resizeEditor(ctx, editor) {
    const {  } = ctx;
    editor.style.height = "auto";
    const maxHeight = window.innerHeight * 0.5;
    editor.style.height = `${Math.min(Math.max(editor.scrollHeight, 42), maxHeight)}px`;
    editor.style.overflowY = editor.scrollHeight > maxHeight ? "auto" : "hidden";

}

export function sleep(ctx, ms) {
    const {  } = ctx;
    return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

}

export function isInactiveSteerResponse(ctx, status, message) {
    const {  } = ctx;
    return (status === 404 || status === 409) && /not running|not found|already finished|no active/i.test(message);

}

export function isLikelyBackendDisconnect(ctx, error) {
    const {  } = ctx;
    if (error instanceof TypeError || error instanceof DOMException) {
        return true;
    }
    const message = error instanceof Error ? error.message : String(error ?? "");
    const status = /API returned (\d+)/.exec(message)?.[1];
    return Boolean(message.includes("Failed to fetch") ||
        message.includes("NetworkError") ||
        message.includes("Load failed") ||
        (status && Number(status) >= 500));

}

export function highlightSessionSearchText(ctx, text, query) {
    const { _jsx, escapeRegExp, parseSessionSearchHighlightTerms } = ctx;
    const terms = parseSessionSearchHighlightTerms(query).sort((left, right) => right.length - left.length);
    if (!text || terms.length === 0)
        return text;
    const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
    const normalizedTerms = new Set(terms.map((term) => term.toLocaleLowerCase()));
    return text.split(pattern).map((part, index) => normalizedTerms.has(part.toLocaleLowerCase()) ? _jsx("mark", { children: part }, `${part}:${index}`) : part);

}

export function parseSessionSearchHighlightTerms(ctx, query) {
    const {  } = ctx;
    const terms = [];
    let current = "";
    let inQuotes = false;
    let escaped = false;
    const pushCurrent = () => {
        const term = current.trim().slice(0, 128);
        current = "";
        if (!term || terms.some((candidate) => candidate.toLocaleLowerCase() === term.toLocaleLowerCase()))
            return;
        if (terms.length < 12)
            terms.push(term);
    };
    for (const character of query.trim()) {
        if (escaped) {
            current += character;
            escaped = false;
        }
        else if (character === "\\" && inQuotes) {
            escaped = true;
        }
        else if (character === '"') {
            inQuotes = !inQuotes;
        }
        else if (/\s/.test(character) && !inQuotes) {
            pushCurrent();
        }
        else {
            current += character;
        }
    }
    if (escaped)
        current += "\\";
    pushCurrent();
    return terms;

}

export function escapeRegExp(ctx, value) {
    const {  } = ctx;
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

}

export function describeStreamItem(ctx, item) {
    const { approvalDecisionLabel, subagentNames, subagentToolLabel } = ctx;
    if (item.itemType === "agent_message") {
        return item.eventType === "item.completed" ? "Response ready" : "Writing response";
    }
    if (item.itemType === "reasoning") {
        return item.text.trim() || "Thinking";
    }
    if (item.itemType === "command_execution") {
        return `${item.status}: ${item.command || "command"}`;
    }
    if (item.itemType === "file_change") {
        return `${item.status} file changes (${item.changes.length})`;
    }
    if (item.itemType === "web_search") {
        return `Searching: ${item.query}`;
    }
    if (item.itemType === "todo_list") {
        const remaining = item.items.filter((todo) => !todo.completed).length;
        return remaining ? `Plan updated (${remaining} remaining)` : "Plan completed";
    }
    if (item.itemType === "context_compaction") {
        return item.eventType === "item.completed" ? "Context compacted" : "Compacting context";
    }
    if (item.itemType === "subagent") {
        return `${subagentToolLabel(item.tool)}: ${subagentNames(item).join(", ") || "subagent"}`;
    }
    if (item.itemType === "approval") {
        return item.status === "pending" ? "Approval requested" : `Approval ${approvalDecisionLabel(item.decision)}`;
    }
    return item.message;

}

export function describeCodexEvent(ctx, event) {
    const { getCodexEventName } = ctx;
    const eventName = getCodexEventName(event);
    if (eventName === "thread.started" || eventName === "thread/started") {
        return "Thread started";
    }
    if (eventName === "turn.started" || eventName === "turn/started") {
        return "Codex is working";
    }
    if (eventName === "turn.completed" || eventName === "turn/completed") {
        return "Turn completed";
    }
    if (eventName === "turn.failed" || eventName === "turn/failed") {
        return event.error?.message ?? "Turn failed";
    }
    if (eventName === "thread.compacted" || eventName === "thread/compacted") {
        return "Context compacted";
    }
    if (!event.item) {
        return eventName;
    }
    if (event.item.type === "command_execution") {
        const command = event.item.command ?? "command";
        return `${event.item.status ?? "running"}: ${command}`;
    }
    if (event.item.type === "file_change") {
        const count = event.item.changes?.length ?? 0;
        return `${event.item.status ?? "updated"} file changes (${count})`;
    }
    if (event.item.type === "web_search") {
        return `Searching: ${event.item.query ?? ""}`;
    }
    if (event.item.type === "reasoning") {
        return event.item.text?.trim() || "Thinking";
    }
    if (event.item.type === "agent_message") {
        return "Writing response";
    }
    if (event.item.type === "error") {
        return event.item.message ?? "Codex item error";
    }
    return event.item.type;

}
