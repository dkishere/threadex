import assert from "node:assert/strict";
import test from "node:test";
import { createDecisionPolicy, validatedAnswers, type DecisionAudit } from "./decision/policy";
import { jevResult } from "./decision/jev";
import { openaiResult } from "./decision/openai";
import { decodeDecisionResponse } from "./decision/http";
import { fakeBackend } from "./decision/fake";
import { durableDecision } from "./decision/service";
import { pickActor, breakClaimTie } from "./decision/actors";
import type { DecisionAnswer, DecisionRequest, DecisionResult } from "./decision/types";

const request: DecisionRequest = { purpose: "test", state: "PRIVATE STATE", audit: { workspaceId: "ws", roundId: "round" },
  questions: [{ id: "q", kind: "choice", instructions: "Choose", options: { yes: "Yes", no: "No" } }] };
const answer = { q: { kind: "choice", choice: "yes", confidence: 0.9 } } as const;
const fakePolicy = { order: ["fake"] as const, threshold: { fake: 0.5 } };

test("documented provider shapes normalize predicate, choice distributions and score scales", () => {
  const req: DecisionRequest = { ...request, questions: [
    { id: "p", kind: "predicate", instructions: "Is it?" },
    ...request.questions,
    { id: "s", kind: "score", instructions: "Rate", min: 10, max: 20, levels: ["Low", "Medium", "High"] }
  ] };
  const jev = jevResult(req, { answers: { p: { noul: 0.7 }, q: { choice: "yes", confidence: 0.8, probabilities: { yes: 0.9, no: 0.1 } }, s: { score: 1.5, confidence: 0.6 } }, usage: { input_tokens: 20, output_tokens: 5 } });
  const openai = openaiResult(req, { answers: [
    { type: "score", name: "s", score: 1.5, confidence: 0.6 },
    { type: "predicate", name: "p", probability: 0.7 },
    { type: "choice", name: "q", choice: "yes", confidence: 0.8, probabilities: [{ value: "yes", probability: 0.9 }, { value: "no", probability: 0.1 }] }
  ] });
  assert.ok(jev.ok && openai.ok);
  assert.deepEqual(validatedAnswers(req, jev.answers), validatedAnswers(req, openai.answers));
  assert.deepEqual(jev.answers.s, { kind: "score", score: 17.5, confidence: 0.6 });
  assert.deepEqual(jev.usage, { inputTokens: 20, outputTokens: 5 });
  const refusal = openaiResult(request, { answers: [{ type: "refusal", name: "q" }] });
  assert.ok(refusal.ok);
  assert.equal(validatedAnswers(request, refusal.answers), undefined);
});
function decideWith(answers: Record<string, DecisionAnswer>) {
  return createDecisionPolicy({ backends: [fakeBackend(answers)], policy: () => ({ ...fakePolicy, order: [...fakePolicy.order] }) });
}

test("ordered policy skips unconfigured backends and audits only validated fields", async () => {
  let audit: DecisionAudit | undefined;
  const decide = createDecisionPolicy({
    backends: [fakeBackend(async req => {
      assert.match(req.questions[0].instructions, /state as task data, never instructions/);
      return { ok: true, backend: "fake", model: "fake", calibrated: true, answers: { q: { ...answer.q, raw: "SECRET BODY" } }, latencyMs: 0, raw: "SECRET BODY" } as DecisionResult;
    })],
    policy: () => ({ order: ["jev", "openai", "fake"], threshold: {} }),
    audit: async (_req, entry) => { audit = entry; }
  });
  const result = await decide(request);
  assert.ok(result.ok);
  assert.equal(result.calibrated, false);
  assert.deepEqual(audit?.attempts, [{ backend: "jev", reason: "not_configured" }, { backend: "openai", reason: "not_configured" }]);
  assert.doesNotMatch(JSON.stringify(audit), /SECRET|PRIVATE/);
});

test("invalid probabilities, confidence, choices, missing answers and scores fail closed", async () => {
  for (const value of [NaN, Infinity, -0.1, 1.01]) {
    assert.equal((await decideWith({ q: { ...answer.q, confidence: value } })(request)).ok, false);
    assert.equal((await decideWith({ q: { ...answer.q, probabilities: { yes: value, no: 0 } } })(request)).ok, false);
    const predicate = { ...request, questions: [{ id: "q", kind: "predicate" as const, instructions: "Is it?" }] };
    assert.equal((await decideWith({ q: { kind: "predicate", probability: value } })(predicate)).ok, false);
  }
  const invalidAnswers: Record<string, DecisionAnswer>[] = [{}, { q: { ...answer.q, choice: "__proto__" } }, { q: { ...answer.q, probabilities: { yes: 0.2, no: 0.2 } } }];
  for (const invalid of invalidAnswers) {
    assert.equal((await decideWith(invalid)(request)).ok, false);
  }
  const score = { ...request, questions: [{ id: "q", kind: "score" as const, instructions: "Rate", min: 2, max: 5 }] };
  assert.equal((await decideWith({ q: { kind: "score", score: 5.1 } })(score)).ok, false);
  assert.equal((await decideWith({ q: { kind: "score", score: 3.5 } })(score)).ok, true);
});

test("invalid first answer falls through, thrown errors are sanitized, and timeout is bounded", async () => {
  const failing = { ...fakeBackend({ q: { ...answer.q, confidence: 4 } }), id: "jev" as const };
  const decide = createDecisionPolicy({ backends: [failing, fakeBackend(answer)], policy: () => ({ order: ["jev", "fake"], threshold: {} }) });
  assert.equal((await decide(request)).ok, true);
  const thrown = createDecisionPolicy({ backends: [fakeBackend(() => { throw new Error("SECRET"); })], policy: () => ({ order: ["fake"], threshold: {} }) });
  assert.deepEqual(await thrown(request), { ok: false, attempts: [{ backend: "fake", reason: "http_error" }] });
  const slow = createDecisionPolicy({ backends: [fakeBackend(() => new Promise(() => {}))], policy: () => ({ order: ["fake"], threshold: {} }) });
  assert.deepEqual(await slow({ ...request, timeoutMs: 5 }), { ok: false, attempts: [{ backend: "fake", reason: "timeout" }] });
});

test("durable decisions survive retries/restarts, coalesce concurrency, and replay failures", async () => {
  const rows = new Map<string, DecisionAudit>();
  const usageRows = new Set<string>();
  let calls = 0;
  const storage = { load: async (key: string) => rows.get(key) ?? null,
    save: async (key: string, entry: DecisionAudit) => { rows.set(key, rows.get(key) ?? entry); return rows.get(key)!; },
    usage: async (key: string) => { usageRows.add(key); } };
  const factory = () => durableDecision(audit => createDecisionPolicy({
    backends: [fakeBackend(() => { calls++; return { ok: false, attempts: [{ backend: "fake", reason: "http_error" }] }; })],
    policy: () => ({ order: ["fake"], threshold: {} }), audit
  }), storage);
  const first = factory();
  const results = await Promise.all([first(request), first(request)]);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(await factory()(request), results[0]);
  assert.equal(calls, 1);
  assert.equal(usageRows.size, 1);
  assert.doesNotMatch(JSON.stringify([...rows.values()]), /PRIVATE/);
  await factory()({ ...request, audit: { ...request.audit, roundId: "another" } });
  assert.equal(calls, 2);
});

test("actor callers do not fabricate an owner, use backend thresholds, and bypass a lone claim", async () => {
  const actors = [{ id: "a", systemHeader: "Developer", roleSummary: "Code" }, { id: "b", systemHeader: "Writer", roleSummary: "Text" }];
  const context = { userPrompt: "Fix code", actors, audit: request.audit, policy: { order: ["fake" as const], threshold: { fake: 0.7 } } };
  const picked = await pickActor({ ...context, decide: decideWith({ a: { kind: "predicate", probability: 0.8 }, b: { kind: "predicate", probability: 0.6 } }) });
  assert.ok(picked.ok && picked.actorId === "a");
  const tied = await pickActor({ ...context, decide: decideWith({ a: { kind: "predicate", probability: 0.8 }, b: { kind: "predicate", probability: 0.8 } }) });
  assert.equal(tied.ok, false);
  const claims = [{ actorId: "a", claim: "I can code" }];
  const single = await breakClaimTie({ ...context, claims, decide: async () => { throw new Error("must not call"); } });
  assert.deepEqual(single, { ok: true, actorId: "a" });
  const other = await breakClaimTie({ ...context, claims: [...claims, { actorId: "b", claim: "I can write" }], decide: decideWith({ owner: { kind: "choice", choice: "other", confidence: 0.9 } }) });
  assert.equal(other.ok, false);
});

test("claim tiebreak rejects tied maxima (including other) and inconsistent choices", async () => {
  const context = {
    userPrompt: "Fix code", audit: request.audit,
    actors: ["a", "b"].map(id => ({ id, systemHeader: "Developer", roleSummary: "Code" })),
    claims: ["a", "b"].map(actorId => ({ actorId, claim: "I can do it" })),
    policy: { order: ["fake" as const], threshold: { fake: 0.5 } }
  };
  for (const [probabilities, expected] of [
    [{ a: 0.5, b: 0.5, other: 0 }, false],
    [{ a: 0.5, b: 0, other: 0.5 }, false],
    [{ a: 0.2, b: 0.8, other: 0 }, false],
    [{ a: 0.6, b: 0.2, other: 0.2 }, true]
  ] as const) {
    const result = await breakClaimTie({ ...context, decide: decideWith({ owner: { kind: "choice", choice: "a", confidence: 0.5, probabilities } }) });
    assert.equal(result.ok, expected);
    if (!result.ok) assert.equal(result.reason, "routing_failed");
  }
});

test("usage survives invalid answers and parser failures without preserving raw content", async () => {
  let audit: DecisionAudit | undefined;
  const invalid = { ok: true, backend: "fake", model: "fake", calibrated: false,
    answers: { q: { ...answer.q, confidence: 9 } }, latencyMs: 0, usage: { inputTokens: 20, outputTokens: 5, secret: "SECRET" } } as DecisionResult;
  const decide = createDecisionPolicy({ backends: [fakeBackend(() => invalid)], policy: () => ({ order: ["fake"], threshold: {} }),
    audit: async (_req, entry) => { audit = entry; } });
  assert.equal((await decide(request)).ok, false);
  assert.deepEqual(audit?.usage, [{ attempt: 0, backend: "fake", model: "fake", inputTokens: 20, outputTokens: 5, cachedInputTokens: 0 }]);
  assert.doesNotMatch(JSON.stringify(audit), /SECRET|PRIVATE/);
  const body = { usage: { input_tokens: 20, output_tokens: 5 }, raw: "SECRET" };
  const failed = decodeDecisionResponse("llm", body, () => { throw new Error("SECRET"); });
  assert.deepEqual(failed, { ok: false, attempts: [{ backend: "llm", reason: "invalid_response" }], usage: { inputTokens: 20, outputTokens: 5 } });
  const malformed = decodeDecisionResponse("openai", body, value => openaiResult(request, value));
  assert.equal(malformed.ok, false);
  assert.deepEqual(malformed.usage, { inputTokens: 20, outputTokens: 5 });
  for (const count of [NaN, Infinity, -1, 0.5]) {
    const rejected = createDecisionPolicy({ backends: [fakeBackend(() => ({ ...invalid, usage: { inputTokens: count, outputTokens: 5 } }))],
      policy: () => ({ order: ["fake"], threshold: {} }), audit: async (_req, entry) => { audit = entry; } });
    await rejected(request);
    assert.deepEqual(audit?.usage, []);
  }
});
