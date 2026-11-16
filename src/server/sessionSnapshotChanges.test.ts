import assert from "node:assert/strict";
import test from "node:test";
import { snapshotChangeItems } from "./sessionSnapshotChanges";

test("large repeated file snapshots retain counts and exact item identity without transporting file bodies", () => {
  const prefix = "unchanged line\n".repeat(300_000);
  const change = { path: "/project/config.json", kind: "update", before: prefix + "old\n", after: prefix + "new\n" };
  const items = Array.from({ length: 12 }, (_, n) => ({ id: `item/${n}`, itemType: "file_change", status: "completed", changes: [change] }));
  const compact = snapshotChangeItems("session", "turn", items) as typeof items;
  assert.ok(JSON.stringify(compact).length < 10_000);
  assert.equal(items[0].changes[0].before, change.before, "stored history is never mutated");
  const projected = compact[11].changes[0] as unknown as Record<string, unknown>;
  assert.equal(projected.additions, 1);
  assert.equal(projected.deletions, 1);
  assert.equal(projected.before, undefined);
  assert.equal(projected.after, undefined);
  assert.equal(projected.contentUrl, "/api/sessions/session/file-change-content?turnId=turn&itemId=item%2F11&index=0");
});

test("small changes and non-file events keep their original content; large deletions also load lazily", () => {
  const small = { path: "small", kind: "add", after: "hello\n" };
  const message = { id: "message", itemType: "agent_message", text: "answer" };
  const result = snapshotChangeItems("s", "t", [message, { id: "edit", itemType: "file_change", changes: [small, { path: "deleted", kind: "delete", before: "x\n".repeat(20_000) }] }]) as any[];
  assert.equal(result[0], message);
  assert.equal(result[1].changes[0], small);
  assert.equal(result[1].changes[1].deletions, 20_000);
  assert.match(result[1].changes[1].contentUrl, /index=1$/);
});
