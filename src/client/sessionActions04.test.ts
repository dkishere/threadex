import assert from "node:assert/strict";
import test from "node:test";
import {
  commitQueuedPromptEdit,
  editQueuedPrompt,
  insertEditedQueuedPrompt
} from "./sessionActions04";

function queuedPrompt(id: string, content = id) {
  return {
    id,
    kind: "queue" as const,
    content,
    attachments: [],
    executionMode: "default" as const,
    skills: []
  };
}

test("editing a queued prompt removes it and moves its text into the composer", () => {
  const prompts = [queuedPrompt("a"), queuedPrompt("b"), queuedPrompt("c")];
  const queuedPromptsRef = { current: prompts };
  const queuedPromptEditRef = { current: null as null | Record<string, unknown> };
  let currentQueue = prompts;
  let composerInput = "unfinished draft";
  let status = "";
  let focused = false;

  editQueuedPrompt({
    focusComposer: () => { focused = true; },
    input: composerInput,
    queuedPromptEditRef,
    queuedPromptsRef,
    setComposerInput: (value: string) => { composerInput = value; },
    setQueuedPrompts: (value: typeof prompts) => { currentQueue = value; },
    setStatus: (value: string) => { status = value; }
  }, "b");

  assert.deepEqual(currentQueue.map((prompt) => prompt.id), ["a", "c"]);
  assert.equal(composerInput, "b");
  assert.equal(queuedPromptEditRef.current?.displacedInput, "unfinished draft");
  assert.equal(status, "Editing queued prompt");
  assert.equal(focused, true);
});

test("an edited prompt returns to its original position when the queue is unchanged", () => {
  const a = queuedPrompt("a");
  const b = queuedPrompt("b", "before");
  const c = queuedPrompt("c");
  const edit = {
    prompt: b,
    originalIndex: 1,
    remainingPrompts: [a, c],
    displacedInput: "draft"
  };

  const result = insertEditedQueuedPrompt([a, c], edit, "after");

  assert.deepEqual(result.map((prompt) => prompt.id), ["a", "b", "c"]);
  assert.equal(result[1].content, "after");
  assert.equal(result[1].executionMode, "default");
});

test("an edited prompt moves to the tail when the queue changed", () => {
  const a = queuedPrompt("a");
  const b = queuedPrompt("b", "before");
  const c = queuedPrompt("c");
  const added = queuedPrompt("added");
  const edit = {
    prompt: b,
    originalIndex: 1,
    remainingPrompts: [a, c],
    displacedInput: "draft"
  };

  const result = insertEditedQueuedPrompt([a, c, added], edit, "after");

  assert.deepEqual(result.map((prompt) => prompt.id), ["a", "c", "added", "b"]);
});

test("committing an edit restores the displaced composer draft and clears transient state", () => {
  const a = queuedPrompt("a");
  const b = queuedPrompt("b", "before");
  const editRef = {
    current: {
      prompt: b,
      originalIndex: 1,
      remainingPrompts: [a],
      displacedInput: "unfinished draft"
    } as null | Record<string, unknown>
  };
  let currentQueue = [a];
  let composerInput = "after";

  const committed = commitQueuedPromptEdit({
    focusComposer() {},
    queuedPromptEditRef: editRef,
    setComposerInput: (value: string) => { composerInput = value; },
    setQueuedPrompts: (update: (current: typeof currentQueue) => typeof currentQueue) => {
      currentQueue = update(currentQueue);
    },
    setStatus() {}
  }, "after");

  assert.equal(committed, true);
  assert.equal(editRef.current, null);
  assert.equal(composerInput, "unfinished draft");
  assert.deepEqual(currentQueue.map((prompt) => prompt.id), ["a", "b"]);
  assert.equal(currentQueue[1].content, "after");
});
