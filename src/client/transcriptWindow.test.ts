import assert from "node:assert/strict";
import test from "node:test";
import { transcriptWindow } from "./transcriptWindow";

const messages = Array.from({ length: 1723 }, (_, index) => [
  { id: `u${index}`, turnId: `t${index}` },
  { id: `a${index}`, turnId: `t${index}` }
]).flat();

test("large transcripts initially render only the latest 50 complete turns", () => {
  const page = transcriptWindow(messages);
  assert.equal(page.messages.length, 100);
  assert.equal(page.messages[0].id, "u1673");
  assert.equal(page.messages.at(-1)?.id, "a1722");
  assert.equal(page.total, 1723);
  assert.equal(page.earlierTurnCount, 50);
  assert.equal(messages.length, 3446);
});

test("loading earlier turns prepends history and keeps loaded turns", () => {
  const latest = transcriptWindow(messages);
  const expanded = transcriptWindow(messages, latest.earlierFirstMessageId);
  assert.equal(expanded.messages.length, 200);
  assert.equal(expanded.messages[0].id, "u1623");
  assert.deepEqual(expanded.messages.slice(100), latest.messages);
  const updated = transcriptWindow([...messages, { id: "new", turnId: "new" }], latest.earlierFirstMessageId);
  assert.equal(updated.messages[0].id, "u1623");
  assert.equal(updated.messages.at(-1)?.id, "new");
});

test("the earliest load is partial and then reports no earlier turns", () => {
  const short = messages.slice(0, 2 * 53);
  const latest = transcriptWindow(short);
  assert.equal(latest.start, 3);
  assert.equal(latest.earlierTurnCount, 3);
  const all = transcriptWindow(short, latest.earlierFirstMessageId);
  assert.deepEqual(all.messages, short);
  assert.equal(all.earlierFirstMessageId, undefined);
  assert.equal(all.earlierTurnCount, 0);
});

test("deep links load every turn from the linked one through the latest", () => {
  const page = transcriptWindow(messages, "a12");
  assert.equal(page.messages[0].id, "u12");
  assert.equal(page.messages.at(-1)?.id, "a1722");
  assert.equal(transcriptWindow(messages, "a1700").start, 1673);
});

test("missing anchors, empty transcripts and messages without turn IDs are supported", () => {
  assert.deepEqual(transcriptWindow(messages, "missing").messages, transcriptWindow(messages).messages);
  assert.deepEqual(transcriptWindow([]).messages, []);
  assert.deepEqual(transcriptWindow([{ id: "standalone" }]).messages, [{ id: "standalone" }]);
  assert.equal(transcriptWindow(messages, "u0").earlierFirstMessageId, undefined);
});
