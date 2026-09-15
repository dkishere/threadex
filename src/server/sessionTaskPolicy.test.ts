import assert from "node:assert/strict";
import test from "node:test";
import { decideSessionTaskCreation } from "./sessionTaskPolicy";

const workerAssignment = {
  parentSessionId: "local_parent-1",
  itemId: "todo-assigned-1"
};

test("ordinary Todo worker follow-ups cannot create another task", () => {
  assert.deepEqual(decideSessionTaskCreation({
    sourceSessionId: "local_worker-1",
    parentSessionId: "local_parent-1",
    todoItemId: "todo-nested-1",
    contextFork: false,
    workerAssignment,
    existingTodoWorkerSessionId: null
  }), {
    allowed: false,
    reason: "worker_followup",
    sessionId: "local_worker-1",
    parentSessionId: "local_parent-1",
    todoItemId: "todo-assigned-1"
  });
});

test("an explicit context fork can create a child from a Todo worker", () => {
  assert.deepEqual(decideSessionTaskCreation({
    sourceSessionId: "local_worker-1",
    parentSessionId: "local_worker-1",
    todoItemId: null,
    contextFork: true,
    workerAssignment,
    existingTodoWorkerSessionId: null
  }), { allowed: true });
});

test("contextFork cannot bypass the worker guard for todo delegation", () => {
  assert.equal(decideSessionTaskCreation({
    sourceSessionId: "local_worker-1",
    parentSessionId: "local_parent-1",
    todoItemId: "todo-nested-1",
    contextFork: true,
    workerAssignment,
    existingTodoWorkerSessionId: null
  }).allowed, false);
});

test("a Todo item with a worker must resume it instead of creating a duplicate", () => {
  assert.deepEqual(decideSessionTaskCreation({
    sourceSessionId: "local_parent-1",
    parentSessionId: "local_parent-1",
    todoItemId: "todo-assigned-1",
    contextFork: false,
    workerAssignment: null,
    existingTodoWorkerSessionId: "local_worker-1"
  }), {
    allowed: false,
    reason: "todo_item_already_assigned",
    sessionId: "local_worker-1",
    parentSessionId: "local_parent-1",
    todoItemId: "todo-assigned-1"
  });
});
