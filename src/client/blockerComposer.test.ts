import assert from "node:assert/strict";
import test from "node:test";
import type { ActorBlockerView } from "./actorBlockerPresentation";
import { blockerComposerText } from "./blockerComposer";

const blocker = (fields: Partial<ActorBlockerView> = {}) => ({
  id: "b1", taskSessionId: "task-1", taskSessionTitle: "Fix CDD", kind: "other", status: "solution_proposed", description: "Rerun blocked",
  proposals: [{ id: "p1", actorId: "ui", text: "Update the fixture, then rerun the check and verify its output." }], ...fields
}) as ActorBlockerView;

test("blocker composer text carries description, status, task and the full proposal", () => {
  const text = blockerComposerText(blocker(), "Anya");
  for (const part of ["Rerun blocked", "Owner: Anya", "Fix CDD (task-1)", "Update the fixture, then rerun the check and verify its output."]) assert.ok(text.includes(part), part);
});

test("blocker composer text omits the proposal section when none exists", () => {
  assert.ok(!blockerComposerText(blocker({ proposals: [] }), "Anya").includes("Latest proposed solution"));
});
