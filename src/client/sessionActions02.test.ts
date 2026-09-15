import assert from "node:assert/strict";
import test from "node:test";
import { isTerminalRunnerDurableEvent, switchWorkspace } from "./sessionActions02.js";

test("raw Codex completion does not finish a retrying manager turn", () => {
  assert.equal(isTerminalRunnerDurableEvent({
    type: "runner.codex",
    payload: { method: "turn/completed", params: { turn: { status: "failed" } } }
  }), false);

  for (const type of ["runner.result", "runner.pending", "runner.error", "runner.done"]) {
    assert.equal(isTerminalRunnerDurableEvent({ type }), true, type);
  }
  assert.equal(isTerminalRunnerDurableEvent({ type: "runner.item" }), false);
});

test("switching workspaces keeps the restored active session in the navigation URL", async () => {
  const originalFetch = globalThis.fetch;
  const navigationUpdates: Array<{ target: unknown; mode: string }> = [];
  const state: { selectedSessionSnapshot: { session: { id: string } } | null } = {
    selectedSessionSnapshot: null
  };
  globalThis.fetch = async () => new Response(JSON.stringify({
    activeWorkspace: { id: "workspace-two" },
    workspaces: []
  }), { status: 200 });

  try {
    const viewKeyRef = { current: 0 };
    let newSessionProject: string | null = "default-project";
    let newSessionBaseSessionId: string | null = "default-session";
    const eventStore = {
      getState: () => state,
      setSelectedSessionSnapshot: (snapshot: typeof state.selectedSessionSnapshot) => {
        state.selectedSessionSnapshot = snapshot;
      },
      setSessionPage: () => undefined
    };
    const switched = await switchWorkspace({
      activeWorkspace: { id: "default" },
      applyAccountPayload: () => undefined,
      bumpViewKey: () => { viewKeyRef.current += 1; },
      clearNewSessionProjectSelection: () => {
        newSessionProject = null;
        newSessionBaseSessionId = null;
      },
      clearTodoPanelState: () => undefined,
      createSystemMessage: (content: string) => ({ content }),
      eventStore,
      explicitNewSessionRef: { current: false },
      isCurrentViewKey: (viewKey: number) => viewKey === viewKeyRef.current,
      loadWorkspaceSnapshot: async () => {
        state.selectedSessionSnapshot = { session: { id: "workspace-two-session" } };
      },
      parentSessionTodo: null,
      replaceComposerDraftForSession: () => undefined,
      sessionIdRef: { current: "default-session" },
      sessionTodo: null,
      setActiveSessionId: () => undefined,
      setActiveTurnId: () => undefined,
      setActiveWorkspace: () => undefined,
      setMessages: () => undefined,
      setParentSessionTodo: () => undefined,
      setQueuedPrompts: () => undefined,
      setResumeThreadId: () => undefined,
      setSessionExecutionStatuses: () => undefined,
      setSessionId: () => undefined,
      setSessionTodo: () => undefined,
      setStatus: () => undefined,
      setThreadId: () => undefined,
      setWorkspaceList: () => undefined,
      toSessionPageState: () => ({}),
      updateNavigationUrl: (target: unknown, mode: string) => navigationUpdates.push({ target, mode }),
      viewKeyRef,
      workspaceList: []
    }, "workspace-two");

    assert.equal(switched, true);
    assert.equal(newSessionProject, null);
    assert.equal(newSessionBaseSessionId, null);
    assert.deepEqual(navigationUpdates, [{
      target: { workspaceId: "workspace-two", sessionId: "workspace-two-session" },
      mode: "push"
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
