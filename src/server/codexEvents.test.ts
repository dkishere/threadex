import assert from "node:assert/strict";
import test from "node:test";
import { fileChangesFromTurnDiff, normalizeStructuredAgentComment, streamItemFromPlanUpdate, streamItemFromThreadItem } from "./codexEvents.js";

test("native file changes retain rename targets during stream-item conversion", () => {
  for (const fields of [
    { kind: "update", movePath: "new.txt" },
    { kind: "update", move_path: "new.txt" },
    { kind: { type: "update", move_path: "new.txt" } },
    { kind: { type: "update", movePath: "new.txt" } }
  ]) {
    const item = streamItemFromThreadItem({ id: "rename", type: "fileChange", status: "completed",
      changes: [{ path: "old.txt", ...fields }] }, "item.completed");
    assert.equal(item?.itemType, "file_change");
    if (item?.itemType === "file_change") {
      assert.deepEqual(item.changes, [{ path: "old.txt", kind: "update", movePath: "new.txt" }]);
    }
  }
});

test("parses the authoritative net file list from a turn diff", () => {
  const changes = fileChangesFromTurnDiff([
    "diff --git a/src/kept.ts b/src/kept.ts",
    "index 1111111..2222222 100644",
    "--- a/src/kept.ts",
    "+++ b/src/kept.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1 @@",
    "+new file"
  ].join("\n"));

  assert.deepEqual(changes.map(({ path, kind }) => ({ path, kind })), [
    { path: "src/kept.ts", kind: "update" },
    { path: "src/new.ts", kind: "add" }
  ]);
  assert.match(changes[0].unifiedDiff ?? "", /-old\n\+new/);
});

test("an empty authoritative turn diff represents no net file changes", () => {
  assert.deepEqual(fileChangesFromTurnDiff(""), []);
});

test("legacy commentary JSON contributes only its prose to the default envelope", () => {
  const item = streamItemFromThreadItem({
    id: "message-1",
    type: "agentMessage",
    phase: "commentary",
    text: JSON.stringify({ type: "research", short: "Inspect event flow", detail: "I am tracing the event flow now." })
  }, "item.completed");

  assert.deepEqual(item, {
    id: "message-1",
    eventType: "item.completed",
    itemType: "agent_message",
    phase: "commentary",
    text: "I am tracing the event flow now.",
    comment: { extracts: [{ type: "action", shortMsg: "tracing the event flow now." }], detail: "I am tracing the event flow now." }
  });
});

test("agent-provided answer metadata is ignored until Luna classifies the prose", () => {
  const detail = "唔係真正搜尋；嗰啲係空白 reasoning event 被暫時渲染成 Thinking。";
  const item = streamItemFromThreadItem({
    id: "answer-message",
    type: "agentMessage",
    phase: "commentary",
    text: JSON.stringify({ type: "answer", short: "空白 reasoning 暫時顯示為 Thinking", detail })
  }, "item.completed");

  assert.equal(item?.itemType, "agent_message");
  if (item?.itemType !== "agent_message") return;
  assert.deepEqual(item.comment, {
    extracts: [{ type: "action", shortMsg: detail }],
    detail
  });
});

test("plain text commentary keeps a semantic short when the model omits the envelope", () => {
  const item = streamItemFromThreadItem({
    id: "message-2",
    type: "agentMessage",
    phase: "commentary",
    text: "Inspecting the event flow."
  }, "item.completed");

  assert.equal(item?.itemType, "agent_message");
  if (item?.itemType !== "agent_message") return;
  assert.equal(item.text, "Inspecting the event flow.");
  assert.deepEqual(item.comment, {
    extracts: [{ type: "action", shortMsg: "Inspecting the event flow." }],
    detail: "Inspecting the event flow."
  });
});

test("agent-provided trouble metadata is ignored until Luna classifies the prose", () => {
  const item = streamItemFromThreadItem({
    id: "message-3",
    type: "agentMessage",
    phase: "commentary",
    text: JSON.stringify({
      type: "blocker",
      short: "Build is blocked",
      detail: "編譯失敗，等緊一個缺少嘅 dependency。"
    })
  }, "item.completed");

  assert.equal(item?.itemType, "agent_message");
  if (item?.itemType !== "agent_message") return;
  assert.deepEqual(item.comment, {
    extracts: [{ type: "action", shortMsg: "編譯失敗，等緊一個缺少嘅 dependency。" }],
    detail: "編譯失敗，等緊一個缺少嘅 dependency。"
  });
});

test("legacy detail-prefix shorts are replaced with a concise semantic fallback", () => {
  const detail = "我會檢查完整 session timeline，再確認 runner ownership 同錯誤來源。";
  const comment = normalizeStructuredAgentComment({
    type: "action",
    short: "我會檢查完整 session timeline，再確認…",
    detail
  });
  assert.equal(comment?.extracts[0]?.shortMsg, "檢查完整 session timeline，再確認 runner ownership 同錯誤來源。");
  assert.equal(comment?.detail, detail);
});

test("legacy generic shorts are replaced with semantic detail fallbacks", () => {
  const cases = [
    { type: "action", short: "対応中", detail: "ファイル構成を調べています。", expected: "ファイル構成を調べています。" },
    { type: "edit", short: "変更中", detail: "設定ファイルを変更します。", expected: "設定ファイルを変更します。" },
    { type: "verification", short: "검증 중", detail: "전체 테스트를 실행합니다.", expected: "전체 테스트를 실행합니다." },
    { type: "solution", short: "已找到解決方法", detail: "已找到修復方案，下一步會套用。", expected: "找到修復方案，下一步會套用。" }
  ];

  for (const [index, entry] of cases.entries()) {
    const comment = normalizeStructuredAgentComment({
      type: entry.type,
      short: entry.short,
      detail: entry.detail
    });
    assert.equal(comment?.extracts[0]?.shortMsg, entry.expected, `case ${index}`);
  }
});

test("commentary short is capped at 64 CJK token units", () => {
  const longShort = `驗證${"長".repeat(140)}`;
  const comment = normalizeStructuredAgentComment({
    type: "verification",
    short: longShort,
    detail: "驗證完整結果仍然保留。"
  });
  assert.equal([...(comment?.extracts[0]?.shortMsg ?? "")].length, 64);
  assert.equal(comment?.extracts[0]?.shortMsg.endsWith("…"), true);
  assert.equal(comment?.detail, "驗證完整結果仍然保留。");
});

test("commentary short token cap handles English words", () => {
  const comment = normalizeStructuredAgentComment({
    type: "action",
    short: "go ".repeat(80).trim(),
    detail: "Checking the complete English detail while keeping it available."
  });
  assert.equal(comment?.extracts[0]?.shortMsg.match(/go/g)?.length, 63);
  assert.equal(comment?.extracts[0]?.shortMsg.endsWith("…"), true);
});

test("normalizes wait commentary as its own type", () => {
  const comment = normalizeStructuredAgentComment({
    extracts: [{ type: "wait", shortMsg: "Waiting for the next step" }],
    detail: "Waiting for the next step."
  });

  assert.deepEqual(comment?.extracts, [{ type: "wait", shortMsg: "Waiting for the next step." }]);
});

test("merges extracts of the same type while preserving first-type order", () => {
  const detail = "Inspect the session, report the failure, then trace the runner and propose a fix.";
  assert.deepEqual(normalizeStructuredAgentComment({
    extracts: [
      { type: "action", shortMsg: "Inspect the saved session." },
      { type: "trouble", shortMsg: "The runner lost its context." },
      { type: "action", shortMsg: "Trace the runner lifecycle." },
      { type: "solution", shortMsg: "Restore context from persisted turns." }
    ],
    detail
  }), {
    extracts: [
      { type: "action", shortMsg: "Inspect the saved session; Trace the runner lifecycle." },
      { type: "solution", shortMsg: "Restore context from persisted turns." }
    ],
    issues: ["The runner lost its context."],
    detail
  });
});

test("normalizes multiple extracts and an issue ledger", () => {
  const comment = normalizeStructuredAgentComment({
    extracts: [
      { type: "trouble", shortMsg: "Build fails on the generated type" },
      { type: "solution", shortMsg: "Regenerated the missing declaration" }
    ],
    issues: ["Generated type is missing", "Generated type is missing"],
    solutions: [{ issueKey: 1, solution: "Regenerated the declaration" }],
    detail: "The generated type was missing, so I regenerated its declaration."
  });
  assert.deepEqual(comment, {
    extracts: [
      { type: "solution", shortMsg: "Regenerated the missing declaration" }
    ],
    issues: ["Generated type is missing"],
    solutions: [{ issueKey: 1, solution: "Regenerated the declaration" }],
    detail: "The generated type was missing, so I regenerated its declaration."
  });
});

test("keeps a solution that targets an earlier turn-wide issue", () => {
  const detail = "The import now preserves turn_context.model.";
  assert.deepEqual(normalizeStructuredAgentComment({
    extracts: [{ type: "solution", shortMsg: "Preserved turn_context.model during import" }],
    detail,
    solutions: [{ issueKey: 2, solution: "Copied turn_context.model into the imported turn" }]
  }), {
    extracts: [{ type: "solution", shortMsg: "Preserved turn_context.model during import" }],
    detail,
    solutions: [{ issueKey: 2, solution: "Copied turn_context.model into the imported turn" }]
  });
});

test("collaboration agent tool calls become structured subagent live items", () => {
  const item = streamItemFromThreadItem({
    id: "collab-1",
    type: "collabAgentToolCall",
    tool: "spawnAgent",
    status: "completed",
    senderThreadId: "parent-thread",
    receiverThreadIds: ["child-thread"],
    prompt: "Inspect the API tests",
    model: "gpt-test",
    reasoningEffort: "high",
    agentsStates: {
      "child-thread": { status: "completed", message: "Found two missing cases." }
    }
  }, "item.completed");

  assert.deepEqual(item, {
    id: "collab-1",
    eventType: "item.completed",
    itemType: "subagent",
    tool: "spawnAgent",
    status: "completed",
    senderThreadId: "parent-thread",
    receiverThreadIds: ["child-thread"],
    prompt: "Inspect the API tests",
    model: "gpt-test",
    reasoningEffort: "high",
    agents: [{ id: "child-thread", status: "completed", message: "Found two missing cases." }]
  });
});

test("subagent activity items retain the inspectable agent path", () => {
  const item = streamItemFromThreadItem({
    id: "activity-1",
    type: "subAgentActivity",
    kind: "started",
    agentThreadId: "child-thread",
    agentPath: "/root/api_tests"
  }, "item.started");

  assert.deepEqual(item, {
    id: "activity-1",
    eventType: "item.started",
    itemType: "subagent",
    tool: "activity",
    status: "started",
    label: "/root/api_tests",
    receiverThreadIds: ["child-thread"],
    agents: [{ id: "child-thread", name: "/root/api_tests", status: "started" }]
  });
});

test("context compaction items become durable timeline events", () => {
  const item = streamItemFromThreadItem({
    id: "compact-1",
    type: "contextCompaction"
  }, "item.completed");

  assert.deepEqual(item, {
    id: "compact-1",
    eventType: "item.completed",
    itemType: "context_compaction"
  });
});


test("native plan updates preserve explicit states and a stable turn identity", () => {
  const item = streamItemFromPlanUpdate({ turnId: "t1", plan: [
    { step: "Deferred", status: "pending" },
    { step: "Working", status: "inProgress" },
    { step: "Verified", status: "completed" }
  ] });
  assert.deepEqual(item, {
    id: "native-plan:t1", eventType: "item.updated", itemType: "todo_list",
    items: [
      { text: "Deferred", completed: false, status: "pending" },
      { text: "Working", completed: false, status: "in_progress" },
      { text: "Verified", completed: true, status: "completed" }
    ]
  });
  assert.equal(streamItemFromPlanUpdate({ turnId: "t1", plan: [] })?.id, item?.id);
  assert.equal(streamItemFromPlanUpdate({ plan: [] }), undefined);
  assert.equal(streamItemFromPlanUpdate({ turnId: "t1", plan: [{ step: "Bad", status: "unknown" }] }), undefined);
});
