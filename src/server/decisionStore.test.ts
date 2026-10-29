import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SessionStore } from "./sessionStore";
import { AutoModelSettings } from "./autoModelSettings";
import { createDecisionService, decisionKey } from "./decision/service";
import type { DecisionRequest } from "./decision/types";
import type { DecisionAudit } from "./decision/policy";
import { createDecisionPolicy } from "./decision/policy";
import { fakeBackend } from "./decision/fake";

test("Decision records and token usage survive reopening and retain the first result", async () => {
  if (process.env.SESSION_PG_SCHEMA) throw new Error("This test requires an isolated generated schema; unset SESSION_PG_SCHEMA.");
  const path = `/private/tmp/decision-store-${randomUUID()}`;
  const request: DecisionRequest = { purpose: "model_select", state: "PRIVATE STATE", audit: { workspaceId: "default", turnId: "turn" },
    questions: [{ id: "model", kind: "choice", instructions: "Choose", options: { "gpt-6-sol": "Code" } }] };
  const audit: DecisionAudit = { purpose: "model_select", attempts: [], result: { ok: true, backend: "fake", model: "fake", calibrated: false,
    answers: { model: { kind: "choice", choice: "gpt-6-sol", confidence: 0.8 } }, latencyMs: 3, usage: { inputTokens: 12, outputTokens: 4 } } };
  const store = new SessionStore(path);
  try {
    await store.ready();
    await store.upsertSession({ id: "session", workspaceId: "default", cwd: "/private/tmp", title: "Decision test" });
    await store.recordSessionTurn({ id: "turn", sessionId: "session", userInput: "test", agentResponse: "", tokenIn: 0, tokenOut: 0 });
    assert.equal(await store.getDecisionRecord(decisionKey(request)!), null);
    await store.saveDecisionRecord(decisionKey(request)!, audit);
    assert.deepEqual(await store.saveDecisionRecord(decisionKey(request)!, { ...audit, result: { ok: false, attempts: [] } }), audit);
    await store.recordSessionTurnEvent({ id: "auto-model:turn", sessionId: "session", turnId: "turn", eventName: "auto_model.selected", payload: { model: "gpt-6-sol", effort: "high", provider: "openai", selectorModel: "gpt-6-luna", reason: "Selected" } });
  } finally { await store.close(); }
  const reopened = new SessionStore(path);
  try {
    await reopened.ready();
    const decide = createDecisionService(new AutoModelSettings(`${path}/unused-key`), reopened);
    assert.deepEqual(await decide(request), audit.result);
    assert.deepEqual(await decide(request), audit.result);
    const rows = await reopened.runSqlQuery({ sql: "SELECT usage_type, input_tokens, output_tokens, total_tokens, metadata FROM token_usage WHERE usage_type = 'decision'" });
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].total_tokens, 16);
    assert.doesNotMatch(JSON.stringify(rows.rows), /PRIVATE STATE/);
    assert.equal((await reopened.getAutoModelSelection("turn"))?.model, "gpt-6-sol");
    assert.equal((await reopened.listSessionAutoModelProviders("session")).turn.provider, "openai");
  } finally { await reopened.close(); }
});

test("Auto retry retains within-turn upgrades after interruption/reopen while a fresh turn may downgrade", async () => {
  if (process.env.SESSION_PG_SCHEMA) throw new Error("This test requires an isolated generated schema; unset SESSION_PG_SCHEMA.");
  const path = `/private/tmp/decision-upgrade-${randomUUID()}`;
  const original = { model: "gpt-6-luna", effort: "high", provider: "openai", selectorModel: "gpt-6-luna", reason: "Selected" };
  const store = new SessionStore(path);
  try {
    await store.ready();
    for (const sessionId of ["recorded", "missing-event"]) {
      await store.upsertSession({ id: sessionId, workspaceId: "default", cwd: "/private/tmp", title: "Auto retry" });
      await store.recordSessionTurn({ id: sessionId, sessionId, userInput: "test", agentResponse: "", tokenIn: 0, tokenOut: 0 });
      await store.setSessionAutoModelEnabled(sessionId, true);
      await store.recordSessionTurnEvent({ sessionId, turnId: sessionId, eventName: "auto_model.selected", payload: original });
      await store.selectSessionAutoModel({ sessionId, ...original });
      const upgrade = await store.upgradeSessionAutoModel({ sessionId, model: "gpt-6-astra", effort: "max" });
      if (sessionId === "recorded") await store.recordSessionTurnEvent({ sessionId, turnId: sessionId, eventName: "auto_model.upgraded", payload: { ...upgrade, reason: "Complex task" } });
    }
  } finally { await store.close(); }
  const reopened = new SessionStore(path);
  try {
    await reopened.ready();
    for (const sessionId of ["recorded", "missing-event"]) {
      const prior = await reopened.getAutoModelSelection(sessionId);
      assert.ok(prior);
      assert.equal(prior.model, sessionId === "recorded" ? "gpt-6-astra" : "gpt-6-luna");
      const before = await reopened.getSessionAutoModel(sessionId);
      const retried = await reopened.selectSessionAutoModel({ sessionId, ...prior, preserveUpgrades: true });
      assert.equal(retried.model, "gpt-6-astra");
      assert.equal(retried.effort, "max");
      assert.equal(retried.revision, before.revision, "replay does not create a new selection revision");
      // Covers an upgrade between reading the selection and applying it on retry.
      const staleReplay = await reopened.selectSessionAutoModel({ sessionId, ...original, preserveUpgrades: true });
      assert.equal(staleReplay.model, "gpt-6-astra");
      assert.equal(staleReplay.effort, "max");
      assert.equal(await reopened.getAutoModelSelection(`${sessionId}-new-turn`), null);
      const fresh = await reopened.selectSessionAutoModel({ sessionId, ...original, preserveUpgrades: false });
      assert.equal(fresh.model, "gpt-6-luna");
      assert.equal(fresh.effort, "high");
    }
  } finally { await reopened.close(); }
});

test("invalid Jev attempt plus successful OpenAI records 41 tokens exactly once across retries and restart", async () => {
  if (process.env.SESSION_PG_SCHEMA) throw new Error("This test requires an isolated generated schema; unset SESSION_PG_SCHEMA.");
  const path = `/private/tmp/decision-attempt-usage-${randomUUID()}`;
  const req: DecisionRequest = { purpose: "test", state: "PRIVATE STATE", audit: { workspaceId: "default", roundId: "round" },
    questions: [{ id: "owner", kind: "choice", instructions: "Choose", options: { a: "A", b: "B" } }] };
  const store = new SessionStore(path);
  try {
    await store.ready();
    const decide = createDecisionPolicy({ backends: [
      { ...fakeBackend(() => ({ ok: true, backend: "jev", model: "jev-latest", calibrated: true,
        answers: { owner: { kind: "choice", choice: "a", confidence: 5 } }, latencyMs: 1, usage: { inputTokens: 20, outputTokens: 5 } })), id: "jev" },
      { ...fakeBackend(() => ({ ok: true, backend: "openai", model: "gpt-6-luna", calibrated: true,
        answers: { owner: { kind: "choice", choice: "a", confidence: 0.9 } }, latencyMs: 1, usage: { inputTokens: 12, outputTokens: 4 } })), id: "openai" }
    ], policy: () => ({ order: ["jev", "openai"], threshold: {} }),
    audit: async (_scope, entry) => { await store.saveDecisionRecord(decisionKey(req)!, entry); } });
    assert.equal((await decide(req)).ok, true);
    const replay = createDecisionService(new AutoModelSettings(`${path}/unused-key`), store);
    await replay(req);
    await replay(req);
  } finally { await store.close(); }
  const reopened = new SessionStore(path);
  try {
    await reopened.ready();
    await createDecisionService(new AutoModelSettings(`${path}/unused-key`), reopened)(req);
    const rows = await reopened.runSqlQuery({ sql: "SELECT source, total_tokens, metadata FROM token_usage WHERE usage_type = 'decision' ORDER BY source" });
    assert.deepEqual(rows.rows.map(row => [row.source, row.total_tokens]), [["jev", 25], ["openai", 16]]);
    assert.equal(rows.rows.reduce((sum, row) => sum + Number(row.total_tokens), 0), 41);
    assert.doesNotMatch(JSON.stringify(rows.rows), /PRIVATE STATE/);
  } finally { await reopened.close(); }
});
