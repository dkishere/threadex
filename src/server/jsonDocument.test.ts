import assert from "node:assert/strict";
import test from "node:test";
import { cloneJsonDocument } from "./jsonDocument";

test("JSON history copies isolate every mutable container and preserve large strings", () => {
  const text = "歷史資料".repeat(1_000_000);
  const original = { rounds: [{ text, replies: [{ status: "running" }] }], revision: 1 };
  const copy = cloneJsonDocument(original);
  assert.deepEqual(copy, original);
  copy.rounds[0].replies[0].status = "done";
  copy.rounds.push({ text: "new", replies: [] });
  assert.equal(original.rounds.length, 1);
  assert.equal(original.rounds[0].replies[0].status, "running");
  assert.equal(copy.rounds[0].text, text);
});

test("normalization preserves JSON no-op semantics and treats special property names as data", () => {
  const value = { missing: undefined, nested: { lease: undefined, score: NaN }, list: [undefined, Infinity, null] };
  assert.deepEqual(cloneJsonDocument(value), JSON.parse(JSON.stringify(value)));
  const special = JSON.parse('{"__proto__":{"value":1},"constructor":"data"}');
  const copy = cloneJsonDocument(special);
  assert.deepEqual(copy, special);
  assert.equal(Object.getPrototypeOf(copy), Object.prototype);
  assert.notEqual(copy.__proto__, special.__proto__);
});
