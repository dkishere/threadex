// @ts-nocheck
import { useEffect, useLayoutEffect } from "react";
import { deferSnapshotWrite } from "./deferredSnapshot";
import { CLIENT_EVENT_TYPES } from "../eventProtocol";

export function useSessionEffects(ctx) {
  const { accountPopoverRef, activeGearIndex, activePromptTurnIds, activeTurnId, activeTurnIdRef, activeWorkspace, approvalPolicy, backendConnection, backendConnectionRef, bumpViewKey, composerDraftSessionIdRef, currentModelPreferences, currentRunningTurnId, currentSessionIsRunning, currentSessionIsStopping, didBootReconnectRef, effectiveParentSessionId, escStopArmedRef, escStopTimerRef, eventStore, executionMode, explicitNewSessionRef, findAssistantMessageId, forcePlanNextPrompt, forkNextPrompt, gearProfiles, handleDurableEvent, hasRunningTurn, inlinePromptEditor, inlinePromptEditorRef, isAccountLoginOpen, isAccountPopoverOpen, isBootstrapped, isLikelyBackendDisconnect, isSessionSearchOpen, isSettingsOpen, latestMessagesRef, loadContext, loadSessionSearchPage, loadSessionsTimerRef, loadWorkspaceSnapshot, messageIndicatorMarks, messageScrollIndicatorRef, messageScrollTopRef, messages, messagesRef, modelPreferencesEditRevisionRef, navigationTargetRef, noteBackendDisconnect, noteBackendRequestSucceeded, patchStoredComposerDraft, persistModelPreferences, profileAccountId, profileWorkspaceId, promptTurns, promptTurnsScrollRef, queuedModelPreferencesRevisionRef, queuedPrompts, queuedPromptsBySession, queuedPromptsRef, readNavigationTarget, reconnectRunner, reconnectingTurnIdsRef, refreshSelectedSessionSnapshot, resetAccountLoginDialog, resetEscStopPrompt, resizeEditor, responseQuotePopover, restoreBackendConnection, resumeThreadId, runningSessionCount, selectedEffort, selectedModel, sessionExecutionStatusesRef, sessionId, sessionIdRef, sessionSearchQuery, setActivePromptTurnIds, setClockNow, setComposerResponseQuote, setIsAccountPopoverOpen, setIsLoadingProfileAnalytics, setIsLoadingSkills, setIsSettingsOpen, setParentSessionTodo, setPendingApprovalSessionIds, setProfileAnalytics, setProfileAnalyticsError, setProfileWorkspaceId, setResponseQuotePopover, setSelectedSkills, setSessionExecutionStatuses, setSkillSuggestions, setSlashSuggestionIndex, setStatus, setsEqual, settingsSection, showToast, skillSuggestions, slashTrigger, status, stickToMessageBottomRef, stopCurrentTurn, switchingSessionTitle, threadId, toastTimerRef, updateMessageIndicatorPositions, updateMessageViewportIndicator, useLoadBalanceInWorkspace, viewKeyRef, writeStoredSession } = ctx;
useEffect(() => {
        const validTurnIds = new Set(promptTurns.map(({ prompt }) => prompt.turnId));
        setActivePromptTurnIds((current) => {
            const next = new Set([...current].filter((turnId) => validTurnIds.has(turnId)));
            if (next.size === 0 && promptTurns.length > 0)
                next.add(promptTurns.at(-1).prompt.turnId);
            return setsEqual(current, next) ? current : next;
        });
    }, [promptTurns]);
useLayoutEffect(() => {
        const container = promptTurnsScrollRef.current;
        if (!container || activePromptTurnIds.size === 0)
            return;
        const activeCards = [...container.querySelectorAll('.prompt-turn-card[data-active="true"]')];
        if (activeCards.length === 0)
            return;
        const viewport = container.getBoundingClientRect();
        const firstBounds = activeCards[0].getBoundingClientRect();
        const lastBounds = activeCards.at(-1).getBoundingClientRect();
        if (firstBounds.top < viewport.top) {
            container.scrollTo({ top: container.scrollTop + firstBounds.top - viewport.top, behavior: "smooth" });
        }
        else if (lastBounds.bottom > viewport.bottom) {
            container.scrollTo({ top: container.scrollTop + lastBounds.bottom - viewport.bottom, behavior: "smooth" });
        }
    }, [activePromptTurnIds]);
useEffect(() => {
        if (!hasRunningTurn) {
            return;
        }
        setClockNow(Date.now());
        const timer = window.setInterval(() => setClockNow(Date.now()), 1_000);
        return () => window.clearInterval(timer);
    }, [hasRunningTurn]);
useEffect(() => {
        if (!isSessionSearchOpen)
            return;
        const abortController = new AbortController();
        const timer = window.setTimeout(async () => {
            await loadSessionSearchPage(0, abortController.signal);
        }, 180);
        return () => {
            window.clearTimeout(timer);
            abortController.abort();
        };
    }, [isSessionSearchOpen, sessionSearchQuery]);
useEffect(() => {
        return deferSnapshotWrite(() => writeStoredSession({
            version: 1,
            messages,
            queuedPrompts,
            queuedPromptsBySession,
            workspaceId: activeWorkspace?.id ?? null,
            sessionId,
            threadId,
            activeTurnId,
            resumeThreadId,
            status,
            selectedModel,
            selectedEffort,
            approvalPolicy,
            gearProfiles,
            activeGearIndex,
            useLoadBalanceInWorkspace
        }));
    }, [
        activeTurnId,
        activeGearIndex,
        gearProfiles,
        messages,
        queuedPrompts,
        queuedPromptsBySession,
        resumeThreadId,
        selectedEffort,
        approvalPolicy,
        selectedModel,
        sessionId,
        status,
        threadId,
        activeWorkspace?.id,
        useLoadBalanceInWorkspace
    ]);
useEffect(() => {
        if (!isBootstrapped) {
            return;
        }
        const editRevision = modelPreferencesEditRevisionRef.current;
        if (editRevision <= queuedModelPreferencesRevisionRef.current) {
            return;
        }
        queuedModelPreferencesRevisionRef.current = editRevision;
        persistModelPreferences(currentModelPreferences());
    }, [activeGearIndex, gearProfiles, isBootstrapped, selectedEffort, selectedModel, sessionId]);
useEffect(() => {
        patchStoredComposerDraft(composerDraftSessionIdRef.current, {
            forcePlanNextPrompt,
            executionMode,
            forkNextPrompt: forkNextPrompt && Boolean(composerDraftSessionIdRef.current)
        });
    }, [executionMode, forcePlanNextPrompt, forkNextPrompt, sessionId]);
useEffect(() => {
        if (!effectiveParentSessionId || !sessionId) {
            setParentSessionTodo(null);
            return;
        }
        const abortController = new AbortController();
        void fetch(`/api/sessions/${encodeURIComponent(effectiveParentSessionId)}/todos`, {
            signal: abortController.signal
        })
            .then((response) => response.ok ? response.json() : null)
            .then((todo) => {
            if (!abortController.signal.aborted) {
                setParentSessionTodo(todo);
            }
        })
            .catch(() => {
            if (!abortController.signal.aborted) {
                setParentSessionTodo(null);
            }
        });
        return () => abortController.abort();
    }, [effectiveParentSessionId, sessionId]);
useEffect(() => {
        activeTurnIdRef.current = activeTurnId;
    }, [activeTurnId]);
useEffect(() => {
        sessionIdRef.current = sessionId;
        if (sessionId !== null && composerDraftSessionIdRef.current === null) {
            composerDraftSessionIdRef.current = sessionId;
        }
    }, [sessionId]);
useEffect(() => {
        latestMessagesRef.current = messages;
    }, [messages]);
useEffect(() => {
        queuedPromptsRef.current = queuedPrompts;
    }, [queuedPrompts]);
useLayoutEffect(() => {
        const container = messagesRef.current;
        if (!container) {
            return;
        }
        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        container.scrollTop = stickToMessageBottomRef.current
            ? maxScrollTop
            : Math.min(messageScrollTopRef.current, maxScrollTop);
        messageScrollTopRef.current = container.scrollTop;
        updateMessageViewportIndicator(container);
        updateMessageIndicatorPositions(container);
    }, [messages, switchingSessionTitle]);
useLayoutEffect(() => {
        const container = messagesRef.current;
        const rail = messageScrollIndicatorRef.current;
        if (!container || !rail) {
            return;
        }
        let refreshFrame = 0;
        const refresh = () => {
            if (refreshFrame) {
                return;
            }
            refreshFrame = window.requestAnimationFrame(() => {
                refreshFrame = 0;
                updateMessageViewportIndicator(container);
                updateMessageIndicatorPositions(container);
            });
        };
        const resizeObserver = new ResizeObserver(refresh);
        resizeObserver.observe(container);
        resizeObserver.observe(rail);
        const mutationObserver = new MutationObserver(refresh);
        // Only observe details state changes. Observing every attribute also sees
        // the indicator's own style updates and can cause a refresh loop.
        mutationObserver.observe(container, {
            attributeFilter: ["open"],
            attributes: true,
            childList: true,
            subtree: true
        });
        refresh();
        return () => {
            if (refreshFrame) {
                window.cancelAnimationFrame(refreshFrame);
            }
            resizeObserver.disconnect();
            mutationObserver.disconnect();
        };
    }, [messageIndicatorMarks]);
useLayoutEffect(() => {
        const editor = inlinePromptEditorRef.current;
        if (!editor) {
            return;
        }
        resizeEditor(editor);
    }, [inlinePromptEditor?.value]);
useEffect(() => {
        setResponseQuotePopover(null);
        setComposerResponseQuote(null);
    }, [sessionId]);
useEffect(() => {
        if (!responseQuotePopover)
            return;
        const dismissResponseQuotePopover = (event) => {
            if (!event.target?.closest(".response-quote-popover")) {
                setResponseQuotePopover(null);
            }
        };
        const dismissResponseQuotePopoverOnEscape = (event) => {
            if (event.key === "Escape") {
                setResponseQuotePopover(null);
            }
        };
        window.addEventListener("pointerdown", dismissResponseQuotePopover);
        window.addEventListener("keydown", dismissResponseQuotePopoverOnEscape);
        return () => {
            window.removeEventListener("pointerdown", dismissResponseQuotePopover);
            window.removeEventListener("keydown", dismissResponseQuotePopoverOnEscape);
        };
    }, [responseQuotePopover]);
useEffect(() => {
        const onPopState = () => {
            const target = readNavigationTarget();
            bumpViewKey();
            const viewKey = viewKeyRef.current;
            navigationTargetRef.current = target;
            // Browser navigation to a saved session is an explicit resume target,
            // even if the previous screen was the blank New thread composer.
            if (target.sessionId) {
                explicitNewSessionRef.current = false;
            }
            void loadWorkspaceSnapshot({ navigationTarget: target, canonicalizeUrl: true, viewKey });
        };
        window.addEventListener("popstate", onPopState);
        void loadContext();
        return () => window.removeEventListener("popstate", onPopState);
    }, []);
useEffect(() => {
        // A Vite restart can finish before the API server has returned. Keep
        // retrying the initial snapshot so the process-monitor sidebar is not
        // permanently left empty with event polling disabled.
        if (isBootstrapped || backendConnection !== "reconnecting")
            return;
        let cancelled = false;
        let timer = null;
        const retryBootstrap = async () => {
            await loadContext();
            if (!cancelled) {
                timer = window.setTimeout(retryBootstrap, 1_000);
            }
        };
        void retryBootstrap();
        return () => {
            cancelled = true;
            if (timer !== null)
                window.clearTimeout(timer);
        };
    }, [isBootstrapped, backendConnection]);
useEffect(() => {
        setSkillSuggestions([]);
        setSelectedSkills([]);
    }, [activeWorkspace?.id]);
useEffect(() => {
        if (!slashTrigger || skillSuggestions.length > 0)
            return;
        let cancelled = false;
        setIsLoadingSkills(true);
        const workspaceQuery = activeWorkspace?.id ? `?workspaceId=${encodeURIComponent(activeWorkspace.id)}` : "";
        void fetch(`/api/skills${workspaceQuery}`, { cache: "no-store" })
            .then(async (response) => {
            if (!response.ok)
                throw new Error(`API returned ${response.status}`);
            return response.json();
        })
            .then((payload) => {
            if (!cancelled)
                setSkillSuggestions(Array.isArray(payload.skills) ? payload.skills : []);
        })
            .catch((error) => {
            if (!cancelled)
                setStatus(`Skill list failed: ${error instanceof Error ? error.message : "Unknown error"}`);
        })
            .finally(() => {
            if (!cancelled)
                setIsLoadingSkills(false);
        });
        return () => {
            cancelled = true;
        };
    }, [activeWorkspace?.id, Boolean(slashTrigger), skillSuggestions.length]);
useEffect(() => {
        setSlashSuggestionIndex(0);
    }, [slashTrigger?.query]);
useEffect(() => {
        const unsubscribe = eventStore.subscribeTo(CLIENT_EVENT_TYPES, (event) => void handleDurableEvent(event));
        return unsubscribe;
    }, []);
useEffect(() => {
        if (!isBootstrapped)
            return;
        let cancelled = false;
        let timer = null;
        async function pollEvents() {
            try {
                const resetRequired = await eventStore.poll();
                if (cancelled)
                    return;
                const shouldRestoreBackend = backendConnectionRef.current === "reconnecting";
                noteBackendRequestSucceeded();
                if (shouldRestoreBackend) {
                    await restoreBackendConnection();
                }
                else if (resetRequired) {
                    await loadWorkspaceSnapshot({ preserveSelectedSession: true });
                }
            }
            catch (error) {
                if (isLikelyBackendDisconnect(error))
                    noteBackendDisconnect();
            }
            finally {
                if (!cancelled) {
                    timer = window.setTimeout(pollEvents, currentSessionIsRunning ? 750 : 2_500);
                }
            }
        }
        void pollEvents();
        return () => {
            cancelled = true;
            if (timer !== null)
                window.clearTimeout(timer);
        };
    }, [isBootstrapped, currentSessionIsRunning]);
useEffect(() => {
        if (!isBootstrapped || runningSessionCount === 0) {
            return;
        }
        let cancelled = false;
        let timer = null;
        async function reconcileExecutionStatuses() {
            try {
                const selectedSessionId = sessionIdRef.current;
                const selectedTurnId = activeTurnIdRef.current ?? undefined;
                const response = await fetch("/api/session-execution-statuses", { cache: "no-store" });
                if (!response.ok)
                    throw new Error(`API returned ${response.status}`);
                const payload = await response.json();
                const nextStatuses = payload.sessionExecutionStatuses ?? {};
                const selectedWasRunning = Boolean(selectedSessionId && sessionExecutionStatusesRef.current[selectedSessionId] === "running");
                const selectedIsRunning = Boolean(selectedSessionId && nextStatuses[selectedSessionId] === "running");
                sessionExecutionStatusesRef.current = nextStatuses;
                setSessionExecutionStatuses((current) => {
                    const keys = Object.keys(current);
                    const nextKeys = Object.keys(nextStatuses);
                    return keys.length === nextKeys.length && keys.every((key) => current[key] === nextStatuses[key]) ? current : nextStatuses;
                });
                const nextPendingApprovalSessionIds = Array.isArray(payload.pendingApprovalSessionIds) ? payload.pendingApprovalSessionIds : [];
                setPendingApprovalSessionIds((current) => current.length === nextPendingApprovalSessionIds.length && current.every((id, index) => id === nextPendingApprovalSessionIds[index])
                    ? current
                    : nextPendingApprovalSessionIds);
                // Only fetch the transcript when a missed terminal event is
                // detected. Live runner events already keep active turns fresh.
                if (selectedWasRunning && !selectedIsRunning && selectedSessionId && sessionIdRef.current === selectedSessionId) {
                    await refreshSelectedSessionSnapshot(selectedSessionId, selectedTurnId);
                }
            }
            catch (error) {
                if (isLikelyBackendDisconnect(error))
                    noteBackendDisconnect();
            }
            finally {
                if (!cancelled) {
                    timer = window.setTimeout(reconcileExecutionStatuses, 5_000);
                }
            }
        }
        timer = window.setTimeout(reconcileExecutionStatuses, 1_000);
        return () => {
            cancelled = true;
            if (timer !== null)
                window.clearTimeout(timer);
        };
    }, [isBootstrapped, runningSessionCount]);
useEffect(() => () => {
        if (loadSessionsTimerRef.current !== null) {
            window.clearTimeout(loadSessionsTimerRef.current);
        }
        if (toastTimerRef.current !== null) {
            window.clearTimeout(toastTimerRef.current);
        }
        if (escStopTimerRef.current !== null) {
            window.clearTimeout(escStopTimerRef.current);
        }
    }, []);
useEffect(() => {
        if (!currentSessionIsRunning) {
            resetEscStopPrompt();
        }
    }, [currentSessionIsRunning]);
useEffect(() => {
        function handleEscapeToStop(event) {
            if (event.key !== "Escape" ||
                event.defaultPrevented ||
                !currentSessionIsRunning ||
                !currentRunningTurnId ||
                currentSessionIsStopping ||
                isAccountLoginOpen ||
                isSettingsOpen) {
                return;
            }
            event.preventDefault();
            if (!escStopArmedRef.current) {
                escStopArmedRef.current = true;
                showToast("Press Esc again to stop agent");
                if (escStopTimerRef.current !== null) {
                    window.clearTimeout(escStopTimerRef.current);
                }
                escStopTimerRef.current = window.setTimeout(() => {
                    escStopArmedRef.current = false;
                    escStopTimerRef.current = null;
                }, 1800);
                return;
            }
            resetEscStopPrompt();
            void stopCurrentTurn(currentRunningTurnId);
        }
        window.addEventListener("keydown", handleEscapeToStop);
        return () => window.removeEventListener("keydown", handleEscapeToStop);
    }, [
        currentRunningTurnId,
        currentSessionIsRunning,
        currentSessionIsStopping,
        isAccountLoginOpen,
        isSettingsOpen
    ]);
useEffect(() => {
        if (!isSettingsOpen && !isAccountLoginOpen) {
            return;
        }
        function handleEscapeFromSettings(event) {
            if (event.key !== "Escape" || event.defaultPrevented) {
                return;
            }
            event.preventDefault();
            if (isAccountLoginOpen) {
                resetAccountLoginDialog();
            }
            else {
                setIsSettingsOpen(false);
            }
        }
        window.addEventListener("keydown", handleEscapeFromSettings);
        return () => window.removeEventListener("keydown", handleEscapeFromSettings);
    }, [isAccountLoginOpen, isSettingsOpen]);
useEffect(() => {
        if (activeWorkspace?.id && !profileWorkspaceId) {
            setProfileWorkspaceId(activeWorkspace.id);
        }
    }, [activeWorkspace?.id, profileWorkspaceId]);
useEffect(() => {
        if (!isSettingsOpen || settingsSection !== "profile" || !profileWorkspaceId) {
            return;
        }
        const abortController = new AbortController();
        const params = new URLSearchParams({ workspaceId: profileWorkspaceId });
        if (profileAccountId)
            params.set("accountId", profileAccountId);
        setIsLoadingProfileAnalytics(true);
        setProfileAnalyticsError("");
        void fetch(`/api/profile-analytics?${params.toString()}`, { signal: abortController.signal })
            .then(async (response) => {
            const payload = (await response.json().catch(() => null));
            if (!response.ok || !payload) {
                throw new Error(payload?.error || `API returned ${response.status}`);
            }
            setProfileAnalytics(payload);
        })
            .catch((error) => {
            if (error instanceof DOMException && error.name === "AbortError")
                return;
            setProfileAnalyticsError(error instanceof Error ? error.message : "Could not load profile analytics");
        })
            .finally(() => {
            if (!abortController.signal.aborted)
                setIsLoadingProfileAnalytics(false);
        });
        return () => abortController.abort();
    }, [isSettingsOpen, profileAccountId, profileWorkspaceId, settingsSection]);
useEffect(() => {
        if (!isAccountPopoverOpen) {
            return;
        }
        function closeAccountPopover(event) {
            if (event instanceof globalThis.KeyboardEvent) {
                if (event.key !== "Escape")
                    return;
            }
            else if (accountPopoverRef.current?.contains(event.target)) {
                return;
            }
            setIsAccountPopoverOpen(false);
        }
        window.addEventListener("mousedown", closeAccountPopover);
        window.addEventListener("keydown", closeAccountPopover);
        return () => {
            window.removeEventListener("mousedown", closeAccountPopover);
            window.removeEventListener("keydown", closeAccountPopover);
        };
    }, [isAccountPopoverOpen]);
useEffect(() => {
        if (!isBootstrapped || didBootReconnectRef.current) {
            return;
        }
        // This effect only restores a turn that was already running when the app
        // bootstrapped. Mark the boot check as consumed even when there is no turn;
        // otherwise starting a new turn later also opens /api/runner/stream beside
        // its existing /api/chat stream and renders every text delta twice.
        didBootReconnectRef.current = true;
        if (!activeTurnId || reconnectingTurnIdsRef.current.has(activeTurnId)) {
            return;
        }
        const assistantMessageId = findAssistantMessageId(messages, activeTurnId);
        if (!assistantMessageId) {
            return;
        }
        setStatus("Reconnecting to prompt runner");
        void reconnectRunner(activeTurnId, assistantMessageId, sessionId, viewKeyRef.current);
    }, [activeTurnId, isBootstrapped, messages, sessionId]);
}
