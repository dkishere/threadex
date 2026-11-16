import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CollaborationView } from "../collaboration";
import { ForkedTurns } from "./ForkedTurns";

test("panel-created members appear only under their source turn in native card styling", () => {
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
  assert.match(html, /class="subagent-event forked-turn"/);
  assert.match(html, /data-status="running"/);
  assert.match(html, /c1 · gpt-6/);
  assert.match(html, /Creating/);
  assert.match(html, /User prompt/);
  assert.match(html, /Full original user prompt/);
  assert.match(html, /Second line/);
  assert.match(html, /Effort: high/);
  assert.match(html, /Open member session/);
  assert.doesNotMatch(html, /open=""/);
  assert.match(html, /data-source-turn-id="source-turn"/);
  assert.doesNotMatch(html, /c2|c3|Later prompt|Other session prompt/);
  const later = render("parent", "later-turn");
  assert.match(later, /c2 · gpt-6/);
  assert.match(later, /Later prompt/);
  assert.doesNotMatch(later, /c1|c3|Full original user prompt/);
  assert.equal(render("parent", "no-forks"), "");
  assert.equal(render("unrelated", "source-turn"), "");
});

test("an agent-spawned worker appears under the turn that delegated it, not its context boundary", () => {
  const group = {
    id: "group", workspaceId: "workspace", mainSessionId: "parent", revision: 1, created: "", updated: "", lease: null,
    results: [], activity: { c1: { status: "running", turnId: "w", progress: "Inspecting parser" } }, conflicts: [], messages: [],
    members: [{ localId: "c1", sessionId: "worker", sourceSessionId: "parent", sourceTurnId: "boundary-turn", spawnTurnId: "spawning-turn",
      task: "Review the parser", fork: null, model: "claude-opus-5-5", effort: "high", stopped: false, observed: {} }]
  } as CollaborationView;
  const render = (sourceTurnId: string) => renderToStaticMarkup(
    <ForkedTurns sessionId="parent" sourceTurnId={sourceTurnId} group={group} onOpen={() => {}} />
  );
  assert.equal(render("boundary-turn"), "");
  const html = render("spawning-turn");
  assert.match(html, /c1 · claude-opus-5-5/);
  assert.match(html, /data-status="running"/);
  assert.match(html, /Inspecting parser/);
  assert.match(html, /Delegated task/);
  assert.match(html, /Review the parser/);
});

test("completed member shows Markdown result and recorded changes", () => {
  const group = {
    id: "group", workspaceId: "workspace", mainSessionId: "parent", revision: 1, created: "", updated: "", lease: null,
    results: [{ id: "old", localId: "c1", sessionId: "worker", turnId: "w1", status: "completed", summary: "Old result", changes: [], created: "2026-01-01" },
      { id: "new", localId: "c1", sessionId: "worker", turnId: "w2", status: "completed", summary: "**Fixed** parser", changes: [
        { path: "src/client/parser.ts", kind: "modified", additions: 3, deletions: 1 }
      ], created: "2026-01-02" }],
    activity: { c1: { status: "idle", turnId: "w2", progress: "" } }, conflicts: [], messages: [],
    members: [{ localId: "c1", sessionId: "worker", sourceSessionId: "parent", sourceTurnId: "boundary", spawnTurnId: "spawn",
      task: "Fix parser", fork: null, model: "gpt-6", effort: "high", stopped: false, observed: {} }]
  } as CollaborationView;
  const html = renderToStaticMarkup(<ForkedTurns sessionId="parent" sourceTurnId="spawn" group={group} onOpen={() => {}} />);
  assert.match(html, /data-status="done"/);
  assert.match(html, /Returned content/);
  assert.match(html, /<strong>Fixed<\/strong> parser/);
  assert.match(html, /modified: src\/client\/parser.ts/);
  assert.match(html, /\(\+3 −1\)/);
  assert.doesNotMatch(html, /Old result/);
  group.activity.c1 = { status: "running", turnId: "w3", progress: "Checking follow-up" };
  const followup = renderToStaticMarkup(<ForkedTurns sessionId="parent" sourceTurnId="spawn" group={group} onOpen={() => {}} />);
  assert.match(followup, /data-status="running"/);
  assert.match(followup, /Checking follow-up/);
  group.activity.c1 = { status: "queued", turnId: "w4", progress: "**Fixed** parser" };
  const queued = renderToStaticMarkup(<ForkedTurns sessionId="parent" sourceTurnId="spawn" group={group} onOpen={() => {}} />);
  assert.match(queued, /data-status="running"/, "a queued follow-up is not shown as the previous completion");
  assert.match(queued, /subagent-event-status">Queued</);
  assert.doesNotMatch(queued, /subagent-activity-headline/, "only a running turn shows live progress");
});
