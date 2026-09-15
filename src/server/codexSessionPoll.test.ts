import assert from "node:assert/strict";
import test from "node:test";
import { codexSessionPollSources, isPathInsideCodexHome } from "./codexSessionPoll.js";

test("Codex session polling includes the regular local Codex home", () => {
  const sources = codexSessionPollSources([
    { id: "default", codexHome: "/manager/data/codex-homes/default" },
    { id: "project", codexHome: "/manager/data/codex-homes/project" }
  ], "/Users/example/.codex");

  assert.deepEqual(sources, [
    { workspaceId: "default", codexHome: "/manager/data/codex-homes/default" },
    { workspaceId: "project", codexHome: "/manager/data/codex-homes/project" },
    { workspaceId: null, codexHome: "/Users/example/.codex" }
  ]);
});

test("Codex session polling avoids duplicating a configured local Codex home", () => {
  const sources = codexSessionPollSources([
    { id: "default", codexHome: "/Users/example/.codex" }
  ], "/Users/example/.codex");

  assert.deepEqual(sources, [{ workspaceId: "default", codexHome: "/Users/example/.codex" }]);
});

test("external imported transcript paths are scoped to their Codex home", () => {
  assert.equal(
    isPathInsideCodexHome("/Users/example/.codex/sessions/2026/08/26/rollout.jsonl", "/Users/example/.codex"),
    true
  );
  assert.equal(
    isPathInsideCodexHome("/manager/data/codex-homes/default/sessions/rollout.jsonl", "/Users/example/.codex"),
    false
  );
});
