import assert from "node:assert/strict";
import test from "node:test";
import { isCollaborationMemberEnded, type CollaborationView } from "./collaboration";

function view(status = "idle", stopped = false): CollaborationView {
  return {
    members: [{ localId: "main", stopped: false }, { localId: "w1", stopped }],
    activity: { w1: { status, turnId: "turn-1", progress: "" } },
    messages: []
  } as unknown as CollaborationView;
}

test("ended workers reject further prompts while main remains available", () => {
  assert.equal(isCollaborationMemberEnded(view(), "w1"), true);
  assert.equal(isCollaborationMemberEnded(view("running", true), "w1"), true);
  assert.equal(isCollaborationMemberEnded(view(), "main"), false);
  for (const status of ["creating", "running", "queued", "waiting"])
    assert.equal(isCollaborationMemberEnded(view(status), "w1"), false);
});

test("queued deliveries and unresolved dependencies keep an idle worker open", () => {
  for (const state of ["pending", "steering", "uncertain"] as const) {
    const group = view();
    group.messages = [{ to: "w1", from: "main", completed: false, state, wait: false }] as CollaborationView["messages"];
    assert.equal(isCollaborationMemberEnded(group, "w1"), false);
  }
  const group = view();
  group.messages = [{ to: "w2", from: "w1", completed: false, state: "delivered", wait: true }] as CollaborationView["messages"];
  assert.equal(isCollaborationMemberEnded(group, "w1"), false);
  group.messages[0].completed = true;
  assert.equal(isCollaborationMemberEnded(group, "w1"), true);
});
