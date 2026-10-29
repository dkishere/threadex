import { postDecision, scoreLevels, usageFrom, type HttpOptions } from "./http";
import { record } from "./policy";
import type { DecisionAnswer, DecisionBackend, DecisionRequest, DecisionResult } from "./types";

export function openaiBackend(options: HttpOptions): DecisionBackend {
  return { id: "openai", supports: { kinds: ["predicate", "choice", "score"], multiQuestion: true },
    decide: req => postDecision("openai", req, options, "https://api.openai.com/v1/decisions", {
      model: "gpt-6-luna", input: req.state,
      questions: req.questions.map(q => ({ name: q.id, type: q.kind, instructions: q.instructions,
        ...(q.kind === "choice" ? { choices: Object.entries(q.options).map(([value, description]) => ({ value, description })) }
          : q.kind === "score" ? { levels: scoreLevels(q).map((description, i) => ({ label: String(i), description })) } : {}) }))
    }, body => openaiResult(req, body)) };
}

/** Pure protocol mapping; common policy validates the projected answers. */
export function openaiResult(req: DecisionRequest, body: Record<string, unknown>): DecisionResult {
      if (!Array.isArray(body.answers) || body.answers.length !== req.questions.length) return { ok: false, attempts: [{ backend: "openai", reason: "invalid_response" }] };
      const raw = body.answers.map(record);
      if (new Set(raw.map(a => a?.name)).size !== raw.length) return { ok: false, attempts: [{ backend: "openai", reason: "invalid_response" }] };
      const answers = Object.fromEntries(req.questions.map(q => {
        const a = raw.find(a => a?.name === q.id);
        if (!a || a.type !== q.kind) return [q.id, {}];
        if (q.kind === "predicate") return [q.id, { kind: q.kind, probability: a.probability }];
        if (q.kind === "score") return [q.id, { kind: q.kind, score: typeof a.score === "number" ? q.min + a.score / (scoreLevels(q).length - 1) * (q.max - q.min) : undefined, confidence: a.confidence }];
        if (Array.isArray(a.probabilities) && new Set(a.probabilities.map(p => record(p)?.value)).size !== a.probabilities.length) return [q.id, {}];
        const probabilities = Array.isArray(a.probabilities) ? Object.fromEntries(a.probabilities.map(p => { const value = record(p); return [String(value?.value), value?.probability]; })) : a.probabilities;
        return [q.id, { kind: q.kind, choice: a.choice, confidence: a.confidence, probabilities }];
      })) as Record<string, DecisionAnswer>;
      return { ok: true, backend: "openai", model: "gpt-6-luna", calibrated: true, answers, latencyMs: 0, usage: usageFrom(body.usage) };

}
