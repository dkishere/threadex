import assert from "node:assert/strict";
import test from "node:test";
import { mergeManagerHistory, sessionSnapshotUrl } from "./workspaceManagerHistory";

const turn = (id: string, content = id, status = "done") => ({ id, content, status, created: "2026-01-01T00:00:00Z" });
const page = (turns: ReturnType<typeof turn>[], beforeTurnId: string, requestedBeforeTurnId: string | null = null, hasMore = true) => ({
  turns, managerHistory: { beforeTurnId, requestedBeforeTurnId, hasMore }
});

test("manager pages deduplicate pinned turns and preserve a reply updated while older history loads", () => {
  const current = page([turn("a", "Live reply", "running"), turn("d"), turn("e")], "d");
  const older = page([turn("a", "Stale reply", "running"), turn("b"), turn("c")], "a", "d", false);
  const merged = mergeManagerHistory(current, older);
  assert.deepEqual(merged.turns.map(turn => turn.id), ["a", "b", "c", "d", "e"]);
  assert.equal(merged.turns[0].content, "Live reply");
  assert.equal(merged.managerHistory.hasMore, false);

  const refreshed = mergeManagerHistory(merged, page([turn("a", "Final reply"), turn("e", "Updated"), turn("f")], "e"));
  assert.deepEqual(refreshed.turns.map(turn => turn.id), ["a", "b", "c", "d", "e", "f"]);
  assert.equal(refreshed.turns[0].content, "Final reply");
  assert.equal(refreshed.managerHistory.beforeTurnId, "a", "refresh must retain the older page's cursor");
  assert.equal(refreshed.managerHistory.hasMore, false);
  assert.equal(current.turns[0].content, "Live reply");
});

test("refreshes stay within the latest page until earlier history is requested; silent running turns expire", () => {
  const current = page([turn("a"), turn("b")], "a");
  const refreshed = mergeManagerHistory(current, page([turn("b"), turn("c")], "b"));
  assert.deepEqual(refreshed.turns.map(turn => turn.id), ["b", "c"]);
  const expanded = page([turn("a"), turn("b"), turn("manager_hidden", "", "running")], "a", "b", false);
  assert.deepEqual(mergeManagerHistory(expanded, page([turn("c")], "c")).turns.map(turn => turn.id), ["a", "b", "c"]);
});

test("raw session requests keep full snapshots; manager requests encode history and reconciliation targets", () => {
  assert.equal(sessionSnapshotUrl("tx a/b"), "/api/sessions/tx%20a%2Fb/snapshot");
  assert.equal(sessionSnapshotUrl("tx", false, "old", "running"), "/api/sessions/tx/snapshot");
  assert.equal(sessionSnapshotUrl("tx", true, "old&turn", "running"), "/api/sessions/tx/snapshot?view=workspace-chat&beforeTurnId=old%26turn&turnId=running");
});
