import assert from "node:assert/strict";
import test from "node:test";
import { currentWorkspaceId, loadSessions, selectedSessionReferences, submit } from "./sessionActions01";
import { toSessionPageState } from "./sessionUtils";

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
