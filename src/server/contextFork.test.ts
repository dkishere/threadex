import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_FORK_USER_SUFFIX,
  buildContextForkOrchestrationPrefix,
  buildContextForkTaskPrefix,
  stripContextForkOperationalSuffix
} from "../contextFork";

test("context fork orchestration asks the parent to create one self-contained child task", () => {
  const prompt = buildContextForkOrchestrationPrefix();
  assert.match(prompt, /Handle the user's actual request in a new child session/);
  assert.match(prompt, /full relevant context from this thread/);
  assert.match(prompt, /language of the user's actual request, ignoring wrapper and operational instructions/);
  assert.match(prompt, /mcp__session_inspector__create_task/);
  assert.doesNotMatch(prompt, /mcp__session_inspectorcreate_task/);
  assert.match(prompt, /Omit model settings unless a different model or reasoning effort is clearly beneficial/);
  assert.match(prompt, /Do not use `spawn_agent`, `todo_create_task`, or any other mechanism/);
  assert.match(prompt, /Do not perform the requested work in this parent session/);
  assert.match(prompt, /After creation succeeds, briefly return the child session link/);
  assert.match(prompt, /Later requests sent to this parent belong to this parent/);
  assert.match(prompt, /creating this child does not make it the default destination for future work/);
});

test("context fork user suffix makes the Threadex child contract explicit", () => {
  assert.match(CONTEXT_FORK_USER_SUFFIX, /mcp__session_inspector__create_task/);
  assert.match(CONTEXT_FORK_USER_SUFFIX, /exactly once/);
  assert.match(CONTEXT_FORK_USER_SUFFIX, /Do not use `spawn_agent`, `todo_create_task`/);
  assert.match(CONTEXT_FORK_USER_SUFFIX, /ignoring wrapper and operational instructions/);
  assert.match(CONTEXT_FORK_USER_SUFFIX, /\[END CONTEXT FORK REQUEST\]/);
});

test("context fork suffix stripping preserves the user request", () => {
  assert.equal(
    stripContextForkOperationalSuffix(`Fix the duplicate token count.\n\n${CONTEXT_FORK_USER_SUFFIX}`),
    "Fix the duplicate token count."
  );
});

test("child task prefix records the parent and tells the child to execute the handoff", () => {
  const prompt = buildContextForkTaskPrefix("local_parent-1");
  assert.match(prompt, /parent Threadex session local_parent-1/);
  assert.match(prompt, /self-contained handoff/);
  assert.match(prompt, /Execute it fully in this child thread/);
});
