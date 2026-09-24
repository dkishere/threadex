import assert from "node:assert/strict";
import test from "node:test";
import { parseBrowserBridgeContext } from "./browserBridgeContext";
import { deletePendingTurn, handleEditorKeyDown, handleEditorPaste, removeWaitSubscription, steerPendingTurn } from "./sessionActions05";
import { EventStore, type WaitSubscription } from "./eventStore";
import { buildTurnIssueCopyPayload, parseTurnIssueContext } from "./turnIssueCopy";

const context = {
  kind: "browser-bridge-context",
  tabId: 42,
  url: "https://example.test/assessment",
  title: "Assessment",
  selector: "main > button",
  "extension-context-key": "codex-browser-bridge:context:42:test"
};

for (const [action, method, suffix] of [
  [deletePendingTurn, "DELETE", ""],
  [steerPendingTurn, "POST", "/steer"]
] as const) {
  test(`${method} submitted queued prompt updates the backend before refreshing the UI`, async (t) => {
    const events: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
      assert.equal(url, `/api/pending-turns/queued-1${suffix}`);
      assert.equal(options?.method, method);
      assert.deepEqual(JSON.parse(String(options?.body)), { sessionId: "session-1" });
      events.push("backend");
      return Response.json({ ok: true });
    });
    const changed = await action({
      sessionId: "session-1",
      isLikelyBackendDisconnect: () => false,
      noteBackendDisconnect: () => assert.fail("unexpected disconnect"),
      noteBackendRequestSucceeded: () => events.push("ack"),
      refreshSelectedSessionSnapshot: async () => { events.push("snapshot"); },
      setStatus: () => events.push("status"),
      showToast: () => assert.fail("unexpected error")
    }, "queued-1");
    assert.equal(changed, true);
    assert.deepEqual(events, ["backend", "ack", "snapshot", "status"]);
  });
}

for (const outcome of ["cancelled", "dispatching", "done", "invalid", "error"] as const) {
  test(`removing a wait applies ${outcome} response without waiting for background sync`, async (t) => {
    const store = new EventStore();
    const subscription = {
      id: "rate_limit:test", workspaceId: "default", status: outcome === "cancelled" ? "dispatching" : "waiting", actionType: "retry_turn",
      updated: "2026-09-19T10:00:00.000Z"
    } as WaitSubscription;
    store.setWorkspaceSnapshot({ waitSubscriptions: [subscription] }, store.getState().sessionPage, null, 0);
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { confirm: () => true } });
    t.after(() => {
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    });
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(
      outcome === "invalid" ? {} : {
        cancelled: outcome === "cancelled",
        subscription: { ...subscription, status: outcome, updated: "2026-09-19T10:01:00.000Z" }
      }
    ), { status: outcome === "error" ? 500 : 200 }));
    let finishPoll!: (value: boolean) => void;
    const background = new Promise<boolean>((resolve) => { finishPoll = resolve; });
    t.mock.method(store, "poll", () => background);
    const toasts: string[] = [];
    const actions: unknown[] = [];
    try {
      await removeWaitSubscription({
        eventStore: store, isLikelyBackendDisconnect: () => false,
        noteBackendDisconnect: () => assert.fail("not a connection error"),
        noteBackendRequestSucceeded: () => undefined, readApiError: async () => "Server error",
        setWaitSubscriptionAction: (action: unknown) => actions.push(action),
        showToast: (message: string) => toasts.push(message)
      }, subscription);
      assert.equal(actions.at(-1), null, "UI is unlocked while background poll is pending");
      if (outcome === "cancelled" || outcome === "done") {
        assert.equal(store.getState().waitSubscriptions.length, 0);
        assert.equal(toasts[0], outcome === "cancelled" ? "Pending wait removed" : "Wait already completed");
      } else {
        assert.equal(store.getState().waitSubscriptions[0].status, outcome === "dispatching" ? "dispatching" : "waiting");
        assert.match(toasts[0], outcome === "dispatching" ? /could not be cancelled/ : /Remove failed/);
      }
    } finally {
      finishPoll(false);
    }
  });
}

test("pasting a browser bridge context creates an annotation attachment instead of editor text", () => {
  let prevented = false;
  let attached: unknown = null;
  const event = {
    clipboardData: {
      getData: () => JSON.stringify(context),
      files: [],
      items: []
    },
    preventDefault: () => { prevented = true; }
  };

  handleEditorPaste({
    MAX_ATTACHMENTS: 4,
    addFiles: () => assert.fail("image handler must not run"),
    addPastedBrowserBridgeContext: (value: unknown) => { attached = value; },
    addPastedText: () => assert.fail("text attachment handler must not run"),
    attachments: [],
    parseBrowserBridgeContext,
    setStatus: () => undefined,
    shouldCompactPastedText: () => false
  }, event);

  assert.equal(prevented, true);
  assert.deepEqual(attached, context);
});

test("pasting a Threadex issue context creates an attachment instead of editor text", () => {
  const issueContext = buildTurnIssueCopyPayload({
    id: "codex-session-123",
    workspaceId: "threadex",
    sessionId: "local_session-1",
    turnId: "turn-2",
    issueKey: 1,
    issue: "The copied issue was pasted as plain text",
    solution: null
  });
  let prevented = false;
  let attached: unknown = null;
  const event = {
    clipboardData: {
      getData: () => JSON.stringify(issueContext),
      files: [],
      items: []
    },
    preventDefault: () => { prevented = true; }
  };

  handleEditorPaste({
    MAX_ATTACHMENTS: 4,
    addFiles: () => assert.fail("image handler must not run"),
    addPastedBrowserBridgeContext: () => assert.fail("browser context handler must not run"),
    addPastedTurnIssueContext: (value: unknown) => { attached = value; },
    addPastedText: () => assert.fail("text attachment handler must not run"),
    attachments: [],
    parseBrowserBridgeContext,
    parseTurnIssueContext,
    setStatus: () => undefined,
    shouldCompactPastedText: () => false
  }, event);

  assert.equal(prevented, true);
  assert.deepEqual(attached, issueContext);
});

const suggestions = [
  { kind: "keyword", name: "deploy", insertText: "deploy " },
  { kind: "keyword", name: "debug", insertText: "debug " }
];

function suggestionKeyContext(overrides: Record<string, unknown> = {}) {
  return {
    canSend: true,
    composerSuggestionIndex: -1,
    composerSuggestionTrigger: { start: 0, end: 3, query: "dep" },
    currentSessionIsRunning: false,
    selectComposerSuggestion: () => assert.fail("suggestion should not be accepted"),
    selectSlashSuggestion: () => undefined,
    setComposerSuggestionIndex: () => undefined,
    setComposerSuggestionTrigger: () => undefined,
    setSlashSuggestionIndex: () => undefined,
    setSlashTrigger: () => undefined,
    slashSuggestionIndex: 0,
    slashTrigger: null,
    submitSteer: () => undefined,
    visibleComposerSuggestions: suggestions,
    visibleSlashSuggestions: [],
    ...overrides
  };
}

function keyEvent(key: string, overrides: Record<string, unknown> = {}) {
  let prevented = false;
  let submitted = false;
  return {
    event: {
      key,
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: () => { prevented = true; },
      currentTarget: { closest: () => ({ requestSubmit: () => { submitted = true; } }) },
      ...overrides
    },
    prevented: () => prevented,
    submitted: () => submitted
  };
}

for (const modifier of ["ctrlKey", "metaKey"] as const) {
  test(`${modifier === "ctrlKey" ? "Ctrl" : "Cmd"}+Enter steers the running session directly`, () => {
    let steered = false;
    const input = keyEvent("Enter", { [modifier]: true });
    handleEditorKeyDown(suggestionKeyContext({
      currentSessionIsRunning: true,
      submitSteer: () => { steered = true; }
    }), input.event);

    assert.equal(input.prevented(), true);
    assert.equal(input.submitted(), false);
    assert.equal(steered, true);
  });
}

test("Tab accepts the first composer suggestion without arrow-key navigation", () => {
  let selected: unknown = null;
  const input = keyEvent("Tab");
  handleEditorKeyDown(suggestionKeyContext({ selectComposerSuggestion: (suggestion: unknown) => { selected = suggestion; } }), input.event);
  assert.equal(input.prevented(), true);
  assert.equal(selected, suggestions[0]);
});

test("Arrow keys start composer suggestion navigation at the nearest edge", () => {
  let nextIndex: number | null = null;
  const down = keyEvent("ArrowDown");
  handleEditorKeyDown(suggestionKeyContext({
    setComposerSuggestionIndex: (update: (current: number) => number) => { nextIndex = update(-1); }
  }), down.event);
  assert.equal(nextIndex, 0);

  const up = keyEvent("ArrowUp");
  handleEditorKeyDown(suggestionKeyContext({
    setComposerSuggestionIndex: (update: (current: number) => number) => { nextIndex = update(-1); }
  }), up.event);
  assert.equal(nextIndex, suggestions.length - 1);
});

for (const key of ["Enter", " "]) {
  test(`${key === " " ? "Space" : key} accepts a composer suggestion after keyboard navigation`, () => {
    let selected: unknown = null;
    const input = keyEvent(key);
    handleEditorKeyDown(suggestionKeyContext({
      composerSuggestionIndex: 1,
      selectComposerSuggestion: (suggestion: unknown) => { selected = suggestion; }
    }), input.event);
    assert.equal(input.prevented(), true);
    assert.equal(input.submitted(), false);
    assert.equal(selected, suggestions[1]);
  });
}

test("Enter still submits when no composer suggestion was keyboard-selected", () => {
  const input = keyEvent("Enter");
  handleEditorKeyDown(suggestionKeyContext(), input.event);
  assert.equal(input.prevented(), true);
  assert.equal(input.submitted(), true);
});

for (const nativeEvent of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
  for (const key of ["Enter", " ", "Tab", "ArrowDown", "ArrowUp", "Escape"]) {
    test(`IME ${JSON.stringify(nativeEvent)} keeps ${JSON.stringify(key)} out of composer shortcuts`, () => {
      const unexpected = () => assert.fail("IME input must not change suggestions");
      for (const slashTrigger of [null, { query: "dep" }]) {
        for (const composerSuggestionIndex of [-1, 1]) {
          const input = keyEvent(key, { nativeEvent });
          handleEditorKeyDown(suggestionKeyContext({
            slashTrigger,
            composerSuggestionIndex,
            visibleSlashSuggestions: suggestions,
            selectSlashSuggestion: unexpected,
            selectComposerSuggestion: unexpected,
            setSlashSuggestionIndex: unexpected,
            setComposerSuggestionIndex: unexpected,
            setSlashTrigger: unexpected,
            setComposerSuggestionTrigger: unexpected
          }), input.event);
          assert.equal(input.prevented(), false);
          assert.equal(input.submitted(), false);
        }
      }
    });
  }
}
