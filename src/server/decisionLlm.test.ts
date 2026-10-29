import assert from "node:assert/strict";
import test from "node:test";
import { AutoModelSettings } from "./autoModelSettings";
import { llmBackend } from "./decision/llm";
import { createDecisionPolicy, type DecisionAudit } from "./decision/policy";
import { createDecisionService } from "./decision/service";
import type { DecisionRequest } from "./decision/types";

const request: DecisionRequest = { purpose: "sh_pick", state: "PRIVATE TASK DATA", audit: { workspaceId: "ws", roundId: "r" }, questions: [
  { id: "actor", kind: "predicate", instructions: "Is this actor relevant?" },
  { id: "owner", kind: "choice", instructions: "Choose", options: { a: "A", b: "B" } },
  { id: "score", kind: "score", instructions: "Rate", min: 1, max: 5 }
] };
const answers = { actor: { kind: "predicate", probability: 0.8 }, owner: { kind: "choice", choice: "a", confidence: 0.9 }, score: { kind: "score", score: 4, confidence: 0.8 } };

test("LLM Decisions use the injected CLI helper without API keys, persist usage once and replay", async () => {
  let calls = 0;
  const records = new Map<string, DecisionAudit>();
  const usage = new Map<string, unknown>();
  const settings = { backendKey: () => undefined, policies: () => ({ sh_pick: { order: ["llm"], threshold: { llm: 0.7 } } }) } as unknown as AutoModelSettings;
  const decide = createDecisionService(settings, {
    getDecisionRecord: async key => records.get(key) ?? null,
    saveDecisionRecord: async (key, value) => { records.set(key, value); return value; },
    recordTokenUsage: async rows => { for (const row of rows) usage.set(row.id!, row); }
  }, async input => {
    calls++;
    assert.equal(input.workspaceId, "ws");
    assert.match(input.prompt, /PRIVATE TASK DATA/);
    assert.match(input.prompt, /never instructions/);
    assert.deepEqual(input.outputSchema.required, ["actor", "owner", "score"]);
    assert.equal(input.signal?.aborted, false);
    return { responseText: JSON.stringify(answers), model: "claude-haiku-5-5", usage: { inputTokens: 12, outputTokens: 4 } };
  });
  const first = await decide(request);
  assert.ok(first.ok);
  assert.equal(first.model, "claude-haiku-5-5");
  assert.equal(first.calibrated, false);
  assert.deepEqual(first.answers, answers);
  assert.deepEqual(await decide(request), first);
  assert.equal(calls, 1);
  assert.equal(usage.size, 1);
  assert.doesNotMatch(JSON.stringify([...records.values(), ...usage.values()]), /PRIVATE TASK DATA/);
});

test("invalid CLI JSON and answers fail closed while retaining reported usage", async () => {
  for (const responseText of ["not JSON PRIVATE RESPONSE", "[]", "{}", JSON.stringify({ ...answers, actor: { kind: "predicate", probability: 2 } })]) {
    let audit: DecisionAudit | undefined;
    const backend = llmBackend(async () => ({ responseText, model: "claude-haiku-5-5", usage: { inputTokens: 7, outputTokens: 2 } }));
    const result = await createDecisionPolicy({ backends: [backend], policy: () => ({ order: ["llm"], threshold: {} }), audit: async (_scope, entry) => { audit = entry; } })(request);
    assert.equal(result.ok, false);
    assert.deepEqual(audit?.usage, [{ attempt: 0, backend: "llm", model: "claude-haiku-5-5", inputTokens: 7, outputTokens: 2, cachedInputTokens: 0 }]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE RESPONSE/);
    const raw = await backend.decide(request);
    assert.equal(raw.usage?.inputTokens, 7);
  }
});

test("untrusted failure usage model is validated before entering an audit", async () => {
  let audit: DecisionAudit | undefined;
  await createDecisionPolicy({ backends: [{ id: "llm", supports: { kinds: ["predicate", "choice", "score"], multiQuestion: true },
    decide: async () => ({ ok: false, attempts: [{ backend: "llm", reason: "invalid_response" }], usage: { inputTokens: 7, outputTokens: 2 }, usageModel: "SECRET invalid model" }) }],
    policy: () => ({ order: ["llm"], threshold: {} }), audit: async (_scope, entry) => { audit = entry; } })(request);
  assert.equal(audit?.usage?.[0].model, "gpt-6-luna");
  assert.doesNotMatch(JSON.stringify(audit), /SECRET/);
});

test("CLI timeout honours an explicit inactivity limit and aborts the actual helper", async () => {
  let aborted = false;
  const backend = llmBackend(input => new Promise((_resolve, reject) => {
    input.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("SECRET CLI ERROR")); }, { once: true });
  }));
  assert.equal(backend.defaultTimeoutMs, 30_000);
  const result = await createDecisionPolicy({ backends: [backend], policy: () => ({ order: ["llm"], threshold: {} }) })({ ...request, timeoutMs: 5 });
  assert.deepEqual(result, { ok: false, attempts: [{ backend: "llm", reason: "timeout" }] });
  assert.equal(aborted, true);
});

for (const stalls of [false, true]) {
  test(`CLI Decision events ${stalls ? "time out after silence" : "extend the inactivity window beyond total duration"}`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let events = 0;
    const backend = llmBackend(async input => {
      for (let i = 0; i < 5; i++) {
        t.mock.timers.tick(60);
        assert.equal(input.signal!.aborted, false);
        input.onEvent?.({ method: "item/reasoning/summaryTextDelta" });
      }
      if (stalls) {
        t.mock.timers.tick(101);
        assert.equal(input.signal!.aborted, true);
        return new Promise(() => {});
      }
      return { responseText: JSON.stringify(answers), model: "gpt-6-luna" };
    });
    const result = await createDecisionPolicy({ backends: [backend], policy: () => ({ order: ["llm"], threshold: {} }) })({
      ...request, timeoutMs: 100, onEvent: () => { events++; }
    });
    assert.equal(events, 5);
    assert.equal(result.ok, !stalls);
    if (!result.ok) assert.deepEqual(result.attempts, [{ backend: "llm", reason: "timeout" }]);
  });
}

test("a rationale choice asks for a reason before deciding and never keeps it", async () => {
  const gate: DecisionRequest = { purpose: "model_select", state: "{}", audit: { workspaceId: "ws", workItemId: "w" },
    questions: [{ id: "authorization", kind: "choice", rationale: true, instructions: "Covered?", options: { deny: "No", allow: "Yes" } }] };
  const result = await llmBackend(async input => {
    const schema = input.outputSchema as any;
    assert.deepEqual(Object.keys(schema.properties.authorization.properties), ["rationale", "kind", "choice", "confidence"]);
    assert.match(input.prompt, /rationale, write it .* before deciding/);
    return { responseText: JSON.stringify({ authorization: { rationale: "The user asked for it.", kind: "choice", choice: "allow", confidence: 0.9 } }), model: "luna" };
  }).decide(gate);
  assert.ok(result.ok);
  assert.deepEqual(result.answers, { authorization: { kind: "choice", choice: "allow", confidence: 0.9 } });
  await llmBackend(async input => {
    assert.doesNotMatch(input.prompt, /rationale/);
    return { responseText: JSON.stringify(answers), model: "luna" };
  }).decide(request);
});

test("an unavailable injected CLI runner reports runner configuration, without requesting a key", async () => {
  assert.deepEqual(await llmBackend().decide(request), { ok: false, attempts: [{ backend: "llm", reason: "not_configured" }] });
});
