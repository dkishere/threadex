/** Shared model metadata for client selectors, server defaults and Auto routing. */
export const MODEL_CATALOG = {
  luna: { id: "gpt-6-luna", label: "6 Luna", ultra: true, autoLowEffort: false, aliases: ["gpt-5.6-luna", "gpt-5.6 Luna", "gpt-5.6-terra", "gpt-5.6 Terra"] },
  sol: { id: "gpt-6-sol", label: "6 Sol", ultra: true, autoLowEffort: false, aliases: ["gpt-5.6-sol", "gpt-5.6 Sol"] },
  astra: { id: "gpt-6-astra", label: "6 Astra", ultra: true, autoLowEffort: true, aliases: [] },
  gpt55: { id: "gpt-5.5", label: "5.5", ultra: false, autoLowEffort: false, aliases: [] },
  gpt54: { id: "gpt-5.4", label: "5.4", ultra: false, autoLowEffort: false, aliases: [] },
  mini: { id: "gpt-5.4-mini", label: "5.4-mini", ultra: false, autoLowEffort: false, aliases: [] }
} as const;

export const AUTO_MODEL_ORDER = [MODEL_CATALOG.luna.id, MODEL_CATALOG.sol.id, MODEL_CATALOG.astra.id] as const;
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
