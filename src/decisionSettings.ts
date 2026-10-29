export const DECISION_BACKENDS = ["jev", "openai", "llm"] as const;
export type ConfiguredDecisionBackend = typeof DECISION_BACKENDS[number];
export type DecisionPurposeSettings = {
  order: ConfiguredDecisionBackend[];
  threshold: Record<ConfiguredDecisionBackend, number>;
};
export type DecisionPolicies = Record<string, DecisionPurposeSettings>;
export const DEFAULT_DECISION_POLICIES: DecisionPolicies = Object.fromEntries(["model_select", "sh_pick", "claim_tiebreak"].map(purpose => [purpose, {
  order: ["jev"], threshold: { jev: 0.5, openai: 0.5, llm: 0.7 }
}]));
export function validDecisionPolicies(value: unknown): value is DecisionPolicies {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.length <= 50 && ["model_select", "sh_pick", "claim_tiebreak"].every(p => Object.hasOwn(value, p))
    && entries.every(([purpose, policy]) => /^[a-z][a-z0-9_]{0,79}$/.test(purpose)
      && policy && typeof policy === "object" && Array.isArray(policy.order) && policy.order.length > 0
      && policy.order.length <= 3 && new Set(policy.order).size === policy.order.length
      && policy.order.every((id: unknown) => DECISION_BACKENDS.includes(id as ConfiguredDecisionBackend))
      && policy.threshold && typeof policy.threshold === "object"
      && DECISION_BACKENDS.every(id => typeof policy.threshold[id] === "number" && Number.isFinite(policy.threshold[id]) && policy.threshold[id] >= 0 && policy.threshold[id] <= 1));
}
