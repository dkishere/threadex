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
  assert.equal(messages.length, 3446);
});

test("older and newer pages preserve turn pairs and do not accumulate DOM history", () => {
  const latest = transcriptWindow(messages);
  const older = transcriptWindow(messages, latest.previousAnchor);
  assert.equal(older.messages.length, 100);
  assert.equal(older.messages.at(-1)?.id, "a1672");
  assert.deepEqual(transcriptWindow(messages, older.nextAnchor).messages, latest.messages);
});

test("deep links include the prompt and response and stay stable when new turns arrive", () => {
  const page = transcriptWindow(messages, "a12");
  assert.equal(page.messages[0].id, "u12");
  const updated = transcriptWindow([...messages, { id: "new", turnId: "new" }], "a12");
  assert.deepEqual(updated.messages, page.messages);
});

test("missing anchors, empty transcripts and messages without turn IDs are supported", () => {
  assert.deepEqual(transcriptWindow(messages, "missing").messages, transcriptWindow(messages).messages);
  assert.deepEqual(transcriptWindow([]).messages, []);
  assert.deepEqual(transcriptWindow([{ id: "standalone" }]).messages, [{ id: "standalone" }]);
  assert.equal(transcriptWindow(messages, "u0").previousAnchor, undefined);
});
