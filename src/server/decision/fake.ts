import type { DecisionBackend, DecisionRequest, DecisionResult, DecisionAnswer } from "./types";

/** Inject at the Decision boundary. Never registered by the production settings factory. */
export function fakeBackend(answer: Record<string, DecisionAnswer> | ((req: DecisionRequest) => DecisionResult | Promise<DecisionResult>)): DecisionBackend {
  return { id: "fake", supports: { kinds: ["predicate", "choice", "score"], multiQuestion: true },
    async decide(req) { return typeof answer === "function" ? answer(req) : { ok: true, backend: "fake", model: "fake", calibrated: false, answers: answer, latencyMs: 0 }; } };
}
