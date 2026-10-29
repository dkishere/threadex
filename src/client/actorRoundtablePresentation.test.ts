import assert from "node:assert/strict";
import test from "node:test";
import type { ActorRoundtable, ActorRoundtableView } from "../actorRoundtables";
import type { ActorRound } from "../domainActors";
import { actorRoundtableActive, actorRoundtableRequest, actorRoundtableStateLabel, groupChatEntries, mergeActorRoundtables, parseActorRoundtableReceipts } from "./actorRoundtablePresentation";

const link = (requestId: string, created: string): ActorRoundtable => ({ requestId, workspaceId: "w", sessionId: `s-${requestId}`, turnId: `t-${requestId}`,
  title: `Title ${requestId}`, prompt: "p", contextSummary: "", actorNames: ["A", "B"], sourceRoundId: null, created });
const view = (requestId: string, created: string, fields: Partial<ActorRoundtableView> = {}): ActorRoundtableView =>
  ({ ...link(requestId, created), state: "running", rounds: 1, conclusion: null, error: null, ...fields });
const round = (id: string, created: string) => ({ id, created }) as ActorRound;
const actor = { id: "a", name: "A", model: "m", effort: "high", systemPrompt: "" };

test("room links keep their place and gain state from the list; views without a room link are still shown", () => {
  const merged = mergeActorRoundtables([link("x", "2026-10-26T10:00:00Z"), link("y", "2026-10-26T10:01:00Z")],
    [view("y", "2026-10-26T10:01:00Z", { state: "done", conclusion: "Ship it" }), view("z", "2026-10-26T10:02:00Z")]);
  assert.deepEqual(merged.map(item => [item.requestId, item.view?.state]), [["x", undefined], ["y", "done"], ["z", "running"]]);
  assert.equal(merged[1].view?.conclusion, "Ship it");
});

test("group chat entries interleave rounds and round table cards by creation time", () => {
  const entries = groupChatEntries([round("r1", "2026-10-26T10:00:00Z"), round("r2", "2026-10-26T10:05:00Z")],
    mergeActorRoundtables([link("x", "2026-10-26T10:02:00Z"), link("same", "2026-10-26T10:05:00Z")], []));
  assert.deepEqual(entries.map(entry => entry.kind === "round" ? entry.round.id : entry.link.requestId), ["r1", "x", "r2", "same"]);
});

test("state labels and polling cover every contract state", () => {
  assert.equal(actorRoundtableStateLabel("running"), "In progress");
  assert.equal(actorRoundtableStateLabel("done"), "Done");
  assert.equal(actorRoundtableStateLabel("missing"), "Session unavailable");
  assert.equal(actorRoundtableStateLabel(undefined), "Loading status…");
  assert.deepEqual((["queued", "running", "done", "error", "stopped", "missing"] as const).filter(actorRoundtableActive), ["queued", "running"]);
});

test("saved receipts are validated and the request body drops client bookkeeping", () => {
  const saved = JSON.stringify([
    { requestId: "r1", message: "Topic", actors: [actor, actor], created: "2026-10-26T10:00:00Z", error: "offline", sourceRoundId: "round-1" },
    { requestId: "bad", message: "Topic", actors: [{ id: 1 }], created: "now" },
    { message: "no id", actors: [], created: "now" }
  ]);
  const receipts = parseActorRoundtableReceipts(saved);
  assert.deepEqual(receipts.map(item => item.requestId), ["r1"]);
  assert.deepEqual(actorRoundtableRequest(receipts[0]), { requestId: "r1", message: "Topic", actors: [actor, actor], sourceRoundId: "round-1" });
  assert.deepEqual(parseActorRoundtableReceipts("not json"), []);
  assert.deepEqual(parseActorRoundtableReceipts(null), []);
});
