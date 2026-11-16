import assert from "node:assert/strict";
import test from "node:test";
import { clearGroupFollowUpDraft, getGroupFollowUpDraft, groupFollowUpGuard, setGroupFollowUpDraft, type GroupFollowUpDraft } from "./groupFollowUpDraft";

const draft: GroupFollowUpDraft = { sessionId: "s1", title: "Fix login", projectId: "p1", projectName: "Alpha" };
const ok = { draft, chatProjectId: "p1", hasPromptText: true, attachmentCount: 0, roundtableMode: false, addressesActor: false };

test("draft store sets, replaces and clears a single session", () => {
  clearGroupFollowUpDraft();
  assert.equal(getGroupFollowUpDraft(), null);
  setGroupFollowUpDraft(draft);
  assert.equal(getGroupFollowUpDraft()?.sessionId, "s1");
  setGroupFollowUpDraft({ ...draft, sessionId: "s2", title: "  " });
  assert.deepEqual(getGroupFollowUpDraft(), { ...draft, sessionId: "s2", title: "s2" });
  clearGroupFollowUpDraft("s1");
  assert.equal(getGroupFollowUpDraft()?.sessionId, "s2");
  clearGroupFollowUpDraft("s2");
  assert.equal(getGroupFollowUpDraft(), null);
});

test("guard allows a plain prompt in the session's own group chat", () => {
  assert.deepEqual(groupFollowUpGuard(ok), { ok: true });
});

test("guard blocks with a reason", () => {
  assert.match(String((groupFollowUpGuard({ ...ok, chatProjectId: "p2" }) as { reason: string }).reason), /belongs to Alpha/);
  assert.match(String((groupFollowUpGuard({ ...ok, chatProjectId: null }) as { reason: string }).reason), /belongs to Alpha/);
  assert.deepEqual(groupFollowUpGuard({ ...ok, attachmentCount: 1 }), { ok: false, reason: "Files cannot be sent with a group follow-up yet." });
  assert.equal(groupFollowUpGuard({ ...ok, roundtableMode: true }).ok, false);
  assert.equal(groupFollowUpGuard({ ...ok, addressesActor: true }).ok, false);
  assert.deepEqual(groupFollowUpGuard({ ...ok, hasPromptText: false }), { ok: false, reason: null });
});
