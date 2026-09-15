// @ts-nocheck
export async function switchAccount(ctx, accountId) {
    const { accountIdentityLabel, accountList, accountNeedsLogin, activeWorkspace, applyAccountPayload, beginAccountRelogin, sessionId, setIsAccountPopoverOpen, setStatus, setUseLoadBalanceInWorkspace } = ctx;
        setIsAccountPopoverOpen(false);
        if (accountId === "__load_balance__") {
            setUseLoadBalanceInWorkspace(true);
            setStatus("Enabling load balance in workspace");
            try {
                const response = await fetch("/api/accounts/auto-load-balance", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ workspaceId: activeWorkspace?.id, enabled: true })
                });
                if (!response.ok) {
                    throw new Error(`API returned ${response.status}`);
                }
                const payload = (await response.json());
                applyAccountPayload(payload);
                setStatus(payload.activeAccount ? `Load balance: ${accountIdentityLabel(payload.activeAccount)}` : "Load balance in workspace");
            }
            catch (error) {
                setUseLoadBalanceInWorkspace(false);
                setStatus(error instanceof Error ? `Load balance failed: ${error.message}` : "Load balance failed");
            }
            return;
        }
        const selectedAccount = accountList.find((account) => account.id === accountId) ?? null;
        if (selectedAccount && accountNeedsLogin(selectedAccount)) {
            beginAccountRelogin(selectedAccount);
            return;
        }
        setUseLoadBalanceInWorkspace(false);
        setStatus("Switching account");
        try {
            const response = await fetch("/api/accounts/switch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ accountId: accountId || null, sessionId: sessionId || null })
            });
            if (!response.ok) {
                throw new Error(`API returned ${response.status}`);
            }
            const payload = (await response.json());
            applyAccountPayload(payload);
            setStatus(sessionId ? "Account switched; session context preserved" : "Account switched");
        }
        catch (error) {
            setStatus(error instanceof Error ? `Account switch failed: ${error.message}` : "Account switch failed");
        }
    
}

export async function resetAccountRateLimit(ctx, account) {
    const { accountIdentityLabel, accountResetCredits, applyAccountPayload, earliestExpiringResetCredit, resetOutcomeLabel, resettingAccountId, setResettingAccountId, setStatus, showToast } = ctx;
        const resetCredits = accountResetCredits(account);
        if (resetCredits.availableCount <= 0 || resettingAccountId) {
            return;
        }
        if (!window.confirm(`Use one reset for ${accountIdentityLabel(account)}?`)) {
            return;
        }
        const credit = earliestExpiringResetCredit(resetCredits.credits);
        setResettingAccountId(account.id);
        setStatus(`Resetting ${accountIdentityLabel(account)}`);
        try {
            const response = await fetch("/api/accounts/reset-rate-limit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    accountId: account.id,
                    creditId: credit?.id,
                    idempotencyKey: crypto.randomUUID()
                })
            });
            const payload = (await response.json().catch(() => null));
            if (!response.ok) {
                throw new Error(payload?.error || `API returned ${response.status}`);
            }
            if (payload)
                applyAccountPayload(payload);
            const outcomeLabel = resetOutcomeLabel(payload?.outcome);
            setStatus(outcomeLabel);
            showToast(outcomeLabel);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Reset failed";
            setStatus(`Reset failed: ${message}`);
            showToast(`Reset failed: ${message}`);
        }
        finally {
            setResettingAccountId(null);
        }
    
}

export async function importCurrentAccount(ctx, ) {
    const { accountList, accountLoginTargetId, activeAccount, applyAccountPayload, setStatus } = ctx;
        const targetAccount = accountLoginTargetId
            ? accountList.find((account) => account.id === accountLoginTargetId) ?? null
            : activeAccount;
        const name = window.prompt("Account name", targetAccount?.name || "");
        if (!name?.trim()) {
            return;
        }
        setStatus("Importing account");
        try {
            const response = await fetch("/api/accounts/import-current", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    accountId: targetAccount?.id,
                    name: name.trim()
                })
            });
            if (!response.ok) {
                const payload = (await response.json().catch(() => null));
                throw new Error(payload?.error || `API returned ${response.status}`);
            }
            const payload = (await response.json());
            applyAccountPayload({ ...payload, activeAccount: payload.activeAccount ?? payload.account ?? null });
            setStatus("Account imported");
        }
        catch (error) {
            setStatus(error instanceof Error ? `Account import failed: ${error.message}` : "Account import failed");
        }
    
}

export async function createApiAccount(ctx, event) {
    const { accountLoginTargetId, apiAccountKey, apiAccountUrl, applyAccountPayload, isSavingAccount, newAccountName, resetAccountLoginDialog, setIsSavingAccount, setStatus } = ctx;
        event.preventDefault();
        if (!newAccountName.trim() || !apiAccountKey.trim() || isSavingAccount) {
            return;
        }
        setIsSavingAccount(true);
        setStatus("Creating API account");
        try {
            const response = await fetch("/api/accounts/create-api", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    accountId: accountLoginTargetId ?? undefined,
                    name: newAccountName.trim(),
                    apiUrl: apiAccountUrl.trim() || undefined,
                    apiKey: apiAccountKey.trim()
                })
            });
            if (!response.ok) {
                const payload = (await response.json().catch(() => null));
                throw new Error(payload?.error || `API returned ${response.status}`);
            }
            const payload = (await response.json());
            applyAccountPayload({ ...payload, activeAccount: payload.activeAccount ?? payload.account ?? null });
            resetAccountLoginDialog();
            setStatus("API account created");
        }
        catch (error) {
            setStatus(error instanceof Error ? `API account failed: ${error.message}` : "API account failed");
        }
        finally {
            setIsSavingAccount(false);
        }
    
}

export async function startChatGptLogin(ctx, target) {
    const { accountLoginTargetId, cleanLoginUrlValue, isSavingAccount, newAccountName, pollChatGptLoginStatus, sessionId, setIsSavingAccount, setPendingAccountLogin, setStatus } = ctx;
        const targetName = (target?.name ?? newAccountName).trim();
        const targetAccountId = target?.accountId ?? accountLoginTargetId;
        if (!targetName || isSavingAccount) {
            return;
        }
        const popup = window.open("about:blank", "_blank");
        setIsSavingAccount(true);
        setStatus("Starting ChatGPT login");
        try {
            const response = await fetch("/api/accounts/login/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ accountId: targetAccountId ?? undefined, name: targetName, sessionId: sessionId || null })
            });
            if (!response.ok) {
                const payload = (await response.json().catch(() => null));
                throw new Error(payload?.error || `API returned ${response.status}`);
            }
            const payload = (await response.json());
            const cleanLoginUrl = cleanLoginUrlValue(payload.loginUrl);
            const nextLogin = { ...payload, loginUrl: cleanLoginUrl };
            setPendingAccountLogin(nextLogin);
            if (cleanLoginUrl && cleanLoginUrl !== "about:blank") {
                if (popup && !popup.closed) {
                    popup.location.href = cleanLoginUrl;
                }
                else {
                    window.open(cleanLoginUrl, "_blank", "noopener,noreferrer");
                }
            }
            void pollChatGptLoginStatus(nextLogin.loginId);
            setStatus("ChatGPT login opened");
        }
        catch (error) {
            popup?.close();
            setStatus(error instanceof Error ? `ChatGPT login failed: ${error.message}` : "ChatGPT login failed");
        }
        finally {
            setIsSavingAccount(false);
        }
    
}

export async function pollChatGptLoginStatus(ctx, loginId) {
    const { applyAccountPayload, cleanLoginUrlValue, resetAccountLoginDialog, setPendingAccountLogin, setStatus, sleep } = ctx;
        for (let attempt = 0; attempt < 120; attempt += 1) {
            await sleep(1000);
            try {
                const response = await fetch("/api/accounts/login/status", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ loginId })
                });
                if (!response.ok) {
                    return;
                }
                const payload = (await response.json());
                if (payload.error) {
                    setStatus(`ChatGPT login failed: ${payload.error}`);
                    return;
                }
                setPendingAccountLogin((current) => {
                    if (!current || current.loginId !== loginId) {
                        return current;
                    }
                    return {
                        ...current,
                        loginUrl: cleanLoginUrlValue(payload.loginUrl || current.loginUrl),
                        userCode: payload.userCode ?? current.userCode
                    };
                });
                if (payload.complete) {
                    applyAccountPayload({ ...payload, activeAccount: payload.activeAccount ?? payload.account ?? null });
                    resetAccountLoginDialog();
                    setStatus("ChatGPT account added");
                    return;
                }
            }
            catch {
                return;
            }
        }
    
}

export function resetAccountLoginDialog(ctx, ) {
    const { setAccountLoginMode, setAccountLoginTargetId, setApiAccountKey, setApiAccountUrl, setIsAccountLoginOpen, setNewAccountName, setPendingAccountLogin } = ctx;
        setIsAccountLoginOpen(false);
        setAccountLoginMode("chatgpt");
        setAccountLoginTargetId(null);
        setNewAccountName("");
        setApiAccountUrl("");
        setApiAccountKey("");
        setPendingAccountLogin(null);
    
}

export function openAccountLoginDialog(ctx, account) {
    const { setAccountLoginMode, setAccountLoginTargetId, setApiAccountKey, setApiAccountUrl, setIsAccountLoginOpen, setIsAccountPopoverOpen, setNewAccountName, setPendingAccountLogin } = ctx;
        setIsAccountPopoverOpen(false);
        setAccountLoginTargetId(account?.id ?? null);
        setNewAccountName(account?.name ?? "");
        setApiAccountUrl("");
        setApiAccountKey("");
        setPendingAccountLogin(null);
        setAccountLoginMode("chatgpt");
        setIsAccountLoginOpen(true);
    
}

export function beginAccountRelogin(ctx, account) {
    const { openAccountLoginDialog, startChatGptLogin } = ctx;
        openAccountLoginDialog(account);
        void startChatGptLogin({ accountId: account.id, name: account.name });
    
}

export function applyAccountPayload(ctx, payload) {
    const { setAccountList, setActiveAccount, setUseLoadBalanceInWorkspace, setWorkspaceAccountIds, setWorkspaceAccountList } = ctx;
        if (Array.isArray(payload.accounts)) {
            setAccountList(sortAccountsByLoadBalanceParticipation(payload.accounts, payload.workspaceAccountIds));
        }
        if (Array.isArray(payload.workspaceAccounts)) {
            setWorkspaceAccountList(payload.workspaceAccounts);
        }
        if (Array.isArray(payload.workspaceAccountIds)) {
            setWorkspaceAccountIds(payload.workspaceAccountIds);
        }
        if ("activeAccount" in payload) {
            setActiveAccount(payload.activeAccount ?? null);
        }
        if (typeof payload.loadBalanceInWorkspace === "boolean") {
            setUseLoadBalanceInWorkspace(payload.loadBalanceInWorkspace);
        }
    
}

export function sortAccountsByLoadBalanceParticipation(accounts, workspaceAccountIds) {
    const candidateIds = new Set(Array.isArray(workspaceAccountIds) ? workspaceAccountIds : []);
    return [...accounts].sort((left, right) => Number(candidateIds.has(right.id)) - Number(candidateIds.has(left.id)));
}

export function scheduleLoadSessions(ctx, delayMs = 350) {
    const { loadSessions, loadSessionsTimerRef } = ctx;
        if (loadSessionsTimerRef.current !== null) {
            window.clearTimeout(loadSessionsTimerRef.current);
        }
        loadSessionsTimerRef.current = window.setTimeout(() => {
            loadSessionsTimerRef.current = null;
            void loadSessions();
        }, delayMs);
    
}

export function bumpViewKey(ctx, ) {
    const { viewKeyRef } = ctx;
        viewKeyRef.current += 1;
    
}

export function isCurrentViewKey(ctx, viewKey) {
    const { viewKeyRef } = ctx;
        return viewKeyRef.current === viewKey;
    
}

export function updateNavigationUrl(ctx, target, mode) {
    const { navigationTargetRef, navigationUrl } = ctx;
        navigationTargetRef.current = target;
        const nextUrl = navigationUrl(target);
        if (mode === "push") {
            window.history.pushState(null, "", nextUrl);
        }
        else {
            window.history.replaceState(null, "", nextUrl);
        }
    
}

export function replaceNavigationUrl(ctx, target) {
    const { updateNavigationUrl } = ctx;
        updateNavigationUrl(target, "replace");
    
}

export function registerStreamTarget(ctx, turnId, assistantMessageId, targetSessionId, viewKey) {
    const { streamTargetsRef } = ctx;
        const target = {
            turnId,
            assistantMessageId,
            sessionId: targetSessionId,
            viewKey,
            textByItemId: {},
            liveItemEventRankById: {}
        };
        streamTargetsRef.current[turnId] = target;
        return target;
    
}

export function unregisterStreamTarget(ctx, target, originalTurnId = target.turnId) {
    const { streamTargetsRef } = ctx;
        for (const turnId of new Set([originalTurnId, target.turnId])) {
            if (streamTargetsRef.current[turnId] === target) {
                delete streamTargetsRef.current[turnId];
            }
        }
    
}

export function markTurnRunning(ctx, turnId) {
    const { setRunningTurnIds } = ctx;
        setRunningTurnIds((current) => {
            if (current.has(turnId)) {
                return current;
            }
            return new Set([...current, turnId]);
        });
    
}

export function markTurnFinished(ctx, turnId) {
    const { setRunningTurnIds } = ctx;
        setRunningTurnIds((current) => {
            if (!current.has(turnId)) {
                return current;
            }
            const next = new Set(current);
            next.delete(turnId);
            return next;
        });
    
}

export function markTurnStopped(ctx, turnId, message) {
    const { activeTurnIdRef, markTurnFinished, setActiveTurnId, setMessages } = ctx;
        markTurnFinished(turnId);
        if (activeTurnIdRef.current === turnId) {
            activeTurnIdRef.current = null;
            setActiveTurnId(null);
        }
        setMessages((current) => current.map((chatMessage) => chatMessage.role === "assistant" && chatMessage.turnId === turnId
            ? {
                ...chatMessage,
                content: message,
                pending: false,
                liveItems: [],
                segments: [],
                turnStatus: "todo"
            }
            : chatMessage));
    
}

export function replaceRunningTurns(ctx, turnIds) {
    const { setRunningTurnIds } = ctx;
        setRunningTurnIds(new Set(turnIds));
    
}

export function isTargetVisible(ctx, target) {
    const { sessionIdRef, viewKeyRef } = ctx;
        if (target.sessionId) {
            return sessionIdRef.current === target.sessionId;
        }
        return sessionIdRef.current === null && viewKeyRef.current === target.viewKey;
    
}

export function scrollToMessage(ctx, messageId, anchorId) {
    const { messageElementsRef } = ctx;
        const messageElement = messageElementsRef.current[messageId];
        if (!messageElement) {
            return;
        }
        const scrollTarget = anchorId ? document.getElementById(anchorId) ?? messageElement : messageElement;
        const scroll = () => scrollTarget.scrollIntoView({ behavior: "smooth", block: "center" });
        const detailsToOpen = [];
        let parentDetails = scrollTarget.closest("details");
        while (parentDetails) {
            if (!parentDetails.open) {
                detailsToOpen.push(parentDetails);
            }
            parentDetails = parentDetails.parentElement?.closest("details") ?? null;
        }
        if (detailsToOpen.length > 0) {
            for (const details of detailsToOpen) {
                details.open = true;
            }
            window.requestAnimationFrame(scroll);
            return;
        }
        scroll();
    
}

export function updateMessageViewportIndicator(ctx, container) {
    const { messageScrollIndicatorRef, messageViewportIndicatorRef, setActivePromptTurnIds, setFeaturedPromptTurnId, setsEqual } = ctx;
        if (container) {
            const viewport = container.getBoundingClientRect();
            const visibleTurns = [...container.querySelectorAll(".message.assistant[data-turn-id]")]
                .map((article) => {
                const bounds = article.getBoundingClientRect();
                return {
                    turnId: article.dataset.turnId,
                    visibleHeight: Math.max(0, Math.min(bounds.bottom, viewport.bottom) - Math.max(bounds.top, viewport.top))
                };
            })
                .filter((candidate) => candidate.visibleHeight > 0);
            const visibleTurnIds = new Set(visibleTurns.map((turn) => turn.turnId).filter(Boolean));
            const featuredTurn = visibleTurns.reduce((featured, candidate) => candidate.visibleHeight > featured.visibleHeight ? candidate : featured, { turnId: undefined, visibleHeight: 0 });
            setActivePromptTurnIds((current) => setsEqual(current, visibleTurnIds) ? current : visibleTurnIds);
            setFeaturedPromptTurnId((current) => current === featuredTurn.turnId ? current : featuredTurn.turnId);
        }
        const rail = messageScrollIndicatorRef.current;
        const indicator = messageViewportIndicatorRef.current;
        if (!container || !rail || !indicator) {
            return;
        }
        const railHeight = rail.clientHeight;
        const contentHeight = container.scrollHeight;
        if (railHeight <= 0 || contentHeight <= 0) {
            return;
        }
        const maxScrollTop = Math.max(0, contentHeight - container.clientHeight);
        const indicatorHeight = Math.min(railHeight, Math.max(12, (container.clientHeight / contentHeight) * railHeight));
        const scrollProgress = maxScrollTop === 0
            ? 0
            : Math.max(0, Math.min(1, container.scrollTop / maxScrollTop));
        const indicatorTop = maxScrollTop === 0
            ? 0
            : scrollProgress * (railHeight - indicatorHeight);
        indicator.style.height = `${indicatorHeight}px`;
        indicator.style.top = `${indicatorTop}px`;
    
}

export function updateMessageIndicatorPositions(ctx, container) {
    const { messageElementsRef, messageIndicatorMarks, setMessageIndicatorPositions } = ctx;
        if (!container) {
            return;
        }
        const marks = messageIndicatorMarks;
        if (marks.length === 0) {
            setMessageIndicatorPositions((current) => Object.keys(current).length === 0 ? current : {});
            return;
        }
        const containerRect = container.getBoundingClientRect();
        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const nextPositions = {};
        for (const mark of marks) {
            const anchor = mark.anchorId ? document.getElementById(mark.anchorId) : null;
            const messageElement = messageElementsRef.current[mark.targetId];
            const candidate = anchor && anchor.getClientRects().length > 0 ? anchor : messageElement;
            if (!candidate) {
                nextPositions[mark.id] = mark.position;
                continue;
            }
            const targetRect = candidate.getBoundingClientRect();
            const targetCenter = targetRect.top - containerRect.top + container.scrollTop + targetRect.height / 2;
            const targetScrollTop = Math.max(0, Math.min(maxScrollTop, targetCenter - container.clientHeight / 2));
            nextPositions[mark.id] = maxScrollTop === 0 ? 0 : (targetScrollTop / maxScrollTop) * 100;
        }
        setMessageIndicatorPositions((current) => {
            const currentKeys = Object.keys(current);
            const nextKeys = Object.keys(nextPositions);
            if (currentKeys.length === nextKeys.length && nextKeys.every((key) => Math.abs((current[key] ?? 0) - nextPositions[key]) < 0.1)) {
                return current;
            }
            return nextPositions;
        });
    
}

export function scrollFromMessageRail(ctx, event) {
    const { messageScrollIndicatorRef, messageViewportIndicatorRef, messagesRef } = ctx;
        if (event.target.closest(".message-scroll-indicator-mark")) {
            return;
        }
        const container = messagesRef.current;
        const rail = messageScrollIndicatorRef.current;
        const indicator = messageViewportIndicatorRef.current;
        if (!container || !rail || !indicator) {
            return;
        }
        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const availableTravel = Math.max(0, rail.clientHeight - indicator.offsetHeight);
        if (maxScrollTop === 0 || availableTravel === 0) {
            return;
        }
        const clickY = event.clientY - rail.getBoundingClientRect().top;
        const scrollProgress = Math.max(0, Math.min(1, (clickY - indicator.offsetHeight / 2) / availableTravel));
        container.scrollTo({ top: scrollProgress * maxScrollTop, behavior: "smooth" });
    
}

export function scrollFromMessageRailWheel(ctx, event) {
    const { messagesRef } = ctx;
        const container = messagesRef.current;
        if (!container || (event.deltaX === 0 && event.deltaY === 0)) {
            return;
        }
        event.preventDefault();
        container.scrollBy({ top: event.deltaY, left: event.deltaX, behavior: "auto" });
    
}

export function startMessageRailDrag(ctx, event) {
    const { messageRailDragRef, messageScrollIndicatorRef } = ctx;
        if (event.button !== 0) {
            return;
        }
        const rail = messageScrollIndicatorRef.current;
        if (!rail) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.dragging = "true";
        messageRailDragRef.current = {
            pointerId: event.pointerId,
            grabOffset: event.clientY - rail.getBoundingClientRect().top - event.currentTarget.offsetTop
        };
    
}

export function dragMessageRailViewport(ctx, event) {
    const { messageRailDragRef, messageScrollIndicatorRef, messagesRef } = ctx;
        const drag = messageRailDragRef.current;
        const container = messagesRef.current;
        const rail = messageScrollIndicatorRef.current;
        if (!drag || drag.pointerId !== event.pointerId || !container || !rail) {
            return;
        }
        event.preventDefault();
        const availableTravel = Math.max(0, rail.clientHeight - event.currentTarget.offsetHeight);
        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        if (availableTravel === 0 || maxScrollTop === 0) {
            return;
        }
        const desiredTop = event.clientY - rail.getBoundingClientRect().top - drag.grabOffset;
        const scrollProgress = Math.max(0, Math.min(1, desiredTop / availableTravel));
        container.scrollTop = scrollProgress * maxScrollTop;
    
}

export function finishMessageRailDrag(ctx, event) {
    const { messageRailDragRef } = ctx;
        const drag = messageRailDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) {
            return;
        }
        event.stopPropagation();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        delete event.currentTarget.dataset.dragging;
        messageRailDragRef.current = null;
    
}

export async function bindAccount(ctx, accountId) {
    const { activeWorkspace, applyAccountPayload, setBindAccountId, setStatus } = ctx;
        if (!accountId) {
            return;
        }
        setStatus("Binding account");
        try {
            const response = await fetch("/api/accounts/bind", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    workspaceId: activeWorkspace?.id,
                    accountId
                })
            });
            if (!response.ok) {
                const payload = (await response.json().catch(() => null));
                throw new Error(payload?.error || `API returned ${response.status}`);
            }
            const payload = (await response.json());
            applyAccountPayload(payload);
            setBindAccountId("");
            setStatus("Account bound");
        }
        catch (error) {
            setStatus(error instanceof Error ? `Bind failed: ${error.message}` : "Bind failed");
        }
    
}

export async function unbindAccount(ctx, accountId) {
    const { activeWorkspace, applyAccountPayload, setStatus } = ctx;
        if (!accountId) {
            return;
        }
        setStatus("Unbinding account");
        try {
            const response = await fetch("/api/accounts/unbind", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    workspaceId: activeWorkspace?.id,
                    accountId
                })
            });
            if (!response.ok) {
                const payload = (await response.json().catch(() => null));
                throw new Error(payload?.error || `API returned ${response.status}`);
            }
            const payload = (await response.json());
            applyAccountPayload(payload);
            setStatus("Account unbound");
        }
        catch (error) {
            setStatus(error instanceof Error ? `Unbind failed: ${error.message}` : "Unbind failed");
        }
    
}

export async function deleteAccount(ctx, account) {
    const { accountIdentityLabel, applyAccountPayload, deletingAccountId, setBindAccountId, setDeletingAccountId, setProfileAccountId, setStatus, showToast } = ctx;
        if (!account || deletingAccountId) {
            return;
        }
        const label = accountIdentityLabel(account);
        if (!window.confirm(`Delete ${label}?\n\nThis removes its saved credentials and all workspace bindings from Threadex. Session history is kept.`)) {
            return;
        }
        setDeletingAccountId(account.id);
        setStatus(`Deleting ${label}`);
        try {
            const response = await fetch("/api/accounts/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ accountId: account.id })
            });
            const payload = (await response.json().catch(() => null));
            if (!response.ok) {
                throw new Error(payload?.error || `API returned ${response.status}`);
            }
            if (payload)
                applyAccountPayload(payload);
            setBindAccountId((current) => current === account.id ? "" : current);
            setProfileAccountId((current) => current === account.id ? "" : current);
            setStatus("Account deleted");
            showToast(`${label} deleted`);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Delete failed";
            setStatus(`Delete failed: ${message}`);
            showToast(`Delete failed: ${message}`);
        }
        finally {
            setDeletingAccountId(null);
        }
    
}

export async function switchSession(ctx, record, options = {}) {
    const { applyComposerDraftState, applySelectedSessionSnapshot, bumpViewKey, clearTodoPanelState, currentComposerDraft, displaySessionTitle, executionMode, explicitNewSessionRef, forcePlanNextPrompt, forkNextPrompt, input, isCurrentViewKey, isLikelyBackendDisconnect, messages, noteBackendDisconnect, noteBackendRequestSucceeded, parentSessionTodo, reconnectRunner, replaceComposerDraftForSession, scheduleLoadSessions, sessionIdRef, sessionTodo, setMessages, setParentSessionTodo, setSessionTodo, setStatus, setSwitchingSessionTitle, stickToMessageBottomRef, updateNavigationUrl, viewKeyRef } = ctx;
        bumpViewKey();
        const viewKey = viewKeyRef.current;
        const previousExplicitNewSession = explicitNewSessionRef.current;
        explicitNewSessionRef.current = false;
        setStatus("Switching session");
        const previousMessages = messages;
        const previousSessionId = sessionIdRef.current;
        const previousSessionTodo = sessionTodo;
        const previousParentSessionTodo = parentSessionTodo;
        const previousComposerDraft = currentComposerDraft(input, forcePlanNextPrompt, executionMode, forkNextPrompt);
        replaceComposerDraftForSession(record.id);
        stickToMessageBottomRef.current = true;
        setSwitchingSessionTitle(displaySessionTitle(record.title) || "session");
        setMessages([]);
        clearTodoPanelState();
        try {
            const response = await fetch("/api/sessions/switch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sessionId: record.id })
            });
            if (!response.ok) {
                throw new Error(`API returned ${response.status}`);
            }
            noteBackendRequestSucceeded();
            const payload = (await response.json());
            if (!isCurrentViewKey(viewKey)) {
                return;
            }
            const switchedSession = payload.session ?? record;
            const runningTurn = (payload.turns ?? []).find((turn) => turn.status === "running");
            applySelectedSessionSnapshot({ ...payload, session: switchedSession });
            setSwitchingSessionTitle(null);
            if (options.history !== "none") {
                updateNavigationUrl({ workspaceId: switchedSession.workspaceId, sessionId: switchedSession.id }, options.history === "replace" ? "replace" : "push");
            }
            setStatus("Session switched");
            scheduleLoadSessions();
            if (runningTurn) {
                void reconnectRunner(runningTurn.id, `${runningTurn.id}:assistant`, switchedSession.id, viewKeyRef.current);
            }
        }
        catch (error) {
            if (!isCurrentViewKey(viewKey)) {
                return;
            }
            setMessages(previousMessages);
            sessionIdRef.current = previousSessionId;
            explicitNewSessionRef.current = previousExplicitNewSession;
            setSessionTodo(previousSessionTodo);
            setParentSessionTodo(previousParentSessionTodo);
            applyComposerDraftState(previousComposerDraft, previousSessionId);
            setSwitchingSessionTitle(null);
            if (isLikelyBackendDisconnect(error)) {
                noteBackendDisconnect();
            }
            else {
                setStatus(error instanceof Error ? `Switch failed: ${error.message}` : "Switch failed");
            }
        }
    
}
