import assert from "node:assert/strict";
import test from "node:test";
import { parseBrowserBridgeContext } from "./browserBridgeContext";
import { handleEditorKeyDown, handleEditorPaste } from "./sessionActions05";
import { buildTurnIssueCopyPayload, parseTurnIssueContext } from "./turnIssueCopy";

const context = {
  kind: "browser-bridge-context",
  tabId: 42,
  url: "https://example.test/assessment",
  title: "Assessment",
  selector: "main > button",
  "extension-context-key": "codex-browser-bridge:context:42:test"
};

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
