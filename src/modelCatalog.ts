/** Shared model metadata for client selectors, server defaults and Auto routing. */
export const MODEL_CATALOG = {
  luna: { id: "gpt-6-luna", label: "6 Luna", ultra: true, autoLowEffort: false, aliases: ["gpt-5.6-luna", "gpt-5.6 Luna", "gpt-5.6-terra", "gpt-5.6 Terra"] },
  sol: { id: "gpt-6-sol", label: "6 Sol", ultra: true, autoLowEffort: false, aliases: ["gpt-5.6-sol", "gpt-5.6 Sol"] },
  sol61: { id: "gpt-6.1-sol", label: "6.1 Sol", ultra: true, autoLowEffort: false, aliases: [] },
  astra: { id: "gpt-6-astra", label: "6 Astra", ultra: true, autoLowEffort: true, aliases: [] },
  gpt55: { id: "gpt-5.5", label: "5.5", ultra: false, autoLowEffort: false, aliases: [] },
  gpt54: { id: "gpt-5.4", label: "5.4", ultra: false, autoLowEffort: false, aliases: [] },
  mini: { id: "gpt-5.4-mini", label: "5.4-mini", ultra: false, autoLowEffort: false, aliases: [] },
  // Claude models run through the Claude Agent SDK instead of Codex (see server/claudeRunner.ts).
  claudeOpus: { id: "claude-opus-5-5", label: "Claude Opus 5.5", ultra: false, autoLowEffort: false, aliases: ["opus"] },
  claudeSonnet: { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", ultra: false, autoLowEffort: false, aliases: ["sonnet"] },
  claudeHaiku: { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", ultra: false, autoLowEffort: false, aliases: ["haiku"] }
} as const;

export type ModelProvider = "codex" | "claude";
/** Which agent backend runs a model. Claude model ids always start with "claude-". */
export function modelProvider(value: string | null | undefined): ModelProvider {
  return normalizeModelId(value?.trim() ?? "").startsWith("claude-") ? "claude" : "codex";
}
export function isClaudeModel(value: string | null | undefined): boolean {
  return modelProvider(value) === "claude";
}

export const AUTO_MODEL_ORDER = [MODEL_CATALOG.luna.id, MODEL_CATALOG.sol.id, MODEL_CATALOG.astra.id] as const;
/** Manager assignments use 6.1 Sol without changing Auto routing defaults. */
export const WORKSPACE_MANAGER_MODEL_ORDER = [MODEL_CATALOG.luna.id, MODEL_CATALOG.sol61.id, MODEL_CATALOG.astra.id] as const;
export const MODEL_OPTIONS: readonly string[] = [...[...AUTO_MODEL_ORDER].reverse(), ...Object.values(MODEL_CATALOG).filter(model => !(AUTO_MODEL_ORDER as readonly string[]).includes(model.id)).map(model => model.id)];
export const DEFAULT_MODEL = MODEL_CATALOG.luna.id;
export const REVIEW_MODEL = MODEL_CATALOG.sol.id;
export function normalizeModelId(value: string): string {
  return Object.values(MODEL_CATALOG).find(model => model.id === value || (model.aliases as readonly string[]).includes(value))?.id ?? value;
}
export function modelLabel(value: string): string {
  return Object.values(MODEL_CATALOG).find(model => model.id === value)?.label ?? value.replace(/^gpt-/i, "");
}
export function supportsUltraEffort(value: string): boolean {
  return Object.values(MODEL_CATALOG).find(model => model.id === normalizeModelId(value))?.ultra ?? false;
}
export const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export const CODEX_ULTRA_EFFORTS = [...CODEX_EFFORTS, "max", "ultra"] as const;
// https://platform.claude.com/docs/en/build-with-claude/effort
// The catalog's Opus, Sonnet and Haiku 5.5 models support all five levels.
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ModelEffort = typeof CODEX_ULTRA_EFFORTS[number];

export function modelEfforts(model: string): readonly ModelEffort[] {
  if (isClaudeModel(model)) return CLAUDE_EFFORTS;
  return supportsUltraEffort(model) ? CODEX_ULTRA_EFFORTS : CODEX_EFFORTS;
}

/** Preserve supported choices; adapt old settings and cross-provider model switches. */
export function normalizeModelEffort(model: string, effort: string): ModelEffort {
  const options = modelEfforts(model);
  if (options.includes(effort as ModelEffort)) return effort as ModelEffort;
  if (effort === "minimal" || effort === "none") return "low";
  if (effort === "ultra" || effort === "max") return options[options.length - 1];
  return "high";
}
export function supportsAutoLowEffort(value: string): boolean {
  return Object.values(MODEL_CATALOG).find(model => model.id === value)?.autoLowEffort ?? false;
}
export function defaultGearProfiles() {
  return [
    { model: DEFAULT_MODEL, effort: "low" as const },
    { model: DEFAULT_MODEL, effort: "medium" as const },
    { model: MODEL_CATALOG.astra.id, effort: "high" as const },
    { model: DEFAULT_MODEL, effort: "xhigh" as const },
    { model: REVIEW_MODEL, effort: "high" as const },
    { model: MODEL_CATALOG.astra.id, effort: "xhigh" as const }
  ];
}
