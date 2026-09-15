import assert from "node:assert/strict";
import test from "node:test";
import type { LiveItem, StructuredComment } from "./appTypes.js";
import { attachCommentaryActivities, commentaryActivityCounts, commentaryTypeForActivities } from "./commentaryActivity.js";
import { latestTurnIssueTracker, TurnIssueTracker } from "./sessionHelpers01.js";
import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jsx, jsxs } from "react/jsx-runtime";
import { serializeTurnIssueCopy } from "./turnIssueCopy.js";

test("issue panel renders an explicit blocker without claiming resolution", () => {
  const html = renderToStaticMarkup(createElement(() => TurnIssueTracker({
    Copy: () => null, _jsx: jsx, _jsxs: jsxs, serializeTurnIssueCopy, useState
  }, { tracker: { issues: ["Deployment unavailable"], solutions: [], blockers: [{ issueKey: 1, blocker: "Credentials required" }] },
    codexSessionId: "codex", sessionId: "session", turnId: "turn", workspaceId: "workspace" })));
  assert.match(html, /Blocker: Credentials required/);
  assert.match(html, /0\/1 resolved · 1 blocked/);
  assert.match(html, /data-resolved="false"/);
  assert.match(html, /data-blocked="true"/);
});

function comment(id: string, ledger: Pick<StructuredComment, "issues" | "solutions" | "blockers"> = {}) {
  return {
    kind: "item",
    id: `live:${id}`,
    item: {
      id,
      itemType: "agent_message",
      eventType: "item.completed",
      phase: "commentary",
      text: `Detail ${id}`,
      comment: { extracts: [{ type: "action", shortMsg: `Comment ${id}` }], detail: `Detail ${id}`, ...ledger }
    } satisfies LiveItem
  } as const;
}

test("turn issue tracker distinguishes blockers from fixes and supports later resolution", () => {
  const issue = comment("issue", { issues: ["Deployment unavailable"] });
  const blocked = comment("blocked", { blockers: [{ issueKey: 1, blocker: "Owner credentials required" }] });
  const fixed = comment("fixed", { solutions: [{ issueKey: 1, solution: "Configured credentials" }] });
  const tracker = latestTurnIssueTracker({}, [issue, blocked]);
  assert.ok(tracker);
  assert.deepEqual(tracker.solutions, []);
  assert.deepEqual(tracker.blockers, [{ issueKey: 1, blocker: "Owner credentials required" }]);
  const resolved = latestTurnIssueTracker({}, [issue, blocked, fixed]);
  assert.ok(resolved);
  assert.equal(resolved.blockers, undefined);
  assert.equal(resolved.solutions.length, 1);
  assert.deepEqual(latestTurnIssueTracker({}, [issue, fixed, blocked])?.solutions, []);
});

function commandGroup(id: string, count: number, command = "command") {
  return {
    kind: "action_group",
    id: `command-group:${id}`,
    groupType: "command",
    items: Array.from({ length: count }, (_, index) => ({
      id: `${id}:${index}`,
      item: {
        id: `${id}:${index}`,
        itemType: "command_execution",
        eventType: "item.completed",
        command: `${command} ${index}`,
        aggregatedOutput: "",
        status: "completed"
      } satisfies LiveItem
    }))
  } as const;
}

function editGroup(id: string, paths: string[]) {
  return {
    kind: "action_group",
    id: `edit-group:${id}`,
    groupType: "edit",
    items: [{
      id,
      item: {
        id,
        itemType: "file_change",
        eventType: "item.completed",
        changes: paths.map((path) => ({ path, kind: "update" })),
        status: "completed"
      } satisfies LiveItem
    }]
  } as const;
}

function searchGroup(id: string, count: number) {
  return {
    kind: "action_group",
    id: `search-group:${id}`,
    groupType: "search",
    items: Array.from({ length: count }, (_, index) => ({
      id: `${id}:${index}`,
      item: {
        id: `${id}:${index}`,
        itemType: "web_search",
        eventType: "item.completed",
        query: `query ${index}`
      } satisfies LiveItem
    }))
  } as const;
}

test("attaches run/edit/search groups to the preceding comment until the next comment", () => {
  const first = comment("first");
  const second = comment("second");
  const entries = attachCommentaryActivities([
    first,
    commandGroup("run-a", 2),
    editGroup("edit-a", ["a.ts", "b.ts"]),
    searchGroup("search-a", 3),
    second,
    commandGroup("run-b", 1)
  ]);

  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.kind, "comment_activity");
  assert.equal(entries[1]?.kind, "comment_activity");
  if (entries[0]?.kind !== "comment_activity" || entries[1]?.kind !== "comment_activity") return;
  assert.deepEqual(commentaryActivityCounts(entries[0].activities), { commandCount: 2, editCount: 2, searchCount: 3 });
  assert.deepEqual(commentaryActivityCounts(entries[1].activities), { commandCount: 1, editCount: 0, searchCount: 0 });
});

test("keeps action groups before the first comment at top level", () => {
  const run = commandGroup("pre-comment", 1);
  const entries = attachCommentaryActivities([run, comment("later")]);
  assert.equal(entries[0], run);
  assert.equal(entries[1]?.kind, "comment_activity");
});

test("promotes a comment type to edit when its activities contain edits", () => {
  const entries = attachCommentaryActivities([
    comment("editing"),
    editGroup("edit", ["src/client/App.tsx"])
  ]);
  const entry = entries[0];
  assert.equal(entry?.kind, "comment_activity");
  if (entry?.kind !== "comment_activity") return;
  assert.equal(commentaryTypeForActivities(entry.item.comment!.extracts[0].type, entry.activities), "edit");
});

test("promotes a comment type to edit for edit and in-place sed commands", () => {
  for (const command of [
    "edit src/client/App.tsx",
    "sed -i '' 's/old/new/' src/client/App.tsx",
    "sed --in-place=.bak 's/old/new/' src/client/App.tsx",
    "/bin/zsh -lc \"sed -Ei '' 's/old/new/' src/client/App.tsx\""
  ]) {
    const entries = attachCommentaryActivities([comment(command), commandGroup(command, 1, command)]);
    const entry = entries[0];
    assert.equal(entry?.kind, "comment_activity");
    if (entry?.kind !== "comment_activity") continue;
    assert.equal(commentaryTypeForActivities(entry.item.comment!.extracts[0].type, entry.activities), "edit");
  }
});

test("preserves the generated comment type for unrelated and read-only sed commands", () => {
  for (const command of [
    "rg -n sed src/client",
    "sed -n '1,20p' src/client/App.tsx",
    "/bin/zsh -lc \"sed -n '1,20p' src/client/App.tsx\""
  ]) {
    const entries = attachCommentaryActivities([comment(command), commandGroup(command, 1, command)]);
    const entry = entries[0];
    assert.equal(entry?.kind, "comment_activity");
    if (entry?.kind !== "comment_activity") continue;
    assert.equal(commentaryTypeForActivities(entry.item.comment!.extracts[0].type, entry.activities), "action");
  }
});

test("corrects a generated edit type for read-only sed commands", () => {
  for (const command of [
    "sed -n '1,20p' src/client/App.tsx",
    "sed -e 's/old/new/p' -n src/client/App.tsx",
    "/bin/zsh -lc \"sed -n '1,20p' src/client/App.tsx\""
  ]) {
    const entries = attachCommentaryActivities([comment(command), commandGroup(command, 1, command)]);
    const entry = entries[0];
    assert.equal(entry?.kind, "comment_activity");
    if (entry?.kind !== "comment_activity") continue;
    assert.equal(commentaryTypeForActivities("edit", entry.activities), "action");
  }
});

test("keeps a generated edit type for in-place sed commands", () => {
  for (const command of [
    "sed -i '' 's/old/new/' src/client/App.tsx",
    "sed --in-place=.bak 's/old/new/' src/client/App.tsx"
  ]) {
    const entries = attachCommentaryActivities([comment(command), commandGroup(command, 1, command)]);
    const entry = entries[0];
    assert.equal(entry?.kind, "comment_activity");
    if (entry?.kind !== "comment_activity") continue;
    assert.equal(commentaryTypeForActivities("edit", entry.activities), "edit");
  }
});

test("corrects a generated edit type when mixed command activity has no edit evidence", () => {
  const entries = attachCommentaryActivities([
    comment("mixed"),
    commandGroup("sed", 1, "sed -n '1,20p' src/client/App.tsx"),
    commandGroup("deploy", 1, "make ministack-replace-image SERVICE=hiring-metadata-service")
  ]);
  const entry = entries[0];
  assert.equal(entry?.kind, "comment_activity");
  if (entry?.kind !== "comment_activity") return;
  assert.equal(commentaryTypeForActivities("edit", entry.activities), "action");
});

test("turn issue tracker accumulates delta comments and their later solutions", () => {
  const first = comment("first", { issues: ["Imported turn has no model"] });
  const second = comment("second", { issues: ["Token usage is cumulative"] });
  const third = comment("third", { solutions: [
    { issueKey: 1, solution: "Copied turn_context.model into imported turns" },
    { issueKey: 2, solution: "Derived each turn's delta from cumulative token totals" }
  ] });

  assert.deepEqual(latestTurnIssueTracker({}, [first.item, second.item, third.item]), {
    issues: ["Imported turn has no model", "Token usage is cumulative"],
    solutions: [
      { issueKey: 1, solution: "Copied turn_context.model into imported turns" },
      { issueKey: 2, solution: "Derived each turn's delta from cumulative token totals" }
    ]
  });
});

test("preserves a generated edit type until activity provides stronger evidence", () => {
  assert.equal(commentaryTypeForActivities("edit", []), "edit");
});
