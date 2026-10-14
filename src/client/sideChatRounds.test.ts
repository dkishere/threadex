import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSideChat } from "./sessionApi";
import { buildSideChatRounds, type OutgoingSideChatReply } from "./sideChatRounds";

const saved = (id: string, roundId: string | null, extra: Partial<SessionSideChat> = {}): SessionSideChat => ({
  id, sessionId: "s", question: `Q ${roundId ?? id}`, answer: `A ${id}`, model: "m", created: "", roundId, ...extra
});
const outgoing = (key: string, roundId: string, extra: Partial<OutgoingSideChatReply> = {}): OutgoingSideChatReply => ({
  key, roundId, actor: null, question: `Q ${roundId}`, model: "m", effort: "high", status: "pending", ...extra
});

test("replies to one user message share a round with in-flight replies", () => {
  const rounds = buildSideChatRounds(
    [saved("legacy", null), saved("a", "r1"), saved("b", "r1")],
    [outgoing("r1:c", "r1"), outgoing("r2:a", "r2")]
  );
  assert.deepEqual(rounds.map((round) => [round.id, round.question, round.items.length]), [
    ["legacy", "Q legacy", 1],
    ["r1", "Q r1", 3],
    ["r2", "Q r2", 1]
  ]);
});

test("reply rounds have no user message", () => {
  const rounds = buildSideChatRounds([saved("a", "r1"), saved("b", "r2", { replyToId: "a" })], [outgoing("r3:x", "r3", { replyToId: "b" })]);
  assert.deepEqual(rounds.map((round) => round.question), ["Q r1", null, null]);
  assert.deepEqual(rounds.map((round) => round.replyToId), [null, "a", "b"]);
});
