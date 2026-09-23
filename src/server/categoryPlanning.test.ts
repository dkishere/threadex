import assert from "node:assert/strict";
import test from "node:test";
import { parsePlan, parseMemberships } from "./categoryPlanning";
import { initialCategories, sessionCategoryIds } from "../sessionCategories";

test("plans reject cycles and missing parents, allow feature-first nesting", () => {
  const category = { id: "gear", parentId: "threadex", name: "Gear Box", description: "Composer model presets" };
  assert.equal(parsePlan(JSON.stringify({ categories: [category] }))[1].name, "Gear Box");
  assert.equal(parsePlan(JSON.stringify({ categories: [category] }), "My workspace")[0].name, "My workspace");
  assert.throws(() => parsePlan(JSON.stringify({ categories: [{ ...category, parentId: "gear" }] })));
  assert.throws(() => parsePlan(JSON.stringify({ categories: [{ ...category, parentId: "missing" }] })));
});
test("multi-membership accepts overlap but rejects omitted sessions, unknown and duplicate categories", () => {
  const assignment = { sessionId: "s", categoryIds: ["gear", "ui"], reason: "Gear interaction" };
  const result = parseMemberships(JSON.stringify({ assignments: [assignment] }), ["s"], ["gear", "ui"]);
  assert.deepEqual(result[0].categoryIds, ["gear", "ui"]);
  assert.throws(() => parseMemberships(JSON.stringify({ assignments: [assignment] }), ["s", "t"], ["gear", "ui"]));
  assert.throws(() => parseMemberships(JSON.stringify({ assignments: [assignment] }), ["s"], ["gear"]));
  assert.throws(() => parseMemberships(JSON.stringify({ assignments: [{ ...assignment, categoryIds: ["gear", "gear"] }] }), ["s"], ["gear"]));
  const state = initialCategories(); state.assignments.s = "ui";
  assert.deepEqual(sessionCategoryIds(state, "s"), ["ui"]);
  state.memberships = { s: ["gear", "ui"] };
  assert.deepEqual(sessionCategoryIds(state, "s"), ["gear", "ui"]);
});
