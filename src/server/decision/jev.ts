import { postDecision, scoreLevels, usageFrom, type HttpOptions } from "./http";
import { record } from "./policy";
import type { DecisionBackend, DecisionAnswer, DecisionRequest, DecisionResult } from "./types";

export function jevBackend(options: HttpOptions): DecisionBackend {
  return { id: "jev", supports: { kinds: ["predicate", "choice", "score"], multiQuestion: true },
    decide: req => postDecision("jev", req, options, "https://api.typesafe.ai/v1/systemone", {
      model: "jev-latest", state: req.state,
      questions: Object.fromEntries(req.questions.map(q => [q.id, { type: q.kind === "predicate" ? "noul" : q.kind, instructions: q.instructions,
        ...(q.kind === "choice" ? { criteria: q.options } : q.kind === "score" ? { criteria: scoreLevels(q) } : {}) }]))
    }, body => jevResult(req, body)) };
}

/** Pure protocol mapping; common policy validates the projected answers. */
export function jevResult(req: DecisionRequest, body: Record<string, unknown>): DecisionResult {
      const raw = record(body.answers);
      const answers = Object.fromEntries(req.questions.map(q => {
        const a = record(raw?.[q.id]) ?? {};
        return [q.id, q.kind === "predicate" ? { kind: q.kind, probability: a.noul }
          : q.kind === "choice" ? { kind: q.kind, choice: a.choice, confidence: a.confidence, ...(a.probabilities !== undefined ? { probabilities: a.probabilities } : {}) }
          : { kind: q.kind, score: typeof a.score === "number" ? q.min + a.score / (scoreLevels(q).length - 1) * (q.max - q.min) : undefined, ...(a.confidence !== undefined ? { confidence: a.confidence } : {}) }];
      })) as Record<string, DecisionAnswer>;
      return { ok: true, backend: "jev", model: "jev-latest", calibrated: true, answers, latencyMs: 0, usage: usageFrom(body.usage) };

}
