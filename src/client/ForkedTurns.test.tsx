import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CollaborationView } from "../collaboration";
import { ForkedTurns } from "./ForkedTurns";

test("Concurrent forks appear only under their source turn with the full user prompt collapsed", () => {
  const group: CollaborationView = {
    id: "group", workspaceId: "workspace", mainSessionId: "parent", revision: 1,
    created: "", updated: "", lease: null, results: [], activity: {}, conflicts: [],
    members: [
      { localId: "c1", sessionId: "worker", sourceSessionId: "parent", sourceTurnId: "source-turn",
        task: "Short title", fork: null, model: "gpt-6", effort: "high", stopped: false, observed: {} },
      { localId: "c2", sessionId: "later-worker", sourceSessionId: "parent", sourceTurnId: "later-turn",
        task: "Later prompt", fork: null, model: "gpt-6", effort: "high", stopped: false, observed: {} },
      { localId: "c3", sessionId: "other-worker", sourceSessionId: "other-session", sourceTurnId: "source-turn",
        task: "Other session prompt", fork: null, model: "gpt-6", effort: "high", stopped: false, observed: {} }
    ],
    messages: [{ id: "request", from: "main", to: "c1", text: "Full original user prompt\nSecond line",
      reason: "", kind: "task", wait: false, parentId: null, depth: 0, state: "pending",
      targetTurnId: null, completed: false, error: null, created: "" }]
  };
  const render = (sessionId: string, sourceTurnId: string) => renderToStaticMarkup(
    <ForkedTurns sessionId={sessionId} sourceTurnId={sourceTurnId} group={group} onOpen={() => {}} />
  );
  const html = render("parent", "source-turn");
  assert.match(html, /Forked turns/);
  assert.match(html, /c1 · Concurrent/);
  assert.match(html, /creating/);
  assert.match(html, /<details><summary>User prompt<\/summary>/);
  assert.match(html, /Full original user prompt\nSecond line/);
  assert.doesNotMatch(html, /open=""/);
  assert.match(html, /data-source-turn-id="source-turn"/);
  assert.doesNotMatch(html, /c2|c3|Later prompt|Other session prompt/);
  const later = render("parent", "later-turn");
  assert.match(later, /c2 · Concurrent/);
  assert.match(later, /Later prompt/);
  assert.doesNotMatch(later, /c1|c3|Full original user prompt/);
  assert.equal(render("parent", "no-forks"), "");
  assert.equal(render("unrelated", "source-turn"), "");
});
