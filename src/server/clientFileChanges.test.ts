import assert from "node:assert/strict";
import test from "node:test";
import { collectFileChanges } from "../client/sessionHelpers02.js";

test("completed-turn file list uses the authoritative net diff", () => {
  const changes = collectFileChanges({}, [
    {
      itemType: "file_change",
      changes: [{ path: "reverted-a.ts" }, { path: "reverted-b.ts" }]
    },
    {
      itemType: "file_change",
      authoritative: true,
      changes: [{ path: "net-a.ts" }, { path: "net-b.ts" }, { path: "net-c.ts" }]
    }
  ]);

  assert.deepEqual(changes.map((change: { path: string }) => change.path), ["net-a.ts", "net-b.ts", "net-c.ts"]);
});

test("an authoritative empty diff hides reverted edit activity", () => {
  const changes = collectFileChanges({}, [
    { itemType: "file_change", changes: [{ path: "reverted.ts" }] },
    { itemType: "file_change", authoritative: true, changes: [] }
  ]);

  assert.deepEqual(changes, []);
});
