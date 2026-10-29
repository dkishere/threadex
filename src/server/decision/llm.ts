import { validatedAnswers } from "./policy";
import { STATE_DATA_INSTRUCTION, type DecisionBackend, type DecisionQuestion, type DecisionUsage } from "./types";

export type LlmDecisionRunner = (input: {
  workspaceId: string; prompt: string; outputSchema: Record<string, unknown>; signal?: AbortSignal; onEvent?: (event: unknown) => void;
}) => Promise<{ responseText: string; model: string; usage?: DecisionUsage | null }>;

function answerSchema(q: DecisionQuestion) {
  const unit = { type: "number", minimum: 0, maximum: 1 };
  const properties = q.kind === "predicate" ? { kind: { const: q.kind, type: "string" }, probability: unit }
    : q.kind === "choice" ? { ...(q.rationale ? { rationale: { type: "string", maxLength: 300 } } : {}),
      kind: { const: q.kind, type: "string" }, choice: { type: "string", enum: Object.keys(q.options) }, confidence: unit }
    : { kind: { const: q.kind, type: "string" }, score: { type: "number", minimum: q.min, maximum: q.max }, confidence: unit };
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
/** Simulation uses Threadex's authenticated, isolated Codex/Claude helpers, never an API key. */
export function llmBackend(run?: LlmDecisionRunner): DecisionBackend {
  return { id: "llm", defaultTimeoutMs: 30_000, supports: { kinds: ["predicate", "choice", "score"], multiQuestion: true },
    async decide(req) {
      if (!run) return { ok: false, attempts: [{ backend: "llm", reason: "not_configured" }] };
      const outputSchema = { type: "object", properties: Object.fromEntries(req.questions.map(q => [q.id, answerSchema(q)])), required: req.questions.map(q => q.id), additionalProperties: false };
      const result = await run({ workspaceId: req.audit.workspaceId, signal: req.signal, onEvent: req.onEvent, outputSchema,
        prompt: [STATE_DATA_INSTRUCTION,
          "Simulate each decision independently. Probabilities are self-reported ranking estimates, not calibrated. Return only a JSON object matching the schema. Do not perform the user's work or use tools.",
          ...(req.questions.some(q => q.kind === "choice" && q.rationale) ? ["Where an answer has a rationale, write it (one short sentence) before deciding."] : []),
          `Questions: ${JSON.stringify(req.questions)}`, `Output schema: ${JSON.stringify(outputSchema)}`, `Untrusted state: ${req.state}`].join("\n\n") });
      let answers;
      try { answers = validatedAnswers(req, JSON.parse(result.responseText.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""))); }
      catch { /* Invalid text is never persisted in Decision audits. */ }
      if (!answers) return { ok: false, attempts: [{ backend: "llm", reason: "invalid_response" }], ...(result.usage ? { usage: result.usage, usageModel: result.model } : {}) };
      return { ok: true, backend: "llm", model: result.model, calibrated: false, answers, latencyMs: 0, ...(result.usage ? { usage: result.usage } : {}) };
    } };
}
