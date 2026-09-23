import test from "node:test";
import assert from "node:assert/strict";
import { initialCategories } from "../sessionCategories";
import { parsePoolResponse, poolSources, poolSourceHash } from "./categoryContextPools";
import type { SessionRecord } from "./sessionStore";

test("AI output must cover every requested category with bounded text", () => {
  assert.deepEqual(parsePoolResponse('```json\n{"ui":"A decision"}\n```', ["ui"]), { ui: "A decision" });
  for (const value of ['{}', '[]', '{"ui":42}', JSON.stringify({ ui: "x".repeat(4001) })]) assert.throws(() => parsePoolResponse(value, ["ui"]));
});
test("pool sources include descendants, exclude unrelated sessions and bound recency", () => {
  const state = initialCategories();
  const sessions = Array.from({ length: 12 }, (_, index) => ({ id: String(index), title: "Title", description: "", updated: String(index).padStart(2, "0") } as SessionRecord));
  sessions.forEach(session => { state.assignments[session.id] = Number(session.id) % 2 ? "runner" : "ui"; });
  assert.equal(poolSources(state, "threadex", sessions).length, 8);
  assert.deepEqual(poolSources(state, "ui", sessions).map(item => item.id), ["10", "8", "6", "4", "2", "0"]);
  const before = poolSourceHash(sessions);
  sessions[0].updated = "changed";
  assert.notEqual(poolSourceHash(sessions), before);
});
