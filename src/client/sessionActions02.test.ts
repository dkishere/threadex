import assert from "node:assert/strict";
import test from "node:test";
import { handleDurableEvent, isTerminalRunnerDurableEvent, switchWorkspace } from "./sessionActions02.js";

test("durable approval resolution updates transcript items and segments without a runner stream", async () => {
  const item = { itemType: "approval", approvalId: "question", status: "pending" };
  let messages: any[] = [{ role: "assistant", liveItems: [item], segments: [{ type: "live", item }, { type: "text", text: "Keep this text" }] }];
  const decision = { answers: { scope: { answers: ["UI"] } } };
  const removed: string[] = [];
  const ctx = { sessionIdRef: { current: "selected" }, removePendingApprovalItem: (id: string) => removed.push(id), setMessages: (update: any) => { messages = update(messages); } };
  await handleDurableEvent(ctx, { type: "runner.approval.resolved", sessionId: "background", payload: { sessionId: "background", approvalId: "question", decision } });
  assert.equal(messages[0].liveItems[0].status, "pending");
  await handleDurableEvent(ctx, { type: "runner.approval.resolved", sessionId: "selected", payload: { sessionId: "selected", approvalId: "question", decision } });
  assert.equal(messages[0].liveItems[0].status, "resolved");
  assert.deepEqual(messages[0].segments[0].item.decision, decision);
  assert.equal(messages[0].segments[1].text, "Keep this text");
  assert.deepEqual(removed, ["question", "question"]);
});

test("durable approval expiry marks transcript cards expired and a re-registration revives them", async () => {
  const item = { itemType: "approval", approvalId: "command", status: "pending" };
  let messages: any[] = [{ role: "assistant", liveItems: [item], segments: [{ type: "live", item }] }];
  const ctx = { sessionIdRef: { current: "selected" }, removePendingApprovalItem: () => undefined,
    approvalEventToLiveItem: (approval: any, status: string) => ({ ...approval, itemType: "approval", status }),
    setPendingApprovalItems: () => undefined, setPendingApprovalSessionIds: () => undefined, upsertPendingApprovalItem: (current: unknown) => current,
    setMessages: (update: any) => { messages = update(messages); } };
  await handleDurableEvent(ctx, { type: "runner.approval.resolved", sessionId: "selected", payload: { sessionId: "selected", approvalId: "command", expired: true, error: "Expired" } });
  assert.equal(messages[0].liveItems[0].status, "expired");
  assert.equal(messages[0].segments[0].item.status, "expired");
  await handleDurableEvent(ctx, { type: "runner.approval.requested", sessionId: "selected", payload: { sessionId: "selected", approvalId: "command" } });
  assert.equal(messages[0].liveItems[0].status, "pending");
  assert.equal(messages[0].segments[0].item.error, undefined);
});

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
