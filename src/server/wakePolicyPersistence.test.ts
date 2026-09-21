import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { SessionStore } from "./sessionStore.js";
import { WaitEventService } from "./waitEvent.js";

test("manual and automatic exit subscriptions deliver once per session, including late subscriptions", async () => {
  const store = new SessionStore(resolve(mkdtempSync(resolve(tmpdir(), "wake-dedupe-")), "sessions.postgres"));
  const delivered: string[] = [];
  const service = new WaitEventService(store, { onDispatch: async (subscription) => { delivered.push(subscription.sessionId); } });
  try {
    await store.ready();
    const event = await service.ensureEvent({ workspaceId: "default", topic: "process.exited", subjectKey: "monitor:run" });
    const input = { eventId: event.id, workspaceId: "default", sessionId: "target", actionType: "enqueue_prompt" as const, actionPayload: { message: "Complete", approvalPolicy: "granular" } };
    const [manual, automatic] = await Promise.all([
      service.subscribe({ ...input, id: "manual" }), service.subscribe({ ...input, id: "process_wake" })
    ]);
    assert.equal(manual.id, automatic.id);
    await service.fire(event.id);
    await service.subscribe({ ...input, id: "late" });
    await service.subscribe({ ...input, id: "other", sessionId: "other" });
    assert.deepEqual(delivered, ["target", "other"]);
    assert.equal((await store.listWaitSubscriptions({ eventId: event.id })).length, 2);
  } finally { service.stop(); await store.close(); }
});

test("queued policy survives reopening and a later session policy change", async () => {
  const path = resolve(mkdtempSync(resolve(tmpdir(), "wake-policy-")), "sessions.postgres");
  const store = new SessionStore(path);
  try {
    await store.ready();
    assert.equal(await store.resolveApprovalPolicy("target"), undefined);
    await store.resolveApprovalPolicy("target", undefined, "granular");
    assert.equal(await store.resolveApprovalPolicy("target", "queued"), "granular");
    await store.resolveApprovalPolicy("target", undefined, "on-request");
  } finally { await store.close(); }
  const reopened = new SessionStore(path);
  try {
    await reopened.ready();
    assert.equal(await reopened.resolveApprovalPolicy("target", "queued"), "granular");
    assert.equal(await reopened.resolveApprovalPolicy("target", "new"), "on-request");
    assert.equal(await reopened.resolveApprovalPolicy("other"), undefined);
  } finally { await reopened.close(); }
});
