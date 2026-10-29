import { record } from "./policy";
import type { BackendId, DecisionRequest, DecisionResult, DecisionUsage } from "./types";

export type HttpOptions = { apiKey?: string; fetch?: typeof fetch };
export function usageFrom(raw: unknown): DecisionUsage | undefined {
  const u = record(raw);
  if (!u) return;
  const inputTokens = u.input_tokens ?? u.prompt_tokens;
  const outputTokens = u.output_tokens ?? u.completion_tokens;
  if (![inputTokens, outputTokens].every(v => typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) return;
  return { inputTokens: inputTokens as number, outputTokens: outputTokens as number };
}

/** Keep reported billing even when a provider's answer cannot be decoded. */
export function decodeDecisionResponse(id: BackendId, body: Record<string, unknown>, parse: (body: Record<string, unknown>) => DecisionResult, httpOk = true): DecisionResult {
  const usage = usageFrom(body.usage);
  const fail = (reason: "http_error" | "invalid_response"): DecisionResult => ({ ok: false, attempts: [{ backend: id, reason }], ...(usage ? { usage } : {}) });
  if (!httpOk) return fail("http_error");
  try {
    const result = parse(body);
    return usage ? { ...result, usage } : result;
  } catch { return fail("invalid_response"); }
}
export async function postDecision(id: BackendId, req: DecisionRequest, options: HttpOptions, endpoint: string, body: unknown,
  parse: (body: Record<string, unknown>) => DecisionResult): Promise<DecisionResult> {
  const fail = (reason: Extract<DecisionResult, { ok: false }>["attempts"][number]["reason"]): DecisionResult => ({ ok: false, attempts: [{ backend: id, reason }] });
  if (!options.apiKey) return fail("not_configured");
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.signal?.addEventListener("abort", abort, { once: true });
  if (req.signal?.aborted) controller.abort();
  const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? 8_000);
  try {
    const response = await (options.fetch ?? fetch)(endpoint, { method: "POST", headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify(body) });
    try {
      const parsed = record(await response.json());
      return parsed ? decodeDecisionResponse(id, parsed, parse, response.ok) : fail(response.ok ? "invalid_response" : "http_error");
    } catch { return fail(controller.signal.aborted ? "timeout" : response.ok ? "invalid_response" : "http_error"); }
  } catch { return fail(controller.signal.aborted ? "timeout" : "http_error"); }
  finally { clearTimeout(timeout); req.signal?.removeEventListener("abort", abort); }
}

/** Descriptive levels can be supplied; otherwise the caller's rubric defines numeric endpoints. */
export function scoreLevels(q: Extract<DecisionRequest["questions"][number], { kind: "score" }>): string[] {
  return q.levels ?? [`The minimum rating (${q.min}) under the question's rubric.`, `The maximum rating (${q.max}) under the question's rubric.`];
}
