// @ts-nocheck
export async function restoreSelectedSessionForWorkspace(ctx, workspaceId) {
    const { sessionIdRef } = ctx;
        const selectedSessionId = sessionIdRef.current;
        if (!selectedSessionId) {
            return null;
        }
        const snapshotResponse = await fetch(`/api/sessions/${encodeURIComponent(selectedSessionId)}/snapshot`, {
            cache: "no-store"
        });
        if (!snapshotResponse.ok) {
            return null;
        }
        const snapshot = (await snapshotResponse.json());
        if (!snapshot.session || snapshot.session.workspaceId !== workspaceId) {
            return null;
        }
        const switchResponse = await fetch("/api/sessions/switch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: snapshot.session.id })
        });
        if (!switchResponse.ok) {
            return snapshot;
        }
        return (await switchResponse.json());
    
}

export async function loadWorkspaceSnapshot(ctx, options = {}) {
    const { activeTurnIdRef, activeWorkspaceIdRef, applyAccountPayload, applySelectedSessionSnapshot, approvalRecordToLiveItem, clearNewSessionProjectSelection, createSystemMessage, eventStore, isApprovalLiveItem, isLikelyBackendDisconnect, navigationRequestIdRef, noteBackendDisconnect, noteBackendRequestSucceeded, prepareNewLocalModelPreferences, replaceComposerDraftForSession, replaceNavigationUrl, replaceRunningTurns, restoreSelectedSessionForWorkspace, sessionIdRef, setActiveSessionId, setActiveTurnId, setActiveWorkspace, setIsBootstrapped, setMessages, setParentSessionTodo, setPendingApprovalItems, setPendingApprovalSessionIds, setSessionExecutionStatuses, setSessionId, setSessionTodo, setStatus, setThreadId, setWorkspaceList, toSessionPageState, updateNavigationUrl, viewKeyRef } = ctx;
        const requestId = ++navigationRequestIdRef.current;
        let navigationTarget = options.navigationTarget;
        const expectedViewKey = typeof options.viewKey === "number" ? options.viewKey : null;
        const previousWorkspaceId = activeWorkspaceIdRef.current;
        const preserveSelectedSession = options.preserveSelectedSession === true && !navigationTarget;
        const preservedWorkspaceId = preserveSelectedSession ? activeWorkspaceIdRef.current : null;
        const preservedSelectedSnapshot = preserveSelectedSession
            ? eventStore.getState().selectedSessionSnapshot
            : null;
        try {
            if (navigationTarget?.threadId || navigationTarget?.turnNumbers) {
                const params = new URLSearchParams({ target: navigationTarget.threadId || navigationTarget.sessionId });
                if (navigationTarget.workspaceId) params.set("workspaceId", navigationTarget.workspaceId);
                if (navigationTarget.turnNumbers) params.set("turnNumbers", navigationTarget.turnNumbers);
                const resolved = await fetch(`/api/sessions/resolve-reference?${params}`, { cache: "no-store" });
                if (!resolved.ok) throw new Error("Linked thread was not found.");
                const result = await resolved.json();
                navigationTarget = { ...navigationTarget, sessionId: result.session.id, workspaceId: result.session.workspaceId, threadId: null,
                    turnId: result.turns?.[0]?.turnId ?? navigationTarget.turnId };
            }
            let response = await fetch("/api/workspace/snapshot", { cache: "no-store" });
            if (!response.ok)
                throw new Error(`API returned ${response.status}`);
            noteBackendRequestSucceeded();
            let payload = (await response.json());
            if (navigationTarget?.workspaceId && navigationTarget.workspaceId !== payload.activeWorkspace.id) {
                const switchResponse = await fetch("/api/workspaces/switch", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ workspaceId: navigationTarget.workspaceId })
                });
                if (!switchResponse.ok) {
                    throw new Error(`Workspace API returned ${switchResponse.status}`);
                }
                noteBackendRequestSucceeded();
                response = await fetch("/api/workspace/snapshot", { cache: "no-store" });
                if (!response.ok)
                    throw new Error(`API returned ${response.status}`);
                payload = (await response.json());
            }
            if (preserveSelectedSession &&
                preservedWorkspaceId &&
                (activeWorkspaceIdRef.current !== preservedWorkspaceId || payload.activeWorkspace?.id !== preservedWorkspaceId)) {
                return;
            }
            if (requestId !== navigationRequestIdRef.current) {
                return;
            }
            if (expectedViewKey !== null && viewKeyRef.current !== expectedViewKey) {
                return;
            }
            const nextWorkspaceId = payload.activeWorkspace?.id ?? null;
            if (previousWorkspaceId && nextWorkspaceId && previousWorkspaceId !== nextWorkspaceId) {
                clearNewSessionProjectSelection();
            }
            const sessionPage = toSessionPageState(payload.sessions ?? [], payload.sessionPage);
            eventStore.setWorkspaceSnapshot(payload, sessionPage, preserveSelectedSession ? preservedSelectedSnapshot : payload.activeSession, payload.eventCursor);
            setWorkspaceList(Array.isArray(payload.workspaces) ? payload.workspaces : []);
            setActiveWorkspace(payload.activeWorkspace ?? null);
            setSessionExecutionStatuses(payload.sessionExecutionStatuses ?? {});
            setPendingApprovalSessionIds(payload.pendingApprovalSessionIds ?? []);
            if (!preserveSelectedSession) {
                setActiveSessionId(payload.activeSessionId ?? null);
            }
            applyAccountPayload(payload);
            setPendingApprovalItems((payload.approvals ?? []).map(approvalRecordToLiveItem).filter(isApprovalLiveItem));
            let selectedSnapshot = null;
            if (preserveSelectedSession) {
                selectedSnapshot = preservedSelectedSnapshot;
            }
            else if (navigationTarget) {
                if (navigationTarget.sessionId &&
                    payload.activeSessionId === navigationTarget.sessionId &&
                    payload.activeSession?.session?.id === navigationTarget.sessionId &&
                    payload.activeSession.session.workspaceId === payload.activeWorkspace.id) {
                    // The workspace response already contains the selected transcript.
                    // Avoid reading it again and switching to the already-active session.
                    selectedSnapshot = payload.activeSession;
                }
                else if (navigationTarget.sessionId) {
                    const snapshotResponse = await fetch(`/api/sessions/${encodeURIComponent(navigationTarget.sessionId)}/snapshot`, { cache: "no-store" });
                    if (snapshotResponse.ok) {
                        const snapshot = (await snapshotResponse.json());
                        if (snapshot.session?.workspaceId === payload.activeWorkspace.id) {
                            const switchResponse = await fetch("/api/sessions/switch", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ sessionId: snapshot.session.id })
                            });
                            if (switchResponse.ok) {
                                selectedSnapshot = (await switchResponse.json());
                            }
                            else {
                                selectedSnapshot = snapshot;
                            }
                        }
                    }
                    if (!selectedSnapshot && payload.activeSessionId) {
                        const clearResponse = await fetch("/api/sessions/switch", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: "{}"
                        });
                        if (!clearResponse.ok) {
                            throw new Error(`Session API returned ${clearResponse.status}`);
                        }
                    }
                }
                else if (payload.activeSessionId) {
                    // A sessionless history entry can outlive the blank composer
                    // that created it. Keep the backend's active session instead
                    // of turning the next submitted message into a new root task.
                    selectedSnapshot = payload.activeSession?.session
                        ? payload.activeSession
                        : await restoreSelectedSessionForWorkspace(payload.activeWorkspace.id);
                }
            }
            else {
                selectedSnapshot = payload.activeSession?.session
                    ? payload.activeSession
                    : await restoreSelectedSessionForWorkspace(payload.activeWorkspace.id);
            }
            // A late response from an older popstate must not overwrite the newer
            // location the user is currently viewing.
            if (requestId !== navigationRequestIdRef.current)
                return;
            if (expectedViewKey !== null && viewKeyRef.current !== expectedViewKey)
                return;
            if (preserveSelectedSession) {
                setIsBootstrapped(true);
                return;
            }
            if (selectedSnapshot?.session) {
                applySelectedSessionSnapshot(selectedSnapshot);
                if (navigationTarget && !navigationTarget.sessionId) {
                    updateNavigationUrl({
                        workspaceId: payload.activeWorkspace.id,
                        sessionId: selectedSnapshot.session.id
                    }, "replace");
                }
            }
            else {
                eventStore.setSelectedSessionSnapshot(null);
                sessionIdRef.current = null;
                setSessionId(null);
                prepareNewLocalModelPreferences(payload.activeWorkspace?.id ?? null, payload.modelPreferences);
                replaceComposerDraftForSession(null);
                setThreadId(null);
                setSessionTodo(null);
                setParentSessionTodo(null);
                activeTurnIdRef.current = null;
                setActiveTurnId(null);
                replaceRunningTurns([]);
                if (navigationTarget) {
                    setMessages([createSystemMessage("New local session. The next message starts a fresh Codex thread.")]);
                }
            }
            setIsBootstrapped(true);
            if (options.canonicalizeUrl) {
                replaceNavigationUrl({
                    workspaceId: payload.activeWorkspace.id,
                    sessionId: selectedSnapshot?.session?.id ?? null,
                    turnId: navigationTarget?.turnId ?? null,
                    turnNumbers: navigationTarget?.turnNumbers ?? null
                });
            }
        }
        catch (error) {
            if (isLikelyBackendDisconnect(error))
                noteBackendDisconnect();
            else
                setStatus(error instanceof Error ? `Workspace snapshot failed: ${error.message}` : "Workspace snapshot failed");
        }
    
}

export function applySelectedSessionSnapshot(ctx, payload) {
    const { activeTurnIdRef, applyModelPreferencesState, composerDraftSessionIdRef, composerInputEditRevisionRef, displaySessionTitle, eventStore, explicitNewSessionRef, modelPreferencesHydratedRef, modelPreferencesWorkspaceIdRef, moveStoredComposerDraft, persistedModelPreferencesWorkspaceIdRef, queueModelPreferencesSave, readPendingModelPreferences, replaceComposerDraftForSession, sessionIdRef, sessionTurnsToMessages, setActiveSessionId, setActiveTurnId, setMessages, setResumeThreadId, setRunningTurnIds, setSessionAutoModel, setSessionId, setSessionTodo, setThreadId } = ctx;
        const selectedSession = payload.session;
        if (!selectedSession)
            return;
        eventStore.setSelectedSessionSnapshot(payload);
        const turns = payload.turns ?? [];
        const runningTurns = turns.filter((turn) => turn.status === "running");
        const runningTurn = runningTurns.at(-1) ?? null;
        sessionIdRef.current = selectedSession.id;
        explicitNewSessionRef.current = false;
        setSessionId(selectedSession.id);
        const workspaceId = selectedSession.workspaceId;
        const shouldHydrateModelPreferences = !modelPreferencesHydratedRef.current ||
            modelPreferencesWorkspaceIdRef.current !== workspaceId;
        const modelPreferencesWerePersisted = persistedModelPreferencesWorkspaceIdRef.current === workspaceId;
        persistedModelPreferencesWorkspaceIdRef.current = workspaceId;
        // Reconciliation snapshots can predate a queued workspace preference
        // write. Once the workspace is hydrated, keep its live composer state
        // instead of letting a stale response roll a gear edit back.
        if (shouldHydrateModelPreferences) {
            applyModelPreferencesState(payload.modelPreferences, workspaceId);
        }
        const pendingModelPreferences = readPendingModelPreferences(workspaceId);
        if ((!modelPreferencesWerePersisted || shouldHydrateModelPreferences) && pendingModelPreferences) {
            queueModelPreferencesSave(workspaceId, pendingModelPreferences);
        }
        // Snapshot refreshes for the already-visible session must not reload an
        // older draft over composer changes the user just made (including Todo
        // plan mode). Only hydrate a draft when the selected session changes.
        if (composerDraftSessionIdRef.current !== selectedSession.id) {
            if (composerDraftSessionIdRef.current === null && composerInputEditRevisionRef.current > 0) {
                moveStoredComposerDraft(null, selectedSession.id);
                composerDraftSessionIdRef.current = selectedSession.id;
                composerInputEditRevisionRef.current = 0;
            }
            else {
                replaceComposerDraftForSession(selectedSession.id);
            }
        }
        setThreadId(selectedSession.threadId);
        activeTurnIdRef.current = runningTurn?.id ?? null;
        setActiveTurnId(runningTurn?.id ?? null);
        setRunningTurnIds((current) => {
            const next = new Set(current);
            for (const turn of turns)
                next.delete(turn.id);
            for (const turn of runningTurns)
                next.add(turn.id);
            return next;
        });
        setResumeThreadId(selectedSession.threadId ?? "");
        setActiveSessionId(selectedSession.id);
        setSessionAutoModel(payload.autoModel ?? null);
        setSessionTodo(payload.todo?.sessionId === selectedSession.id ? payload.todo : null);
        setMessages((current) => sessionTurnsToMessages(turns, displaySessionTitle(selectedSession.title), current, selectedSession.threadId));
    
}

export function clearTodoPanelState(ctx, ) {
    const { setParentSessionTodo, setSessionTodo } = ctx;
        setSessionTodo(null);
        setParentSessionTodo(null);
    
}

export function applyTodoSnapshotForSession(ctx, targetSessionId, todo) {
    const { sessionIdRef, setSessionTodo } = ctx;
        if (sessionIdRef.current === targetSessionId && todo?.sessionId === targetSessionId) {
            setSessionTodo(todo);
        }
    
}

export async function handleDurableEvent(ctx, event) {
    const { activeTurnIdRef, applyDeveloperInstructionsToTurn, approvalEventToLiveItem, eventStore, finalizeTerminalAssistantMessage, loadWorkspaceSnapshot, markTurnFinished, readRecord, readStringField, reconnectRunner, reconnectingTurnIdsRef, refreshSelectedSessionSnapshot, removePendingApprovalItem, scheduleLoadSessions, sessionIdRef, setActiveTurnId, setMessages, setPendingApprovalItems, setPendingApprovalSessionIds, setSessionExecutionStatuses, setSessionTodo, streamTargetsRef, upsertPendingApprovalItem, viewKeyRef } = ctx;
        if (event.type === "workspace.created" || event.type === "workspace.switched") {
            await loadWorkspaceSnapshot({ preserveSelectedSession: true });
            return;
        }
        if (event.type === "runner.approval.requested") {
            const approval = event.payload;
            if (approval?.approvalId && approval.sessionId) {
                const item = approvalEventToLiveItem(approval, "pending");
                setPendingApprovalItems((current) => upsertPendingApprovalItem(current, item));
                setPendingApprovalSessionIds((current) => current.includes(approval.sessionId) ? current : [...current, approval.sessionId]);
            }
            return;
        }
        if (event.type === "runner.approval.resolved") {
            const approval = event.payload;
            if (approval?.approvalId)
                removePendingApprovalItem(approval.approvalId);
            return;
        }
        if (!event.sessionId)
            return;
        if (event.type === "session.title.updated") {
            const title = readStringField(readRecord(event.payload), "title");
            const selectedSnapshot = eventStore.getState().selectedSessionSnapshot;
            if (title && selectedSnapshot?.session?.id === event.sessionId) {
                eventStore.setSelectedSessionSnapshot({
                    ...selectedSnapshot,
                    session: { ...selectedSnapshot.session, title }
                });
            }
            scheduleLoadSessions(0);
            return;
        }
        if (event.type === "session.imported" || event.type === "session.task.created") {
            scheduleLoadSessions(0);
            return;
        }
        if (event.type === "todo.changed") {
            if (sessionIdRef.current === event.sessionId && event.payload?.sessionId === event.sessionId) {
                setSessionTodo(event.payload);
                const selectedSnapshot = eventStore.getState().selectedSessionSnapshot;
                if (selectedSnapshot?.session?.id === event.sessionId) {
                    eventStore.setSelectedSessionSnapshot({ ...selectedSnapshot, todo: event.payload });
                }
            }
            return;
        }
        if (event.type === "runner.runner.callback_error") {
            const callbackEvent = readStringField(readRecord(event.payload), "event");
            if (callbackEvent === "result" ||
                callbackEvent === "done" ||
                callbackEvent === "error" ||
                callbackEvent === "pending") {
                await refreshSelectedSessionSnapshot(event.sessionId, event.turnId);
            }
            return;
        }
        if (event.type === "runner.session" || event.type === "runner.runner.started") {
            setSessionExecutionStatuses((current) => current[event.sessionId] === "running"
                ? current
                : { ...current, [event.sessionId]: "running" });
            scheduleLoadSessions();
            if (event.type === "runner.runner.started" &&
                event.turnId &&
                sessionIdRef.current === event.sessionId &&
                !streamTargetsRef.current[event.turnId] &&
                !reconnectingTurnIdsRef.current.has(event.turnId)) {
                await refreshSelectedSessionSnapshot(event.sessionId, event.turnId);
                if (sessionIdRef.current === event.sessionId &&
                    !streamTargetsRef.current[event.turnId] &&
                    !reconnectingTurnIdsRef.current.has(event.turnId)) {
                    void reconnectRunner(event.turnId, `${event.turnId}:assistant`, event.sessionId, viewKeyRef.current);
                }
            }
            return;
        }
        if (event.type === "runner.developer_instructions") {
            applyDeveloperInstructionsToTurn(event.turnId, event.payload);
            return;
        }
        const terminal = isTerminalRunnerDurableEvent(event);
        if (!terminal)
            return;
        setSessionExecutionStatuses((current) => {
            if (!(event.sessionId in current)) {
                return current;
            }
            const next = { ...current };
            delete next[event.sessionId];
            return next;
        });
        if (event.turnId) {
            const turnStatus = event.type === "runner.pending" ? "todo" : "done";
            const target = streamTargetsRef.current[event.turnId];
            if (target && event.type !== "runner.codex")
                target.completed = true;
            markTurnFinished(event.turnId);
            if (sessionIdRef.current === event.sessionId) {
                activeTurnIdRef.current = null;
                setActiveTurnId(null);
                setMessages((current) => current.map((message) => message.role === "assistant" && message.turnId === event.turnId
                    ? finalizeTerminalAssistantMessage(message, { turnStatus })
                    : message));
            }
        }
        scheduleLoadSessions();
        await refreshSelectedSessionSnapshot(event.sessionId, event.turnId);
    
}

export function isTerminalRunnerDurableEvent(event) {
    // Codex turn/completed ends one app-server attempt, not necessarily the
    // Threadex turn. A usage-limit attempt can immediately continue on
    // another account, and app-server can still hold the thread writer until
    // promptRunner publishes one of the manager-level terminal events below.
    return event.type === "runner.result" ||
        event.type === "runner.pending" ||
        event.type === "runner.error" ||
        event.type === "runner.done";
}

export async function loadWorkspaces(ctx, ) {
    const { isLikelyBackendDisconnect, noteBackendDisconnect, noteBackendRequestSucceeded, setActiveWorkspace, setStatus, setWorkspaceList } = ctx;
        try {
            const response = await fetch("/api/workspaces");
            if (!response.ok) {
                throw new Error(`API returned ${response.status}`);
            }
            noteBackendRequestSucceeded();
            const payload = (await response.json());
            setWorkspaceList(Array.isArray(payload.workspaces) ? payload.workspaces : []);
            setActiveWorkspace(payload.activeWorkspace ?? null);
        }
        catch (error) {
            if (isLikelyBackendDisconnect(error)) {
                noteBackendDisconnect();
            }
            else {
                setStatus(error instanceof Error ? `Workspace list failed: ${error.message}` : "Workspace list failed");
            }
        }
    
}

export async function loadAccounts(ctx, ) {
    const { applyAccountPayload, isLikelyBackendDisconnect, noteBackendDisconnect, noteBackendRequestSucceeded, setStatus } = ctx;
        try {
            const response = await fetch("/api/accounts");
            if (!response.ok) {
                throw new Error(`API returned ${response.status}`);
            }
            noteBackendRequestSucceeded();
            const payload = (await response.json());
            applyAccountPayload(payload);
        }
        catch (error) {
            if (isLikelyBackendDisconnect(error)) {
                noteBackendDisconnect();
            }
            else {
                setStatus(error instanceof Error ? `Account list failed: ${error.message}` : "Account list failed");
            }
        }
    
}

export async function refreshApprovalState(ctx, ) {
    const { approvalRecordToLiveItem, isApprovalLiveItem, isLikelyBackendDisconnect, noteBackendDisconnect, readRecord, setPendingApprovalItems, setPendingApprovalSessionIds } = ctx;
        try {
            const response = await fetch("/api/approvals", { cache: "no-store" });
            if (!response.ok)
                throw new Error(`API returned ${response.status}`);
            const payload = (await response.json());
            const approvals = payload.approvals ?? [];
            setPendingApprovalItems(approvals.map(approvalRecordToLiveItem).filter(isApprovalLiveItem));
            setPendingApprovalSessionIds([
                ...new Set(approvals.flatMap((approval) => {
                    const record = readRecord(approval);
                    return typeof record?.sessionId === "string" ? [record.sessionId] : [];
                }))
            ]);
        }
        catch (error) {
            if (isLikelyBackendDisconnect(error))
                noteBackendDisconnect();
        }
    
}

export async function restartProcessMonitor(ctx, monitor, parameterValues) {
    const { eventStore, readApiError, setProcessMonitorAction, setStatus } = ctx;
        setProcessMonitorAction(`restart:${monitor.id}`);
        try {
            const response = await fetch(`/api/process-monitors/${encodeURIComponent(monitor.id)}/${monitor.status === "available" ? "run" : "restart"}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ parameterValues })
            });
            if (!response.ok)
                throw new Error(await readApiError(response));
            setStatus(`${monitor.status === "available" ? "Started" : "Restarted"} ${monitor.label}`);
            await eventStore.poll();
            return true;
        }
        catch (error) {
            setStatus(error instanceof Error ? `Restart failed: ${error.message}` : "Restart failed");
            if (ctx.rethrowErrors) throw error;
            return false;
        }
        finally {
            setProcessMonitorAction(null);
        }
    
}

export async function openProcessMonitorLog(ctx, monitor) {
    const { readApiError, setHoveredProcessMonitor, setProcessMonitorLog } = ctx;
        setHoveredProcessMonitor(null);
        setProcessMonitorLog({
            monitorId: monitor.id,
            label: monitor.label,
            status: "loading",
            content: "",
            size: 0,
            truncated: false,
            updatedAt: null,
            error: null
        });
        try {
            const response = await fetch(`/api/process-monitors/${encodeURIComponent(monitor.id)}/logs`, { cache: "no-store" });
            if (!response.ok)
                throw new Error(await readApiError(response));
            const payload = (await response.json());
            const log = payload.log;
            if (!log || typeof log.content !== "string")
                throw new Error("API returned an invalid log response.");
            const content = log.content;
            setProcessMonitorLog((current) => current?.monitorId === monitor.id ? {
                ...current,
                status: "ready",
                content,
                size: typeof log.size === "number" ? log.size : 0,
                truncated: log.truncated === true,
                updatedAt: typeof log.updatedAt === "string" ? log.updatedAt : null,
                error: null
            } : current);
        }
        catch (error) {
            setProcessMonitorLog((current) => current?.monitorId === monitor.id ? {
                ...current,
                status: "error",
                error: error instanceof Error ? error.message : "Failed to load process log."
            } : current);
        }
    
}

export async function removeProcessMonitor(ctx, monitor) {
    const { eventStore, readApiError, setProcessMonitorAction, setStatus } = ctx;
        if (!window.confirm(`Remove monitor "${monitor.label}"?${monitor.pid ? " The process will be stopped." : ""}`)) {
            return;
        }
        setProcessMonitorAction(`remove:${monitor.id}`);
        try {
            const response = await fetch(`/api/process-monitors/${encodeURIComponent(monitor.id)}`, { method: "DELETE" });
            if (!response.ok)
                throw new Error(await readApiError(response));
            setStatus(`Removed ${monitor.label}`);
            await eventStore.poll();
        }
        catch (error) {
            setStatus(error instanceof Error ? `Remove failed: ${error.message}` : "Remove failed");
        }
        finally {
            setProcessMonitorAction(null);
        }
    
}

export async function switchWorkspace(ctx, workspaceId, options = {}) {
    const { activeWorkspace, applyAccountPayload, bumpViewKey, clearNewSessionProjectSelection, clearTodoPanelState, createSystemMessage, eventStore, explicitNewSessionRef, isCurrentViewKey, loadWorkspaceSnapshot, parentSessionTodo, replaceComposerDraftForSession, sessionIdRef, sessionTodo, setActiveSessionId, setActiveTurnId, setActiveWorkspace, setMessages, setParentSessionTodo, setQueuedPrompts, setResumeThreadId, setSessionExecutionStatuses, setSessionId, setSessionTodo, setStatus, setThreadId, setWorkspaceList, toSessionPageState, updateNavigationUrl, viewKeyRef, workspaceList } = ctx;
        if (!workspaceId || workspaceId === activeWorkspace?.id) {
            return true;
        }
        bumpViewKey();
        const viewKey = viewKeyRef.current;
        setStatus("Switching workspace");
        const previousSessionTodo = sessionTodo;
        const previousParentSessionTodo = parentSessionTodo;
        clearTodoPanelState();
        try {
            const response = await fetch("/api/workspaces/switch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ workspaceId })
            });
            if (!response.ok) {
                throw new Error(`API returned ${response.status}`);
            }
            const payload = (await response.json());
            if (!isCurrentViewKey(viewKey)) {
                return false;
            }
            setWorkspaceList(Array.isArray(payload.workspaces) ? payload.workspaces : workspaceList);
            const switchedWorkspace = payload.activeWorkspace ?? payload.workspace ?? null;
            clearNewSessionProjectSelection();
            setActiveWorkspace(switchedWorkspace);
            eventStore.setSessionPage(toSessionPageState([], undefined));
            eventStore.setSelectedSessionSnapshot(null);
            setSessionExecutionStatuses({});
            setActiveSessionId(null);
            sessionIdRef.current = null;
            explicitNewSessionRef.current = true;
            setSessionId(null);
            clearTodoPanelState();
            replaceComposerDraftForSession(null);
            setThreadId(null);
            setActiveTurnId(null);
            setResumeThreadId("");
            setQueuedPrompts([]);
            if ("activeAccount" in payload) {
                applyAccountPayload(payload);
            }
            setMessages([createSystemMessage(`Switched workspace. The next message starts a fresh Codex thread.`)]);
            await loadWorkspaceSnapshot({ viewKey });
            if (!isCurrentViewKey(viewKey)) {
                return false;
            }
            if (options.history !== "none") {
                updateNavigationUrl({
                    workspaceId: switchedWorkspace?.id ?? workspaceId,
                    sessionId: eventStore.getState().selectedSessionSnapshot?.session?.id ?? null
                }, options.history === "replace" ? "replace" : "push");
            }
            setStatus("Workspace switched");
            return true;
        }
        catch (error) {
            if (!isCurrentViewKey(viewKey)) {
                return false;
            }
            setSessionTodo(previousSessionTodo);
            setParentSessionTodo(previousParentSessionTodo);
            setStatus(error instanceof Error ? `Workspace switch failed: ${error.message}` : "Workspace switch failed");
            return false;
        }
    
}

export async function createWorkspace(ctx, ) {
    const { activeWorkspace, applyAccountPayload, bumpViewKey, clearNewSessionProjectSelection, clearTodoPanelState, createSystemMessage, eventStore, explicitNewSessionRef, isCurrentViewKey, loadWorkspaceSnapshot, parentSessionTodo, replaceComposerDraftForSession, sessionIdRef, sessionTodo, setActiveSessionId, setActiveTurnId, setActiveWorkspace, setMessages, setParentSessionTodo, setQueuedPrompts, setResumeThreadId, setSessionExecutionStatuses, setSessionId, setSessionTodo, setStatus, setThreadId, setWorkspaceList, slugify, toSessionPageState, updateNavigationUrl, viewKeyRef } = ctx;
        const name = window.prompt("Workspace name");
        if (!name?.trim()) {
            return;
        }
        const codexHome = window.prompt("CODEX_HOME path", `~/\.codex-${slugify(name)}`) ?? "";
        const cwd = window.prompt("Working directory", activeWorkspace?.cwd || "") ?? "";
        bumpViewKey();
        const viewKey = viewKeyRef.current;
        setStatus("Creating workspace");
        const previousSessionTodo = sessionTodo;
        const previousParentSessionTodo = parentSessionTodo;
        clearTodoPanelState();
        try {
            const response = await fetch("/api/workspaces/create", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: name.trim(),
                    codexHome: codexHome.trim() || undefined,
                    cwd: cwd.trim() || undefined
                })
            });
            if (!response.ok) {
                throw new Error(`API returned ${response.status}`);
            }
            const payload = (await response.json());
            if (!isCurrentViewKey(viewKey)) {
                return;
            }
            const workspace = payload.workspace ?? payload.activeWorkspace;
            setWorkspaceList(Array.isArray(payload.workspaces) ? payload.workspaces : []);
            clearNewSessionProjectSelection();
            setActiveWorkspace(workspace);
            eventStore.setSessionPage(toSessionPageState([], undefined));
            eventStore.setSelectedSessionSnapshot(null);
            setSessionExecutionStatuses({});
            applyAccountPayload(payload);
            setActiveSessionId(null);
            sessionIdRef.current = null;
            explicitNewSessionRef.current = true;
            setSessionId(null);
            clearTodoPanelState();
            replaceComposerDraftForSession(null);
            setThreadId(null);
            setActiveTurnId(null);
            setResumeThreadId("");
            setQueuedPrompts([]);
            setMessages([createSystemMessage(`Workspace "${workspace.name}" is ready.`)]);
            await loadWorkspaceSnapshot({ viewKey });
            if (!isCurrentViewKey(viewKey)) {
                return;
            }
            updateNavigationUrl({ workspaceId: workspace.id, sessionId: null }, "push");
            setStatus("Workspace created");
        }
        catch (error) {
            if (!isCurrentViewKey(viewKey)) {
                return;
            }
            setSessionTodo(previousSessionTodo);
            setParentSessionTodo(previousParentSessionTodo);
            setStatus(error instanceof Error ? `Workspace create failed: ${error.message}` : "Workspace create failed");
        }
    
}
