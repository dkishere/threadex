import assert from "node:assert/strict";
import test from "node:test";
import { initialCategories } from "../sessionCategories";
import { applyCategoryDecisions, automaticSplitCandidates, classificationHash, parseCategoryDecisions, parseCategorySplit, prepareSemanticCategories } from "./categoryClassifier";
import type { SessionRecord } from "./sessionStore";

const session = (id: string, title: string, description = "") => ({ id, title, description } as SessionRecord);

test("classification output requires each requested session exactly once and an existing category", () => {
  const response = JSON.stringify({ assignments: [
    { sessionId: "a", categoryId: "ui", confidence: .91, reason: "主要處理 sidebar 互動" },
    { sessionId: "b", categoryId: "server", confidence: .84, reason: "主要處理 API 儲存" }
  ] });
  assert.deepEqual(parseCategoryDecisions(response, ["a", "b"], ["threadex", "ui", "server"]), JSON.parse(response).assignments);
  assert.throws(() => parseCategoryDecisions(JSON.stringify({ assignments: [{ sessionId: "a", categoryId: "wrong", confidence: .9, reason: "x" }] }), ["a"], ["ui"]));
  assert.throws(() => parseCategoryDecisions(JSON.stringify({ assignments: [{ sessionId: "a", categoryId: "ui", confidence: .9, reason: "x" }, { sessionId: "a", categoryId: "ui", confidence: .9, reason: "x" }] }), ["a", "b"], ["ui"]));
});

test("manual assignment stays locked; low confidence stays in current category", () => {
  const state = initialCategories(); state.enabled = true;
  const a = session("a", "Sidebar focus"); const b = session("b", "Unknown topic");
  state.assignments.a = "server";
  state.decisions = { a: { source: "manual", hash: "", confidence: 1, reason: "Manual", at: "" } };
  const result = applyCategoryDecisions(state, [
    { sessionId: "a", categoryId: "ui", confidence: .99, reason: "UI" },
    { sessionId: "b", categoryId: "ui", confidence: .5, reason: "Unclear" }
  ], [a, b], [a, b]);
  assert.equal(result.assignments.a, "server");
  assert.equal(result.assignments.b, "threadex");
  assert.match(result.decisions!.b.reason, /Needs review/);
});

test("semantic migration keeps a recoverable keyword tree but starts Luna with only seed/manual structure", () => {
  const state = initialCategories(); state.enabled = true;
  state.categories.push({ id: "ui/agent", parentId: "ui", name: "agent", terms: ["agent"], context: "" });
  state.assignments = { a: "ui/agent" };
  const result = prepareSemanticCategories(state);
  assert.equal(result.classifierVersion, 1);
  assert.equal(result.previousTree?.assignments.a, "ui/agent");
  assert.equal(result.categories.some(item => item.id === "ui/agent"), false);
  assert.deepEqual(result.assignments, {});
  assert.deepEqual(prepareSemanticCategories(result), result);
});

test("semantic splits reject generic or weak groups and accept distinct supported groups", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const valid = JSON.stringify({ groups: [
    { name: "Turn recovery", description: "Recovering interrupted or stale turns", sessionIds: ["a", "b", "c"], confidence: .9, reason: "Repeated recovery objective" },
    { name: "Account routing", description: "Selecting execution accounts", sessionIds: ["d", "e", "f"], confidence: .88, reason: "Repeated account-selection objective" }
  ] });
  assert.equal(parseCategorySplit(valid, ids).length, 2);
  assert.throws(() => parseCategorySplit(JSON.stringify({ groups: [{ name: "agent", description: "x", sessionIds: ["a", "b", "c"], confidence: .9, reason: "x" }, { name: "Other", description: "x", sessionIds: ["d", "e", "f"], confidence: .9, reason: "x" }] }), ids));
  assert.notEqual(classificationHash(session("a", "x")), classificationHash(session("a", "y")));
});

test("automatic split review considers top-level product areas only", () => {
  const state = initialCategories();
  state.categories.push({ id: "ui/composer", parentId: "ui", name: "Composer", terms: [], context: "", origin: "luna" });
  assert.deepEqual(automaticSplitCandidates(state).map(category => category.id), ["runner", "ui", "server"]);
});
