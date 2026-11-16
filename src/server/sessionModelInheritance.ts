/**
 * The model and effort a user's own composer prompt chose, to save as the session's selected model.
 * An automated prompt without a model (session tool, task wake) inherits that selection, so it must
 * follow the user's latest choice rather than an older actor-task or default selection.
 * Automated prompts, Auto mode and workspace manager turns keep their own model handling.
 */
export function composerModelSelectionToSave(input: {
  clientLayout?: string;
  promptOrigin?: unknown;
  requestedModel?: string;
  model?: string;
  modelReasoningEffort?: string;
  autoModelEnabled: boolean;
  workspaceManager: boolean;
}): { selectedModel: string; selectedEffort?: string } | null {
  if (input.clientLayout === undefined || input.promptOrigin || input.autoModelEnabled || input.workspaceManager) return null;
  if (!input.requestedModel?.trim() || !input.model) return null;
  return { selectedModel: input.model, ...(input.modelReasoningEffort ? { selectedEffort: input.modelReasoningEffort } : {}) };
}
