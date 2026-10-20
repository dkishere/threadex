import { AUTO_MODEL_CHOICES } from "./autoModelCatalog";
import { AUTO_MODEL_ORDER, MODEL_CATALOG, isClaudeModel, normalizeModelId } from "./modelCatalog";

/** Runner-only instruction. Never use message text to detect whether the mode is enabled. */
export const MANAGED_MODE_PREFIX = "[Managed mode]\nUse native sub-agents more often to execute the plan. Where native model selection is supported, choose suitable models no stronger than your own current model.";

/** Refresh on every new turn, including disabled turns and resumed sessions. */
export function managedModeTurnInstructions(enabled: boolean, turnId: string): string {
  return [
    `Current Threadex Managed mode: ${enabled ? "ON" : "OFF"}. Applies only to authorization turn ${JSON.stringify(turnId)}.`,
    "This current state supersedes Managed mode policies and delegation authorizations in earlier messages, saved history, handoffs and summaries. Managed mode is a per-turn setting, not a persistent session preference for the agent. Do not carry its delegation authorization into later turns.",
    enabled
      ? "Apply the Managed mode guidance supplied for this request only."
      : "Earlier Managed mode instructions to prefer sub-agents, delegate implementation or choose worker models are inactive. Do not proactively spawn sub-agents because of those earlier instructions. Handle the current request directly unless the current user request or applicable repository/skill instructions explicitly authorize delegation. Turning this mode off does not cancel already-running work."
  ].join("\n");
}

export function managedModelSuggestions(model: string): { model: string; guidance: string }[] {
  const current = normalizeModelId(model);
  if (isClaudeModel(current)) {
    const choices = [
      { model: MODEL_CATALOG.claudeHaiku.id, guidance: "Haiku: mechanical edits, bounded searches, summaries and running known checks." },
      { model: MODEL_CATALOG.claudeSonnet.id, guidance: "Sonnet: implementation from a clear plan, multi-file changes, tests and routine debugging." },
      { model: MODEL_CATALOG.claudeOpus.id, guidance: "Opus: unresolved architecture, security, difficult debugging or repeated failures; prefer cheaper workers for settled implementation." }
    ];
    const ceiling = choices.findIndex(choice => choice.model === current);
    return ceiling < 0 ? [] : choices.slice(0, ceiling + 1);
  }
  // Auto's capability order is authoritative. 6.1 Sol shares Sol's role;
  // legacy models have no declared cross-generation rank, so use only themselves.
  const ceiling = current === MODEL_CATALOG.sol61.id ? 1 : AUTO_MODEL_ORDER.findIndex(id => id === current);
  if (ceiling < 0) return current === "auto" || !current ? [] : [{ model: current, guidance: "Use this same model with an appropriate effort; no stronger-model ranking is established." }];
  return AUTO_MODEL_ORDER.slice(0, ceiling + 1).map(id => ({
    model: id === MODEL_CATALOG.sol.id ? MODEL_CATALOG.sol61.id : id,
    guidance: AUTO_MODEL_CHOICES[id]
  }));
}

/** Expand only at execution, after Auto routing and any queued model change. */
export function resolveManagedModePrompt(message: string, model: string, enabled = false): string {
  if (!enabled) return message;
  const choices = managedModelSuggestions(model);
  const instructions = [
    MANAGED_MODE_PREFIX,
    `This policy applies to this request. Current supervisor model: ${normalizeModelId(model)}. Provider: ${isClaudeModel(model) ? "Claude Code" : "Codex"}.`,
    !isClaudeModel(model)
      ? "Codex: inspect the actual spawn_agent schema before selecting a model. Feature flags alone do not establish the active sub-agent version. If the schema does not expose model selection, children inherit the supervisor model: do not pass unsupported model/reasoning_effort arguments or claim cheaper-model delegation. In that case the model recommendations below do not apply; delegate for bounded scope and coordination only. If model selection is exposed, use the recommendations within the supervisor ceiling."
      : "Claude Code: use the native Agent tool's supported model selection for the recommendations below.",
    "Prefer native sub-agents, including a single worker when parallelism is unnecessary. You are authorized to delegate this request within its existing scope. Keep planning and final review with the supervisor. Reuse an existing clear plan; delegate concrete implementation instead of writing the whole implementation yourself first.",
    "Choose the least costly model and reasoning effort capable of the assigned work, not blindly the cheapest or the inherited supervisor model. State the choice and a short reason. Use only the same provider and the allowed recommendations below; never exceed the current supervisor's model tier, including retries or nested delegation. Do not upgrade the supervisor just to bypass this ceiling.",
    "Give workers bounded scope, relevant context, constraints and acceptance checks. Prefer a fresh bounded brief when a full-history fork prevents model selection. Avoid overlapping edits. Review the actual diff and verification results; request targeted rework when needed. Escalate only within the ceiling. If native delegation or model selection is unavailable, explain that limitation rather than silently claiming delegation or using a stronger model.",
    "Write sub-agent task prompts and follow-up instructions in the user's language, including their preferred language variant. Preserve code, identifiers, paths and commands verbatim. Ask workers to use the same language for progress updates and results unless the user requests otherwise.",
    "Avoid repeated worker startup checks. When a native startup snapshot is supplied, use it rather than rerunning pwd, repository-root or git status merely as a ritual. If no native snapshot is available (including the Codex handoff fallback), include a recent timestamped cwd, repository root, branch and relevant uncommitted changes in the worker brief, in the user's language. Do not reuse the session's old opening snapshot as current state or invent missing facts. Recheck selectively after directory/worktree changes, missing or truncated data, or when the operation needs current state. This fallback is prompt guidance, not automatic child-start injection.",
    "Respect plan-only/read-only requests and existing permissions. This mode does not authorize extra scope, publishing or permission changes.",
    choices.length ? `Allowed ${isClaudeModel(model) ? "CC" : "Codex"} recommendations (only when native model selection is exposed):\n${choices.map(choice => `- ${choice.model}: ${choice.guidance}`).join("\n")}` : "No model ranking is available. Do not guess a stronger worker model; explain the limitation."
  ].join("\n\n");
  return `${instructions}\n\n${message}`;
}
