import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CollaborationView } from "../collaboration";
import { ForkedTurns } from "./ForkedTurns";

test("Concurrent forks show immediately with their full user prompt collapsed", () => {
  const group: CollaborationView = {
    id: "group", workspaceId: "workspace", mainSessionId: "parent", revision: 1,
    created: "", updated: "", lease: null, results: [], activity: {}, conflicts: [],
    members: [{ localId: "c1", sessionId: "worker", sourceSessionId: "parent", sourceTurnId: "source-turn",
      task: "Short title", fork: null, model: "gpt-6", effort: "high", stopped: false, observed: {} }],
    messages: [{ id: "request", from: "main", to: "c1", text: "Full original user prompt\nSecond line",
      reason: "", kind: "task", wait: false, parentId: null, depth: 0, state: "pending",
      targetTurnId: null, completed: false, error: null, created: "" }]
  };
  const html = renderToStaticMarkup(<ForkedTurns sessionId="parent" group={group} onOpen={() => {}} />);
  assert.match(html, /Forked turns/);
  assert.match(html, /c1 · Concurrent/);
  assert.match(html, /creating/);
  assert.match(html, /<details><summary>User prompt<\/summary>/);
  assert.match(html, /Full original user prompt\nSecond line/);
  assert.doesNotMatch(html, /open=""/);
  assert.equal(renderToStaticMarkup(<ForkedTurns sessionId="unrelated" group={group} onOpen={() => {}} />), "");
});
