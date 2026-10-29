import assert from "node:assert/strict";
import test from "node:test";
import { MANAGED_MODE_PREFIX, actorRequiresManagedMode, managedModeTurnInstructions, managedModelSuggestions, resolveManagedModePrompt, resolveTurnManagedMode } from "../managedMode";
import { MODEL_CATALOG as M } from "../modelCatalog";

test("actor Sol/Opus and Astra/Fable tiers require Managed mode; other tiers do not", () => {
  for (const model of [M.sol.id, M.sol61.id, M.claudeOpus.id, M.astra.id, M.claudeFable.id, "gpt-5.6-sol", "opus", "fable"]) {
    assert.equal(actorRequiresManagedMode(model), true, model);
  }
  for (const model of [M.luna.id, M.mini.id, M.terra61.id, M.claudeSonnet.id, M.claudeHaiku.id, M.gpt55.id, M.gpt54.id, "auto", "", undefined, "claude-unknown"]) {
    assert.equal(actorRequiresManagedMode(model), false, String(model));
  }
});

test("actor tier policy overrides an OFF request on the final model only", () => {
  const actor = { requested: false, domainActor: true, excluded: false };
  assert.deepEqual(resolveTurnManagedMode({ ...actor, model: M.sol61.id }), { enabled: true, forced: true });
  assert.deepEqual(resolveTurnManagedMode({ ...actor, model: M.claudeFable.id }), { enabled: true, forced: true });
  // Auto requested Luna but routed this turn to Sol: the routed model decides.
  assert.deepEqual(resolveTurnManagedMode({ ...actor, model: M.sol.id }), { enabled: true, forced: true });
  assert.deepEqual(resolveTurnManagedMode({ ...actor, model: M.luna.id }), { enabled: false, forced: false });
  assert.deepEqual(resolveTurnManagedMode({ ...actor, model: M.terra61.id }), { enabled: false, forced: false });
  assert.deepEqual(resolveTurnManagedMode({ ...actor, requested: true, model: M.claudeHaiku.id }), { enabled: true, forced: false });
  assert.deepEqual(resolveTurnManagedMode({ ...actor, requested: true, model: M.astra.id }), { enabled: true, forced: false }, "requester already chose ON");
  assert.deepEqual(resolveTurnManagedMode({ ...actor, domainActor: false, model: M.astra.id }), { enabled: false, forced: false }, "ordinary sessions keep their setting");
  assert.deepEqual(resolveTurnManagedMode({ ...actor, excluded: true, model: M.astra.id }), { enabled: false, forced: false }, "structural exclusions still apply");
});

test("Codex suggestions mirror Haiku/Sonnet/Opus tiers without exceeding the supervisor", () => {
  const ids = (model: string) => managedModelSuggestions(model).map(choice => choice.model);
  assert.deepEqual(ids(M.luna.id), [M.luna.id]);
  assert.deepEqual(ids(M.terra61.id), [M.luna.id, M.terra61.id]);
  assert.deepEqual(ids(M.sol.id), [M.luna.id, M.terra61.id, M.sol61.id]);
  assert.deepEqual(ids(M.sol61.id), [M.luna.id, M.terra61.id, M.sol61.id]);
  assert.deepEqual(ids(M.astra.id), [M.luna.id, M.terra61.id, M.sol61.id, M.astra.id]);
  assert.deepEqual(ids("gpt-5.6-sol"), [M.luna.id, M.terra61.id, M.sol61.id]);
  assert.deepEqual(ids("gpt-5.6-terra"), [M.luna.id], "legacy Terra ids remain Luna aliases");
  assert.deepEqual(ids(M.mini.id), [M.mini.id]);
  assert.deepEqual(ids("auto"), []);
});

test("Claude recommendations stay within provider and model ceiling", () => {
  assert.deepEqual(managedModelSuggestions("haiku").map(c => c.model), [M.claudeHaiku.id]);
  assert.deepEqual(managedModelSuggestions("sonnet").map(c => c.model), [M.claudeHaiku.id, M.claudeSonnet.id]);
  const implementationTier = [M.claudeHaiku.id, M.claudeSonnet.id, M.claudeOpus.id, M.claudeFable.id];
  for (const supervisor of ["opus", "fable", M.claudeFable.id]) {
    assert.deepEqual(managedModelSuggestions(supervisor).map(c => c.model), implementationTier);
  }
  assert.deepEqual(managedModelSuggestions("claude-unknown").map(c => c.model), ["claude-unknown"]);
  const fablePrompt = resolveManagedModePrompt("Research the bounded question.", M.claudeFable.id, true);
  assert.ok(fablePrompt.includes(`- ${M.claudeFable.id}:`));
  assert.doesNotMatch(fablePrompt, /No model ranking is available|gpt-/);
});

test("planned implementation uses worker-specific guidance instead of whole-task Auto criteria", () => {
  const codex = managedModelSuggestions(M.astra.id);
  const terra = codex.find(choice => choice.model === M.terra61.id)!.guidance;
  const sol = codex.find(choice => choice.model === M.sol61.id)!.guidance;
  const astra = codex.find(choice => choice.model === M.astra.id)!.guidance;
  assert.match(terra, /Terra-class routine small development, lookups and ordinary debugging/);
  assert.match(sol, /default implementation worker/);
  assert.doesNotMatch(sol, /Terra/);
  assert.match(sol, /security fixes whose rules have already been decided/);
  assert.match(astra, /exception for unresolved/);
  assert.match(astra, /why Sol 6.1 cannot handle it/);
  assert.doesNotMatch(codex.map(choice => choice.guidance).join("\n"), /all security or safety work|Escalate to Astra for large scope/);

  const claude = managedModelSuggestions(M.claudeOpus.id);
  const haiku = claude.find(choice => choice.model === M.claudeHaiku.id)!.guidance;
  const sonnet = claude.find(choice => choice.model === M.claudeSonnet.id)!.guidance;
  const opus = claude.find(choice => choice.model === M.claudeOpus.id)!.guidance;
  assert.match(haiku, /Luna-class mechanical work with explicit targets, methods and outcomes/);
  assert.match(sonnet, /Terra-class routine small development, lookups and ordinary debugging/);
  assert.match(opus, /normal implementation worker for Sol-class substantive implementation/);
  assert.doesNotMatch(opus, /exception for unresolved|Name the unresolved problem or observed failure/);
});

test("Managed routing avoids inherited model and effort while preserving native capability fallback", () => {
  const codex = resolveManagedModePrompt("Implement the reviewed validation rules and regression cases.", M.astra.id, true);
  assert.match(codex, /remaining assignment complexity/);
  assert.match(codex, /low for mechanical work, medium for settled implementation/);
  assert.match(codex, /Explicitly set model and reasoning_effort only when supported/);
  assert.match(codex, /fork_turns="none" with a self-contained brief/);
  assert.match(codex, /If unavailable, children inherit the supervisor model/);
  assert.match(codex, /For routine rework, give targeted feedback at the same tier first/);
  assert.match(codex, /never exceed the supervisor ceiling/);

  const claude = resolveManagedModePrompt("Implement the reviewed plan.", M.claudeOpus.id, true);
  assert.match(claude, /low for mechanical work, medium for settled implementation/);
  assert.match(claude, /Exception-tier assignments require an unresolved problem or observed failure/);
  assert.match(claude, /native Agent tool's supported model and effort selection/);
  assert.doesNotMatch(claude, /Before a top-tier spawn|fork_turns|reasoning_effort|gpt-6/);
});

test("delegation needs a concrete benefit; a lone same-tier worker is done directly", () => {
  for (const model of [M.claudeOpus.id, M.claudeFable.id, M.astra.id, M.sol61.id]) {
    const prompt = resolveManagedModePrompt("Find why the turn hangs.", model, true);
    assert.match(prompt, /when delegation gives a concrete benefit: a cheaper capable tier, genuinely parallel work, or keeping bulky scans, logs or test output out of supervisor context/);
    assert.match(prompt, /State that benefit in one clause when delegating/);
    assert.match(prompt, /A lone worker on the supervisor's model or tier with no parallel work only adds briefing, handoff and review cost: do that work directly/);
    assert.match(prompt, /Keep root-cause judgment, design decisions and work that depends on context you already hold/);
    assert.match(prompt, /split off separable evidence collection, scans, polling and build\/test runs to a cheaper tier/);
    assert.doesNotMatch(prompt, /even to one worker|Evidence collection is execution, not supervisor-only review/);
  }
});

test("each new turn overrides historical Managed authorization, including enabled then disabled", () => {
  const on = managedModeTurnInstructions(true, "turn-on") ?? "";
  const off = managedModeTurnInstructions(false, "turn-off");
  assert.match(on, /Managed mode: ON/);
  assert.match(on, /request only/);
  assert.match(on, /authorization turn "turn-on"/);
  assert.match(on, /supersedes Managed mode policies and delegation authorizations/);
  assert.equal(off, undefined);
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
  assert.match(low, /If unavailable, children inherit the supervisor model/);
  assert.match(low, /explain the limitation and do not claim cheaper delegation/);
});

test("managed prompt budgets retain delegation, timeout continuation and review ownership", () => {
  for (const model of [M.astra.id, M.claudeOpus.id, M.claudeFable.id]) {
    const prompt = resolveManagedModePrompt("", model, true);
    assert.ok(prompt.length - 2 < 5000, `${model} instruction budget exceeded`);
    assert.equal(prompt.match(/Keep task-level decisions, planning and result review with the supervisor/g)?.length, 1);
    assert.match(prompt, /verification\/build\/test execution, polling, data scanning, research/);
    assert.match(prompt, /maximum 3600000 ms; use the actual schema if different/);
    assert.match(prompt, /After a timeout with unchanged worker status, immediately call wait again: no commentary, agent_message, progress query or renewed analysis/);
    assert.match(prompt, /Process completion, failure, blocker, decision requests or new user input/);
    assert.match(prompt, /higher-priority instructions require updates within 60 seconds/);
    assert.match(prompt, /Do not relay routine worker commentary/);
  }
});
