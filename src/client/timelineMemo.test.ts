import assert from "node:assert/strict";
import test from "node:test";
import { sameTimelineItems } from "./timelineMemo";

test("regrouping unchanged items does not invalidate a timeline card", () => {
  const item = { aggregatedOutput: "large output" };
  const entries = [{ id: "command", item, groupType: "command" }];
  assert.equal(sameTimelineItems(entries, entries.map((entry) => ({ ...entry }))), true);
  assert.equal(sameTimelineItems(entries, [{ ...entries[0], item: { ...item, aggregatedOutput: "new output" } }]), false);
  assert.equal(sameTimelineItems(entries, [{ ...entries[0], groupType: "edit" }]), false);
  assert.equal(sameTimelineItems(entries, []), false);
  assert.equal(sameTimelineItems(entries, [{ ...entries[0], id: "other" }]), false);
});
