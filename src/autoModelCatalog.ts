/** Ordered by routing capability; legacy models remain available in manual gears. */
export const AUTO_MODEL_CHOICES = {
  "gpt-5.6-luna": "Use only for fully explicit, mechanical tasks with a known target and exact desired outcome: change specified text or simple CSS at a location supplied by Browser Bridge JSON; execute an unambiguous routine terminal or log-extraction command. Do not use when investigation, interpretation, design judgment or open-ended development is needed.",
  "gpt-5.6-terra": "Use for everyday small development, code/content lookup, investigation and routine debugging when no Sol or Astra criterion applies. This is the default when the task requires finding the target or deciding how to implement it rather than following fully mechanical instructions.",
  "gpt-5.6-sol": "Use at minimum for moderate reviews/audits, planning, performance optimization, prompt design/evaluation/optimization, investigating logs for clues or root causes, and reasoning over large datasets or many records. Also use for multi-part analysis and changes requiring meaningful reasoning across interacting constraints. Merely displaying prompt text or running an exact supplied log command does not trigger this criterion. Escalate to Astra for large scope or when an Astra criterion applies.",
  "gpt-6-astra": "Use for 3D model/scene creation, editing and manipulation; all security or safety work; large reviews/audits spanning a codebase or multiple subsystems; and large plans involving architecture, migrations or substantial cross-system coordination. Also use for the hardest problems and repeated failures or stalled attempts at lower tiers. Unrelated historical mentions or terminology-only translation do not trigger this criterion; active continuations do."
} as const;

export const AUTO_EFFORT_CHOICES = {
  low: "Direct, simple work with little reasoning needed.",
  medium: "Routine work requiring a few reasoning steps.",
  high: "Substantial analysis, implementation or debugging.",
  xhigh: "Difficult work with many interacting constraints or subtle failure modes.",
  ultra: "Exceptional reasoning depth for the hardest problems; use sparingly."
} as const;

export type AutoModel = keyof typeof AUTO_MODEL_CHOICES;
export type AutoEffort = keyof typeof AUTO_EFFORT_CHOICES;
export type AutoCustomRule = { enabled: boolean; efforts: AutoEffort[]; condition: string };
export type AutoCustomRules = Partial<Record<AutoModel, AutoCustomRule>>;
export function isAutoModel(value: unknown): value is AutoModel {
  return typeof value === "string" && Object.hasOwn(AUTO_MODEL_CHOICES, value);
}
export function isAutoEffort(value: unknown): value is AutoEffort {
  return typeof value === "string" && Object.hasOwn(AUTO_EFFORT_CHOICES, value);
}
