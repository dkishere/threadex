import assert from "node:assert/strict";
import test from "node:test";
import { sessionOwnerActors } from "./sessionOwnerActors";

const actors = [
  { id: "a", name: "Parent", parentActorId: null },
  { id: "b", name: "Child", parentActorId: "a" },
  { id: "c", name: "Other", parentActorId: null }
];
const work = (patch: Record<string, unknown>) => ({ taskSessionId: "s1", executorActorId: "a", ...patch });
const room = (workItems: unknown[]) => ({ actors, workItems }) as never;

test("no actor yields no badge", () => {
  assert.deepEqual(sessionOwnerActors(room([work({ taskSessionId: "other" })]), "s1"), []);
  assert.deepEqual(sessionOwnerActors(null, "s1"), []);
});

test("shows the executor, not the claiming parent, with its parent name", () => {
  const [owner] = sessionOwnerActors(room([work({ ownerActorId: "a", executorActorId: "b" })]), "s1");
  assert.equal(owner.actor.id, "b");
  assert.equal(owner.kind, "owner");
  assert.equal(owner.parentActorName, "Parent");
});

test("lists the owner first, deduplicates and marks mention guests", () => {
  const list = sessionOwnerActors(room([
    work({ id: "g", executorActorId: "c", sessionScope: "turn" }),
    work({ id: "o", executorActorId: "b" }),
    work({ id: "n", executorActorId: "c", hostWorkItemId: "o" })
  ]), "s1");
  assert.deepEqual(list.map(entry => [entry.actor.id, entry.kind]), [["b", "owner"], ["c", "guest"]]);
});

test("ignores cancelled work", () => {
  assert.deepEqual(sessionOwnerActors(room([work({ cancelledAt: "2026-01-01" })]), "s1"), []);
});
