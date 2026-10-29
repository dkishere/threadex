import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { actorDialogConclusions } from "../actorConclusions";
import { actorConclusionFlow } from "./testFixtures/actorConclusionFlow";
import { actorSummary } from "./domainActorSummary";
import { DomainActorStore } from "./domainActorStore";
import { createDomainActorRouter } from "./domainActorRoutes";
import type { SessionStore } from "./sessionStore";
import type { CollaborationService } from "./collaborationService";

test("task result waits for review, publishes once to executor dialog and badge, and retains acknowledged history", async () => {
  const h = actorConclusionFlow();
  await h.complete();
  let room = await h.service.getRoom(h.workspaceId);
  assert.equal(room.workItems[0].status, "completed");
  assert.equal(room.workItems[0].completionReviews![0].status, "pending");
  assert.deepEqual(actorDialogConclusions(room, "sub-1"), []);
  assert.ok(actorSummary(room, []).actors.every(actor => actor.unreadConclusions === 0));
  await h.finish();
  room = await h.service.getRoom(h.workspaceId);
  const [conclusion] = actorDialogConclusions(room, "sub-1");
  assert.equal(conclusion.text, "Verified conclusion for turn");
  assert.equal(conclusion.taskSessionId, "task");
  assert.deepEqual(actorDialogConclusions(room, "root-1"), []);
  assert.deepEqual(actorDialogConclusions(room, "root-2"), []);
  assert.deepEqual(actorSummary(room, []).actors.map(actor => actor.unreadConclusions), [0, 0, 1]);
  assert.ok(!JSON.stringify(actorSummary(room, [])).includes(conclusion.text), "summary stays lightweight");
  await h.service.observe(h.event("runner.result", "turn", "replayed-event")); await h.service.settled();
  assert.equal(h.reviewCalls(), 1);
  assert.equal((await h.store.getRoom(h.workspaceId)).conclusions!.length, 1);
  await assert.rejects(h.store.acknowledgeConclusion(h.workspaceId, "root-1", conclusion.id), /not found/);
  await assert.rejects(h.store.acknowledgeConclusion("other-workspace", "sub-1", conclusion.id), /not found/);
  await h.store.acknowledgeConclusion(h.workspaceId, "sub-1", conclusion.id);
  const reopened = new DomainActorStore(h.store.persistence);
  room = await reopened.acknowledgeConclusion(h.workspaceId, "sub-1", conclusion.id);
  assert.equal(actorSummary(room, []).actors[2].unreadConclusions, 0);
  assert.equal(room.conclusions!.length, 1);
  const acknowledgedAt = room.conclusions![0].acknowledgedAt;
  h.resetReview();
  await h.service.observe(h.event("runner.runner.started", "next-turn", "start-next"));
  assert.equal((await h.store.getRoom(h.workspaceId)).conclusions![0].text, conclusion.text, "new turn preserves published history");
  await h.complete("next-turn"); await h.finish();
  room = await reopened.acknowledgeConclusion(h.workspaceId, "sub-1", conclusion.id);
  assert.equal(room.conclusions!.length, 2);
  assert.equal(room.conclusions![0].acknowledgedAt, acknowledgedAt, "Ack retries are idempotent");
  assert.equal(actorSummary(room, []).actors[2].unreadConclusions, 1, "Ack of an older result does not clear a newer one");
});

test("review issues and a late passed review for a superseded turn never enter the dialog or badge", async () => {
  for (const late of [false, true]) {
    const h = actorConclusionFlow(); await h.complete();
    if (late) await h.service.observe(h.event("runner.runner.started", "next-turn", "next-start", "2026-10-23T12:02:00.000Z"));
    await h.finish(late ? "passed" : "issues_found");
    const room = await h.service.getRoom(h.workspaceId);
    assert.equal(room.workItems[0].completionReviews![0].status, late ? "passed" : "issues_found");
    assert.deepEqual(room.conclusions ?? [], []);
    assert.ok(actorSummary(room, []).actors.every(actor => actor.unreadConclusions === 0));
  }
});

test("Ack HTTP route requires sign-in and the matching workspace/actor/conclusion", async () => {
  const h = actorConclusionFlow(); await h.complete(); await h.finish();
  const room = await h.store.getRoom(h.workspaceId);
  const conclusionId = encodeURIComponent(room.conclusions![0].id);
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { res.locals.threadexUserAuthenticated = req.headers["x-test-user"] === "signed-in"; next(); });
  app.use(createDomainActorRouter(h.service, h.store, {} as SessionStore, {} as CollaborationService, { verify: async () => false }));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const call = (actorId: string, signedIn: boolean) => fetch(`http://127.0.0.1:${address.port}/${h.workspaceId}/actors/${actorId}/conclusions/${conclusionId}/ack`,
    { method: "POST", headers: { "Content-Type": "application/json", ...(signedIn ? { "x-test-user": "signed-in" } : {}) }, body: "{}" });
  try {
    assert.equal((await call("sub-1", false)).status, 403);
    assert.equal((await call("root-1", true)).status, 400);
    assert.equal((await h.store.getRoom(h.workspaceId)).conclusions![0].acknowledgedAt, undefined);
    const response = await call("sub-1", true);
    assert.equal(response.status, 200);
    assert.ok((await response.json()).conclusions[0].acknowledgedAt);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
