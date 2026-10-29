import assert from "node:assert/strict";
import test from "node:test";
import { actorComposerTrigger, actorSuggestionScope } from "./useActorComposerSuggestions";

test("actor suggestion triggers preserve mention ownership and support keywords, files and slash skills at the caret", () => {
  assert.equal(actorComposerTrigger("hi @Reviewer"), null);
  assert.equal(actorComposerTrigger("hi "), null);
  assert.deepEqual(actorComposerTrigger("please dep later", 10), { start: 7, end: 10, query: "dep", slash: false });
  assert.deepEqual(actorComposerTrigger("please /browser later", 15), { start: 7, end: 15, query: "browser", slash: true });
  assert.deepEqual(actorComposerTrigger("/"), { start: 0, end: 1, query: "", slash: true });
});

test("suggestion requests follow the chat's project and fall back to the workspace root", () => {
  assert.deepEqual(actorSuggestionScope("w 1", "dev"), { files: "workspaceId=w%201&projectId=dev", skills: "workspaceId=w%201&projectId=dev" });
  assert.deepEqual(actorSuggestionScope("w 1", null), { files: "workspaceId=w%201&scope=workspace", skills: "workspaceId=w%201" });
});
