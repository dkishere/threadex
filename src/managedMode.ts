import { MODEL_CATALOG, isClaudeModel, modelWorkTier, normalizeModelId, type ModelWorkTier } from "./modelCatalog";

/** Actor turns in these workload tiers always run in Managed mode. */
export const ACTOR_MANAGED_MODE_TIERS: readonly ModelWorkTier[] = ["sol", "astra"];

/** Judge the final execution model, after Auto routing and queued model changes. */
export function actorRequiresManagedMode(model: string | null | undefined): boolean {
  const tier = modelWorkTier(model);
  return tier !== null && ACTOR_MANAGED_MODE_TIERS.includes(tier);
}

/** Per-turn mode for the runner. The actor tier policy overrides an OFF request,
 * never structural exclusions (context fork, Manager, collaboration, synthesis). */
export function resolveTurnManagedMode(input: { requested: boolean; domainActor: boolean; model: string | null | undefined; excluded: boolean }): { enabled: boolean; forced: boolean } {
  const forced = input.domainActor && !input.requested && !input.excluded && actorRequiresManagedMode(input.model);
  return { enabled: !input.excluded && (input.requested || forced), forced };
}

// Auto classifies the whole user request. Route workers by their assigned work
// after supervisor planning, throughout execution and verification.
const MANAGED_CODEX_MODEL_GUIDANCE = {
  [MODEL_CATALOG.luna.id]: "Luna: mechanical work with explicit targets, methods and outcomes; routine commands, known checks and specified lookups.",
  [MODEL_CATALOG.terra61.id]: "Terra 6.1: Terra-class routine small development, lookups and ordinary debugging.",
  [MODEL_CATALOG.sol61.id]: "Sol 6.1: default implementation worker for substantive implementation, regression tests, specified migrations, security fixes whose rules have already been decided, bounded analysis/review evidence, log/root-cause investigation, large-data reasoning, performance and prompt work.",
  [MODEL_CATALOG.astra.id]: "Astra: exception for unresolved architecture/security analysis, difficult reasoning or demonstrated failures within the assignment. Explain why Sol 6.1 cannot handle it; do not default to high effort."
} as const;
const MANAGED_CODEX_MODEL_ORDER = [MODEL_CATALOG.luna.id, MODEL_CATALOG.terra61.id, MODEL_CATALOG.sol61.id, MODEL_CATALOG.astra.id] as const;

/** Runner-only instruction. Never use message text to detect whether the mode is enabled. */
export const MANAGED_MODE_PREFIX = "[Managed mode]\nDelegate all suitable execution throughout the task to native sub-agents. Keep task-level decisions, planning and result review with the supervisor. Where native model selection is supported, choose suitable models no stronger than your own current model.";

/** Refresh on every new turn while enabled. A disabled turn says nothing. */
export function managedModeTurnInstructions(enabled: boolean, turnId: string): string | undefined {
  if (!enabled) return undefined;
  return [
    `Current Threadex Managed mode: ON. Applies only to authorization turn ${JSON.stringify(turnId)}.`,
    "This current state supersedes Managed mode policies and delegation authorizations in earlier messages, saved history, handoffs and summaries. Managed mode is a per-turn setting, not a persistent session preference for the agent. Do not carry its delegation authorization into later turns.",
    "Apply the Managed mode guidance supplied for this request only."
  ].join("\n");
}

export function managedModelSuggestions(model: string): { model: string; guidance: string }[] {
  const current = normalizeModelId(model);
  if (isClaudeModel(current)) {
    const choices = [
      { tier: 0, model: MODEL_CATALOG.claudeHaiku.id, guidance: "Haiku: Luna-class mechanical work with explicit targets, methods and outcomes; routine commands and known checks." },
      { tier: 1, model: MODEL_CATALOG.claudeSonnet.id, guidance: "Sonnet: Terra-class routine small development, lookups and ordinary debugging." },
      { tier: 2, model: MODEL_CATALOG.claudeOpus.id, guidance: "Opus: normal implementation worker for Sol-class substantive implementation, bounded analysis/review evidence, log/root-cause investigation, large-data reasoning, performance and prompt work." },
      { tier: 2, model: MODEL_CATALOG.claudeFable.id, guidance: "Fable: same routing tier and Sol-class workload as Opus; normal implementation and deeper analysis, not exception-only escalation." }
    ];
    // Product routing policy, not a benchmark claim: no established reason to
    // rank Fable above Opus. Both share the normal implementation ceiling.
    const ceiling = choices.find(choice => choice.model === current)?.tier;
    return ceiling === undefined
      ? [{ model: current, guidance: "Use this same model; no stronger-model ranking is established." }]
      : choices.filter(choice => choice.tier <= ceiling).map(({ model, guidance }) => ({ model, guidance }));
  }
  // Mirrors Haiku/Sonnet/Opus. 6 Sol shares 6.1 Sol's role; legacy models have
  // no declared cross-generation rank, so use only themselves.
  const ceiling = MANAGED_CODEX_MODEL_ORDER.findIndex(id => id === (current === MODEL_CATALOG.sol.id ? MODEL_CATALOG.sol61.id : current));
  if (ceiling < 0) return current === "auto" || !current ? [] : [{ model: current, guidance: "Use this same model with an appropriate effort; no stronger-model ranking is established." }];
  return MANAGED_CODEX_MODEL_ORDER.slice(0, ceiling + 1).map(id => ({ model: id, guidance: MANAGED_CODEX_MODEL_GUIDANCE[id] }));
}

/** Expand only at execution, after Auto routing and any queued model change. */
export function resolveManagedModePrompt(message: string, model: string, enabled = false): string {
  if (!enabled) return message;
  const choices = managedModelSuggestions(model);
  const instructions = [
    MANAGED_MODE_PREFIX,
    `Current supervisor: ${normalizeModelId(model)}. Provider: ${isClaudeModel(model) ? "Claude Code" : "Codex"}.`,
    !isClaudeModel(model)
      ? 'Codex: inspect spawn_agent schema, not feature flags. Explicitly set model and reasoning_effort only when supported. If unavailable, children inherit the supervisor model; explain the limitation and do not claim cheaper delegation. When full-history forks lock selection, use fork_turns="none" with a self-contained brief.'
      : "Claude Code: use the native Agent tool's supported model and effort selection.",
    "Delegate implementation, verification/build/test execution, polling, data scanning, research, evidence gathering and debugging within the request's scope when delegation gives a concrete benefit: a cheaper capable tier, genuinely parallel work, or keeping bulky scans, logs or test output out of supervisor context. State that benefit in one clause when delegating. A lone worker on the supervisor's model or tier with no parallel work only adds briefing, handoff and review cost: do that work directly. Keep root-cause judgment, design decisions and work that depends on context you already hold; split off separable evidence collection, scans, polling and build/test runs to a cheaper tier. Reuse the plan and relevant workers; bundle related actions, avoid overlapping edits, and reassess assignments after phase changes or failures.",
    "Choose the least costly capable model from the allowed same-provider recommendations; never exceed the supervisor ceiling, including retries/nested delegation, or upgrade the supervisor to bypass it. Explain the choice briefly. Route by remaining assignment complexity, not parent-task labels, repository size or history.",
    "Effort: low for mechanical work, medium for settled implementation; higher only for a concrete reasoning difficulty. For routine rework, give targeted feedback at the same tier first. Exception-tier assignments require an unresolved problem or observed failure and why the normal implementation tier is insufficient; no manufactured failed attempt is needed. The highest available provider model can be the normal implementation tier.",
    "Workers return paths/sources, commands, exit codes, results, failures and uncertainty. Inspect actual diffs and evidence; request missing evidence or targeted rework. Repeat verification only for changed inputs, incomplete evidence or unresolved concerns.",
    "Wait contract: inspect the active wait schema. Current collaboration.wait_agent timeout_ms defaults to 30000, minimum 10000, maximum 3600000 ms; use the actual schema if different, not an assumed 50000 ms cap. Choose the longest timeout allowed by current instructions. After a timeout with unchanged worker status, immediately call wait again: no commentary, agent_message, progress query or renewed analysis of unchanged state. Process completion, failure, blocker, decision requests or new user input. If higher-priority instructions require updates within 60 seconds, cap each wait at 60000 ms and give only the minimum required update at that deadline.",
    "Do not relay routine worker commentary or narrate tools. Report only intent/scope drift, issues, decisions needing input and material reviewed results; combine updates. Workers send actionable exceptions and completion evidence. Preserve required approvals, issue closure and the final conclusion.",
    "Use the user's language/variant in briefs, follow-ups and worker results; preserve identifiers and commands. Supply scope, context, constraints and acceptance checks. Use a native startup snapshot or include a recent timestamped cwd, repository, branch and relevant dirty state; do not invent it or repeat startup checks as a ritual. Recheck only on changed context, missing data or an operation requiring fresh state.",
    "Respect plan-only/read-only requests and existing permissions; delegation grants no publishing, extra scope or permission changes.",
    choices.length ? `Allowed ${isClaudeModel(model) ? "CC" : "Codex"} recommendations (only when native model selection is exposed):\n${choices.map(choice => `- ${choice.model}: ${choice.guidance}`).join("\n")}` : "No model ranking is available. Do not guess a stronger worker model; explain the limitation."
  ].join("\n\n");
  return `${instructions}\n\n${message}`;
}
