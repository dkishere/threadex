import assert from "node:assert/strict";
import test from "node:test";
import { CommentaryIssueInjector } from "./commentaryIssueInjection";

test("injects each unaddressed issue only once even across native turns and requests prose outcomes", async () => {
  const injector = new CommentaryIssueInjector();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const rpc = async (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); };
  const tracker = { issues: ["Open failure", "Fixed failure", "Needs credentials"],
    solutions: [{ issueKey: 2, solution: "Updated parser" }], blockers: [{ issueKey: 3, blocker: "Credentials unavailable" }] };
  const target = { threadId: "root-thread", turnId: "native-turn" };
  await injector.inject(tracker, null, rpc);
  assert.equal(calls.length, 0);
  await injector.inject(tracker, target, rpc);
  assert.equal(calls[0].method, "thread/inject_items");
  assert.equal(calls[0].params.threadId, "root-thread");
  const text = JSON.stringify(calls[0].params.items);
  assert.match(text, /Open failure/);
  assert.doesNotMatch(text, /Fixed failure|Needs credentials/);
  assert.match(text, /commentary/);
  assert.match(text, /explicitly say it is a blocker/);
  await injector.inject(tracker, target, rpc);
  assert.equal(calls.length, 1);
  await injector.inject(tracker, { ...target, turnId: "next-native-turn" }, rpc);
  assert.equal(calls.length, 1);
  await injector.inject({ ...tracker, issues: [...tracker.issues, "New issue"] }, target, rpc);
  assert.equal(calls.length, 2);
  assert.match(JSON.stringify(calls[1].params.items), /New issue/);
  assert.doesNotMatch(JSON.stringify(calls[1].params.items), /Open failure/);
});

test("failed injections remain retryable", async () => {
  const injector = new CommentaryIssueInjector();
  const tracker = { issues: ["Open failure"] };
  const target = { threadId: "thread", turnId: "turn" };
  await assert.rejects(injector.inject(tracker, target, async () => { throw new Error("connection closed"); }));
  let calls = 0;
  await injector.inject(tracker, target, async () => { calls++; });
  assert.equal(calls, 1);
});
