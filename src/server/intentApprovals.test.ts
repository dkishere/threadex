import assert from "node:assert/strict";
import test from "node:test";
import { intentDecision, intentRequest } from "../intentApproval";
import { IntentApprovals } from "./intentApprovals";

const proposal = { title: "Deploy staging", scope: "project A, version abc, staging", actions: ["Build abc", "Deploy abc"], exclusions: "Production, deletion and paid resources", consequences: "Brief staging downtime" };
const approved = { outcome: "approved" as const, actions: ["Deploy abc"], constraints: "After 6pm only" };
function harness(options: { deliveryError?: boolean; persistError?: string; waitMs?: number } = {}) {
  let active = true;
  const events: { event: string; decision: unknown }[] = [], messages: string[] = [];
  const pending = new Set<string>();
  const service = new IntentApprovals({
    active: async (session, turn) => active && session === "session" && turn === "turn",
    pending: (a, waiting) => { if (waiting) pending.add(a.approvalId); else pending.delete(a.approvalId); },
    publish: async (_a, event, decision) => {
      if (event === options.persistError) throw new Error("disk failed");
      events.push({ event, decision });
    },
    deliver: async (_a, message) => {
      assert.equal(events.at(-1)?.event, "approval.decision");
      if (options.deliveryError) throw new Error("steer rejected");
      messages.push(message);
    }
  }, options.waitMs);
  return { service, events, messages, pending, stop: () => { active = false; } };
}

test("scope validation rejects empty or oversized fields, duplicate actions and widened decisions", () => {
  assert.ok(intentRequest(proposal));
  for (const value of [null, {}, { ...proposal, title: " " }, { ...proposal, scope: "x".repeat(2001) }, { ...proposal, actions: [] }, { ...proposal, actions: ["a", "a"] }]) assert.equal(intentRequest(value), null);
  for (const value of ["accept", { ...approved, actions: [] }, { ...approved, actions: ["Production"] }, { ...approved, actions: ["Deploy abc", "Deploy abc"] }]) assert.equal(intentDecision(value, proposal), null);
});

test("host persists the narrowed click before delivery and returns a bounded grant once", async () => {
  const h = harness(), { approvalId } = await h.service.request("session", "turn", proposal);
  assert.deepEqual(await h.service.result(approvalId), { pending: true });
  await h.service.decide(approvalId, approved);
  assert.deepEqual(await h.service.result(approvalId), { decision: approved, grantId: approvalId });
  assert.deepEqual(h.events.map(e => e.event), ["approval.requested", "approval.decision", "approval.resolved"]);
  assert.equal(h.pending.size, 0);
  assert.match(h.messages[0], /valid only for turn turn/);
  assert.match(h.messages[0], /After 6pm only/);
  assert.doesNotMatch(h.messages[0], /Build abc/);
  await assert.rejects(h.service.decide(approvalId, approved), /no longer pending/);
  assert.equal(h.messages.length, 1);
});

test("rejection, cancellation, expiration, turn end and unknown requests never return a grant", async () => {
  for (const decision of [{ outcome: "declined" as const }, "cancel" as const]) {
    const h = harness(), { approvalId } = await h.service.request("session", "turn", proposal);
    await h.service.decide(approvalId, decision);
    assert.deepEqual(await h.service.result(approvalId), { decision });
    assert.equal(h.messages.length, decision === "cancel" ? 0 : 1);
  }
  const h = harness(), { approvalId } = await h.service.request("session", "turn", proposal);
  h.stop();
  assert.equal((await h.service.result(approvalId) as any).decision, "cancel");
  await assert.rejects(h.service.decide(approvalId, approved));
  assert.equal((await h.service.result("unknown") as any).decision, "cancel");
  const short = harness({ waitMs: 20 }), request = await short.service.request("session", "turn", proposal);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal((await short.service.result(request.approvalId) as any).decision, "cancel");
  assert.equal(short.messages.length, 0);
});

test("persistence and delivery failures fail closed", async () => {
  for (const options of [{ deliveryError: true }, { persistError: "approval.decision" }, { persistError: "approval.resolved" }]) {
    const h = harness(options), { approvalId } = await h.service.request("session", "turn", proposal);
    await assert.rejects(h.service.decide(approvalId, approved));
    const result = await h.service.result(approvalId);
    assert.equal((result as any).decision, "cancel");
    assert.equal("grantId" in result, false);
    assert.equal(h.pending.size, 0);
  }
});

test("concurrent decisions deliver once; interrupted callers reconnect only to identical scope", async () => {
  const h = harness();
  await assert.rejects(h.service.request("other", "turn", proposal));
  const { approvalId } = await h.service.request("session", "turn", proposal);
  assert.deepEqual(await h.service.request("session", "turn", proposal), { approvalId });
  await assert.rejects(h.service.request("session", "turn", { ...proposal, scope: "Production" }), /different intention/);
  const result = await Promise.allSettled([h.service.decide(approvalId, approved), h.service.decide(approvalId, { outcome: "declined" })]);
  assert.equal(result.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(h.messages.length, 1);
  assert.deepEqual(await h.service.request("session", "turn", proposal), { approvalId });
  assert.equal(h.events.filter(e => e.event === "approval.requested").length, 1);
  h.stop();
  const expired = await h.service.result(approvalId);
  assert.equal("grantId" in expired, false);
  assert.equal((expired as any).decision, "cancel");
});
