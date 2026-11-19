/** Shared model metadata for client selectors, server defaults and Auto routing.
 * workTier pairs providers by workload tier (Sol/Opus, Astra/Fable); null means
 * no declared pairing. */
export const MODEL_CATALOG = {
  luna: { id: "gpt-6-luna", label: "6 Luna", ultra: true, autoLowEffort: false, workTier: null, aliases: ["gpt-5.6-luna", "gpt-5.6 Luna", "gpt-5.6-terra", "gpt-5.6 Terra"] },
  sol: { id: "gpt-6-sol", label: "6 Sol", ultra: true, autoLowEffort: false, workTier: "sol", aliases: ["gpt-5.6-sol", "gpt-5.6 Sol"] },
  sol61: { id: "gpt-6.1-sol", label: "6.1 Sol", ultra: true, autoLowEffort: false, workTier: "sol", aliases: [] },
  sol62: { id: "gpt-6.2-sol", label: "6.2 Sol", ultra: true, autoLowEffort: false, workTier: "sol", aliases: [] },
  // Sonnet-class Terra workload; legacy gpt-5.6-terra ids remain Luna aliases.
  terra61: { id: "gpt-6.1-terra", label: "6.1 Terra", ultra: true, autoLowEffort: false, workTier: null, aliases: [] },
  astra: { id: "gpt-6-astra", label: "6 Astra", ultra: true, autoLowEffort: true, workTier: "astra", aliases: [] },
  astra62: { id: "gpt-6.2-astra", label: "6.2 Astra", ultra: true, autoLowEffort: true, workTier: "astra", aliases: [] },
  gpt55: { id: "gpt-5.5", label: "5.5", ultra: false, autoLowEffort: false, workTier: null, aliases: [] },
  gpt54: { id: "gpt-5.4", label: "5.4", ultra: false, autoLowEffort: false, workTier: null, aliases: [] },
  mini: { id: "gpt-5.4-mini", label: "5.4-mini", ultra: false, autoLowEffort: false, workTier: null, aliases: [] },
  // Claude models run through the Claude Agent SDK instead of Codex (see server/claudeRunner.ts).
  claudeOpus: { id: "claude-opus-5-5", label: "Opus 5.5", ultra: false, autoLowEffort: false, workTier: "sol", aliases: [] },
  claudeSonnet: { id: "claude-sonnet-5-5", label: "Sonnet 5.5", ultra: false, autoLowEffort: false, workTier: null, aliases: [] },
  claudeHaiku: { id: "claude-haiku-5-5", label: "Haiku 5.5", ultra: false, autoLowEffort: false, workTier: null, aliases: [] },
  claudeFable: { id: "claude-fable-5-2", label: "Fable 5.2", ultra: false, autoLowEffort: false, workTier: "astra", aliases: [] },
  // Superseded by Fable 5.2 but kept so stored selections, actor allowedModels and history keep their label and tier.
  claudeFable51: { id: "claude-fable-5-1", label: "Fable 5.1", ultra: false, autoLowEffort: false, workTier: "astra", aliases: [] }
} as const;
export type ModelWorkTier = NonNullable<typeof MODEL_CATALOG[keyof typeof MODEL_CATALOG]["workTier"]>;
export function modelWorkTier(value: string | null | undefined): ModelWorkTier | null {
  const id = normalizeModelId(value?.trim() ?? "");
  return Object.values(MODEL_CATALOG).find(model => model.id === id)?.workTier ?? null;
}

export type ModelProvider = "codex" | "claude";
/** Which agent backend runs a model. Claude model ids always start with "claude-". */
export function modelProvider(value: string | null | undefined): ModelProvider {
  return normalizeModelId(value?.trim() ?? "").startsWith("claude-") ? "claude" : "codex";
}
/** True when moving a session from `previous` to `next` crosses the Claude Code <-> Codex provider group. */
export function crossesModelGroup(previous: string | null | undefined, next: string | null | undefined): boolean {
  return Boolean(previous && next) && modelProvider(previous) !== modelProvider(next);
}
export function isClaudeModel(value: string | null | undefined): boolean {
  return modelProvider(value) === "claude";
}

export const AUTO_MODEL_ORDER = [MODEL_CATALOG.luna.id, MODEL_CATALOG.sol.id, MODEL_CATALOG.astra.id] as const;

const LEGACY_CODEX_TIER_MODELS = {
  luna: MODEL_CATALOG.luna.id,
  terra: MODEL_CATALOG.terra61.id,
  sol: MODEL_CATALOG.sol61.id,
  astra: MODEL_CATALOG.astra.id
} as const;
export const CODEX_TIER_MODEL_LINEUPS = [
  // Put the next recommendation here. Keep older lineups for their Managed supervisors.
  { ...LEGACY_CODEX_TIER_MODELS, sol: MODEL_CATALOG.sol62.id, astra: MODEL_CATALOG.astra62.id },
  LEGACY_CODEX_TIER_MODELS
] as const;
export const CURRENT_CODEX_TIER_MODELS = CODEX_TIER_MODEL_LINEUPS[0];
/** Current Claude recommendations and the targets of the unversioned family names. */
export const CURRENT_CLAUDE_TIER_MODELS = {
  haiku: MODEL_CATALOG.claudeHaiku.id,
  sonnet: MODEL_CATALOG.claudeSonnet.id,
  opus: MODEL_CATALOG.claudeOpus.id,
  fable: MODEL_CATALOG.claudeFable.id
} as const;
export type CodexRoutingTier = keyof typeof CURRENT_CODEX_TIER_MODELS;
export const CODEX_ROUTING_TIERS = ["luna", "terra", "sol", "astra"] as const;

/** Models within a tier, from the current recommendation to older choices. */
export function codexTierModels(tier: CodexRoutingTier): string[] {
  const models: string[] = CODEX_TIER_MODEL_LINEUPS.map(lineup => lineup[tier]);
  if (tier === "sol") models.push(MODEL_CATALOG.sol.id);
  return [...new Set(models)];
}

export const WORKSPACE_MANAGER_MODEL_ORDER = CODEX_ROUTING_TIERS.map(tier => CURRENT_CODEX_TIER_MODELS[tier]);
export const WORKSPACE_MANAGER_SUPPORTED_MODELS = [...new Set([
  ...WORKSPACE_MANAGER_MODEL_ORDER, ...CODEX_ROUTING_TIERS.flatMap(codexTierModels)
])];
export const MODEL_OPTIONS: readonly string[] = [...[...AUTO_MODEL_ORDER].reverse(), ...Object.values(MODEL_CATALOG).filter(model => !(AUTO_MODEL_ORDER as readonly string[]).includes(model.id)).map(model => model.id)];

// Actor permissions distinguish providers even when their workload tiers match.
// Retired standalone models retain separate permissions.
export const ACTOR_MODEL_TIER_LABELS = {
  "codex-luna": "Codex Luna", "codex-terra": "Codex Terra", "codex-sol": "Codex Sol", "codex-astra": "Codex Astra",
  "claude-haiku": "Claude Haiku", "claude-sonnet": "Claude Sonnet", "claude-opus": "Claude Opus", "claude-fable": "Claude Fable",
  "legacy-5.5": "GPT 5.5", "legacy-5.4": "GPT 5.4", "legacy-5.4-mini": "GPT 5.4-mini"
} as const;
export type ActorModelTier = keyof typeof ACTOR_MODEL_TIER_LABELS;
export const ACTOR_MODEL_TIERS = Object.keys(ACTOR_MODEL_TIER_LABELS) as ActorModelTier[];
const actorModelTiersById = new Map<string, ActorModelTier>([
  ...CODEX_ROUTING_TIERS.flatMap(tier => codexTierModels(tier).map(model => [model, `codex-${tier}`] as const)),
  ...Object.values(MODEL_CATALOG).flatMap(({ id }) => {
    const family = /^claude-(haiku|sonnet|opus|fable)-/.exec(id)?.[1];
    return family ? [[id, `claude-${family}` as ActorModelTier] as const] : [];
  }),
  [MODEL_CATALOG.gpt55.id, "legacy-5.5"],
  [MODEL_CATALOG.gpt54.id, "legacy-5.4"],
  [MODEL_CATALOG.mini.id, "legacy-5.4-mini"]
]);
export function actorModelTier(model: string): ActorModelTier | undefined {
  return actorModelTiersById.get(normalizeModelId(model));
}
export type ActorModelPermissions = { allowedModelTiers?: ActorModelTier[] | null; allowedModels?: readonly string[] };
export function actorAllowedModelTiers(actor: ActorModelPermissions): ActorModelTier[] | null {
  if (actor.allowedModelTiers !== undefined) return actor.allowedModelTiers;
  if (actor.allowedModels === undefined) return null;
  return [...new Set(actor.allowedModels.map(actorModelTier).filter(tier => tier !== undefined))];
}
export function actorAllowedModels(actor: ActorModelPermissions): string[] {
  const allowedTiers = actorAllowedModelTiers(actor);
  return allowedTiers === null ? [...MODEL_OPTIONS] : MODEL_OPTIONS.filter(model => {
    const tier = actorModelTier(model);
    return tier !== undefined && allowedTiers.includes(tier);
  });
}
export function sharedActorAllowedModels(owner: ActorModelPermissions, executor: ActorModelPermissions): string[] {
  const executorModels = new Set(actorAllowedModels(executor));
  return actorAllowedModels(owner).filter(model => executorModels.has(model));
}

export const DEFAULT_MODEL = MODEL_CATALOG.luna.id;
export const REVIEW_MODEL = MODEL_CATALOG.sol.id;
export function normalizeModelId(value: string): string {
  if (Object.hasOwn(CURRENT_CLAUDE_TIER_MODELS, value)) {
    return CURRENT_CLAUDE_TIER_MODELS[value as keyof typeof CURRENT_CLAUDE_TIER_MODELS];
  }
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
