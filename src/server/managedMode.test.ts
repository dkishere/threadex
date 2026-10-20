import assert from "node:assert/strict";
import test from "node:test";
import { MANAGED_MODE_PREFIX, managedModeTurnInstructions, managedModelSuggestions, resolveManagedModePrompt } from "../managedMode";
import { MODEL_CATALOG as M } from "../modelCatalog";

test("Codex suggestions follow Auto tiers without exceeding the supervisor", () => {
  const ids = (model: string) => managedModelSuggestions(model).map(choice => choice.model);
  assert.deepEqual(ids(M.luna.id), [M.luna.id]);
  assert.deepEqual(ids(M.sol.id), [M.luna.id, M.sol61.id]);
  assert.deepEqual(ids(M.sol61.id), [M.luna.id, M.sol61.id]);
  assert.deepEqual(ids(M.astra.id), [M.luna.id, M.sol61.id, M.astra.id]);
  assert.deepEqual(ids("gpt-5.6-sol"), [M.luna.id, M.sol61.id]);
  assert.deepEqual(ids(M.mini.id), [M.mini.id]);
  assert.deepEqual(ids("auto"), []);
});

test("Claude recommendations stay within provider and model ceiling", () => {
  assert.deepEqual(managedModelSuggestions("haiku").map(c => c.model), [M.claudeHaiku.id]);
  assert.deepEqual(managedModelSuggestions("sonnet").map(c => c.model), [M.claudeHaiku.id, M.claudeSonnet.id]);
  assert.deepEqual(managedModelSuggestions("opus").map(c => c.model), [M.claudeHaiku.id, M.claudeSonnet.id, M.claudeOpus.id]);
});

test("each new turn overrides historical Managed authorization, including enabled then disabled", () => {
  const on = managedModeTurnInstructions(true, "turn-on");
  const off = managedModeTurnInstructions(false, "turn-off");
  assert.match(on, /Managed mode: ON/);
  assert.match(on, /request only/);
  assert.match(off, /Managed mode: OFF/);
  assert.match(off, /authorization turn "turn-off"/);
  assert.match(off, /supersedes Managed mode policies and delegation authorizations/);
  assert.match(off, /Do not proactively spawn sub-agents/);
  assert.match(off, /current user request or applicable repository\/skill instructions explicitly authorize delegation/);
  assert.doesNotMatch(off, /turn-on|Apply the Managed mode guidance/);
});

test("request metadata resolves against the actual execution model without inspecting user text", () => {
  const request = "Implement the existing plan.";
  const low = resolveManagedModePrompt(request, M.luna.id, true);
  assert.ok(low.includes(`- ${M.luna.id}:`));
  assert.ok(!low.includes(`- ${M.astra.id}:`));
  const high = resolveManagedModePrompt(request, M.astra.id, true);
  assert.ok(high.includes(`- ${M.astra.id}:`));
  assert.ok(high.endsWith("Implement the existing plan."));
  const claude = resolveManagedModePrompt(request, M.claudeSonnet.id, true);
  assert.ok(claude.includes("Allowed CC recommendations (only when native model selection is exposed):"));
  assert.ok(!claude.includes("gpt-"));
  assert.equal(resolveManagedModePrompt("Ordinary request", M.astra.id), "Ordinary request");
  const pasted = `${MANAGED_MODE_PREFIX}\n\nExplain this quoted text.`;
  assert.equal(resolveManagedModePrompt(pasted, M.astra.id, false), pasted);
  const oldPrefix = "[Managed mode]\nUse native sub-agents more often and choose suitable models to execute the plan. Never choose a worker model stronger than your own current model.";
  assert.equal(resolveManagedModePrompt(oldPrefix, M.astra.id, false), oldPrefix);
  assert.match(low, /If the schema does not expose model selection, children inherit the supervisor model/);
  assert.match(low, /the model recommendations below do not apply/);
});
