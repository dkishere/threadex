import assert from "node:assert/strict";
import test from "node:test";
import { eventStore } from "../client/eventStore";
import { handleStreamEvent } from "../client/sessionActions04";
import { parseEvent } from "../client/appStreamProtocol";

test("Start work ACK stream immediately clears the originating Grill without waiting for work completion", () => {
  const grill = { revision: 1, contentVersion: 1, acknowledgedVersion: 0,
    status: "ready" as const, updated: "", error: null, rounds: [],
    issues: [{ id: "q", md: "Question", responseMd: "Answer", selected: true, status: "open" as const }] };
  eventStore.reportGrill("stream-ack", "origin", grill);
  const summary = () => eventStore.getState().grillSummaries.find((item) => item.sessionId === "stream-ack")!;
  assert.equal(summary().pending, true);
  const event = parseEvent(`event: grill_ack\ndata: ${JSON.stringify({ sessionId: "stream-ack", turnId: "origin", grill: { ...grill, revision: 2, acknowledgedVersion: 1 } })}\n\n`);
  handleStreamEvent({}, event, { completed: false });
  assert.equal(summary().pending, false);
  assert.equal(summary().revision, 2);
});
