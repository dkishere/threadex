import assert from "node:assert/strict";
import test from "node:test";
import { currentWorkspaceId, loadSessions, selectedSessionReferences, steerPrompt, submit } from "./sessionActions01";
import { toSessionPageState } from "./sessionUtils";

function steerTestContext(t: import("node:test").TestContext) {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => ({ matches: false }) } });
  t.after(() => {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  });
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
    return Response.json({ commandId: "steer-1", attachments: [] });
  });
  assert.equal(await steerPrompt(ctx, state.input, [], true, [], true), "sent");
  assert.equal(body.turnId, "original-turn");
  assert.equal(body.forcePlan, true);
  assert.equal(state.queued.length, 0);
  assert.equal(state.sent.length, 1);
  assert.equal(state.steering, false);
});

test("a rejected steer stays a draft when stop and send have already started another turn", async (t) => {
  const { ctx, state } = steerTestContext(t);
  let finishRequest!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>((resolve) => { finishRequest = resolve; }));
  const pending = steerPrompt(ctx, state.input, [], true, [], false);
  ctx.currentRunningTurnId = "next-turn";
  finishRequest(Response.json({ error: "Agent is not running." }, { status: 409 }));
  assert.equal(await pending, false);
  assert.equal(state.input, "correct direction");
  assert.equal(state.queued.length, 0);
  assert.equal(state.sent.length, 0);
  assert.match(state.status, /target turn has stopped or finished/);
  assert.equal(state.steering, false);
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

test("consumes goal mode after submitting one prompt", async () => {
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
      executionMode: "goal",
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
  assert.equal(startedTurns[0][2], "goal");
});

test("does not consume goal mode for an empty submission", async () => {
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
      executionMode: "goal",
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
      executionMode: "default",
      forkNextPrompt: false,
      formatComposerLinkMarkdown() { return ""; },
      formatResponseAnnotationsPrompt() { return ""; },
      input: "Change direction",
      queuePrompt(message: string) { queued.push(message); },
      replaceComposerLinkTokens(value: string) { return value; },
      selectedSkills: [],
      sessionIdRef: { current: "session-1" },
      setComposerExecutionMode() {},
      setComposerForkNextPrompt() {},
      async startChatTurn() {},
      async steerPrompt(message: string) { steered.push(message); }
    },
    undefined,
    "steer"
  );

  assert.deepEqual(queued, []);
  assert.deepEqual(steered, ["Change direction"]);
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
