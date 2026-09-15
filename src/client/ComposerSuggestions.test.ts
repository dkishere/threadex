import assert from "node:assert/strict";
import test from "node:test";
import { findComposerSuggestionTrigger } from "./ComposerSuggestions";

test("composer suggestions use the token at the caret instead of the end of the input", () => {
  assert.deepEqual(findComposerSuggestionTrigger("please dep after", 10), {
    start: 7,
    end: 10,
    query: "dep"
  });
});

test("composer suggestions do not trigger when the caret follows whitespace or a slash token", () => {
  assert.equal(findComposerSuggestionTrigger("please dep after", 7), null);
  assert.equal(findComposerSuggestionTrigger("please /dep after", 11), null);
});
