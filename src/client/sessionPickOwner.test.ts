import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./apiClient";
import { pickOwnerButtonState, pickOwnerErrorMessage, pickOwnerSuccessMessage, type PickOwnerStatus } from "./sessionPickOwner";

const status = (patch: Partial<PickOwnerStatus> = {}): PickOwnerStatus =>
  ({ eligible: true, reason: null, projectId: "p1", projectName: "Alpha", actorCount: 2, pending: null, ...patch });

test("shows the button when the session can be handed to project actors", () => {
  assert.deepEqual(pickOwnerButtonState(status()), { kind: "ready", label: "Group follow-up", disabled: false });
});

test("hides the button when it cannot apply", () => {
  assert.equal(pickOwnerButtonState(null).kind, "hidden");
  for (const reason of ["project_has_no_actors", "session_project_unresolved", "session_actor_bound"] as const) {
    assert.equal(pickOwnerButtonState(status({ eligible: false, reason })).kind, "hidden", reason);
  }
});

test("a pending or sending request is visible but disabled", () => {
  const pending = pickOwnerButtonState(status({ eligible: false, reason: "pick_owner_pending", pending: { requestId: "r", roundId: null, status: "queued" } }));
  assert.deepEqual(pending, { kind: "pending", label: "Picking owner…", disabled: true });
});

test("messages", () => {
  assert.match(pickOwnerSuccessMessage({ projectName: "Alpha" }), /Alpha/);
  assert.equal(pickOwnerErrorMessage(new ApiError("x", 409, "pick_owner_pending")), "Picking an owner is already in progress.");
  assert.equal(pickOwnerErrorMessage(new ApiError("boom", 500)), "boom");
});
