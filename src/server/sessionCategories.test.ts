import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { categoryAncestors, initialCategories } from "../sessionCategories";
import { classifyCategories, SessionCategories } from "./sessionCategories";
import type { SessionRecord } from "./sessionStore";

const session = (id: string, title: string) => ({ id, title, description: "" });
test("synchronous sync never guesses categories or creates word-frequency children", () => {
  const state = initialCategories();
  state.enabled = true;
  state.threshold = 4;
  state.assignments.removed = "ui";
  const result = classifyCategories(state, [1, 2, 3, 4].map(id => session(String(id), "runner retry")));
  assert.deepEqual(result.assignments, {});
  assert.equal(result.categories.length, 4);
});
test("sync preserves manual assignments while pruning deleted sessions", () => {
  const state = initialCategories();
  state.assignments = { kept: "server", deleted: "ui" };
  state.decisions = {
    kept: { source: "manual", hash: "", confidence: 1, reason: "User choice", at: "" },
    deleted: { source: "manual", hash: "", confidence: 1, reason: "User choice", at: "" }
  };
  const result = classifyCategories(state, [session("kept", "UI sidebar")]);
  assert.deepEqual(result.assignments, { kept: "server" });
  assert.equal(result.decisions?.kept.source, "manual");
  assert.equal(result.decisions?.deleted, undefined);
});
test("workspace persistence, project boundaries, inherited notes and disabling context", () => {
  const directory = mkdtempSync(join(tmpdir(), "threadex-categories-"));
  try {
    const store = new SessionCategories(directory, "/project/threadex");
    assert.deepEqual(store.read("default").categories, []);
    assert.equal(store.read("default").enabled, false);
    store.save("untouched", initialCategories());
    assert.deepEqual(store.read("untouched").categories, []);
    assert.deepEqual(store.scoped([
      { id: "outside", cwd: "/another/project", workspaceId: "default" },
      { id: "foreign", cwd: "/project/threadex", workspaceId: "threadex" }
    ] as SessionRecord[], "default").map(s => s.id), ["outside"]);
    const state = initialCategories(); state.enabled = true;
    state.assignments.a = "runner";
    state.categories[0].context = "Root decision";
    state.categories[1].context = "Runner constraint";
    store.save("workspace-a", state);
    assert.deepEqual(new SessionCategories(directory, "/project/threadex").read("workspace-a"), state);
    assert.equal(store.context("workspace-b", "a"), "");
    assert.match(store.context("workspace-a", "a"), /Root decision.*Runner constraint/);
    assert.deepEqual(store.scoped([
      { cwd: "/project/threadex", id: "a" }, { cwd: "/project/threadex/src", id: "b" },
      { cwd: "/project/threadex-other", id: "c" }, { cwd: "/project/elsewhere", id: "d" }
    ] as SessionRecord[]).map(item => item.id), ["a", "b"]);
    state.enabled = false; store.save("workspace-a", state);
    assert.equal(store.context("workspace-a", "a"), "");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
