import assert from "node:assert/strict";
import test from "node:test";

import {
  developerInstructionsIndicateForcePlan,
  extractTodoMcpPromptBlocks,
  isTodoMcpPromptText
} from "./todoPrompt";

const currentPrompt = [
  "[TODO MCP PLAN COMPLETION AND MUTATION GATE - HIGHEST PRIORITY FOR THIS TURN]",
  "Read-only discovery is allowed before creating the plan.",
  "[END TODO MCP PLAN COMPLETION AND MUTATION GATE]",
  "For all generated todo text, use the same natural language as the original user prompt."
].join("\n");
test("recognizes and extracts the current Todo MCP planner marker", () => {
  const blocks = extractTodoMcpPromptBlocks(currentPrompt);

  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /^\[TODO MCP PLAN\]/);
  assert.match(blocks[0], /Read-only discovery is allowed before creating the plan/);
  assert.match(blocks[0], /For all generated todo text/);
  assert.doesNotMatch(blocks[0], /COMPLETION AND MUTATION GATE/);
  assert.match(blocks[0], /\[END TODO MCP PLAN\]$/);
  assert.equal(isTodoMcpPromptText(currentPrompt), true);
  assert.equal(developerInstructionsIndicateForcePlan([{ developerInstructions: currentPrompt }]), true);
});

test("keeps the legacy Todo MCP planner marker compatible", () => {
  const legacyPrompt = [
    "User prompted you to create a Todo MCP plan for this turn.",
    "- MUST call todo_set_plan.",
    "",
    "Todo planner: create the complete plan.",
    "For all generated todo text, use the user's language."
  ].join("\n");

  const blocks = extractTodoMcpPromptBlocks(legacyPrompt);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /MUST call todo_set_plan/);
  assert.match(blocks[0], /Todo planner: create the complete plan/);
  assert.match(blocks[0], /For all generated todo text/);
  assert.equal(developerInstructionsIndicateForcePlan([{ developerInstructions: legacyPrompt }]), true);
});

test("does not classify unrelated developer instructions as Todo mode", () => {
  const value = "[STARTUP]\npwd: /tmp\n[END STARTUP]";

  assert.deepEqual(extractTodoMcpPromptBlocks(value), []);
  assert.equal(isTodoMcpPromptText(value), false);
  assert.equal(developerInstructionsIndicateForcePlan([{ developerInstructions: value }]), false);
});
