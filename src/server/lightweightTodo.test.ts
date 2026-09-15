import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { applyOutcomeAssessment, reviseOutcomePlan } from "./lightweightTodo";
import { outcomeProgress } from "../lightweightTodo";
import { SessionStore } from "./sessionStore";
import { SessionSummarizer } from "./sessionSummarizer";

const initial = () => reviseOutcomePlan(null, {
  baseRevision: 0, objective: "完成 plan 保留顯示", items: [{ title: "保留畫面", acceptance: "重新載入仍可見", children: [{ title: "完成狀態", acceptance: "顯示完成項目" }] }]
});
const evidence = [{ id: "turn:reply", text: "已改，未測 UI" }];
const assess = (id: string, status = "unverified") => JSON.stringify({ updates: [{ id, status, note: "已改，未測 UI", sources: ["turn:reply"] }] });

test("nested plan edits preserve IDs, remove omitted items and invalidate changed acceptance", () => {
  const plan = initial();
  const child = plan.items[0].children[0];
  const assessed = applyOutcomeAssessment(plan, assess(child.id), evidence);
  const moved = reviseOutcomePlan(assessed, { baseRevision: assessed.revision, objective: assessed.objective, items: [child] });
  assert.equal(moved.items[0].id, child.id);
  assert.equal(moved.progress[child.id].status, "unverified");
  assert.equal(moved.items.length, 1);
  const changed = reviseOutcomePlan(moved, { baseRevision: moved.revision, objective: moved.objective, items: [{ ...child, acceptance: "實際 UI 截圖" }] });
  assert.equal(changed.progress[child.id], undefined);
  assert.throws(() => reviseOutcomePlan(changed, { baseRevision: 0 }), /revision conflict/);
});

test("agent cannot write status; malformed trees and unsupported evidence are rejected", () => {
  assert.throws(() => reviseOutcomePlan(null, { baseRevision: 0, objective: "test", items: [{ title: "x", acceptance: "y", status: "done" }] }), /not status/);
  const plan = initial();
  assert.throws(() => reviseOutcomePlan(plan, { baseRevision: 1, objective: plan.objective, items: [plan.items[0], plan.items[0]] }), /Duplicate/);
  assert.throws(() => applyOutcomeAssessment(plan, assess("invented"), evidence), /Unknown/);
  assert.throws(() => applyOutcomeAssessment(plan, assess(plan.items[0].id), []), /known evidence/);
  const parentDone = applyOutcomeAssessment(plan, assess(plan.items[0].id, "done"), evidence);
  assert.equal(outcomeProgress(parentDone, parentDone.items[0]).status, "active");
});

test("plan persistence, stale status rejection, summariser update and reload", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-outcomes-"));
  const storeId = resolve(root, "test.postgres");
  let store = new SessionStore(storeId);
  await store.ready();
  let summarizer: SessionSummarizer | undefined;
  try {
    await store.upsertSession({ id: "outcomes", workspaceId: "default" });
    const plan = initial();
    assert.equal(await store.saveOutcomePlan("outcomes", 0, plan), true);
    assert.equal(await store.saveOutcomePlan("outcomes", 0, plan), false);
    const changed = reviseOutcomePlan(plan, { baseRevision: 1, objective: plan.objective, items: plan.items });
    assert.equal(await store.saveOutcomePlan("outcomes", 1, changed), true);
    assert.equal(await store.saveOutcomePlan("outcomes", 1, applyOutcomeAssessment(plan, assess(plan.items[0].id), evidence)), false);
    await store.recordSessionTurn({ id: "turn", sessionId: "outcomes", userInput: "保留完成 plan", agentResponse: "已改，未測 UI", tokenIn: 1, tokenOut: 1, status: "done" });
    let notified = 0;
    summarizer = new SessionSummarizer(store, {
      model: "test-model", idleMs: 60000, sweepMs: 60000, pendingRetryMs: 60000,
      maxInputChars: 10000, timeoutMs: 1000, runnerMaxRuns: 10, runnerMaxAgeMs: 60000,
      reasoningEffort: "low", provider: "mock", mockResponse: assess(plan.items[0].children[0].id), promptDumpDir: null
    }, async () => { notified++; });
    await summarizer.forceSummarizeSession("outcomes");
    const updated = await store.getOutcomePlan("outcomes");
    assert.equal(updated?.progress[plan.items[0].children[0].id].status, "unverified");
    assert.equal(notified, 1);
    await summarizer.forceSummarizeSession("outcomes");
    assert.equal(notified, 1, "unchanged evidence must not trigger status inference again");
    summarizer.close();
    await store.close();
    store = new SessionStore(storeId);
    assert.deepEqual((await store.getSessionTodo("outcomes")).lightweight, updated);
  } finally {
    summarizer?.close();
    await store.close();
  }
});
