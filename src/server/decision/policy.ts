import { STATE_DATA_INSTRUCTION, type BackendId, type Decision, type DecisionAnswer, type DecisionAttempt, type DecisionBackend, type DecisionRequest, type DecisionResult, type DecisionUsage, type PurposePolicy } from "./types";

export const DEFAULT_POLICY: PurposePolicy = { order: ["jev"], threshold: { jev: 0.5, openai: 0.5, llm: 0.7 } };
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export const unit = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** Validate and project only allowed fields; provider bodies/errors never cross this boundary. */
export function validatedAnswers(req: DecisionRequest, raw: unknown): Record<string, DecisionAnswer> | undefined {
  const source = record(raw);
  if (!source || Object.keys(source).length !== req.questions.length) return;
  const entries: [string, DecisionAnswer][] = [];
  for (const q of req.questions) {
    const a = Object.hasOwn(source, q.id) ? record(source[q.id]) : undefined;
    if (!a || a.kind !== q.kind) return;
    if (q.kind === "predicate") {
      if (!unit(a.probability)) return;
      entries.push([q.id, { kind: "predicate", probability: a.probability }]);
    } else if (q.kind === "choice") {
      if (typeof a.choice !== "string" || !Object.hasOwn(q.options, a.choice) || !unit(a.confidence)) return;
      let probabilities: Record<string, number> | undefined;
      if (a.probabilities !== undefined) {
        const p = record(a.probabilities);
        if (!p || Object.keys(p).length !== Object.keys(q.options).length || Object.entries(p).some(([key, value]) => !Object.hasOwn(q.options, key) || !unit(value))) return;
        if (Math.abs(Object.values(p).reduce<number>((sum, value) => sum + Number(value), 0) - 1) > 0.01) return;
        probabilities = Object.fromEntries(Object.entries(p)) as Record<string, number>;
      }
      entries.push([q.id, { kind: "choice", choice: a.choice, confidence: a.confidence, ...(probabilities ? { probabilities } : {}) }]);
    } else {
      if (typeof a.score !== "number" || !Number.isFinite(a.score) || a.score < q.min || a.score > q.max || (a.confidence !== undefined && !unit(a.confidence))) return;
      entries.push([q.id, { kind: "score", score: a.score, ...(a.confidence !== undefined ? { confidence: a.confidence as number } : {}) }]);
    }
  }
  return Object.fromEntries(entries);
}

export function validRequest(req: DecisionRequest): boolean {
  return typeof req.state === "string" && Boolean(req.purpose && req.audit.workspaceId)
    && (req.timeoutMs === undefined || (Number.isFinite(req.timeoutMs) && req.timeoutMs > 0 && req.timeoutMs <= 120_000))
    && req.questions.length > 0 && req.questions.length <= 400
    && new Set(req.questions.map(q => q.id)).size === req.questions.length
    && req.questions.every(q => q.id.length > 0 && q.instructions.length > 0 && (q.kind === "predicate"
      || q.kind === "choice" && Object.keys(q.options).length > 0 && Object.entries(q.options).every(([id, criterion]) => id.length > 0 && typeof criterion === "string")
      || q.kind === "score" && Number.isFinite(q.min) && Number.isFinite(q.max) && q.min < q.max
        && (!q.levels || q.levels.length >= 2 && q.levels.length <= 10 && q.levels.every(level => typeof level === "string" && level.length > 0))));
}

export type DecisionAttemptUsage = DecisionUsage & { attempt: number; backend: BackendId; model: string };
export type DecisionAudit = { purpose: string; result: DecisionResult; attempts: DecisionAttempt[]; usage?: DecisionAttemptUsage[] };
export function validatedUsage(usage: DecisionUsage | undefined): DecisionUsage | undefined {
  return usage && [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens ?? 0].every(v => Number.isSafeInteger(v) && v >= 0)
    && Number.isSafeInteger(usage.inputTokens + usage.outputTokens)
    ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens ?? 0 } : undefined;
}
export function createDecisionPolicy(input: {
  backends: DecisionBackend[];
  policy?: (purpose: string) => PurposePolicy;
  audit?: (request: DecisionRequest["audit"], audit: DecisionAudit) => Promise<void>;
}): Decision {
  return async req => {
    const attempts: DecisionAttempt[] = [];
    const usage: DecisionAttemptUsage[] = [];
    const policy = input.policy?.(req.purpose) ?? DEFAULT_POLICY;
    const finish = async (result: DecisionResult) => {
      await input.audit?.(req.audit, { purpose: req.purpose, result, attempts, usage });
      return result;
    };
    for (const [attempt, id] of policy.order.entries()) {
      if (req.signal?.aborted) { attempts.push({ backend: id, reason: "timeout" }); break; }
      const backend = input.backends.find(b => b.id === id);
      if (!validRequest(req)) { attempts.push({ backend: id, reason: "unsupported" }); continue; }
      if (!backend) { attempts.push({ backend: id, reason: "not_configured" }); continue; }
      if (req.questions.some(q => !backend.supports.kinds.includes(q.kind)) || (!backend.supports.multiQuestion && req.questions.length > 1)) {
        attempts.push({ backend: id, reason: "unsupported" }); continue;
      }
      const started = Date.now();
      const controller = new AbortController();
      const abort = () => controller.abort();
      req.signal?.addEventListener("abort", abort, { once: true });
      if (req.signal?.aborted) controller.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let listening = true;
      let resetTimeout!: () => void;
      const timeout = new Promise<DecisionResult>(resolve => {
        resetTimeout = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            controller.abort();
            resolve({ ok: false, attempts: [{ backend: id, reason: "timeout" }] });
          }, req.timeoutMs ?? backend.defaultTimeoutMs ?? 8_000);
        };
        resetTimeout();
      });
      try {
        const result = await Promise.race([
          backend.decide({ ...req, signal: controller.signal, onEvent: event => {
            if (!listening || controller.signal.aborted) return;
            resetTimeout(); req.onEvent?.(event);
          }, questions: req.questions.map(q => ({ ...q, instructions: `${STATE_DATA_INSTRUCTION}\n${q.instructions}` })) }),
          timeout
        ]);
        // Billing is independent of answer validity; retain safe counts before fallback.
        const safeUsage = validatedUsage(result.usage);
        const usageModel = result.ok ? result.backend === id ? result.model : undefined : result.usageModel;
        if (safeUsage) usage.push({ ...safeUsage, attempt, backend: id,
          model: typeof usageModel === "string" && /^[a-zA-Z0-9._:-]{1,100}$/.test(usageModel)
            ? usageModel : ({ jev: "jev-latest", openai: "gpt-6-luna", llm: "gpt-6-luna", fake: "fake" })[id] });
        if (!result.ok) {
          const reasons = ["not_configured", "http_error", "timeout", "invalid_response", "unsupported"];
          const reason = result.attempts[0]?.reason;
          attempts.push({ backend: id, reason: reasons.includes(reason) ? reason : "invalid_response" });
          continue;
        }
        const answers = validatedAnswers(req, result.answers);
        if (!answers || result.backend !== id || !/^[a-zA-Z0-9._:-]{1,100}$/.test(result.model)) {
          attempts.push({ backend: id, reason: "invalid_response" }); continue;
        }
        return finish({ ok: true, backend: id, model: result.model, calibrated: id === "jev" || id === "openai", answers, latencyMs: Date.now() - started, ...(safeUsage ? { usage: safeUsage } : {}) });
      } catch {
        attempts.push({ backend: id, reason: "http_error" });
      } finally { listening = false; clearTimeout(timer); req.signal?.removeEventListener("abort", abort); }
    }
    return finish({ ok: false, attempts });
  };
}
