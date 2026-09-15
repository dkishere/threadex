import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTodoChildTaskContextFromSnapshot,
  buildTodoChildTaskPromptFromSnapshot,
  CONTINUE_TODO_PLAN_DEVELOPER_INSTRUCTIONS,
  CONTINUE_TODO_PLAN_USER_SUFFIX,
  delegatedTodoActiveStatus,
  FORCE_TODO_PLAN_DEVELOPER_INSTRUCTIONS,
  FORCE_TODO_PLAN_USER_SUFFIX,
  TODO_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  TODO_LANGUAGE_RULE
} from "./todoInstructions";
import { isTodoPlanAwaitingClarification, TODO_PLAN_CLARIFICATION_PAUSE_REASON } from "../todoPlan";
import type { SessionTodoSnapshot, TodoItemRecord } from "./sessionStore";

test("todo child task prompt carries the todo language rule", () => {
  const todo = todoSnapshot({
    id: "todo-target",
    title: "修正 todo 語言",
    details: "todo 內容要跟返 user prompt"
  });
  const prompt = buildTodoChildTaskPromptFromSnapshot({
    parentSessionId: "local_parent-1",
    todoItemId: "todo-target",
    prompt: "請修正 todo language 要跟返用戶 prompt",
    todo
  });

  assert.match(prompt, /\[SERVER-PROVIDED TODO SUBTASK CONTEXT\]/);
  assert.match(prompt, /Keep all follow-up conversation and continued execution in this same task/);
  assert.match(prompt, /Ordinary turns in this worker cannot create or delegate another task/);
  assert.match(prompt, /original user's actual task request/);
  assert.match(prompt, /operational instructions must never influence/);
  assert.match(prompt, /todo_set_plan plans/);
  assert.match(prompt, /todo_add_comment status\/blocker\/note bodies/);
  assert.match(prompt, /nested split items/);
  assert.match(prompt, /todo_create_task/);
  assert.match(prompt, /Parent session id: local_parent-1/);
  assert.match(prompt, /Target todo item id: todo-target/);
  assert.match(prompt, /請修正 todo language 要跟返用戶 prompt/);
  assert.ok(prompt.includes(TODO_LANGUAGE_RULE));
});

test("todo child task context keeps handoff prompt separate from developer snapshot", () => {
  const todo = todoSnapshot({
    id: "todo-target",
    title: "實作 MCP detail",
    details: "要包含 sessions",
    context: "Target item context prepared by the parent."
  });
  const context = buildTodoChildTaskContextFromSnapshot({
    parentSessionId: "local_parent-1",
    todoItemId: "todo-target",
    prompt: "請處理呢個 todo item",
    todo
  });

  assert.equal(context.prompt, "請處理呢個 todo item");
  assert.match(context.developerInstructions, /Target item context prepared by the parent/);
  assert.match(context.developerInstructions, /contextChain/);
  assert.match(context.developerInstructions, /itemTree/);
  assert.match(context.developerInstructions, /recentMessages/);
  assert.ok(context.developerInstructions.includes(TODO_LANGUAGE_RULE));
});

test("delegated todo activeStatus follows Chinese or English prompt language", () => {
  const item = todoItem({
    id: "todo-target",
    title: "修正 todo 語言",
    details: "todo 內容要跟返 user prompt"
  });

  assert.equal(delegatedTodoActiveStatus("請委派呢個任務", item), "已委派給背景子任務。");
  assert.equal(
    delegatedTodoActiveStatus("Delegate this task", todoItem({ title: "Fix todo language", details: "Use English" })),
    "Delegated to a background child task."
  );
});

test("force-plan instructions keep wrapper language separate and require a concrete planning-only turn", () => {
  assert.match(TODO_LANGUAGE_RULE, /excluding appended operational suffixes/);
  assert.match(TODO_LANGUAGE_RULE, /explicit output-language request takes priority/);
  assert.match(TODO_LANGUAGE_RULE, /operational instructions must never influence/);

  assert.match(FORCE_TODO_PLAN_USER_SUFFIX, /conduct one focused grill-me round/);
  assert.match(FORCE_TODO_PLAN_USER_SUFFIX, /1-5 focused questions/);
  assert.match(FORCE_TODO_PLAN_USER_SUFFIX, /operational metadata/);

  assert.match(FORCE_TODO_PLAN_DEVELOPER_INSTRUCTIONS, /MUST conduct exactly one focused grill-me round/);
  assert.match(FORCE_TODO_PLAN_DEVELOPER_INSTRUCTIONS, /even when the request initially appears clear/);
  assert.match(FORCE_TODO_PLAN_DEVELOPER_INSTRUCTIONS, /end the turn without calling todo_set_plan/);
  assert.match(FORCE_TODO_PLAN_DEVELOPER_INSTRUCTIONS, /Do not inspect files, search the workspace, browse, run commands/);
  assert.match(FORCE_TODO_PLAN_DEVELOPER_INSTRUCTIONS, /another capable agent could execute the plan without inferring missing work/);
  assert.match(FORCE_TODO_PLAN_DEVELOPER_INSTRUCTIONS, /read-only both before and after plan creation/);
  assert.match(FORCE_TODO_PLAN_DEVELOPER_INSTRUCTIONS, /chronological, not a final-state check/);
  assert.match(FORCE_TODO_PLAN_DEVELOPER_INSTRUCTIONS, /Todo plan as Solution plus Verification/);

  assert.match(CONTINUE_TODO_PLAN_USER_SUFFIX, /use the user's answers/);
  assert.match(CONTINUE_TODO_PLAN_USER_SUFFIX, /Do not repeat questions/);
  assert.match(CONTINUE_TODO_PLAN_DEVELOPER_INSTRUCTIONS, /first task-related tool action MUST be one successful/);
  assert.match(CONTINUE_TODO_PLAN_DEVELOPER_INSTRUCTIONS, /mcp__session_inspector__todo_set_plan/);

  assert.match(TODO_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /If either is materially unclear/);
  assert.doesNotMatch(TODO_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /MUST conduct exactly one focused grill-me round/);
});

test("todo clarification state remains recognizable until plan items exist", () => {
  assert.equal(isTodoPlanAwaitingClarification({
    items: [],
    control: { pauseReason: TODO_PLAN_CLARIFICATION_PAUSE_REASON }
  }), true);
  assert.equal(isTodoPlanAwaitingClarification({
    items: [{ id: "todo-1" }],
    control: { pauseReason: TODO_PLAN_CLARIFICATION_PAUSE_REASON }
  }), false);
  assert.equal(isTodoPlanAwaitingClarification({
    items: [],
    control: { pauseReason: "Initial Todo MCP plan created for review. Execution has not started." }
  }), false);
});

function todoSnapshot(item: Partial<TodoItemRecord>): SessionTodoSnapshot {
  return {
    sessionId: "local_parent-1",
    control: {
      sessionId: "local_parent-1",
      paused: false,
      pauseReason: null,
      pausedBy: null,
      context: "",
      problem: "",
      objective: "",
      updated: "2026-07-27T00:00:00.000Z"
    },
    items: [todoItem(item)],
    itemSessions: [],
    itemTree: [],
    comments: [],
    messages: []
  };
}

function todoItem(input: Partial<TodoItemRecord>): TodoItemRecord {
  return {
    id: input.id ?? "todo-1",
    sessionId: "local_parent-1",
    parentId: input.parentId ?? null,
    title: input.title ?? "Todo item",
    details: input.details ?? "",
    context: input.context ?? "",
    section: input.section ?? null,
    status: input.status ?? "todo",
    position: input.position ?? 0,
    createdBy: input.createdBy ?? "agent",
    updatedBy: input.updatedBy ?? "agent",
    lockedByTurnId: input.lockedByTurnId ?? null,
    lockReason: input.lockReason ?? null,
    activeStatus: input.activeStatus ?? null,
    childSessionId: input.childSessionId ?? null,
    childTurnId: input.childTurnId ?? null,
    changedFileCount: input.changedFileCount ?? 0,
    changedFiles: input.changedFiles ?? [],
    created: input.created ?? "2026-07-27T00:00:00.000Z",
    updated: input.updated ?? "2026-07-27T00:00:00.000Z"
  };
}
