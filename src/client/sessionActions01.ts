// @ts-nocheck
import { DEFAULT_MODEL } from "../modelCatalog";
import { savePendingSubmission, removePendingSubmission, beginSubmission, finishSubmission, isSubmissionSending } from "./pendingSubmissions";

function preserveSubmission(ctx, entry) {
    try {
        savePendingSubmission({ createdAt: new Date().toISOString(), ...entry });
        return true;
    } catch {
        ctx.setStatus("Prompt not sent: unable to save locally. Free browser storage and try again.");
        return false;
    }
}
export function currentClientLayout() {
    return window.matchMedia("(width < 768px)").matches ? "mobile"
        : window.matchMedia("(width < 1080px)").matches ? "tablet" : "desktop";
}

export function showToast(ctx, message) {
    const { setToastMessage, toastTimerRef } = ctx;
        setToastMessage(message);
        if (toastTimerRef.current !== null) {
            window.clearTimeout(toastTimerRef.current);
        }
        toastTimerRef.current = window.setTimeout(() => {
            setToastMessage(null);
            toastTimerRef.current = null;
        }, 1800);
    
}

export function toggleTodoPlanMode(ctx, ) {
    const { composerTodoPlanModeAvailable, forcePlanNextPrompt, setComposerForcePlanNextPrompt, setStatus, todoPlanClarificationPending } = ctx;
        if (!composerTodoPlanModeAvailable) {
            return;
        }
        const next = !forcePlanNextPrompt;
        setComposerForcePlanNextPrompt(next);
        const message = next ? "Outcome tracking on" : "Outcome tracking off";
        setStatus(message);
    
}

export async function copySessionReference(ctx, workspaceId, id) {
    const { buildCodexReference, showToast } = ctx;
        const reference = buildCodexReference(workspaceId, id);
        if (!navigator.clipboard) {
            showToast("Clipboard is unavailable");
            return;
        }
        try {
            await navigator.clipboard.writeText(reference);
            showToast(`Copied ${reference}`);
        }
        catch {
            showToast("Unable to copy session ID");
        }
    
}

export function selectedSessionReferences(records, buildCodexReference) {
    return records
        .map((record) => buildCodexReference(record.workspaceId, record.id))
        .join("\n");
}

export function currentWorkspaceId(activeWorkspaceIdRef, activeWorkspace) {
    return activeWorkspaceIdRef?.current ?? activeWorkspace?.id ?? null;
}

export function resetEscStopPrompt(ctx, ) {
    const { escStopArmedRef, escStopTimerRef } = ctx;
        escStopArmedRef.current = false;
        if (escStopTimerRef.current !== null) {
            window.clearTimeout(escStopTimerRef.current);
            escStopTimerRef.current = null;
        }
    
}

export function markBackendConnection(ctx, state) {
    const { backendConnectionRef, setBackendConnection } = ctx;
        backendConnectionRef.current = state;
        setBackendConnection(state);
    
}

export function noteBackendDisconnect(ctx, ) {
    const { backendConnectionRef, markBackendConnection, setStatus } = ctx;
        if (backendConnectionRef.current !== "reconnecting") {
            markBackendConnection("reconnecting");
            setStatus("Backend offline; reconnecting");
        }
    
}

export function noteBackendRequestSucceeded(ctx, ) {
    const { backendConnectionRef, markBackendConnection } = ctx;
        if (backendConnectionRef.current !== "online") {
            markBackendConnection("online");
        }
    
}

export async function restoreBackendConnection(ctx, ) {
    const { backendRestoreInFlightRef, findReconnectTarget, loadContext, reconnectRunner, setStatus, streamTargetsRef, viewKeyRef } = ctx;
        if (backendRestoreInFlightRef.current) {
            return;
        }
        backendRestoreInFlightRef.current = true;
        try {
            setStatus("Backend reconnected");
            await loadContext();
            const target = findReconnectTarget();
            if (target) {
                // The original /api/chat stream can still be alive when an
                // unrelated backend request briefly reports a disconnect.
                // Do not attach a second reader to the same runner log; both
                // readers would append every item to the visible turn.
                if (streamTargetsRef.current[target.turnId]) {
                    return;
                }
                setStatus("Reconnecting to prompt runner");
                void reconnectRunner(target.turnId, target.assistantMessageId, target.sessionId, viewKeyRef.current);
            }
        }
        finally {
            backendRestoreInFlightRef.current = false;
        }
    
}

export function findReconnectTarget(ctx, ) {
    const { activeTurnIdRef, findAssistantMessageId, latestMessagesRef, sessionIdRef } = ctx;
        const messages = latestMessagesRef.current;
        const activeReconnectTurnId = activeTurnIdRef.current ??
            [...messages].reverse().find((message) => message.role === "assistant" && message.turnStatus === "running" && message.turnId)
                ?.turnId;
        if (!activeReconnectTurnId) {
            return null;
        }
        return {
            turnId: activeReconnectTurnId,
            assistantMessageId: findAssistantMessageId(messages, activeReconnectTurnId) ?? `${activeReconnectTurnId}:assistant`,
            sessionId: sessionIdRef.current
        };
    
}

export async function stopCurrentTurn(ctx, turnId) {
    const { isLikelyBackendDisconnect, loadSessions, markTurnStopped, noteBackendDisconnect, noteBackendRequestSucceeded, sessionIdRef, setStatus, setStoppingTurnIds, showToast, stoppingTurnIds } = ctx;
        if (!turnId || stoppingTurnIds.has(turnId)) {
            return;
        }
        setStoppingTurnIds((current) => new Set([...current, turnId]));
        setStatus("Stopping agent");
        try {
            const response = await fetch("/api/runner/stop", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    turnId,
                    sessionId: sessionIdRef.current ?? undefined
                })
            });
            const payload = (await response.json().catch(() => null));
            if (!response.ok) {
                throw new Error(typeof payload?.error === "string" ? payload.error : `API returned ${response.status}`);
            }
            noteBackendRequestSucceeded();
            const message = typeof payload?.message === "string" ? payload.message : "Agent stopped.";
            markTurnStopped(turnId, message);
            setStatus(message);
            void loadSessions();
        }
        catch (error) {
            if (isLikelyBackendDisconnect(error)) {
                noteBackendDisconnect();
            }
            else {
                const message = error instanceof Error ? `Stop failed: ${error.message}` : "Stop failed";
                setStatus(message);
                showToast(message);
            }
        }
        finally {
            setStoppingTurnIds((current) => {
                if (!current.has(turnId)) {
                    return current;
                }
                const next = new Set(current);
                next.delete(turnId);
                return next;
            });
        }
    
}

export function captureResponseQuoteSelection(ctx, event) {
    const { activeWorkspace, buildCodexReference, elementForSelectionNode, sessionId, setResponseQuotePopover, threadId } = ctx;
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
            setResponseQuotePopover(null);
            return;
        }
        const startElement = elementForSelectionNode(selection.anchorNode);
        const endElement = elementForSelectionNode(selection.focusNode);
        const startMessage = startElement?.closest(".message.assistant");
        const endMessage = endElement?.closest(".message.assistant");
        const startsInResponseText = Boolean(startElement?.closest(".markdown-content"));
        const endsInResponseText = Boolean(endElement?.closest(".markdown-content"));
        if (!startMessage || startMessage !== endMessage || !startsInResponseText || !endsInResponseText) {
            setResponseQuotePopover(null);
            return;
        }
        const text = selection.toString().trim().slice(0, 4_000);
        if (!text) {
            setResponseQuotePopover(null);
            return;
        }
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        const fallbackRect = range.getClientRects().item(range.getClientRects().length - 1);
        const selectionRect = rect.width || rect.height ? rect : fallbackRect;
        if (!selectionRect) {
            setResponseQuotePopover(null);
            return;
        }
        const sourceTarget = threadId ?? sessionId;
        const sourceWorkspaceId = activeWorkspace?.id;
        if (!sourceTarget || !sourceWorkspaceId) {
            setResponseQuotePopover(null);
            return;
        }
        const sourceTurnId = startMessage.dataset.turnId;
        const sourceTurnNumber = Number(startMessage.dataset.turnNumber);
        setResponseQuotePopover({
            text,
            left: Math.min(window.innerWidth - Math.min(190, window.innerWidth / 2), Math.max(Math.min(190, window.innerWidth / 2), selectionRect.left + selectionRect.width / 2)),
            top: Math.max(160, selectionRect.top - 8),
            source: {
                type: "response",
                sessionUrl: buildCodexReference(sourceWorkspaceId, sourceTarget, sourceTurnId),
                ...(sourceTurnId ? { turnId: sourceTurnId } : {}),
                ...(Number.isInteger(sourceTurnNumber) && sourceTurnNumber > 0 ? { turnNumber: sourceTurnNumber } : {})
            }
        });
        event.stopPropagation();
    
}

export function askAboutResponseQuote(ctx, quote) {
    const { inputEditorRef, setComposerResponseQuote, setResponseQuotePopover } = ctx;
        setComposerResponseQuote({ text: quote.text, source: quote.source, annotation: quote.annotation?.trim() });
        setResponseQuotePopover(null);
        window.getSelection()?.removeAllRanges();
        window.requestAnimationFrame(() => inputEditorRef.current?.focus());
    
}

export async function submit(ctx, event, modeOverride?: string) {
    const { attachments, commitQueuedPromptEdit, composerLinkToken, composerMode, composerResponseQuote, composerSessionLinks, composerTodoPlanModeEnabled, currentSessionIsRunning, enqueuePrompt, executionMode, forkNextPrompt, formatComposerLinkMarkdown, formatResponseAnnotationsPrompt, input, queuePrompt, queuedPromptEditRef, replaceComposerLinkTokens, selectedSkills, sessionIdRef, setComposerExecutionMode, setComposerForkNextPrompt, startChatTurn, steerPrompt } = ctx;
        event?.preventDefault();
        if (isSubmissionSending(sessionIdRef.current)) return;
        if (queuedPromptEditRef?.current) {
            const editedMessage = input.trim();
            if (editedMessage) {
                commitQueuedPromptEdit(editedMessage);
            }
            return;
        }
        const inputMessage = replaceComposerLinkTokens(input, composerSessionLinks).trim();
        const linkReferences = composerSessionLinks
            .filter((link) => !input.includes(composerLinkToken(link.id)))
            .map((link) => formatComposerLinkMarkdown(link));
        const inlineAnnotation = composerResponseQuote?.source?.type === "file"
            ? composerResponseQuote.annotation?.trim() ?? ""
            : "";
        const standaloneRequest = [inputMessage, ...linkReferences].filter(Boolean).join("\n");
        const plainMessage = standaloneRequest || inlineAnnotation ||
            (attachments.length > 0 ? "Review the attached file(s)." : "");
        if (!plainMessage) {
            return;
        }
        const message = composerResponseQuote
            ? formatResponseAnnotationsPrompt([{
                    text: composerResponseQuote.text,
                    annotation: inlineAnnotation || inputMessage || plainMessage,
                    source: composerResponseQuote.source
                }], inlineAnnotation ? standaloneRequest : linkReferences.join("\n"))
            : plainMessage;
        const turnSkills = selectedSkills.filter((skill) => message.includes(`$${skill.name}`));
        const forcePlan = composerTodoPlanModeEnabled;
        if (executionMode === "goal") {
            setComposerExecutionMode("default");
        }
        const submissionMode = modeOverride ?? composerMode;
        if (forkNextPrompt && submissionMode !== "steer" && sessionIdRef.current) {
            setComposerForkNextPrompt(false);
            if (currentSessionIsRunning) {
                await enqueuePrompt(message, "queue", executionMode, turnSkills, attachments, true, forcePlan);
            }
            else {
                await startChatTurn(message, attachments, executionMode, turnSkills, true, forcePlan);
            }
            return;
        }
        if (currentSessionIsRunning) {
            if (submissionMode === "steer") {
                await steerPrompt(message, attachments, true, turnSkills, forcePlan);
            }
            else {
                await queuePrompt(message, executionMode, turnSkills, forcePlan);
            }
            return;
        }
        await startChatTurn(message, attachments, executionMode, turnSkills, false, forcePlan);
    
}

export async function startChatTurn(ctx, message, turnAttachments, turnExecutionMode, turnSkills, contextForkRequest, forcePlan, clearComposer, grillOrigin = undefined, submissionId: string | undefined = undefined) {
    const { AUTO_MODEL_VALUE, activeAccount, activeWorkspace, activeWorkspaceIdRef, approvalPolicy, clearComposerInputDraft, clearComposerSessionLinks, composerDraftSessionIdRef, currentModelPreferences, explicitNewSessionRef, handleStreamEvent, isLikelyBackendDisconnect, markTurnFinished, markTurnRunning, modelPreferencesWorkspaceIdRef, moveStoredComposerDraft, newSessionBaseSessionIdRef, newSessionProjectRef, noteBackendDisconnect, noteBackendRequestSucceeded, patchAssistantMessage, persistedModelPreferencesWorkspaceIdRef, readEventStream, reconnectRunner, registerStreamTarget, restoreKnownActiveSessionBeforeSend, resumeThreadId, scheduleLoadSessions, selectedModel, sessionAutoModel, sessionIdRef, setActiveSessionId, setActiveTurnId, setAttachments, setComposerResponseQuote, setMessages, setResponseQuotePopover, setSelectedSkills, setSessionId, setSlashTrigger, setStatus, stickToMessageBottomRef, streamTargetsRef, unregisterStreamTarget, updateNavigationUrl, useLoadBalanceInWorkspace, viewKeyRef } = ctx;
        const workspaceId = currentWorkspaceId(activeWorkspaceIdRef, activeWorkspace);
        if (isSubmissionSending(sessionIdRef.current)) return false;
        stickToMessageBottomRef.current = true;
        setStatus(contextForkRequest ? "Preparing child task handoff" : "Connecting to Codex");
        const turnId = submissionId ?? crypto.randomUUID();
        const provisionalSessionId = sessionIdRef.current ?? `tx_${crypto.randomUUID()}`;
        const submission = {
            id: turnId, turnId, sessionId: provisionalSessionId, workspaceId, kind: "prompt", message,
            attachments: turnAttachments,
            settings: { executionMode: turnExecutionMode, skills: turnSkills, contextFork: contextForkRequest,
                forcePlan, grillOrigin, modelPreferences: currentModelPreferences(), approvalPolicy }
        };
        // Even restoring the selected session can make a network request.
        // Preserve the input before the first await, then rebind it if necessary.
        if (!preserveSubmission(ctx, submission)) return false;
        beginSubmission(turnId, sessionIdRef.current);
        try {
        // Allocate the local session id before opening the stream. This keeps the
        // turn associated with a durable session even if the user switches views
        // before the runner's first SSE event arrives.
        const restoredSessionId = sessionIdRef.current ?? await restoreKnownActiveSessionBeforeSend();
        if (restoredSessionId === false) {
            return false;
        }
        const currentSessionId = restoredSessionId;
        const targetSessionId = currentSessionId ?? provisionalSessionId;
        if (targetSessionId !== provisionalSessionId &&
            !preserveSubmission(ctx, { ...submission, sessionId: targetSessionId })) return false;
        beginSubmission(turnId, targetSessionId);
        if (clearComposer) {
            clearComposerInputDraft();
            setAttachments([]);
            setComposerResponseQuote(null);
            setResponseQuotePopover(null);
            clearComposerSessionLinks();
            setSelectedSkills([]);
            setSlashTrigger(null);
        }
        if (!currentSessionId) {
            moveStoredComposerDraft(null, targetSessionId);
            composerDraftSessionIdRef.current = targetSessionId;
            modelPreferencesWorkspaceIdRef.current = workspaceId ?? null;
            persistedModelPreferencesWorkspaceIdRef.current = workspaceId ?? null;
            sessionIdRef.current = targetSessionId;
            explicitNewSessionRef.current = false;
            setSessionId(targetSessionId);
            setActiveSessionId(targetSessionId);
            // The sessionless route is only a placeholder for this first turn.
            // Replacing it prevents browser Back/Forward from landing on a stale
            // blank route and silently allocating another session on the next send.
            updateNavigationUrl({ workspaceId, sessionId: targetSessionId }, "replace");
        }
        setActiveTurnId(turnId);
        markTurnRunning(turnId);
        const displayExecutionMode = contextForkRequest ? "default" : turnExecutionMode;
        const modelPreferences = currentModelPreferences();
        const turnModel = selectedModel === AUTO_MODEL_VALUE
            ? sessionAutoModel?.model ?? DEFAULT_MODEL
            : modelPreferences.selectedModel;
        const turnReasoningEffort = selectedModel === AUTO_MODEL_VALUE
            ? sessionAutoModel?.effort ?? "high"
            : modelPreferences.selectedEffort;
        const userMessage = {
            id: crypto.randomUUID(),
            role: "user",
            content: message,
            turnId,
            model: turnModel,
            reasoningEffort: turnReasoningEffort,
            autoModel: selectedModel === AUTO_MODEL_VALUE,
            createdAt: new Date().toISOString(),
            attachments: turnAttachments,
            forcePlan,
            contextFork: contextForkRequest,
            executionMode: displayExecutionMode
        };
        const assistantMessage = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            turnId,
            createdAt: new Date().toISOString(),
            pending: true,
            turnStatus: "running",
            runnerStarted: false,
            segments: []
        };
        const target = registerStreamTarget(turnId, assistantMessage.id, targetSessionId, viewKeyRef.current);
        setMessages((current) => [...current, userMessage, assistantMessage]);
        try {
            const selectedModel = modelPreferences.selectedModel;
            const selectedEffort = modelPreferences.selectedEffort;
            const response = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message,
                    clientLayout: currentClientLayout(),
                    turnId,
                    grillOrigin,
                    model: selectedModel === AUTO_MODEL_VALUE ? DEFAULT_MODEL : selectedModel,
                    modelReasoningEffort: selectedModel === AUTO_MODEL_VALUE ? "high" : selectedEffort,
                    modelPreferences,
                    approvalPolicy,
                    autoModel: selectedModel === AUTO_MODEL_VALUE,
                    executionMode: turnExecutionMode,
                    skills: turnSkills.map(({ name, path }) => ({ name, path })),
                    attachments: turnAttachments,
                    forcePlan,
                    workspaceId: workspaceId ?? undefined,
                    accountId: useLoadBalanceInWorkspace ? undefined : activeAccount?.id ?? null,
                    loadBalanceInWorkspace: useLoadBalanceInWorkspace,
                    sessionId: targetSessionId,
                    baseSessionId: newSessionBaseSessionIdRef.current ?? undefined,
                    newSessionProjectId: currentSessionId ? undefined : newSessionProjectRef.current?.id ?? undefined,
                    contextFork: contextForkRequest,
                    // A new local session must never inherit the previous thread. Use
                    // the ref because New thread clears it synchronously while the
                    // React state update may still be pending.
                    resumeThreadId: currentSessionId ? resumeThreadId.trim() || undefined : undefined
                })
            });
            if (!response.ok || !response.body) {
                throw new Error(`API returned ${response.status}`);
            }
            noteBackendRequestSucceeded();
            scheduleLoadSessions();
            await readEventStream(response.body, (streamEvent) => handleStreamEvent(streamEvent, target));
        }
        catch (error) {
            if (isLikelyBackendDisconnect(error)) {
                noteBackendDisconnect();
            }
            // This target is no longer owned by the failed /api/chat stream.
            // Remove it before opening the replay stream below.
            if (streamTargetsRef.current[turnId] === target) {
                delete streamTargetsRef.current[turnId];
            }
            setStatus("Reconnecting to prompt runner");
            const reconnected = await reconnectRunner(turnId, assistantMessage.id, target.sessionId, target.viewKey);
            if (reconnected) {
                return;
            }
            const content = error instanceof Error ? error.message : "Unknown request error";
            patchAssistantMessage(target, `Request failed: ${content}`, false, "done");
            setStatus("Error");
            markTurnFinished(turnId);
        }
        finally {
            unregisterStreamTarget(target, turnId);
        }
        } finally {
            finishSubmission(turnId);
        }
    
}

export function queuePrompt(ctx, message, mode, skills, forcePlan) {
    const { attachments, enqueuePrompt } = ctx;
        return enqueuePrompt(message, "queue", mode, skills, attachments, false, forcePlan);
    
}

export async function steerPrompt(ctx, message, steerAttachments, clearComposer, steerSkills, forcePlan) {
    const { addSteerMessage, clearComposerInputDraft, clearComposerSessionLinks, currentRunningTurnId, enqueuePrompt, executionMode, isInactiveSteerResponse, isLikelyBackendDisconnect, isSteering, noteBackendDisconnect, noteBackendRequestSucceeded, parseResponseAnnotations, refreshSelectedSessionSnapshot, sessionIdRef, setAttachments, setComposerForcePlanNextPrompt, setComposerInput, setComposerResponseQuote, setIsSteering, setResponseQuotePopover, setSelectedSkills, setSlashTrigger, setStatus, showToast } = ctx;
        const turnId = currentRunningTurnId;
        const targetSessionId = sessionIdRef.current;
        if (!turnId || !targetSessionId || isSteering || isSubmissionSending(targetSessionId)) {
            if (!isSteering) {
                showToast("No active agent turn to steer.");
            }
            return false;
        }
        const submissionId = crypto.randomUUID();
        if (!preserveSubmission(ctx, {
            id: submissionId, turnId, sessionId: targetSessionId,
            workspaceId: ctx.activeWorkspaceIdRef?.current ?? null, kind: "steer", message,
            attachments: steerAttachments, settings: { skills: steerSkills, forcePlan }
        })) return false;
        beginSubmission(submissionId, targetSessionId);
        if (clearComposer) {
            clearComposerInputDraft();
            setAttachments([]);
            setComposerResponseQuote(null);
            setResponseQuotePopover(null);
            clearComposerSessionLinks();
            setSelectedSkills([]);
            setSlashTrigger(null);
        }
        setIsSteering(true);
        setStatus("Steering agent");
        const steerCreatedAt = new Date().toISOString();
        try {
            const response = await fetch("/api/runner/steer", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    turnId,
                    sessionId: targetSessionId,
                    message,
                    clientLayout: currentClientLayout(),
                    forcePlan,
                    skills: steerSkills.map(({ name, path }) => ({ name, path })),
                    attachments: steerAttachments
                })
            });
            const payload = (await response.json().catch(() => null));
            if (!response.ok || payload?.ok !== true) {
                const detail = typeof payload?.error === "string" ? payload.error : `API returned ${response.status}`;
                if (isInactiveSteerResponse(response.status, detail)) {
                    noteBackendRequestSucceeded();
                    await refreshSelectedSessionSnapshot(targetSessionId, turnId);
                    throw new Error("The target turn has stopped or finished. Steer was not sent; resend it as a new prompt.");
                }
                throw new Error(detail);
            }
            noteBackendRequestSucceeded();
            const savedAttachments = Array.isArray(payload?.attachments) ? payload.attachments : steerAttachments;
            removePendingSubmission(submissionId);
            addSteerMessage(targetSessionId, turnId, message, savedAttachments, steerCreatedAt, forcePlan, typeof payload?.commandId === "string" ? payload.commandId : undefined);
            setStatus(typeof payload?.message === "string" ? payload.message : "Agent steered.");
            return "sent";
        }
        catch (error) {
            if (clearComposer) {
                const restoredResponseAnnotations = parseResponseAnnotations(message);
                setComposerInput((current) => current || restoredResponseAnnotations?.content || message);
                setComposerResponseQuote((current) => current ?? restoredResponseAnnotations?.annotations[0] ?? null);
                setAttachments((current) => current.length > 0 ? current : steerAttachments);
                setSelectedSkills((current) => current.length > 0 ? current : steerSkills);
                setComposerForcePlanNextPrompt((current) => current || forcePlan);
            }
            if (isLikelyBackendDisconnect(error)) {
                noteBackendDisconnect();
            }
            const detail = error instanceof Error ? error.message : "Unknown steer error";
            setStatus(`Steer failed: ${detail}`);
            showToast(`Steer failed: ${detail}`);
            return false;
        }
        finally {
            finishSubmission(submissionId);
            setIsSteering(false);
        }
    
}

export function addSteerMessage(ctx, sessionId, turnId, content, steerAttachments, createdAt = new Date().toISOString(), forcePlan = false, id = crypto.randomUUID()) {
    const { appendSteerSegment, sessionIdRef, setMessages } = ctx;
        if (sessionIdRef.current !== sessionId) {
            return;
        }
        const steerMessage = {
            id,
            role: "user",
            content,
            turnId,
            kind: "steer",
            createdAt,
            attachments: steerAttachments,
            forcePlan
        };
        setMessages((current) => {
            const withTimelineSteer = current.map((message) => message.role === "assistant" && message.turnId === turnId
                ? { ...message, segments: appendSteerSegment(message.segments ?? [], steerMessage) }
                : message);
            const assistantIndex = current.findIndex((message) => message.role === "assistant" && message.turnId === turnId);
            if (assistantIndex < 0) {
                return [...withTimelineSteer, steerMessage];
            }
            const lastSteerIndex = withTimelineSteer.reduce((lastIndex, message, index) => message.role === "user" && message.kind === "steer" && message.turnId === turnId ? index : lastIndex, -1);
            const insertionIndex = lastSteerIndex > assistantIndex ? lastSteerIndex + 1 : assistantIndex + 1;
            return [...withTimelineSteer.slice(0, insertionIndex), steerMessage, ...withTimelineSteer.slice(insertionIndex)];
        });
    
}

export function enqueuePrompt(ctx, message, kind, mode, skills, promptAttachments, contextFork, forcePlan, clearComposer = true) {
    const {
        activeWorkspaceIdRef, clearComposerInputDraft, clearComposerSessionLinks,
        isLikelyBackendDisconnect, noteBackendDisconnect, noteBackendRequestSucceeded,
        refreshSelectedSessionSnapshot, sessionIdRef, setAttachments,
        setComposerResponseQuote, setResponseQuotePopover, setSelectedSkills,
        setSlashTrigger, setStatus
    } = ctx;
    const sessionId = sessionIdRef.current;
    const id = crypto.randomUUID();
    if (!sessionId || !preserveSubmission(ctx, {
        id, turnId: id, sessionId,
        workspaceId: activeWorkspaceIdRef.current, kind: "prompt", message,
        attachments: promptAttachments,
        settings: { queued: true, executionMode: mode, skills, contextFork, forcePlan, ...ctx.requestSettings }
    })) return false;

    beginSubmission(id, sessionId);
    return (async () => {
        try {
            const response = await fetch("/api/pending-turns", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...ctx.requestSettings,
                    sessionId,
                    turnId: id,
                    workspaceId: activeWorkspaceIdRef.current ?? undefined,
                    message,
                    attachments: promptAttachments,
                    executionMode: mode,
                    skills,
                    contextFork,
                    forcePlan
                })
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok || !payload?.ok || !payload.turn) {
                throw new Error(payload?.error || `API returned ${response.status}`);
            }
            noteBackendRequestSucceeded?.();
            removePendingSubmission(id);
            if (clearComposer) {
                clearComposerInputDraft();
                setAttachments([]);
                setComposerResponseQuote(null);
                setResponseQuotePopover(null);
                clearComposerSessionLinks();
                setSelectedSkills([]);
                setSlashTrigger(null);
            }
            setStatus(contextFork ? "Child task handoff queued" : kind === "steer" ? "Steer queued" : "Prompt queued");
            await refreshSelectedSessionSnapshot?.(sessionId, id);
            return true;
        }
        catch (error) {
            if (isLikelyBackendDisconnect?.(error)) noteBackendDisconnect?.();
            setStatus(`Queue failed: ${error instanceof Error ? error.message : "Unknown error"}`);
            return false;
        }
        finally {
            finishSubmission(id);
        }
    })();
}

export async function loadSessionSearchPage(ctx, offset = 0, signal) {
    const { sessionSearchQuery, setIsSearchingSessions, setSessionSearchPage, setSessionSearchResults, setStatus } = ctx;
        setIsSearchingSessions(true);
        const query = sessionSearchQuery.trim();
        const params = new URLSearchParams({ offset: String(Math.max(0, offset)), limit: "20" });
        if (query) {
            params.set("q", query);
        }
        try {
            const response = await fetch(`/api/sessions?${params}`, { cache: "no-store", signal });
            if (!response.ok)
                throw new Error(`API returned ${response.status}`);
            const payload = (await response.json());
            setSessionSearchResults(Array.isArray(payload.sessions) ? payload.sessions : []);
            setSessionSearchPage({
                offset: payload.page?.offset ?? offset,
                limit: payload.page?.limit ?? 20,
                hasMore: payload.page?.hasMore ?? false,
                nextOffset: payload.page?.nextOffset ?? null,
                total: payload.page?.total ?? 0
            });
        }
        catch (error) {
            if (error instanceof DOMException && error.name === "AbortError")
                return;
            setSessionSearchResults([]);
            setSessionSearchPage({ offset: 0, limit: 20, hasMore: false, nextOffset: null, total: 0 });
            setStatus(error instanceof Error ? `Session search failed: ${error.message}` : "Session search failed");
        }
        finally {
            if (!signal?.aborted)
                setIsSearchingSessions(false);
        }
    
}

export async function loadSessions(ctx, offset = 0, append = false, cwd: string | null = null) {
    const { eventStore, isLikelyBackendDisconnect, noteBackendDisconnect, noteBackendRequestSucceeded, setIsLoadingSessions, setLoadingSessionProjects, setStatus, toSessionPageState } = ctx;
        if (cwd === null)
            setIsLoadingSessions(true);
        else
            setLoadingSessionProjects((current) => new Set([...current, cwd]));
        try {
            const params = new URLSearchParams();
            if (cwd !== null) {
                params.set("cwd", cwd);
                params.set("offset", String(Math.max(0, offset)));
            }
            const response = await fetch(`/api/sessions${params.size > 0 ? `?${params}` : ""}`, { cache: "no-store" });
            if (!response.ok) {
                throw new Error(`API returned ${response.status}`);
            }
            noteBackendRequestSucceeded();
            const payload = (await response.json());
            const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
            const nextPage = toSessionPageState(sessions, payload.page);
            if (cwd !== null) {
                eventStore.setSessionProjectPage(cwd, {
                    cwd,
                    offset: nextPage.offset,
                    limit: nextPage.limit,
                    hasMore: nextPage.hasMore,
                    total: Number(payload.page?.total) || sessions.length,
                    nextOffset: nextPage.nextOffset
                }, sessions);
            }
            else {
                const currentPage = eventStore.getState().sessionPage;
                const refreshedSessionIds = new Set(sessions.map((session) => session.id));
                const preservedSessions = [...sessions];
                const projects = nextPage.projects.map((project) => {
                    const currentProject = currentPage.projects.find((candidate) => candidate.cwd === project.cwd);
                    const currentProjectSessions = currentPage.sessions.filter((session) => session.cwd === project.cwd);
                    const freshProjectCount = sessions.filter((session) => session.cwd === project.cwd).length;
                    if (!currentProject || currentProjectSessions.length <= freshProjectCount)
                        return project;
                    let preservedProjectCount = freshProjectCount;
                    for (const session of currentProjectSessions) {
                        if (!refreshedSessionIds.has(session.id)) {
                            preservedSessions.push(session);
                            preservedProjectCount += 1;
                        }
                    }
                    const hasMore = preservedProjectCount < project.total;
                    return {
                        ...project,
                        hasMore,
                        nextOffset: hasMore ? preservedProjectCount : null
                    };
                });
                eventStore.setSessionPage({
                    ...nextPage,
                    sessions: preservedSessions,
                    hasMore: projects.some((project) => project.hasMore),
                    projects
                });
            }
            setStatus((current) => typeof current === "string" && current.startsWith("Session list failed") ? "Ready" : current || "Ready");
        }
        catch (error) {
            if (isLikelyBackendDisconnect(error)) {
                noteBackendDisconnect();
            }
            else {
                setStatus(error instanceof Error ? `Session list failed: ${error.message}` : "Session list failed");
            }
        }
        finally {
            if (cwd === null)
                setIsLoadingSessions(false);
            else
                setLoadingSessionProjects((current) => {
                    const next = new Set(current);
                    next.delete(cwd);
                    return next;
                });
        }
    
}

export async function refreshSelectedSessionSnapshot(ctx, targetSessionId, turnId) {
    const { applySelectedSessionSnapshot, isLikelyBackendDisconnect, noteBackendDisconnect, noteBackendRequestSucceeded, pendingReconciliationTurnIdsRef, reconcilingTurnIdsRef, sessionIdRef, setStatus } = ctx;
        if (sessionIdRef.current !== targetSessionId)
            return;
        const reconciliationKey = turnId ?? `session:${targetSessionId}`;
        if (reconcilingTurnIdsRef.current.has(reconciliationKey)) {
            // Terminal events commonly arrive as turn/completed, result, then
            // done. Do not drop a later reconciliation merely because an
            // earlier snapshot request is still in flight and may be stale.
            pendingReconciliationTurnIdsRef.current.add(reconciliationKey);
            return;
        }
        reconcilingTurnIdsRef.current.add(reconciliationKey);
        try {
            do {
                pendingReconciliationTurnIdsRef.current.delete(reconciliationKey);
                try {
                    const response = await fetch(`/api/sessions/${encodeURIComponent(targetSessionId)}/snapshot`, { cache: "no-store" });
                    if (!response.ok)
                        throw new Error(`API returned ${response.status}`);
                    noteBackendRequestSucceeded();
                    const payload = (await response.json());
                    if (sessionIdRef.current !== targetSessionId || !payload.session)
                        return;
                    applySelectedSessionSnapshot(payload);
                    const turn = turnId ? payload.turns?.find((candidate) => candidate.id === turnId) : null;
                    setStatus(turn?.status === "todo"
                        ? turn.agentResponse || "Turn queued"
                        : turn?.status === "running"
                            ? "Agent running"
                            : "Turn completed");
                }
                catch (error) {
                    if (isLikelyBackendDisconnect(error)) {
                        noteBackendDisconnect();
                    }
                }
            } while (pendingReconciliationTurnIdsRef.current.has(reconciliationKey));
        }
        finally {
            reconcilingTurnIdsRef.current.delete(reconciliationKey);
            pendingReconciliationTurnIdsRef.current.delete(reconciliationKey);
        }
    
}

export async function loadContext(ctx, ) {
    const { loadWorkspaceSnapshot, readOptionalNavigationTarget } = ctx;
        // Re-read the current URL: backend reconnects can happen after the user
        // has navigated away from the URL that bootstrapped the app.
        const navigationTarget = readOptionalNavigationTarget();
        await loadWorkspaceSnapshot({
            navigationTarget,
            canonicalizeUrl: Boolean(navigationTarget)
        });
    
}
