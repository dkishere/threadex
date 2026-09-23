// @ts-nocheck
import { eventStore } from "./eventStore";
export async function openLinkedSession(ctx, record) {
    const { activeWorkspace, switchSession, switchWorkspace } = ctx;
        if (record.url) {
            window.open(record.url, "_blank", "noopener,noreferrer");
            return;
        }
        if (record.workspaceId !== activeWorkspace?.id && !(await switchWorkspace(record.workspaceId, { history: "none" }))) {
            return;
        }
        await switchSession(record);
    
}

export async function switchToSessionById(ctx, targetSessionId, options = {}) {
    const { isCurrentViewKey, sessionList, setStatus, showToast, switchSession, viewKeyRef } = ctx;
        const listedSession = sessionList.find((record) => record.id === targetSessionId);
        if (listedSession) {
            await switchSession(listedSession, options);
            return;
        }
        const viewKey = viewKeyRef.current;
        try {
            const response = await fetch(`/api/sessions/${encodeURIComponent(targetSessionId)}/snapshot`, { cache: "no-store" });
            const payload = (await response.json().catch(() => null));
            if (!response.ok || !payload?.session) {
                throw new Error(payload?.error || `${options.label ?? "Session"} not found`);
            }
            if (!isCurrentViewKey(viewKey)) {
                return;
            }
            await switchSession(payload.session, options);
        }
        catch (error) {
            if (!isCurrentViewKey(viewKey)) {
                return;
            }
            const label = options.label ?? "session";
            const detail = error instanceof Error ? error.message : `${label} not found`;
            setStatus(`Could not open ${label}: ${detail}`);
            showToast(`Could not open ${label}: ${detail}`);
        }
    
}

export async function switchToParentSession(ctx, parentSessionId) {
    const { switchToSessionById } = ctx;
        await switchToSessionById(parentSessionId, { label: "parent" });
    
}

export async function restoreKnownActiveSessionBeforeSend(ctx, ) {
    const { activeSessionId, eventStore, explicitNewSessionRef, navigationTargetRef, newSessionRequestInFlightRef, readOptionalNavigationTarget, sessionIdRef, sessionList, setStatus, switchSession, switchToSessionById } = ctx;
        if (newSessionRequestInFlightRef.current) {
            setStatus("Wait for New thread to finish before sending.");
            return false;
        }
        // The address bar is the user's visible selection. Reconcile it before
        // trusting React/event-store state, which can briefly lag during
        // popstate, backend reconnect, or a late workspace snapshot.
        const navigationTarget = readOptionalNavigationTarget();
        if (navigationTarget) {
            navigationTargetRef.current = navigationTarget;
        }
        const navigationSessionId = navigationTarget?.sessionId?.trim() || null;
        if (navigationSessionId && sessionIdRef.current !== navigationSessionId) {
            await switchToSessionById(navigationSessionId, { label: "session", history: "replace" });
            if (sessionIdRef.current === navigationSessionId) {
                return navigationSessionId;
            }
            setStatus("Could not restore the session selected in the address bar.");
            return false;
        }
        if (explicitNewSessionRef.current) {
            return null;
        }
        if (sessionIdRef.current) {
            return sessionIdRef.current;
        }
        const selectedSession = eventStore.getState().selectedSessionSnapshot?.session ?? null;
        const listedActiveSession = activeSessionId
            ? sessionList.find((record) => record.id === activeSessionId) ?? null
            : null;
        const targetSession = selectedSession ?? listedActiveSession;
        if (!targetSession) {
            return null;
        }
        await switchSession(targetSession, { history: "replace" });
        if (sessionIdRef.current === targetSession.id) {
            return targetSession.id;
        }
        setStatus("Could not restore active session. Select a session or start a new thread.");
        return false;
    
}

export async function achieveSessionGoal(ctx, record) {
    const { achievingSessionIds, centralState, eventStore, isLikelyBackendDisconnect, noteBackendDisconnect, noteBackendRequestSucceeded, scheduleLoadSessions, setAchievingSessionIds, setStatus, showToast } = ctx;
        if (!record.threadId || achievingSessionIds.has(record.id)) {
            return;
        }
        setAchievingSessionIds((current) => new Set([...current, record.id]));
        setStatus("Achieving session goal");
        try {
            const response = await fetch(`/api/sessions/${encodeURIComponent(record.id)}/achieve`, {
                method: "POST"
            });
            const payload = (await response.json().catch(() => null));
            if (!response.ok) {
                throw new Error(payload?.error || `API returned ${response.status}`);
            }
            noteBackendRequestSucceeded();
            eventStore.setSessionPage({
                ...centralState.sessionPage,
                sessions: centralState.sessionPage.sessions.filter((session) => session.id !== record.id)
            });
            setStatus("Session achieved");
            showToast("Session achieved");
            scheduleLoadSessions(0);
        }
        catch (error) {
            if (isLikelyBackendDisconnect(error)) {
                noteBackendDisconnect();
            }
            else {
                const detail = error instanceof Error ? error.message : "Achieve failed";
                setStatus(`Achieve failed: ${detail}`);
                showToast(`Achieve failed: ${detail}`);
            }
        }
        finally {
            setAchievingSessionIds((current) => {
                const next = new Set(current);
                next.delete(record.id);
                return next;
            });
        }
    
}

export async function forkFromAgentMessage(ctx, message) {
    const { applySelectedSessionSnapshot, bumpViewKey, clearTodoPanelState, currentSessionIsRunning, isCurrentViewKey, messages, parentSessionTodo, scheduleLoadSessions, sessionId, sessionTodo, setForkingTurnId, setMessages, setParentSessionTodo, setQueuedPrompts, setSessionTodo, setStatus, setSwitchingSessionTitle, stickToMessageBottomRef, updateNavigationUrl, viewKeyRef } = ctx;
        if (!sessionId || !message.turnId || message.turnStatus !== "done" || currentSessionIsRunning) {
            return;
        }
        bumpViewKey();
        const viewKey = viewKeyRef.current;
        setForkingTurnId(message.turnId);
        setStatus("Forking session");
        const previousMessages = messages;
        const previousSessionTodo = sessionTodo;
        const previousParentSessionTodo = parentSessionTodo;
        stickToMessageBottomRef.current = true;
        setSwitchingSessionTitle("fork");
        setMessages([]);
        clearTodoPanelState();
        try {
            const response = await fetch("/api/sessions/fork", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sessionId, turnId: message.turnId })
            });
            if (!response.ok) {
                throw new Error(`API returned ${response.status}`);
            }
            const payload = (await response.json());
            const forkedSession = payload.session;
            if (!forkedSession) {
                throw new Error("Fork response did not include a session.");
            }
            if (!isCurrentViewKey(viewKey)) {
                return;
            }
            applySelectedSessionSnapshot(payload);
            updateNavigationUrl({ workspaceId: forkedSession.workspaceId, sessionId: forkedSession.id }, "push");
            setQueuedPrompts([]);
            setStatus("Session forked");
            scheduleLoadSessions();
        }
        catch (error) {
            if (!isCurrentViewKey(viewKey)) {
                return;
            }
            setMessages(previousMessages);
            setSessionTodo(previousSessionTodo);
            setParentSessionTodo(previousParentSessionTodo);
            setStatus(error instanceof Error ? `Fork failed: ${error.message}` : "Fork failed");
        }
        finally {
            if (isCurrentViewKey(viewKey)) {
                setForkingTurnId(null);
                setSwitchingSessionTitle(null);
            }
        }
    
}

export function handleStreamEvent(ctx, event, target) {
    if (event.type === "grill_ack") {
        eventStore.reportGrill(event.data.sessionId, event.data.turnId, event.data.grill);
        return;
    }
    const { activeAccount, activeTurnIdRef, activeWorkspaceIdRef, appendAssistantMessage, applyDeveloperInstructionsToTurn, applyStreamItem, approvalDecisionLabel, approvalEventToLiveItem, capitalize, describeCodexEvent, finishStreamTarget, getCodexEventName, isAccountLoginRequiredMessage, isNoRolloutFoundMessage, isTargetVisible, loadAccounts, loadSessions, markTurnFinished, markTurnRunning, migrateLocalComposerDraft, migrateLocalQueuedPrompts, modelOptionLabel, openAccountLoginDialog, patchAssistantMessage, patchAssistantTurn, readNavigationTarget, removePendingApprovalItem, scheduleLoadSessions, sessionIdRef, setActiveAccount, setActiveTurnId, setMessages, setPendingApprovalItems, setPendingApprovalSessionIds, setResumeThreadId, setSessionAutoModel, setSessionId, setStatus, setThreadId, streamTargetsRef, threadIdRef, updateNavigationUrl, upsertLiveItem, upsertPendingApprovalItem } = ctx;
        // The database reconciliation can finish a target when its terminal SSE
        // event was missed. Ignore a delayed replay of that old stream so it
        // cannot put the chat back into the running state.
        if (target.completed) {
            return;
        }
        if (event.type === "session") {
            const wasVisible = isTargetVisible(target);
            target.sessionId = event.data.sessionId;
            if (event.data.turnId && event.data.turnId !== target.turnId) {
                delete streamTargetsRef.current[target.turnId];
                markTurnFinished(target.turnId);
                target.turnId = event.data.turnId;
                streamTargetsRef.current[target.turnId] = target;
            }
            markTurnRunning(target.turnId);
            if (wasVisible || isTargetVisible(target)) {
                migrateLocalQueuedPrompts(event.data.sessionId);
                migrateLocalComposerDraft(event.data.sessionId);
                sessionIdRef.current = event.data.sessionId;
                setSessionId(event.data.sessionId);
                // The server can coalesce a client-generated id or otherwise
                // remap a request. Keep the address bar aligned with the task
                // actually shown so the next send cannot resume a stale id.
                const visibleNavigation = readNavigationTarget();
                if (visibleNavigation.sessionId !== event.data.sessionId) {
                    updateNavigationUrl({
                        workspaceId: activeWorkspaceIdRef.current,
                        sessionId: event.data.sessionId
                    }, "replace");
                }
                if ("activeAccount" in event.data) {
                    setActiveAccount(event.data.activeAccount ?? null);
                }
                if (event.data.turnId) {
                    activeTurnIdRef.current = event.data.turnId;
                    setActiveTurnId(event.data.turnId);
                }
                if (event.data.turnId && Array.isArray(event.data.attachments)) {
                    setMessages((current) => current.map((message) => message.role === "user" && message.turnId === event.data.turnId
                        ? { ...message, attachments: event.data.attachments }
                        : message));
                }
                if (event.data.startupSnapshot && event.data.turnId && (wasVisible || isTargetVisible(target))) {
                    setMessages((current) => {
                        const firstUserTurnId = current.find((message) => message.role === "user" && message.kind !== "steer")?.turnId;
                        if (firstUserTurnId !== event.data.turnId) {
                            return current;
                        }
                        return current.map((message) => message.role === "user" && message.turnId === event.data.turnId
                            ? { ...message, startupSnapshot: event.data.startupSnapshot }
                            : message);
                    });
                }
                threadIdRef.current = event.data.threadId ?? null;
                setThreadId(threadIdRef.current);
                setStatus(event.data.message);
            }
            if (event.data.turnId) {
                patchAssistantTurn(target, event.data.turnId, true, "running");
            }
            scheduleLoadSessions();
            return;
        }
        if (event.type === "codex") {
            if (isTargetVisible(target)) {
                setStatus(describeCodexEvent(event.data));
            }
            if (isTargetVisible(target) && getCodexEventName(event.data) === "thread.started" && event.data.thread_id) {
                threadIdRef.current = event.data.thread_id;
                setThreadId(event.data.thread_id);
            }
            if (getCodexEventName(event.data) === "thread/name/updated") {
                scheduleLoadSessions();
            }
            return;
        }
        if (event.type === "item") {
            applyStreamItem(target, event.data);
            return;
        }
        if (event.type === "approval.requested") {
            const approvalItem = approvalEventToLiveItem(event.data, "pending");
            upsertLiveItem(target, approvalItem);
            setPendingApprovalItems((current) => upsertPendingApprovalItem(current, approvalItem));
            setPendingApprovalSessionIds((current) => current.includes(event.data.sessionId) ? current : [...current, event.data.sessionId]);
            scheduleLoadSessions();
            if (isTargetVisible(target)) {
                setStatus("Approval requested");
            }
            return;
        }
        if (event.type === "approval.resolved") {
            upsertLiveItem(target, approvalEventToLiveItem(event.data, "resolved"));
            removePendingApprovalItem(event.data.approvalId);
            scheduleLoadSessions();
            if (isTargetVisible(target)) {
                setStatus(event.data.error ? "Approval cancelled" : `Approval ${approvalDecisionLabel(event.data.decision)}`);
            }
            return;
        }
        if (event.type === "auto_model.selected") {
            setMessages((current) => current.map((message) => message.role === "user" && message.turnId === (event.data.turnId ?? target.turnId)
                ? {
                    ...message,
                    model: event.data.model,
                    reasoningEffort: event.data.effort,
                    autoModel: true,
                    autoModelProvider: event.data.provider
                }
                : message));
            if (isTargetVisible(target)) {
                setSessionAutoModel(event.data);
                const fallback = event.data.provider === "fallback" ? ` (fallback: ${event.data.reason})` : "";
                setStatus(`Auto selected ${modelOptionLabel(event.data.model)} ${capitalize(event.data.effort)}${fallback}`);
            }
            return;
        }
        if (event.type === "auto_model.phase_transition") {
            if (isTargetVisible(target)) {
                setSessionAutoModel(event.data.to);
                setStatus(`Auto upgraded to ${modelOptionLabel(event.data.to.model)} ${capitalize(event.data.to.effort)}`);
            }
            return;
        }
        if (event.type === "developer_instructions") {
            applyDeveloperInstructionsToTurn(event.data.turnId ?? target.turnId, event.data);
            return;
        }
        if (event.type === "delta") {
            appendAssistantMessage(target, event.data.text, true);
            return;
        }
        if (event.type === "pending") {
            const wasVisible = isTargetVisible(target);
            target.sessionId = event.data.sessionId;
            finishStreamTarget(target, event.data.turnId ?? target.turnId);
            if (wasVisible || isTargetVisible(target)) {
                migrateLocalQueuedPrompts(event.data.sessionId);
                migrateLocalComposerDraft(event.data.sessionId);
                sessionIdRef.current = event.data.sessionId;
                setSessionId(event.data.sessionId);
            }
            if (event.data.turnId) {
                patchAssistantTurn(target, event.data.turnId, false, event.data.queued ? "todo" : "done");
            }
            if (wasVisible || isTargetVisible(target)) {
                threadIdRef.current = event.data.threadId ?? null;
                setThreadId(threadIdRef.current);
                setStatus(event.data.message);
                activeTurnIdRef.current = null;
                setActiveTurnId(null);
            }
            patchAssistantMessage(target, event.data.message, false, event.data.queued ? "todo" : "done", {
                clearTimeline: event.data.stopped === true
            });
            if (event.data.needsLogin || event.data.reason === "auth") {
                openAccountLoginDialog(event.data.account ?? activeAccount);
                void loadAccounts();
            }
            void loadSessions();
            return;
        }
        if (event.type === "result") {
            const wasVisible = isTargetVisible(target);
            target.sessionId = event.data.sessionId;
            finishStreamTarget(target, event.data.turnId ?? target.turnId);
            if (wasVisible || isTargetVisible(target)) {
                migrateLocalQueuedPrompts(event.data.sessionId);
                migrateLocalComposerDraft(event.data.sessionId);
                sessionIdRef.current = event.data.sessionId;
                setSessionId(event.data.sessionId);
            }
            if (event.data.turnId) {
                patchAssistantTurn(target, event.data.turnId, false, "done");
            }
            if (wasVisible || isTargetVisible(target)) {
                threadIdRef.current = event.data.threadId ?? null;
                setThreadId(threadIdRef.current);
                setStatus(`Done in ${(event.data.elapsedMs / 1000).toFixed(1)}s`);
                activeTurnIdRef.current = null;
                setActiveTurnId(null);
            }
            patchAssistantMessage(target, event.data.reply, false, "done", {
                conclusion: event.data.reply,
                executionDurationMs: event.data.elapsedMs,
                completedAt: new Date().toISOString(),
                preserveContent: true
            });
            void loadSessions();
            return;
        }
        if (event.type === "error") {
            if (target.completed) {
                finishStreamTarget(target);
                return;
            }
            patchAssistantMessage(target, `Codex error: ${event.data.message}`, false);
            finishStreamTarget(target);
            if (event.data.needsLogin || isAccountLoginRequiredMessage(event.data.message)) {
                openAccountLoginDialog(event.data.account ?? activeAccount);
                void loadAccounts();
            }
            if (isNoRolloutFoundMessage(event.data.message)) {
                setThreadId(null);
                setResumeThreadId("");
            }
            if (isTargetVisible(target)) {
                setStatus(event.data.needsLogin || isAccountLoginRequiredMessage(event.data.message) ? "Account needs login" : "Error");
            }
            return;
        }
        if (event.type === "done") {
            finishStreamTarget(target);
        }
    
}

export function finishStreamTarget(ctx, target, turnId = target.turnId) {
    const { activeTurnIdRef, finalizeTerminalAssistantMessage, isTargetVisible, markTurnFinished, setActiveTurnId, setMessages } = ctx;
        target.completed = true;
        markTurnFinished(turnId);
        if (turnId !== target.turnId) {
            markTurnFinished(target.turnId);
            target.turnId = turnId;
        }
        if (!isTargetVisible(target)) {
            return;
        }
        if (activeTurnIdRef.current === turnId || activeTurnIdRef.current === target.turnId) {
            activeTurnIdRef.current = null;
            setActiveTurnId(null);
        }
        setMessages((current) => current.map((message) => message.id === target.assistantMessageId || (message.role === "assistant" && message.turnId === turnId)
            ? finalizeTerminalAssistantMessage(message, { turnId, turnStatus: "done" })
            : message));
    
}

export function patchAssistantMessage(ctx, target, content, pending, turnStatus, options = {}) {
    const { isTargetVisible, setMessages } = ctx;
        if (!isTargetVisible(target)) {
            return;
        }
        setMessages((current) => current.map((message) => message.id === target.assistantMessageId || (message.role === "assistant" && message.turnId === target.turnId)
            ? {
                ...message,
                ...(options.preserveContent ? {} : { content }),
                pending,
                turnStatus: turnStatus ?? message.turnStatus,
                ...(options.conclusion !== undefined ? { conclusion: options.conclusion } : {}),
                ...(options.executionDurationMs !== undefined
                    ? { executionDurationMs: options.executionDurationMs }
                    : {}),
                ...(options.completedAt !== undefined ? { completedAt: options.completedAt } : {}),
                ...(options.clearTimeline ? { liveItems: [], segments: [] } : {})
            }
            : message));
    
}

export function appendAssistantMessage(ctx, target, content, pending, turnStatus, textSegmentId = "agent:delta") {
    const { appendTextSegment, isTargetVisible, setMessages } = ctx;
        if (!isTargetVisible(target) || !content) {
            return;
        }
        setMessages((current) => current.map((message) => message.id === target.assistantMessageId || (message.role === "assistant" && message.turnId === target.turnId)
            ? {
                ...message,
                content: `${message.content}${content}`,
                segments: appendTextSegment(message.segments ?? [], textSegmentId, content),
                pending,
                turnStatus: turnStatus ?? message.turnStatus
            }
            : message));
    
}

export function patchAssistantTurn(ctx, target, turnId, pending, turnStatus) {
    const { isTargetVisible, setMessages } = ctx;
        if (!isTargetVisible(target)) {
            return;
        }
        setMessages((current) => current.map((message) => message.id === target.assistantMessageId || (message.role === "assistant" && message.turnId === target.turnId)
            ? { ...message, turnId, pending, turnStatus, runnerStarted: true }
            : message));
    
}

export function applyDeveloperInstructionsToTurn(ctx, turnId, payload) {
    const { developerInstructionRecordFromPayload, developerInstructionsIndicateForcePlan, mergeDeveloperInstructionRecords, setMessages } = ctx;
        if (!turnId) {
            return;
        }
        const record = developerInstructionRecordFromPayload(payload);
        if (!record) {
            return;
        }
        setMessages((current) => current.map((message) => message.role === "user" && message.turnId === turnId
            ? {
                ...message,
                developerInstructions: mergeDeveloperInstructionRecords(message.developerInstructions, [record]),
                forcePlan: message.forcePlan === true || developerInstructionsIndicateForcePlan([record])
            }
            : message));
    
}

export function applyStreamItem(ctx, target, item) {
    const { appendAssistantMessage, describeStreamItem, isTargetVisible, liveItemKey, readAgentMessageAppendText, setStatus, threadIdRef, upsertLiveItem } = ctx;
        if (isTargetVisible(target)) {
            setStatus(describeStreamItem(item));
        }
        const itemKey = liveItemKey(item);
        const isChildOrigin = Boolean(item.originThreadId && item.originThreadId !== threadIdRef.current);
        if (item.itemType === "agent_message" && item.comment) {
            target.textByItemId[itemKey] = item.text ?? item.comment.detail;
            upsertLiveItem(target, item);
            return;
        }
        if (item.itemType === "agent_message") {
            if (isChildOrigin) {
                upsertLiveItem(target, item);
                return;
            }
            appendAssistantMessage(target, readAgentMessageAppendText(target, item), item.eventType !== "item.completed", undefined, `agent:${itemKey}`);
            return;
        }
        upsertLiveItem(target, item);
    
}

export function upsertLiveItem(ctx, target, item) {
    const { applyLiveItemToMessage, isTargetVisible, itemEventRank, liveItemKey, setMessages } = ctx;
        if (!isTargetVisible(target)) {
            return;
        }
        const incomingEventRank = itemEventRank(item.eventType);
        const itemKey = liveItemKey(item);
        const previousEventRank = target.liveItemEventRankById[itemKey] ?? 0;
        if (incomingEventRank < previousEventRank) {
            return;
        }
        target.liveItemEventRankById[itemKey] = incomingEventRank;
        setMessages((current) => current.map((message) => {
            if (message.id !== target.assistantMessageId && (message.role !== "assistant" || message.turnId !== target.turnId)) {
                return message;
            }
            return applyLiveItemToMessage(message, item);
        }));
    
}

export function removePendingApprovalItem(ctx, approvalId) {
    const { refreshApprovalState, setPendingApprovalItems } = ctx;
        setPendingApprovalItems((current) => current.filter((item) => item.approvalId !== approvalId));
        void refreshApprovalState();
    
}

export async function newSession(ctx, project = null, baseSessionId = null) {
    const { activeWorkspace, applyComposerDraftState, bumpViewKey, clearTodoPanelState, createSystemMessage, currentComposerDraft, eventStore, executionMode, explicitNewSessionRef, forcePlanNextPrompt, forkNextPrompt, input, isCurrentViewKey, isLikelyBackendDisconnect, navigationRequestIdRef, newSessionBaseSessionIdRef, newSessionProjectRef, newSessionRequestInFlightRef, noteBackendDisconnect, noteBackendRequestSucceeded, parentSessionTodo, prepareNewLocalModelPreferences, replaceComposerDraftForSession, sessionIdRef, sessionTodo, setActiveSessionId, setActiveTurnId, setComposerInput, setIsBootstrapped, setMessages, setNewSessionProjectId, setNewSessionProjectName, setParentSessionTodo, setPendingApprovalItems, setQueuedPrompts, setResumeThreadId, setSessionAutoModel, setSessionId, setSessionTodo, setStatus, setThreadId, updateNavigationUrl, viewKeyRef } = ctx;
        bumpViewKey();
        // A boot/popstate snapshot may still be in flight. Invalidate it so a
        // late response cannot restore the previous URL after this explicit
        // new-thread action has already cleared the composer.
        navigationRequestIdRef.current += 1;
        const viewKey = viewKeyRef.current;
        const previousExplicitNewSession = explicitNewSessionRef.current;
        const previousNewSessionProject = newSessionProjectRef.current;
        const previousNewSessionBaseSessionId = newSessionBaseSessionIdRef.current;
        explicitNewSessionRef.current = true;
        const newSessionProjectName = project?.name?.trim() || null;
        newSessionProjectRef.current = project?.id?.trim() && newSessionProjectName
            ? { id: project.id.trim(), name: newSessionProjectName }
            : null;
        newSessionBaseSessionIdRef.current = baseSessionId?.trim() || null;
        newSessionRequestInFlightRef.current = true;
        setStatus("Starting new session");
        const previousSessionId = sessionIdRef.current;
        const previousSessionTodo = sessionTodo;
        const previousParentSessionTodo = parentSessionTodo;
        const previousComposerDraft = currentComposerDraft(input, forcePlanNextPrompt, executionMode, forkNextPrompt);
        replaceComposerDraftForSession(null);
        clearTodoPanelState();
        try {
            const response = await fetch("/api/sessions/switch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({})
            });
            if (!response.ok) {
                throw new Error(`API returned ${response.status}`);
            }
            noteBackendRequestSucceeded();
            if (!isCurrentViewKey(viewKey)) {
                newSessionRequestInFlightRef.current = false;
                return;
            }
            eventStore.setSelectedSessionSnapshot(null);
            setActiveSessionId(null);
        }
        catch (error) {
            if (!isCurrentViewKey(viewKey)) {
                newSessionRequestInFlightRef.current = false;
                return;
            }
            sessionIdRef.current = previousSessionId;
            explicitNewSessionRef.current = previousExplicitNewSession;
            newSessionProjectRef.current = previousNewSessionProject;
            newSessionBaseSessionIdRef.current = previousNewSessionBaseSessionId;
            newSessionRequestInFlightRef.current = false;
            setSessionTodo(previousSessionTodo);
            setParentSessionTodo(previousParentSessionTodo);
            applyComposerDraftState(previousComposerDraft, previousSessionId);
            if (isLikelyBackendDisconnect(error)) {
                noteBackendDisconnect();
            }
            else {
                setStatus(error instanceof Error ? `New session failed: ${error.message}` : "New session failed");
            }
            return;
        }
        if (!isCurrentViewKey(viewKey)) {
            newSessionRequestInFlightRef.current = false;
            return;
        }
        setSessionId(null);
        sessionIdRef.current = null;
        clearTodoPanelState();
        prepareNewLocalModelPreferences();
        replaceComposerDraftForSession(null);
        setNewSessionProjectName(newSessionProjectName);
        setNewSessionProjectId(newSessionProjectRef.current?.id ?? null);
        setThreadId(null);
        setActiveTurnId(null);
        setPendingApprovalItems([]);
        setResumeThreadId("");
        setQueuedPrompts([]);
        setSessionAutoModel(null);
        setStatus("New session");
        setIsBootstrapped(true);
        setMessages([
            createSystemMessage(newSessionProjectName
                ? `New local session for ${newSessionProjectName}. The next message starts a fresh Codex thread.`
                : "New local session. The next message starts a fresh Codex thread.")
        ]);
        updateNavigationUrl({ workspaceId: activeWorkspace?.id ?? null, sessionId: null }, "push");
        newSessionRequestInFlightRef.current = false;
    
}

export function editQueuedPrompt(ctx, promptId) {
    const { focusComposer, input, queuedPromptEditRef, queuedPromptsRef, setComposerInput, setQueuedPrompts, setStatus } = ctx;
        const prompt = queuedPromptsRef.current.find((candidate) => candidate.id === promptId);
        if (!prompt) {
            return;
        }
        const originalIndex = queuedPromptsRef.current.findIndex((candidate) => candidate.id === promptId);
        const remainingPrompts = queuedPromptsRef.current.filter((candidate) => candidate.id !== promptId);
        queuedPromptEditRef.current = {
            prompt,
            originalIndex,
            remainingPrompts,
            displacedInput: input
        };
        queuedPromptsRef.current = remainingPrompts;
        setQueuedPrompts(remainingPrompts);
        setComposerInput(prompt.content);
        setStatus(prompt.kind === "steer" ? "Editing queued steer" : "Editing queued prompt");
        focusComposer();
    
}

export function insertEditedQueuedPrompt(current, edit, content) {
    const withoutEditedPrompt = current.filter((candidate) => candidate.id !== edit.prompt.id);
    const queueIsUnchanged = withoutEditedPrompt.length === edit.remainingPrompts.length &&
        withoutEditedPrompt.every((candidate, index) => candidate === edit.remainingPrompts[index]);
    const insertionIndex = queueIsUnchanged
        ? Math.min(edit.originalIndex, withoutEditedPrompt.length)
        : withoutEditedPrompt.length;
    const editedPrompt = { ...edit.prompt, content };
    return [
        ...withoutEditedPrompt.slice(0, insertionIndex),
        editedPrompt,
        ...withoutEditedPrompt.slice(insertionIndex)
    ];
}

export function commitQueuedPromptEdit(ctx, content) {
    const { focusComposer, queuedPromptEditRef, setComposerInput, setQueuedPrompts, setStatus } = ctx;
    const edit = queuedPromptEditRef.current;
    if (!edit) {
        return false;
    }
    // Clear the transient edit before restoring the displaced draft so the
    // restored value, rather than the queue text, is persisted for the composer.
    queuedPromptEditRef.current = null;
    setQueuedPrompts((current) => insertEditedQueuedPrompt(current, edit, content));
    setComposerInput(edit.displacedInput);
    setStatus("Queued prompt edited");
    focusComposer();
    return true;
}

export function focusInlinePromptEditorAtEnd(ctx, ) {
    const { inlinePromptEditorRef } = ctx;
        window.requestAnimationFrame(() => {
            const editor = inlinePromptEditorRef.current;
            if (!editor)
                return;
            editor.focus();
            editor.setSelectionRange(editor.value.length, editor.value.length);
        });
    
}

export function startInlineUserPromptEdit(ctx, message) {
    const { focusInlinePromptEditorAtEnd, setInlinePromptEditor, setStatus } = ctx;
        if (message.role !== "user") {
            return;
        }
        setInlinePromptEditor({
            messageId: message.id,
            value: message.content,
            attachments: [...(message.attachments ?? [])],
            forcePlan: message.forcePlan === true,
            executionMode: message.executionMode ?? "default"
        });
        setStatus("Editing prompt");
        focusInlinePromptEditorAtEnd();
    
}

export function cancelInlineUserPromptEdit(ctx, ) {
    const { setInlinePromptEditor, setStatus } = ctx;
        setInlinePromptEditor(null);
        setStatus("Prompt edit canceled");
    
}
