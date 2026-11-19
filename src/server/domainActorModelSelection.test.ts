import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_CODEX_TIER_MODELS, MODEL_CATALOG as M, MODEL_OPTIONS, normalizeModelEffort } from "../modelCatalog";
import { ACTOR_MODEL_SELECTION_INSTRUCTIONS, ACTOR_MODEL_TIER_GUIDANCE, ACTOR_WORKFLOW_QUESTION, ACTOR_WORKLOAD_ASSESSMENT, PROMPT_WORK_MODEL_FLOOR, actorChosenModel, actorWorkflowAssessment, actorWorkflowExecutionGuidance, actorExecutionModels, actorModelOptions, actorRequestedExecution, actorTaskExecutionEffort, actorWorkloadKind } from "./domainActorModelSelection";
import type { DecisionResult } from "./decision/types";

test("explicit canonical model and effort directives beat routing defaults", () => {
  assert.deepEqual(actorRequestedExecution(["continue merging HMS into hub on a new branch, with astra XH managed"]), { model: CURRENT_CODEX_TIER_MODELS.astra, effort: "xhigh" });
  assert.deepEqual(actorRequestedExecution(["用 astra xh", "use sol high"]), { model: CURRENT_CODEX_TIER_MODELS.sol, effort: "high" });
  for (const model of [M.sol.id, M.sol61.id, CURRENT_CODEX_TIER_MODELS.sol, M.astra.id, CURRENT_CODEX_TIER_MODELS.astra]) {
    assert.deepEqual(actorRequestedExecution([`use ${model} high`]), { model, effort: "high" });
  }
  for (const text of ["don't use astra xh", "唔用 astra xh", "> use astra xh", "```\nuse astra xh\n```", "Compare Astra and Sol"]) {
    assert.equal(actorRequestedExecution([text]), undefined, text);
  }
});

test("prompt provider offers one concrete model per workload tier independent of actor defaults", () => {
  assert.deepEqual(actorExecutionModels([...MODEL_OPTIONS], M.claudeSonnet.id), [M.claudeHaiku.id, M.claudeSonnet.id, M.claudeOpus.id]);
  assert.deepEqual(actorExecutionModels([...MODEL_OPTIONS], M.luna.id), Object.values(CURRENT_CODEX_TIER_MODELS), "the current lineup is preferred when every model is allowed");
  assert.deepEqual(actorExecutionModels([M.luna.id, M.sol61.id, M.astra.id], M.luna.id), [M.luna.id, M.sol61.id, M.astra.id], "actors without Terra permission keep the Sol tier");
  assert.deepEqual(actorExecutionModels([M.sol.id, M.claudeOpus.id], M.astra.id), [M.sol.id]);
  assert.deepEqual(actorExecutionModels([M.luna.id], M.claudeHaiku.id), [], "permissions cannot cause a provider fallback");
});

test("prompt work is floored at the Sol/Opus tier in both provider groups", () => {
  assert.ok(ACTOR_MODEL_SELECTION_INSTRUCTIONS.includes(PROMPT_WORK_MODEL_FLOOR));
  assert.match(PROMPT_WORK_MODEL_FLOOR, /even a small wording change, requires at least the Sol\/Opus tier/);
  assert.match(PROMPT_WORK_MODEL_FLOOR, /A user request is not itself prompt work/);
  const excluded = (models: string[]) => Object.entries(actorModelOptions(models, "high"))
    .filter(([, text]) => /Not eligible for any prompt work/.test(text)).map(([model]) => model);
  assert.deepEqual(excluded(actorExecutionModels([...MODEL_OPTIONS], M.claudeOpus.id)), [M.claudeHaiku.id, M.claudeSonnet.id]);
  assert.deepEqual(excluded(actorExecutionModels([...MODEL_OPTIONS], M.sol.id)), [M.luna.id, M.terra61.id]);
  assert.match(PROMPT_WORK_MODEL_FLOOR, /never Luna, mini, Terra, Haiku or Sonnet/);
  assert.deepEqual(excluded([M.mini.id, M.gpt55.id, M.gpt54.id]), [M.mini.id]);
  const options = actorModelOptions([M.luna.id, M.sol.id], "high");
  assert.match(options[M.luna.id], /Eligible only for small, clear/, "non-prompt guidance is unchanged");
  assert.match(options[M.sol.id], /^gpt-6-sol, actual execution effort \w+\. Assess capability and headroom against the full assigned workload before considering cost\.$/);
});

test("tier guidance sends mechanical work low, keeps Astra for genuine difficulty and puts the user's model first", () => {
  assert.ok(ACTOR_MODEL_SELECTION_INSTRUCTIONS.includes(ACTOR_MODEL_TIER_GUIDANCE));
  assert.match(ACTOR_MODEL_SELECTION_INSTRUCTIONS, /runs only because the actor did not choose a valid model/);
  assert.match(ACTOR_MODEL_TIER_GUIDANCE, /applying a stated configuration, mapping or fixed rule.*suits the lightest sufficient tier even when it spans several actors, workspaces or records/);
  assert.match(ACTOR_MODEL_TIER_GUIDANCE, /Astra is an exception tier for difficult architecture, security analysis/);
  assert.match(ACTOR_MODEL_TIER_GUIDANCE, /not the strongest offered/);
  assert.match(ACTOR_MODEL_TIER_GUIDANCE, /actor's role or domain \(for example security\).*not evidence/);
  assert.match(ACTOR_MODEL_TIER_GUIDANCE, /explicit user model or tier requirement.*takes precedence/);
  assert.match(ACTOR_WORKLOAD_ASSESSMENT, /does not by itself make work substantial/);
  const options = actorModelOptions([M.sol61.id, M.astra.id], "medium");
  assert.match(options[M.astra.id], /Exception tier/);
  assert.doesNotMatch(options[M.sol61.id], /Exception tier/);
  const currentOptions = actorModelOptions([CURRENT_CODEX_TIER_MODELS.sol, CURRENT_CODEX_TIER_MODELS.astra], "medium");
  assert.match(currentOptions[CURRENT_CODEX_TIER_MODELS.astra], /Exception tier/);
  assert.doesNotMatch(currentOptions[CURRENT_CODEX_TIER_MODELS.sol], /Exception tier|Not eligible for any prompt work/);
  assert.equal(actorChosenModel(M.luna.id, [M.luna.id, M.astra.id]), M.luna.id);
  assert.equal(actorChosenModel(M.astra.id, [M.luna.id]), undefined, "a choice outside the allowed options falls back to Decision");
  assert.equal(actorChosenModel(undefined, [M.luna.id]), undefined);
});

test("lighter models run at raised effort unless the work is mechanical; Sol/Astra tiers keep the actor's effort", () => {
  for (const model of [M.luna.id, M.terra61.id, M.mini.id, M.claudeSonnet.id, M.claudeHaiku.id]) {
    assert.equal(actorTaskExecutionEffort(model, "medium"), "xhigh", model);
    assert.equal(actorTaskExecutionEffort(model, "low", { workloadKind: "reasoning" }), "xhigh", model);
    assert.equal(actorTaskExecutionEffort(model, "medium", { workloadKind: "mechanical" }), "medium", model);
  }
  assert.equal(actorTaskExecutionEffort(M.luna.id, "xhigh"), "xhigh", "the floor never lowers a higher actor effort");
  // The claiming actor's proposed effort raises the floor on any tier, but never lowers it.
  assert.equal(actorTaskExecutionEffort(M.claudeOpus.id, "medium", { proposedEffort: "high" }), "high");
  assert.equal(actorTaskExecutionEffort(M.sol61.id, "medium", { proposedEffort: "xhigh" }), "xhigh");
  assert.equal(actorTaskExecutionEffort(M.claudeOpus.id, "medium", { proposedEffort: "low" }), "medium", "a lower proposal keeps the actor's effort");
  assert.equal(actorTaskExecutionEffort(M.luna.id, "medium", { proposedEffort: "high" }), "xhigh", "a lower proposal keeps the light-tier floor");
  assert.equal(actorTaskExecutionEffort(M.mini.id, "medium", { proposedEffort: "max", workloadKind: "mechanical" }), normalizeModelEffort(M.mini.id, "max"), "a proposal is normalized to the model");
  assert.equal(actorTaskExecutionEffort(M.claudeSonnet.id, "medium", { proposedEffort: "max" }), "max");
  assert.equal(actorTaskExecutionEffort(M.luna.id, "medium", { requestedEffort: "low", proposedEffort: "xhigh" }), "low", "an explicit user effort beats the proposal");
  for (const model of [CURRENT_CODEX_TIER_MODELS.sol, CURRENT_CODEX_TIER_MODELS.astra, M.sol61.id, M.astra.id, M.claudeOpus.id, M.claudeFable.id, M.claudeFable51.id]) assert.equal(actorTaskExecutionEffort(model, "medium"), "medium", model);
  assert.equal(actorTaskExecutionEffort(M.luna.id, "medium", { requestedEffort: "low" }), "low", "an explicit user effort is final");
  assert.equal(actorTaskExecutionEffort(M.claudeOpus.id, "medium", { requestedEffort: "xhigh" }), "xhigh");
  const options = actorModelOptions([M.luna.id, M.sol61.id], "medium");
  assert.match(options[M.luna.id], /actual execution effort xhigh \(medium for mechanical work\)\./);
  assert.match(options[M.sol61.id], /actual execution effort medium\./);
  const decision = (choice: string): DecisionResult => ({ ok: true, answers: { workload_kind: { kind: "choice", choice, confidence: 1 } }, attempts: [] } as unknown as DecisionResult);
  assert.equal(actorWorkloadKind(decision("mechanical")), "mechanical");
  assert.equal(actorWorkloadKind(decision("other")), undefined);
  assert.equal(actorWorkloadKind(undefined), undefined);
  assert.match(ACTOR_MODEL_TIER_GUIDANCE, /Lighter models run at raised effort unless the work is mechanical/);
});

test("workflow assessment keeps workload suitability separate from mode authorization", () => {
  assert.match(ACTOR_WORKFLOW_QUESTION.instructions, /combined workload, interacting requirements/);
  assert.match(ACTOR_WORKFLOW_QUESTION.instructions, /Do not classify substantial work as small because Managed mode is OFF/);
  assert.equal(ACTOR_WORKFLOW_QUESTION.kind, "choice");
  const result = (choice: string): DecisionResult => ({ ok: true, backend: "fake", model: "fake", calibrated: false, latencyMs: 0,
    answers: { workflow: { kind: "choice", choice, confidence: 0.9 } } });
  for (const choice of ["small_direct", "substantial_managed", "substantial_direct"] as const) {
    assert.equal(actorWorkflowAssessment(result(choice)), choice);
    const guidance = actorWorkflowExecutionGuidance(choice);
    assert.ok(guidance.includes(choice));
    assert.match(guidance, /does not enable Managed mode/);
    assert.match(guidance, /actual mode and actor binding/);
  }
  assert.match(actorWorkflowExecutionGuidance("substantial_managed"), /dependencies, integration ownership and verification/);
  assert.match(actorWorkflowExecutionGuidance("substantial_managed"), /complete the authorized work directly/);
  assert.match(actorWorkflowExecutionGuidance("small_direct"), /do not split merely/);
  assert.match(actorWorkflowExecutionGuidance("substantial_direct"), /Explain the concrete coupling/);
  assert.equal(actorWorkflowAssessment(result("enable_managed")), undefined);
  assert.equal(actorWorkflowAssessment({ ok: false, attempts: [] }), undefined);
  assert.equal(actorWorkflowAssessment({ ...result("small_direct"), answers: {} } as DecisionResult), undefined);
  assert.match(actorWorkflowExecutionGuidance(undefined), /legacy or incomplete Decision/);
});
