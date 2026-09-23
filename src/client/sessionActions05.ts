// @ts-nocheck
export async function submitInlineUserPromptEdit(ctx, event, message) {
    const { inlinePromptEditor, resendUserPrompt, setInlinePromptEditor } = ctx;
        event.preventDefault();
        const editor = inlinePromptEditor;
        if (!editor || editor.messageId !== message.id) {
            return;
        }
        const prompt = editor.value.trim() ||
            (editor.attachments.length > 0 ? "Review the attached file(s)." : "");
        if (!prompt) {
            return;
        }
        setInlinePromptEditor(null);
        await resendUserPrompt({
            ...message,
            content: prompt,
            attachments: editor.attachments,
            forcePlan: editor.forcePlan,
            executionMode: editor.executionMode
        });
    
}

export function handleInlinePromptEditorKeyDown(ctx, event, message) {
    const { submitInlineUserPromptEdit } = ctx;
        if (event.key !== "Enter" || event.nativeEvent.isComposing || event.shiftKey) {
            return;
        }
        event.preventDefault();
        void submitInlineUserPromptEdit(event, message);
    
}

export async function resendUserPrompt(ctx, message) {
    const { currentSessionIsRunning, enqueuePrompt, setStatus, startChatTurn } = ctx;
        if (message.role !== "user") {
            return;
        }
        const prompt = message.content.trim() ||
            ((message.attachments?.length ?? 0) > 0 ? "Review the attached file(s)." : "");
        if (!prompt) {
            return;
        }
        const resendAttachments = [...(message.attachments ?? [])];
        const resendMode = message.executionMode ?? "default";
        const resendForcePlan = message.forcePlan === true;
        if (currentSessionIsRunning) {
            enqueuePrompt(prompt, "queue", resendMode, [], resendAttachments, false, resendForcePlan, false);
            setStatus("Prompt queued for resend");
            return;
        }
        setStatus("Resending prompt");
        await startChatTurn(prompt, resendAttachments, resendMode, [], false, resendForcePlan, false);
    
}

export function moveQueuedPrompt(ctx, promptId, direction) {
    const { moveQueuedPromptInList, setQueuedPrompts } = ctx;
        setQueuedPrompts((current) => moveQueuedPromptInList(current, promptId, direction) ?? current);
    
}

export async function toggleQueuedPromptSteer(ctx, promptId) {
    const { promoteQueuedPromptToSteer, queuedPromptsRef, setQueuedPrompts, setStatus, steerPrompt } = ctx;
        const prompt = queuedPromptsRef.current.find((candidate) => candidate.id === promptId);
        if (!prompt) {
            return;
        }
        if (prompt.kind === "steer") {
            setQueuedPrompts((current) => current.map((candidate) => candidate.id === promptId ? { ...candidate, kind: "queue" } : candidate));
            setStatus("Queued prompt updated");
            return;
        }
        const steered = await steerPrompt(prompt.content, prompt.attachments, false, prompt.skills ?? [], prompt.forcePlan === true);
        if (steered === "sent") {
            setQueuedPrompts((current) => current.filter((candidate) => candidate.id !== promptId));
        }
        else if (steered === "queued") {
            setQueuedPrompts((current) => promoteQueuedPromptToSteer(current, promptId));
        }
    
}

export function removeQueuedPrompt(ctx, promptId) {
    const { setQueuedPrompts, setStatus } = ctx;
        setQueuedPrompts((current) => current.filter((prompt) => prompt.id !== promptId));
        setStatus("Queued prompt removed");
    
}

export function dropQueuedPrompt(ctx, targetPromptId) {
    const { draggedQueuedPromptId, moveQueuedPromptToTarget, setDraggedQueuedPromptId, setQueuedPrompts } = ctx;
        if (!draggedQueuedPromptId || draggedQueuedPromptId === targetPromptId) {
            setDraggedQueuedPromptId(null);
            return;
        }
        setQueuedPrompts((current) => moveQueuedPromptToTarget(current, draggedQueuedPromptId, targetPromptId) ?? current);
        setDraggedQueuedPromptId(null);
    
}

export async function editPendingTurn(ctx, message) {
    const { findUserMessageForTurn, latestMessagesRef, sessionId, setPromptEditor } = ctx;
        if (!sessionId || !message.turnId || message.role !== "assistant" || message.turnStatus !== "todo") {
            return;
        }
        const userMessage = findUserMessageForTurn(latestMessagesRef.current, message.turnId);
        setPromptEditor({
            kind: "pending",
            turnId: message.turnId,
            title: "Edit pending turn",
            value: userMessage?.content ?? ""
        });
    
}

export function editWaitSubscription(ctx, subscription) {
    const { pendingPromptForSubscription, setPromptEditor } = ctx;
        if (subscription.status === "dispatching" || subscription.actionType === "notify")
            return;
        setPromptEditor({
            kind: "wait",
            subscriptionId: subscription.id,
            turnId: subscription.turnId,
            sessionId: subscription.sessionId,
            title: "Edit pending prompt",
            value: pendingPromptForSubscription(subscription)
        });
    
}

export async function removeWaitSubscription(ctx, subscription) {
    const { eventStore, isLikelyBackendDisconnect, noteBackendDisconnect, noteBackendRequestSucceeded, readApiError, setWaitSubscriptionAction, showToast } = ctx;
        const detail = subscription.actionType === "retry_turn"
            ? " The queued turn will remain in the session, but it will no longer auto-resume for this event."
            : "";
        if (!window.confirm(`Remove this pending wait?${detail} Any task already started will not be stopped.`))
            return;
        setWaitSubscriptionAction(`remove:${subscription.id}`);
        try {
            const response = await fetch(`/api/wait-subscriptions/${encodeURIComponent(subscription.id)}`, {
                method: "DELETE"
            });
            if (!response.ok)
                throw new Error(await readApiError(response));
            const payload = await response.json();
            const updated = payload?.subscription;
            if (!updated || updated.id !== subscription.id ||
                !["waiting", "error", "dispatching", "done", "cancelled"].includes(updated.status) ||
                (updated.status === "cancelled" && payload.cancelled !== true))
                throw new Error("Server did not confirm the wait status. Please refresh and try again.");
            noteBackendRequestSucceeded();
            eventStore.applyWaitSubscription(updated);
            void eventStore.poll().catch(() => undefined);
            showToast(updated.status === "cancelled" && payload.cancelled === true
                ? "Pending wait removed"
                : updated.status === "done"
                    ? "Wait already completed"
                    : updated.status === "dispatching"
                        ? "Wait has already started and could not be cancelled"
                        : "Wait was not cancelled. Please try again.");
        }
        catch (error) {
            if (isLikelyBackendDisconnect(error)) {
                noteBackendDisconnect();
            }
            const content = error instanceof Error ? error.message : "Unknown remove error";
            showToast(`Remove failed: ${content}`);
        }
        finally {
            setWaitSubscriptionAction(null);
        }
    
}

export async function savePromptEditor(ctx, event) {
    const { eventStore, findUserMessageForTurn, isLikelyBackendDisconnect, latestMessagesRef, noteBackendDisconnect, noteBackendRequestSucceeded, promptEditor, scheduleLoadSessions, sessionId, sessionIdRef, setMessages, setPromptEditor, setStatus, setWaitSubscriptionAction, showToast } = ctx;
        event.preventDefault();
        if (!promptEditor) {
            return;
        }
        const trimmedInput = promptEditor.value.trim();
        if (!trimmedInput) {
            return;
        }
        if (promptEditor.kind === "wait") {
            const editor = promptEditor;
            setWaitSubscriptionAction(`edit:${editor.subscriptionId}`);
            try {
                const response = await fetch(`/api/wait-subscriptions/${encodeURIComponent(editor.subscriptionId)}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ prompt: trimmedInput })
                });
                const payload = (await response.json().catch(() => null));
                if (!response.ok || !payload?.subscription) {
                    throw new Error(payload?.error || `API returned ${response.status}`);
                }
                noteBackendRequestSucceeded();
                if (payload.turn && editor.sessionId === sessionIdRef.current) {
                    setMessages((current) => current.map((candidate) => candidate.id === `${payload.turn?.id}:user`
                        ? { ...candidate, content: payload.turn?.userInput ?? trimmedInput }
                        : candidate));
                }
                setPromptEditor(null);
                await eventStore.poll();
                showToast("Pending prompt updated");
                scheduleLoadSessions();
            }
            catch (error) {
                if (isLikelyBackendDisconnect(error)) {
                    noteBackendDisconnect();
                }
                const content = error instanceof Error ? error.message : "Unknown edit error";
                showToast(`Edit failed: ${content}`);
            }
            finally {
                setWaitSubscriptionAction(null);
            }
            return;
        }
        if (!sessionId) {
            return;
        }
        const turnId = promptEditor.turnId;
        const userMessage = findUserMessageForTurn(latestMessagesRef.current, turnId);
        setStatus("Editing queued prompt");
        try {
            const response = await fetch(`/api/pending-turns/${encodeURIComponent(turnId)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    sessionId,
                    message: trimmedInput
                })
            });
            const payload = (await response.json().catch(() => null));
            if (!response.ok || !payload?.turn) {
                throw new Error(payload?.error || `API returned ${response.status}`);
            }
            noteBackendRequestSucceeded();
            setMessages((current) => current.map((candidate) => candidate.id === `${turnId}:user` || (userMessage && candidate.id === userMessage.id)
                ? { ...candidate, content: payload.turn?.userInput ?? trimmedInput }
                : candidate));
            setPromptEditor(null);
            setStatus("Queued prompt edited");
            scheduleLoadSessions();
        }
        catch (error) {
            if (isLikelyBackendDisconnect(error)) {
                noteBackendDisconnect();
            }
            else {
                const content = error instanceof Error ? error.message : "Unknown edit error";
                setStatus(`Edit failed: ${content}`);
                showToast(`Edit failed: ${content}`);
            }
        }
    
}

export async function movePendingTurn(ctx, turnId, direction) {
    const { isLikelyBackendDisconnect, latestMessagesRef, noteBackendDisconnect, noteBackendRequestSucceeded, reorderPendingTurnMessages, scheduleLoadSessions, sessionId, setMessages, setStatus, showToast } = ctx;
        if (!sessionId || !turnId) {
            return;
        }
        const previousMessages = latestMessagesRef.current;
        const reordered = reorderPendingTurnMessages(previousMessages, turnId, direction);
        if (!reordered) {
            return;
        }
        setMessages(reordered);
        setStatus("Reordering queue");
        try {
            const response = await fetch(`/api/pending-turns/${encodeURIComponent(turnId)}/move`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sessionId, direction })
            });
            const payload = (await response.json().catch(() => null));
            if (!response.ok) {
                throw new Error(payload?.error || `API returned ${response.status}`);
            }
            noteBackendRequestSucceeded();
            setStatus("Queue reordered");
            scheduleLoadSessions();
        }
        catch (error) {
            setMessages(previousMessages);
            if (isLikelyBackendDisconnect(error)) {
                noteBackendDisconnect();
            }
            else {
                const content = error instanceof Error ? error.message : "Unknown reorder error";
                setStatus(`Reorder failed: ${content}`);
                showToast(`Reorder failed: ${content}`);
            }
        }
    
}

export async function dropPendingTurn(ctx, targetTurnId) {
    const { draggedPendingTurnId, latestMessagesRef, movePendingTurn, pendingAssistantMessages, setDraggedPendingTurnId } = ctx;
        if (!draggedPendingTurnId || !targetTurnId || draggedPendingTurnId === targetTurnId) {
            setDraggedPendingTurnId(null);
            return;
        }
        const pendingTurnIds = pendingAssistantMessages(latestMessagesRef.current)
            .map((message) => message.turnId)
            .filter((turnId) => Boolean(turnId));
        const fromIndex = pendingTurnIds.indexOf(draggedPendingTurnId);
        const toIndex = pendingTurnIds.indexOf(targetTurnId);
        if (fromIndex < 0 || toIndex < 0) {
            setDraggedPendingTurnId(null);
            return;
        }
        const direction = fromIndex > toIndex ? "up" : "down";
        for (let index = fromIndex; direction === "up" ? index > toIndex : index < toIndex; direction === "up" ? index-- : index++) {
            await movePendingTurn(draggedPendingTurnId, direction);
        }
        setDraggedPendingTurnId(null);
    
}

export async function reconnectRunner(ctx, turnId, assistantMessageId, targetSessionId, viewKey) {
    const { handleStreamEvent, isLikelyBackendDisconnect, markTurnFinished, markTurnRunning, noteBackendDisconnect, noteBackendRequestSucceeded, prepareAssistantMessageForReplay, readEventStream, reconnectingTurnIdsRef, registerStreamTarget, sleep, streamTargetsRef, unregisterStreamTarget } = ctx;
        if (reconnectingTurnIdsRef.current.has(turnId)) {
            return true;
        }
        // A live /api/chat stream already owns this turn. Replaying the same
        // log through /api/runner/stream would duplicate the whole response.
        if (streamTargetsRef.current[turnId]) {
            return true;
        }
        reconnectingTurnIdsRef.current.add(turnId);
        const target = registerStreamTarget(turnId, assistantMessageId, targetSessionId, viewKey);
        markTurnRunning(turnId);
        prepareAssistantMessageForReplay(target);
        try {
            for (let attempt = 0; attempt < 120; attempt += 1) {
                try {
                    const response = await fetch("/api/runner/stream", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ turnId, sessionId: targetSessionId ?? undefined })
                    });
                    if (!response.ok || !response.body) {
                        throw new Error(`API returned ${response.status}`);
                    }
                    noteBackendRequestSucceeded();
                    const completed = await readEventStream(response.body, (streamEvent) => handleStreamEvent(streamEvent, target));
                    if (completed) {
                        return true;
                    }
                    throw new Error("Stream closed before completion.");
                }
                catch (error) {
                    if (isLikelyBackendDisconnect(error)) {
                        noteBackendDisconnect();
                    }
                    await sleep(Math.min(1000 + attempt * 500, 3000));
                }
            }
            markTurnFinished(turnId);
            return false;
        }
        finally {
            reconnectingTurnIdsRef.current.delete(turnId);
            unregisterStreamTarget(target, turnId);
        }
    
}

export function prepareAssistantMessageForReplay(ctx, target) {
    const { isTargetVisible, latestMessagesRef, seedReplayTargetFromMessage, setMessages } = ctx;
        if (!isTargetVisible(target)) {
            return;
        }
        const existingMessage = latestMessagesRef.current.find((message) => message.id === target.assistantMessageId || (message.role === "assistant" && message.turnId === target.turnId));
        if (existingMessage?.role === "assistant") {
            seedReplayTargetFromMessage(target, existingMessage);
        }
        setMessages((current) => current.map((message) => message.id === target.assistantMessageId && message.role === "assistant"
            ? { ...message, pending: true, turnStatus: "running" }
            : message));
    
}

export function readAgentMessageAppendText(ctx, target, item) {
    const { consumeReplayText, liveItemKey } = ctx;
        const itemKey = liveItemKey(item);
        const previous = target.textByItemId[itemKey] ?? "";
        const incoming = item.text ?? "";
        if (!incoming) {
            return "";
        }
        if (incoming.startsWith(previous)) {
            target.textByItemId[itemKey] = incoming;
            return consumeReplayText(target, incoming.slice(previous.length));
        }
        if (previous.startsWith(incoming)) {
            target.textByItemId[itemKey] = previous;
            return "";
        }
        target.textByItemId[itemKey] = `${previous}${incoming}`;
        return consumeReplayText(target, incoming);
    
}

export function seedReplayTargetFromMessage(ctx, target, message) {
    const { itemEventRank, liveItemKey } = ctx;
        let seededTextChars = 0;
        for (const segment of message.segments ?? []) {
            if (segment.type === "text") {
                const sourceId = segment.sourceId ?? segment.id;
                if (sourceId.startsWith("agent:")) {
                    const storedKey = sourceId.slice("agent:".length);
                    const itemKey = storedKey.startsWith(":") || storedKey.includes(":") ? storedKey : `:${storedKey}`;
                    target.textByItemId[itemKey] = `${target.textByItemId[itemKey] ?? ""}${segment.text}`;
                    seededTextChars += segment.text.length;
                }
                continue;
            }
            if (segment.type === "steer") {
                continue;
            }
            const itemKey = liveItemKey(segment.item);
            target.liveItemEventRankById[itemKey] = Math.max(target.liveItemEventRankById[itemKey] ?? 0, itemEventRank(segment.item.eventType));
        }
        for (const item of message.liveItems ?? []) {
            const itemKey = liveItemKey(item);
            target.liveItemEventRankById[itemKey] = Math.max(target.liveItemEventRankById[itemKey] ?? 0, itemEventRank(item.eventType));
        }
        if (seededTextChars === 0 && message.content) {
            target.replayTextSkipChars = Math.max(target.replayTextSkipChars ?? 0, message.content.length);
        }
    
}

export function consumeReplayText(ctx, target, text) {
    const {  } = ctx;
        if (!text || !target.replayTextSkipChars) {
            return text;
        }
        const skipChars = Math.min(target.replayTextSkipChars, text.length);
        target.replayTextSkipChars -= skipChars;
        return text.slice(skipChars);
    
}

export async function addFiles(ctx, fileList) {
    const { MAX_ATTACHMENTS, attachments, readAttachment, setAttachments, setStatus } = ctx;
        if (!fileList || fileList.length === 0) {
            return;
        }
        const nextFiles = Array.from(fileList).slice(0, Math.max(0, MAX_ATTACHMENTS - attachments.length));
        if (nextFiles.length === 0) {
            setStatus(`Attach up to ${MAX_ATTACHMENTS} files`);
            return;
        }
        try {
            const nextAttachments = await Promise.all(nextFiles.map(readAttachment));
            setAttachments((current) => [...current, ...nextAttachments]);
            setStatus(`${nextAttachments.length} file${nextAttachments.length === 1 ? "" : "s"} attached`);
        }
        catch (error) {
            setStatus(error instanceof Error ? error.message : "File upload failed");
        }
    
}

export async function addPastedText(ctx, value) {
    const { MAX_ATTACHMENTS, nextPastedTextFileName, readAttachment, setAttachments, setStatus } = ctx;
        try {
            const file = new File([value], "Pasted text.txt", { type: "text/plain" });
            const attachment = await readAttachment(file);
            setAttachments((current) => {
                if (current.length >= MAX_ATTACHMENTS) {
                    return current;
                }
                return [
                    ...current,
                    {
                        ...attachment,
                        name: nextPastedTextFileName(current)
                    }
                ];
            });
            setStatus("Pasted text attached");
        }
        catch (error) {
            setStatus(error instanceof Error ? error.message : "Could not attach pasted text");
        }
    
}

export async function addPastedBrowserBridgeContext(ctx, context) {
    const { MAX_ATTACHMENTS, browserBridgeContextAttachmentName, readAttachment, setAttachments, setStatus } = ctx;
        try {
            const file = new File([JSON.stringify(context, null, 2)], browserBridgeContextAttachmentName(context), { type: "application/json" });
            const attachment = await readAttachment(file);
            setAttachments((current) => {
                if (current.length >= MAX_ATTACHMENTS) {
                    return current;
                }
                return [...current, attachment];
            });
            setStatus("Browser page context attached");
        }
        catch (error) {
            setStatus(error instanceof Error ? error.message : "Could not attach browser page context");
        }
    
}

export async function addPastedTurnIssueContext(ctx, context) {
    const { MAX_ATTACHMENTS, readAttachment, setAttachments, setStatus, turnIssueContextAttachmentName } = ctx;
        try {
            const file = new File([JSON.stringify(context, null, 2)], turnIssueContextAttachmentName(context), { type: "application/json" });
            const attachment = await readAttachment(file);
            setAttachments((current) => {
                if (current.length >= MAX_ATTACHMENTS) {
                    return current;
                }
                return [...current, attachment];
            });
            setStatus("Threadex issue context attached");
        }
        catch (error) {
            setStatus(error instanceof Error ? error.message : "Could not attach Threadex issue context");
        }

}

export function removeAttachment(ctx, id) {
    const { setAttachments } = ctx;
        setAttachments((current) => current.filter((attachment) => attachment.id !== id));
    
}

export function clearComposerSessionLinks(ctx, ) {
    const { composerSessionLinkUrisRef, setComposerSessionLinks } = ctx;
        composerSessionLinkUrisRef.current.clear();
        setComposerSessionLinks([]);
    
}

export function removeComposerSessionLink(ctx, id) {
    const { composerSessionLinkUrisRef, setComposerSessionLinks } = ctx;
        setComposerSessionLinks((current) => {
            const removed = current.find((link) => link.id === id);
            if (removed) {
                composerSessionLinkUrisRef.current.delete(removed.uri);
            }
            return current.filter((link) => link.id !== id);
        });
    
}

export function pruneComposerLinks(ctx, value) {
    const { composerSessionLinkUrisRef, setComposerSessionLinks } = ctx;
        const activeIds = new Set([...value.matchAll(/\uFFFC([^\uFFFC]+)\uFFFC/g)].map((match) => match[1]));
        setComposerSessionLinks((current) => {
            const next = current.filter((link) => activeIds.has(link.id));
            for (const link of current) {
                if (!activeIds.has(link.id)) composerSessionLinkUrisRef.current.delete(link.uri);
            }
            return next.length === current.length ? current : next;
        });
    
}

export function addComposerSessionLink(ctx, reference) {
    const { composerSessionLinkUrisRef, displaySessionTitle, setComposerSessionLinks, setStatus, showToast } = ctx;
        if (composerSessionLinkUrisRef.current.has(reference.uri)) {
            showToast("Session link already attached");
            return null;
        }
        composerSessionLinkUrisRef.current.add(reference.uri);
        const id = crypto.randomUUID();
        setComposerSessionLinks((current) => [
            ...current,
            {
                id,
                uri: reference.uri,
                workspaceId: reference.workspaceId,
                target: reference.target,
                lookupKind: reference.lookupKind,
                status: "loading",
                title: reference.target
            }
        ]);
        void (async () => {
        try {
            const params = new URLSearchParams({ target: reference.target });
            if (reference.workspaceId) {
                params.set("workspaceId", reference.workspaceId);
            }
            const response = await fetch(`/api/sessions/resolve-reference?${params}`, { cache: "no-store" });
            const payload = (await response.json().catch(() => null));
            if (!response.ok || !payload?.session) {
                throw new Error(payload?.error || "Session not found");
            }
            if (!composerSessionLinkUrisRef.current.has(reference.uri)) {
                return;
            }
            const linkedSession = payload.session;
            setComposerSessionLinks((current) => current.map((link) => link.id === id
                ? {
                    ...link,
                    status: "ready",
                    title: displaySessionTitle(linkedSession.title) || linkedSession.description || reference.target,
                    session: linkedSession
                }
                : link));
            setStatus(`Linked ${displaySessionTitle(linkedSession.title) || "session"}`);
        }
        catch (error) {
            if (!composerSessionLinkUrisRef.current.has(reference.uri)) {
                return;
            }
            setComposerSessionLinks((current) => current.map((link) => link.id === id
                ? { ...link, status: "ready", title: reference.target }
                : link));
            const detail = error instanceof Error ? error.message : "Session not found";
            setStatus(`Session link title lookup failed: ${detail}`);
        }
        })();
        return id;
    
}

export function addComposerUrlLink(ctx, url) {
    const { composerSessionLinkUrisRef, setComposerSessionLinks, setStatus, showToast } = ctx;
        if (composerSessionLinkUrisRef.current.has(url)) {
            showToast("Link already added");
            return null;
        }
        composerSessionLinkUrisRef.current.add(url);
        const id = crypto.randomUUID();
        setComposerSessionLinks((current) => [
            ...current,
            {
                id,
                uri: url,
                target: url,
                lookupKind: "url",
                status: "loading",
                title: url,
                session: { url }
            }
        ]);
        void (async () => {
        try {
            const response = await fetch(`/api/link-preview?url=${encodeURIComponent(url)}`, { cache: "no-store" });
            const payload = await response.json().catch(() => null);
            if (!response.ok || typeof payload?.title !== "string") {
                throw new Error(payload?.error || "Link title lookup failed");
            }
            if (!composerSessionLinkUrisRef.current.has(url)) {
                return;
            }
            setComposerSessionLinks((current) => current.map((link) => link.id === id
                ? { ...link, status: "ready", title: payload.title || url }
                : link));
        }
        catch (error) {
            if (!composerSessionLinkUrisRef.current.has(url)) {
                return;
            }
            setComposerSessionLinks((current) => current.map((link) => link.id === id
                ? { ...link, status: "ready", title: url }
                : link));
            setStatus(`Link title lookup failed: ${error instanceof Error ? error.message : "Unknown error"}`);
        }
        })();
        return id;
    
}

export function addPastedComposerLink(ctx, pastedText) {
    const { addComposerSessionLink, addComposerUrlLink, parseCodexReference, parsePastedHttpUrl } = ctx;
        const sessionReference = parseCodexReference(pastedText);
        if (sessionReference) {
            return addComposerSessionLink(sessionReference);
        }
        const pastedUrl = parsePastedHttpUrl(pastedText);
        return pastedUrl ? addComposerUrlLink(pastedUrl) : null;
    
}

export function activateGearProfile(ctx, index) {
    const { activeGearIndex, modelPreferencesEditRevisionRef, setActiveGearIndex } = ctx;
        if (activeGearIndex === index) {
            return;
        }
        modelPreferencesEditRevisionRef.current += 1;
        setActiveGearIndex(index);
    
}

export function updateGearProfile(ctx, index, update) {
    const { AUTO_MODEL_VALUE, modelPreferencesEditRevisionRef, setGearProfiles, supportsUltraEffort } = ctx;
        modelPreferencesEditRevisionRef.current += 1;
        setGearProfiles((current) => current.map((gear, gearIndex) => {
            if (gearIndex !== index) {
                return gear;
            }
            const nextModel = update.model ?? gear.model;
            const requestedEffort = nextModel === AUTO_MODEL_VALUE ? "high" : update.effort ?? gear.effort;
            return {
                model: nextModel,
                effort: (requestedEffort === "max" || requestedEffort === "ultra") && !supportsUltraEffort(nextModel) ? "xhigh" : requestedEffort
            };
        }));
    
}

export function handleEditorPaste(ctx, event) {
    const { MAX_ATTACHMENTS, addFiles, addPastedBrowserBridgeContext, addPastedText, addPastedTurnIssueContext, attachments, parseBrowserBridgeContext, parseTurnIssueContext, setStatus, shouldCompactPastedText } = ctx;
        const pastedText = event.clipboardData.getData("text/plain");
        const clipboardFiles = Array.from(event.clipboardData.files);
        const itemFiles = clipboardFiles.length === 0
            ? Array.from(event.clipboardData.items)
                .filter((item) => item.kind === "file")
                .map((item) => item.getAsFile())
                .filter((file) => file !== null)
            : [];
        const pastedImages = [...clipboardFiles, ...itemFiles].filter((file) => file.type.startsWith("image/"));
        if (pastedImages.length > 0) {
            event.preventDefault();
            void addFiles(pastedImages);
            return;
        }
        const browserContext = parseBrowserBridgeContext(pastedText);
        if (browserContext) {
            event.preventDefault();
            if (attachments.length >= MAX_ATTACHMENTS) {
                setStatus(`Attach up to ${MAX_ATTACHMENTS} files`);
                return;
            }
            void addPastedBrowserBridgeContext(browserContext);
            return;
        }
        const turnIssueContext = parseTurnIssueContext(pastedText);
        if (turnIssueContext) {
            event.preventDefault();
            if (attachments.length >= MAX_ATTACHMENTS) {
                setStatus(`Attach up to ${MAX_ATTACHMENTS} files`);
                return;
            }
            void addPastedTurnIssueContext(turnIssueContext);
            return;
        }
        const shouldCompact = shouldCompactPastedText(pastedText);
        if (!shouldCompact || attachments.length >= MAX_ATTACHMENTS) {
            if (shouldCompact && attachments.length >= MAX_ATTACHMENTS) {
                setStatus(`Attach up to ${MAX_ATTACHMENTS} files`);
            }
            return;
        }
        event.preventDefault();
        void addPastedText(pastedText);
    
}

export function handleEditorKeyDown(ctx, event) {
    // Android IMEs can report 229 before isComposing becomes true. Leave all
    // candidate-selection keys to the IME, including arrows, Space and Enter.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const { canSend, composerSuggestionIndex, composerSuggestionTrigger, currentSessionIsRunning, selectComposerSuggestion, selectSlashSuggestion, setComposerSuggestionIndex, setComposerSuggestionTrigger, setSlashSuggestionIndex, setSlashTrigger, slashSuggestionIndex, slashTrigger, submitSteer, visibleComposerSuggestions, visibleSlashSuggestions } = ctx;
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (canSend && currentSessionIsRunning) {
                void submitSteer();
            }
            return;
        }
        if (slashTrigger && visibleSlashSuggestions.length > 0) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const direction = event.key === "ArrowDown" ? 1 : -1;
                setSlashSuggestionIndex((current) => (current + direction + visibleSlashSuggestions.length) % visibleSlashSuggestions.length);
                return;
            }
            if (event.key === "Tab" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                selectSlashSuggestion(visibleSlashSuggestions[slashSuggestionIndex] ?? visibleSlashSuggestions[0]);
                return;
            }
            if (event.key === "Escape") {
                event.preventDefault();
                setSlashTrigger(null);
                return;
            }
        }
        if (composerSuggestionTrigger && visibleComposerSuggestions.length > 0) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const direction = event.key === "ArrowDown" ? 1 : -1;
                setComposerSuggestionIndex((current) => current < 0
                    ? event.key === "ArrowDown" ? 0 : visibleComposerSuggestions.length - 1
                    : (Math.min(current, visibleComposerSuggestions.length - 1) + direction + visibleComposerSuggestions.length) % visibleComposerSuggestions.length);
                return;
            }
            if (event.key === "Tab" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                selectComposerSuggestion(visibleComposerSuggestions[composerSuggestionIndex] ?? visibleComposerSuggestions[0]);
                return;
            }
            const selectedSuggestion = composerSuggestionIndex >= 0
                ? visibleComposerSuggestions[composerSuggestionIndex]
                : null;
            if (selectedSuggestion && !event.nativeEvent.isComposing &&
                ((event.key === "Enter" && !event.shiftKey) || event.key === " ")) {
                event.preventDefault();
                selectComposerSuggestion(selectedSuggestion);
                return;
            }
            if (event.key === "Escape") {
                event.preventDefault();
                setComposerSuggestionTrigger(null);
                return;
            }
        }
        if (event.key !== "Enter" || event.nativeEvent.isComposing) {
            return;
        }
        if (event.shiftKey) {
            return;
        }
        event.preventDefault();
        if (canSend) {
            event.currentTarget.closest("form")?.requestSubmit();
        }
    
}
