// @ts-nocheck
export function selectSlashSuggestion(ctx, suggestion) {
    const { capitalize, executionMode, input, inputEditorRef, setComposerExecutionMode, setComposerInput, setSelectedSkills, setSlashTrigger, setStatus, slashTrigger } = ctx;
        if (!slashTrigger)
            return;
        const before = input.slice(0, slashTrigger.start);
        const after = input.slice(slashTrigger.end);
        const replacement = suggestion.kind === "skill" ? `$${suggestion.name} ` : "";
        const nextInput = `${before}${replacement}${after}`;
        const nextCaret = before.length + replacement.length;
        setComposerInput(nextInput);
        setSlashTrigger(null);
        if (suggestion.kind === "mode") {
            const enabled = executionMode !== suggestion.mode;
            setComposerExecutionMode(enabled ? suggestion.mode : "default");
            setStatus(`${capitalize(suggestion.mode)} mode ${enabled ? "on" : "off"}`);
        }
        else if (suggestion.kind === "skill") {
            setSelectedSkills((current) => current.some((skill) => skill.name === suggestion.name && skill.path === suggestion.path)
                ? current
                : [...current, suggestion]);
        }
        window.requestAnimationFrame(() => {
            inputEditorRef.current?.setCaret(nextCaret);
        });
    
}

export function selectComposerSuggestion(ctx, suggestion) {
    const { composerSuggestionTrigger, input, inputEditorRef, setComposerInput, setComposerSuggestionTrigger } = ctx;
        if (!composerSuggestionTrigger || (suggestion.kind !== "path" && suggestion.kind !== "keyword"))
            return;
        const before = input.slice(0, composerSuggestionTrigger.start);
        const after = input.slice(composerSuggestionTrigger.end);
        const nextInput = `${before}${suggestion.insertText}${after}`;
        const nextCaret = before.length + suggestion.insertText.length;
        setComposerInput(nextInput);
        setComposerSuggestionTrigger(null);
        window.requestAnimationFrame(() => {
            inputEditorRef.current?.setCaret(nextCaret);
        });
}

export function clearInput(ctx, ) {
    const { clearComposerInputDraft, inputEditorRef, setComposerResponseQuote, setResponseQuotePopover, setSelectedSkills, setSlashTrigger, setComposerSuggestionTrigger } = ctx;
        clearComposerInputDraft();
        setComposerResponseQuote(null);
        setResponseQuotePopover(null);
        setSelectedSkills([]);
        setSlashTrigger(null);
        setComposerSuggestionTrigger(null);
        inputEditorRef.current?.focus();
    
}

export function cancelHoveredSessionClose(ctx, ) {
    const { hoveredSessionCloseTimerRef } = ctx;
        if (hoveredSessionCloseTimerRef.current !== null) {
            window.clearTimeout(hoveredSessionCloseTimerRef.current);
            hoveredSessionCloseTimerRef.current = null;
        }
    
}

export function scheduleHoveredSessionClose(ctx, ) {
    const { cancelHoveredSessionClose, hoveredSessionCloseTimerRef, setHoveredSession } = ctx;
        cancelHoveredSessionClose();
        hoveredSessionCloseTimerRef.current = window.setTimeout(() => {
            setHoveredSession(null);
            hoveredSessionCloseTimerRef.current = null;
        }, 180);
    
}

export function cancelHoveredProcessMonitorClose(ctx, ) {
    const { hoveredProcessMonitorCloseTimerRef } = ctx;
        if (hoveredProcessMonitorCloseTimerRef.current !== null) {
            window.clearTimeout(hoveredProcessMonitorCloseTimerRef.current);
            hoveredProcessMonitorCloseTimerRef.current = null;
        }
    
}

export function scheduleHoveredProcessMonitorClose(ctx, ) {
    const { cancelHoveredProcessMonitorClose, hoveredProcessMonitorCloseTimerRef, setHoveredProcessMonitor } = ctx;
        cancelHoveredProcessMonitorClose();
        hoveredProcessMonitorCloseTimerRef.current = window.setTimeout(() => {
            setHoveredProcessMonitor(null);
            hoveredProcessMonitorCloseTimerRef.current = null;
        }, 180);
    
}

export async function updateTodoItem(ctx, itemId, patch) {
    const { applyTodoSnapshotForSession, sessionIdRef, setStatus } = ctx;
        const targetSessionId = sessionIdRef.current;
        if (!targetSessionId)
            return;
        try {
            const response = await fetch(`/api/sessions/${encodeURIComponent(targetSessionId)}/todos/items/${encodeURIComponent(itemId)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...patch, actor: "user" })
            });
            if (!response.ok)
                throw new Error(`Todo API returned ${response.status}`);
            applyTodoSnapshotForSession(targetSessionId, await response.json());
        }
        catch (error) {
            setStatus(error instanceof Error ? error.message : "Todo update failed");
        }
    
}

export async function createTodoItem(ctx, parentId) {
    const { applyTodoSnapshotForSession, sessionIdRef, setStatus } = ctx;
        const targetSessionId = sessionIdRef.current;
        if (!targetSessionId)
            return;
        const title = window.prompt(parentId ? "Child todo title" : "Todo title");
        if (!title?.trim())
            return;
        const details = window.prompt("Todo details", "");
        try {
            const response = await fetch(`/api/sessions/${encodeURIComponent(targetSessionId)}/todos/items`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ parentId, title, details: details ?? "", context: "", actor: "user" })
            });
            if (!response.ok)
                throw new Error(`Todo API returned ${response.status}`);
            applyTodoSnapshotForSession(targetSessionId, await response.json());
        }
        catch (error) {
            setStatus(error instanceof Error ? error.message : "Todo create failed");
        }
    
}

export async function setTodoPaused(ctx, paused) {
    const { applyTodoSnapshotForSession, sessionIdRef, setStatus } = ctx;
        const targetSessionId = sessionIdRef.current;
        if (!targetSessionId)
            return;
        const pauseReason = paused ? window.prompt("Pause reason", "Paused by user") : null;
        try {
            const response = await fetch(`/api/sessions/${encodeURIComponent(targetSessionId)}/todos/control`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ paused, pauseReason, actor: "user" })
            });
            if (!response.ok)
                throw new Error(`Todo API returned ${response.status}`);
            applyTodoSnapshotForSession(targetSessionId, await response.json());
        }
        catch (error) {
            setStatus(error instanceof Error ? error.message : "Todo control failed");
        }
    
}

export async function setTodoContext(ctx, context) {
    const { applyTodoSnapshotForSession, sessionIdRef, setStatus, visibleSessionTodo } = ctx;
        const targetSessionId = sessionIdRef.current;
        const targetTodo = visibleSessionTodo;
        if (!targetSessionId || !targetTodo)
            return;
        try {
            const response = await fetch(`/api/sessions/${encodeURIComponent(targetSessionId)}/todos/control`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    paused: targetTodo.control.paused,
                    pauseReason: targetTodo.control.pauseReason,
                    context,
                    actor: "user"
                })
            });
            if (!response.ok)
                throw new Error(`Todo API returned ${response.status}`);
            applyTodoSnapshotForSession(targetSessionId, await response.json());
        }
        catch (error) {
            setStatus(error instanceof Error ? error.message : "Todo context update failed");
        }
    
}

export async function addTodoComment(ctx, itemId, type, bodyOverride = null) {
    const { applyTodoSnapshotForSession, sessionIdRef, setStatus } = ctx;
        const targetSessionId = sessionIdRef.current;
        if (!targetSessionId)
            return;
        const body = bodyOverride ?? window.prompt(type === "blocker" ? "Blocker comment" : "Todo comment");
        if (!body?.trim())
            return;
        try {
            const response = await fetch(`/api/sessions/${encodeURIComponent(targetSessionId)}/todos/comments`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ itemId, type, body, author: "user" })
            });
            if (!response.ok)
                throw new Error(`Todo API returned ${response.status}`);
            applyTodoSnapshotForSession(targetSessionId, await response.json());
        }
        catch (error) {
            setStatus(error instanceof Error ? error.message : "Todo comment failed");
        }
    
}

export async function resolveTodoChallenge(ctx, challengeId) {
    const { applyTodoSnapshotForSession, sessionIdRef, setStatus } = ctx;
        const targetSessionId = sessionIdRef.current;
        if (!targetSessionId)
            return;
        try {
            const response = await fetch(`/api/sessions/${encodeURIComponent(targetSessionId)}/todos/challenges/${encodeURIComponent(String(challengeId))}/resolve`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ actor: "user" })
            });
            if (!response.ok)
                throw new Error(`Todo API returned ${response.status}`);
            applyTodoSnapshotForSession(targetSessionId, await response.json());
        }
        catch (error) {
            setStatus(error instanceof Error ? error.message : "Todo challenge resolve failed");
        }
    
}
