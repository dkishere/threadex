import assert from "node:assert/strict";
import test from "node:test";
import { currentWorkspaceId, enqueuePrompt, loadSessions, selectedSessionReferences, startChatTurn, steerPrompt, submit } from "./sessionActions01";
import { mockSubmissionStorage } from "./pendingSubmissions.testSupport";
import { acknowledgeSubmissionEvent, isSubmissionSending, readPendingSubmissions } from "./pendingSubmissions";
import { toSessionPageState } from "./sessionUtils";

test("direct submission is saved before composer clearing and survives a failed fetch", async t => {
  mockSubmissionStorage(t);
  let cleared = false;
  let postedTurnId: string | undefined;
  const noop = () => {};
  const ctx = new Proxy({
    activeWorkspaceIdRef: { current: "workspace" }, sessionIdRef: { current: "session" },
    stickToMessageBottomRef: { current: false }, viewKeyRef: { current: "view" },
    newSessionBaseSessionIdRef: { current: null }, streamTargetsRef: { current: {} },
    currentModelPreferences: () => ({ selectedModel: "model", selectedEffort: "low" }),
    resumeThreadId: "thread", selectedModel: "model",
    clearComposerInputDraft: () => {
      assert.equal(readPendingSubmissions()[0].message, "Do not lose this");
      cleared = true;
    },
    registerStreamTarget: (turnId: string, assistantMessageId: string, sessionId: string) => ({ turnId, assistantMessageId, sessionId }),
    reconnectRunner: async () => false,
  }, { get: (target, key) => key in target ? Reflect.get(target, key) : noop });
  t.mock.method(globalThis, "fetch", async (_url: string, options?: RequestInit) => {
    postedTurnId = JSON.parse(String(options?.body)).turnId;
    assert.equal(cleared, true);
    assert.equal(isSubmissionSending("session"), true);
    throw new Error("Network disconnected");
  });
  await startChatTurn(ctx, "Do not lose this", [], "default", [], false, false, true, undefined, "stable-turn");
  assert.equal(postedTurnId, "stable-turn");
  assert.equal(readPendingSubmissions()[0].turnId, postedTurnId);
  assert.equal(isSubmissionSending("session"), false);
});

test("start ack releases the composer while the response stream is still open", async t => {
  mockSubmissionStorage(t);
  let release!: () => void;
  let emit!: (event: any) => void;
  const streamEnded = new Promise<void>(resolve => { release = resolve; });
  const noop = () => {};
  const ctx = new Proxy({
    activeWorkspaceIdRef: { current: "workspace" }, sessionIdRef: { current: "session" },
    stickToMessageBottomRef: { current: false }, viewKeyRef: { current: "view" },
    newSessionBaseSessionIdRef: { current: null }, streamTargetsRef: { current: {} },
    currentModelPreferences: () => ({ selectedModel: "model", selectedEffort: "low" }),
    resumeThreadId: "thread", selectedModel: "model",
    registerStreamTarget: (turnId: string, assistantMessageId: string, sessionId: string) => ({ turnId, assistantMessageId, sessionId }),
    handleStreamEvent: (event: any, target: any) => acknowledgeSubmissionEvent(event, target.turnId),
    readEventStream: async (_body: unknown, onEvent: (event: any) => void) => { emit = onEvent; await streamEnded; }
  }, { get: (target, key) => key in target ? Reflect.get(target, key) : noop });
  t.mock.method(globalThis, "fetch", async () => new Response(""));
  const running = startChatTurn(ctx, "wait for ack", [], "default", [], false, false, true, undefined, "sending-turn");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(isSubmissionSending("session"), true, "HTTP 200 does not release input");
  assert.equal(isSubmissionSending("another-session"), false);
  assert.equal(await startChatTurn(ctx, "duplicate", [], "default", [], false, false, true), false);
  emit({ type: "session", data: { sessionId: "session", turnId: "sending-turn", message: "Prompt runner started" } });
  assert.equal(isSubmissionSending("session"), false);
  assert.equal(readPendingSubmissions().length, 0);
  release();
  await running;
});

test("failed local write preserves direct and queued composer input", async t => {
  const storage = mockSubmissionStorage(t);
  t.mock.method(storage, "setItem", () => { throw new Error("Quota exceeded"); });
  let cleared = false;
  let status = "";
  const ctx = {
    activeWorkspaceIdRef: { current: "workspace" }, sessionIdRef: { current: "session" },
    stickToMessageBottomRef: { current: false }, currentModelPreferences: () => ({}),
    clearComposerInputDraft: () => { cleared = true; },
    setStatus: (value: string) => { status = value; }
  };
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not send"); });
  assert.equal(await startChatTurn(ctx, "retain", [], "default", [], false, false, true), false);
  assert.equal(enqueuePrompt(ctx, "retain", "queue", "default", [], [], false, false, true), false);
  assert.equal(cleared, false);
  assert.equal(fetch.mock.callCount(), 0);
  assert.match(status, /unable to save locally/);
});

test("ordinary queue writes once to the backend and does not create a frontend queue item", async t => {
  mockSubmissionStorage(t);
  const calls: Array<{ url: string; body: any }> = [];
  let localQueueChanged = false;
  let refreshed: [string, string] | undefined;
  let cleared = false;
  const ctx = {
    activeWorkspaceIdRef: { current: "workspace" },
    sessionIdRef: { current: "session" },
    requestSettings: { model: "model", approvalPolicy: "never", clientLayout: "desktop" },
    clearComposerInputDraft: () => { cleared = true; },
    clearComposerSessionLinks() {},
    setAttachments() {},
    setComposerResponseQuote() {},
    setResponseQuotePopover() {},
    setSelectedSkills() {},
    setSlashTrigger() {},
    setStatus() {},
    setQueuedPrompts() { localQueueChanged = true; },
    refreshSelectedSessionSnapshot: async (sessionId: string, turnId: string) => { refreshed = [sessionId, turnId]; }
  };
  t.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(options?.body)) });
    return new Response(JSON.stringify({ ok: true, turn: { id: calls[0].body.turnId, status: "todo" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  });

  const result = await enqueuePrompt(ctx, "run this after the active turn", "queue", "goal", [{ name: "skill" }], [{ id: "file-1", name: "note.txt" }], false, true);

  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/pending-turns");
  assert.equal(calls[0].body.message, "run this after the active turn");
  assert.equal(calls[0].body.executionMode, "goal");
  assert.deepEqual(calls[0].body.attachments, [{ id: "file-1", name: "note.txt" }]);
  assert.equal(calls[0].body.forcePlan, true);
  assert.equal(localQueueChanged, false);
  assert.equal(cleared, true);
  assert.deepEqual(refreshed, ["session", calls[0].body.turnId]);
  assert.equal(readPendingSubmissions().length, 0);
});

test("new-session input is already backed up while session restoration is pending", async t => {
  mockSubmissionStorage(t);
  const ctx = {
    activeWorkspaceIdRef: { current: "workspace" }, sessionIdRef: { current: null },
    stickToMessageBottomRef: { current: false }, currentModelPreferences: () => ({}),
    setStatus() {},
    restoreKnownActiveSessionBeforeSend: async () => {
      assert.equal(readPendingSubmissions()[0].message, "Before restore");
      return false;
    }
  };
  assert.equal(await startChatTurn(ctx, "Before restore", [], "default", [], false, false, true), false);
  assert.equal(readPendingSubmissions().length, 1);
  assert.equal(isSubmissionSending(null), false);
});

function steerTestContext(t: import("node:test").TestContext) {
  mockSubmissionStorage(t);
  const state = { input: "correct direction", queued: [] as unknown[][], sent: [] as unknown[][], status: "", steering: false };
  const ctx = {
    currentRunningTurnId: "original-turn", sessionIdRef: { current: "session-1" }, isSteering: false,
    executionMode: "default",
    enqueuePrompt: (...args: unknown[]) => state.queued.push(args),
    addSteerMessage: (...args: unknown[]) => state.sent.push(args),
    clearComposerInputDraft: () => { state.input = ""; },
    clearComposerSessionLinks() {}, setAttachments() {}, setComposerResponseQuote() {},
    setResponseQuotePopover() {}, setSelectedSkills() {}, setSlashTrigger() {},
    setComposerForcePlanNextPrompt() {},
    setComposerInput: (update: (input: string) => string) => { state.input = update(state.input); },
    setIsSteering: (value: boolean) => { state.steering = value; },
    setStatus: (value: string) => { state.status = value; },
    showToast() {}, noteBackendRequestSucceeded() {}, noteBackendDisconnect() {},
    isLikelyBackendDisconnect: () => false, parseResponseAnnotations: () => null,
    isInactiveSteerResponse: (status: number) => status === 409,
    async refreshSelectedSessionSnapshot() {}
  };
  return { ctx, state };
}

test("outcome tracking sends a steer to the current turn without queuing", async (t) => {
  const { ctx, state } = steerTestContext(t);
  let body: Record<string, unknown> = {};
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    body = JSON.parse(String(options.body));
    assert.equal(readPendingSubmissions()[0].message, "correct direction");
    return Response.json({ ok: true, commandId: "steer-1", attachments: [] });
  });
  assert.equal(await steerPrompt(ctx, state.input, [], true, [], true), "sent");
  assert.equal(body.turnId, "original-turn");
  assert.equal(body.forcePlan, true);
  assert.equal(state.queued.length, 0);
  assert.equal(state.sent.length, 1);
  assert.equal(state.steering, false);
  assert.equal(readPendingSubmissions().length, 0);
});

test("a rejected steer stays a draft when stop and send have already started another turn", async (t) => {
  const { ctx, state } = steerTestContext(t);
  let finishRequest!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>((resolve) => { finishRequest = resolve; }));
  const pending = steerPrompt(ctx, state.input, [], true, [], false);
  assert.equal(isSubmissionSending("session-1"), true);
  ctx.currentRunningTurnId = "next-turn";
  finishRequest(Response.json({ error: "Agent is not running." }, { status: 409 }));
  assert.equal(await pending, false);
  assert.equal(state.input, "correct direction");
  assert.equal(state.queued.length, 0);
  assert.equal(state.sent.length, 0);
  assert.match(state.status, /target turn has stopped or finished/);
  assert.equal(readPendingSubmissions()[0].message, "correct direction");
  assert.equal(state.steering, false);
  assert.equal(isSubmissionSending("session-1"), false);
});

test("uses the live workspace ref instead of a stale rendered workspace", () => {
  assert.equal(
    currentWorkspaceId({ current: "default" }, { id: "threadex" }),
    "default"
  );
});

test("falls back to the rendered workspace before the ref is initialized", () => {
  assert.equal(currentWorkspaceId({ current: null }, { id: "threadex" }), "threadex");
});

test("formats selected sessions as newline-separated Codex references", () => {
  assert.equal(
    selectedSessionReferences(
      [
        { workspaceId: "one", id: "local_1" },
        { workspaceId: "two", id: "local_2" }
      ],
      (workspaceId: string, id: string) => `codex://threads/${id}?workspace=${workspaceId}`
    ),
    "codex://threads/local_1?workspace=one\ncodex://threads/local_2?workspace=two"
  );
});

test("consumes Loop mode after submitting one prompt", async () => {
  const executionModeUpdates: string[] = [];
  const startedTurns: unknown[][] = [];

  await submit(
    {
      attachments: [],
      composerLinkToken: (id: string) => id,
      composerMode: "queue",
      composerResponseQuote: null,
      composerSessionLinks: [],
      composerTodoPlanModeEnabled: false,
      currentSessionIsRunning: false,
      enqueuePrompt() {},
      executionMode: "loop",
      forkNextPrompt: false,
      formatComposerLinkMarkdown() { return ""; },
      formatResponseAnnotationsPrompt() { return ""; },
      input: "Finish this task",
      queuePrompt() {},
      replaceComposerLinkTokens(value: string) { return value; },
      selectedSkills: [],
      sessionIdRef: { current: "session-1" },
      setComposerExecutionMode(mode: string) { executionModeUpdates.push(mode); },
      setComposerForkNextPrompt() {},
      async startChatTurn(...args: unknown[]) { startedTurns.push(args); },
      async steerPrompt() {}
    },
    { preventDefault() {} }
  );

  assert.deepEqual(executionModeUpdates, ["default"]);
  assert.equal(startedTurns.length, 1);
  assert.equal(startedTurns[0][2], "loop");
});

test("does not consume Loop mode for an empty submission", async () => {
  const executionModeUpdates: string[] = [];

  await submit(
    {
      attachments: [],
      composerLinkToken: (id: string) => id,
      composerMode: "queue",
      composerResponseQuote: null,
      composerSessionLinks: [],
      composerTodoPlanModeEnabled: false,
      currentSessionIsRunning: false,
      enqueuePrompt() {},
      executionMode: "loop",
      forkNextPrompt: false,
      formatComposerLinkMarkdown() { return ""; },
      formatResponseAnnotationsPrompt() { return ""; },
      input: "   ",
      queuePrompt() {},
      replaceComposerLinkTokens(value: string) { return value; },
      selectedSkills: [],
      sessionIdRef: { current: "session-1" },
      setComposerExecutionMode(mode: string) { executionModeUpdates.push(mode); },
      setComposerForkNextPrompt() {},
      async startChatTurn() {},
      async steerPrompt() {}
    },
    { preventDefault() {} }
  );

  assert.deepEqual(executionModeUpdates, []);
});

test("direct steer submission bypasses the queue even when queue mode is active", async () => {
  const queued: string[] = [];
  const steered: string[] = [];
  const executionModeUpdates: string[] = [];

  await submit(
    {
      attachments: [],
      composerLinkToken: (id: string) => id,
      composerMode: "queue",
      composerResponseQuote: null,
      composerSessionLinks: [],
      composerTodoPlanModeEnabled: false,
      currentSessionIsRunning: true,
      enqueuePrompt(message: string) { queued.push(message); },
      executionMode: "loop",
      forkNextPrompt: false,
      formatComposerLinkMarkdown() { return ""; },
      formatResponseAnnotationsPrompt() { return ""; },
      input: "Change direction",
      queuePrompt(message: string) { queued.push(message); },
      replaceComposerLinkTokens(value: string) { return value; },
      selectedSkills: [],
      sessionIdRef: { current: "session-1" },
      setComposerExecutionMode(mode: string) { executionModeUpdates.push(mode); },
      setComposerForkNextPrompt() {},
      async startChatTurn() {},
      async steerPrompt(message: string) { steered.push(message); }
    },
    undefined,
    "steer"
  );

  assert.deepEqual(queued, []);
  assert.deepEqual(steered, ["Change direction"]);
  assert.deepEqual(executionModeUpdates, []);
});

test("submitting a queued prompt edit commits it without starting a new turn", async () => {
  const editRef = { current: { promptId: "queued-1" } };
  let committed = "";
  let started = false;

  await submit(
    {
      attachments: [],
      commitQueuedPromptEdit(value: string) { committed = value; },
      composerLinkToken: (id: string) => id,
      composerMode: "queue",
      composerResponseQuote: null,
      composerSessionLinks: [],
      composerTodoPlanModeEnabled: false,
      currentSessionIsRunning: false,
      enqueuePrompt() {},
      executionMode: "default",
      forkNextPrompt: false,
      formatComposerLinkMarkdown() { return ""; },
      formatResponseAnnotationsPrompt() { return ""; },
      input: "  edited queue text  ",
      queuePrompt() {},
      queuedPromptEditRef: editRef,
      replaceComposerLinkTokens(value: string) { return value; },
      selectedSkills: [],
      sessionIdRef: { current: "session-1" },
      setComposerExecutionMode() {},
      setComposerForkNextPrompt() {},
      async startChatTurn() { started = true; },
      async steerPrompt() {}
    },
    { preventDefault() {} }
  );

  assert.equal(committed, "edited queue text");
  assert.equal(started, false);
});

test("preserves composer line breaks when submitting a prompt", async () => {
  const startedTurns: unknown[][] = [];

  await submit(
    {
      attachments: [],
      composerLinkToken: (id: string) => id,
      composerMode: "queue",
      composerResponseQuote: null,
      composerSessionLinks: [],
      composerTodoPlanModeEnabled: false,
      currentSessionIsRunning: false,
      enqueuePrompt() {},
      executionMode: "default",
      forkNextPrompt: false,
      formatComposerLinkMarkdown() { return ""; },
      formatResponseAnnotationsPrompt() { return ""; },
      input: "First line\nSecond line",
      queuePrompt() {},
      replaceComposerLinkTokens(value: string) { return value; },
      selectedSkills: [],
      sessionIdRef: { current: "session-1" },
      setComposerExecutionMode() {},
      setComposerForkNextPrompt() {},
      async startChatTurn(...args: unknown[]) { startedTurns.push(args); },
      async steerPrompt() {}
    },
    { preventDefault() {} }
  );

  assert.equal(startedTurns[0][0], "First line\nSecond line");
});

test("loads the next page for one project without replacing other projects", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let loadingProjects = new Set<string>();
  let received: unknown = null;
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      sessions: [{ id: "alpha-21", cwd: "/work/alpha" }],
      page: { offset: 20, limit: 20, hasMore: false, total: 21, nextOffset: null }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    await loadSessions({
      eventStore: {
        setSessionProjectPage(cwd: string, page: unknown, sessions: unknown[]) {
          received = { cwd, page, sessions };
        }
      },
      isLikelyBackendDisconnect() { return false; },
      noteBackendDisconnect() {},
      noteBackendRequestSucceeded() {},
      setIsLoadingSessions() {},
      setLoadingSessionProjects(update: (current: Set<string>) => Set<string>) {
        loadingProjects = update(loadingProjects);
      },
      setStatus() {},
      toSessionPageState
    }, 20, true, "/work/alpha");

    assert.equal(requestedUrl, "/api/sessions?cwd=%2Fwork%2Falpha&offset=20");
    assert.deepEqual(received, {
      cwd: "/work/alpha",
      page: {
        cwd: "/work/alpha",
        offset: 20,
        limit: 20,
        hasMore: false,
        total: 21,
        nextOffset: null
      },
      sessions: [{ id: "alpha-21", cwd: "/work/alpha" }]
    });
    assert.equal(loadingProjects.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
