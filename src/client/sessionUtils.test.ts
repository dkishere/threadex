import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord } from "./appTypes";
import { baseDirLabel, groupSessionsByBaseDir, toSessionPageState } from "./sessionUtils";

function session(
  id: string,
  cwd: string,
  updated: string,
  parentSessionId: string | null = null,
  workspaceId = "workspace-1"
): SessionRecord {
  return {
    id,
    threadId: id,
    workspaceId,
    cwd,
    accountId: null,
    keywordWeights: {},
    title: id,
    titleSource: "initial",
    description: "",
    parentSessionId,
    forkedFromTurnId: null,
    created: updated,
    updated
  };
}

test("groups session trees by cwd and orders groups by latest activity", () => {
  const groups = groupSessionsByBaseDir([
    session("older", "/work/alpha", "2026-08-15T10:00:00Z"),
    session("parent", "/work/beta", "2026-08-16T10:00:00Z"),
    session("child", "/work/beta", "2026-08-17T10:00:00Z", "parent")
  ]);

  assert.deepEqual(groups.map((group) => [group.cwd, group.label]), [
    ["/work/beta", "beta"],
    ["/work/alpha", "alpha"]
  ]);
  assert.equal(groups[0]?.count, 2);
  assert.equal(groups[0]?.baseSessionId, "parent");
  assert.equal(groups[0]?.sessions[0]?.record.id, "parent");
  assert.equal(groups[0]?.sessions[0]?.children[0]?.record.id, "child");
});

test("formats POSIX, Windows, root, and missing directory labels", () => {
  assert.equal(baseDirLabel("/work/alpha/"), "alpha");
  assert.equal(baseDirLabel("C:\\work\\beta\\"), "beta");
  assert.equal(baseDirLabel("/"), "/");
  assert.equal(baseDirLabel(""), "Unknown directory");
});

test("does not use another workspace's session as a project base", () => {
  const groups = groupSessionsByBaseDir([
    session("other-newer", "/work/shared", "2026-08-18T10:00:00Z", null, "workspace-2"),
    session("current", "/work/current", "2026-08-17T10:00:00Z"),
    session("other", "/work/other", "2026-08-16T10:00:00Z", null, "workspace-2")
  ], "workspace-1");

  assert.deepEqual(groups.map((group) => [group.label, group.baseSessionId]), [
    ["current", "current"]
  ]);
});

test("keeps independent project pagination from a session snapshot", () => {
  const sessions = [session("alpha", "/work/alpha", "2026-08-17T10:00:00Z")];
  const page = toSessionPageState(sessions, {
    offset: 0,
    limit: 20,
    hasMore: true,
    nextOffset: null,
    projects: [{
      cwd: "/work/alpha",
      offset: 0,
      limit: 20,
      hasMore: true,
      total: 25,
      nextOffset: 20
    }]
  });

  assert.equal(page.projects[0]?.cwd, "/work/alpha");
  assert.equal(page.projects[0]?.nextOffset, 20);
});
