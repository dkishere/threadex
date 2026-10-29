import assert from "node:assert/strict";
import test from "node:test";
import { mostRecentlyActiveGroupChatKey } from "./domainActors";

test("most recent group chat is the newest activity, ties keep list order", () => {
  assert.equal(mostRecentlyActiveGroupChatKey([
    { key: "a", lastActivityAt: "2026-10-01T00:00:00.000Z" },
    { key: "b", lastActivityAt: "2026-10-03T00:00:00.000Z" },
    { key: "c", lastActivityAt: "2026-10-03T00:00:00.000Z" }
  ]), "b");
});

test("no activity selects nothing", () => {
  assert.equal(mostRecentlyActiveGroupChatKey([{ key: "a" }, { key: "unassigned" }]), null);
  assert.equal(mostRecentlyActiveGroupChatKey(undefined), null);
});
