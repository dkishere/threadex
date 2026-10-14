import assert from "node:assert/strict";
import test from "node:test";
import { findMentionTrigger, formatSideChatTranscript, mentionedActors, parseSideChatActorJson, sideChatActorSnapshot, type SideChatTranscriptEntry } from "./sideChatRoom";

const robin = { name: "Robin" };
const robin2 = { name: "Robin 2" };
const willow = { name: "Willow" };

test("mentions address actors by exact name, case-insensitively, preferring longer names", () => {
  assert.deepEqual(mentionedActors("@willow what do you think?", [robin, willow]), [willow]);
  assert.deepEqual(mentionedActors("@Robin 2 and @Willow", [robin, robin2, willow]), [robin2, willow]);
  assert.deepEqual(mentionedActors("ask @Robins later", [robin]), [], "a longer word is not a mention");
  assert.deepEqual(mentionedActors("no mention here", [robin, willow]), []);
});

test("mention trigger tracks the @query at the caret", () => {
  assert.deepEqual(findMentionTrigger("hi @Wi"), { start: 3, end: 6, query: "Wi" });
  assert.deepEqual(findMentionTrigger("@"), { start: 0, end: 1, query: "" });
  assert.equal(findMentionTrigger("mail me@example"), null, "an @ inside a word is not a mention");
  assert.equal(findMentionTrigger("@Robin done", 11), null);
  assert.deepEqual(findMentionTrigger("@Ro done", 3), { start: 0, end: 3, query: "Ro" });
});

test("actor snapshots drop role prompts and uploaded avatars", () => {
  const snapshot = sideChatActorSnapshot({ id: "a", name: "Robin", model: "gpt-5.5", effort: "high", systemPrompt: "Be critical", avatar: "data:image/webp;base64,xx", presetId: "p" });
  assert.deepEqual(snapshot, { id: "a", name: "Robin", model: "gpt-5.5", effort: "high", presetId: "p" });
  assert.deepEqual(parseSideChatActorJson(JSON.stringify(snapshot)), snapshot);
  assert.equal(parseSideChatActorJson("not json"), null);
  assert.equal(parseSideChatActorJson(null), null);
});

test("transcripts show each round's user message once and label replies", () => {
  const actor = (name: string) => ({ id: name, name, model: "m", effort: "high" });
  const entries: SideChatTranscriptEntry[] = [
    { id: "1", roundId: "r1", replyToId: null, question: "Is it safe?", answer: "Yes", model: "m", actor: actor("Robin") },
    { id: "2", roundId: "r1", replyToId: null, question: "Is it safe?", answer: "No", model: "m", actor: actor("Willow") },
    { id: "3", roundId: "r2", replyToId: "2", question: "Please respond", answer: "I disagree", model: "m", actor: actor("Robin") },
    { id: "4", roundId: null, replyToId: null, question: "Legacy", answer: "Old answer", model: "gpt-5.5", actor: null }
  ];
  const transcript = formatSideChatTranscript(entries);
  assert.equal(transcript.match(/User: Is it safe\?/g)?.length, 1);
  assert.match(transcript, /Robin: Yes[\s\S]*Willow: No/);
  assert.match(transcript, /\[The user asked Robin to reply to Willow\.\]\n\nRobin: I disagree/);
  assert.match(transcript, /User: Legacy\n\nAssistant \(gpt-5\.5\): Old answer/);
});

test("transcripts drop the oldest whole rounds to fit", () => {
  const entries: SideChatTranscriptEntry[] = Array.from({ length: 5 }, (_, index) => ({
    id: String(index), roundId: `r${index}`, replyToId: null, question: `Q${index}`, answer: "x".repeat(100), model: "m", actor: null
  }));
  const transcript = formatSideChatTranscript(entries, entries, 300);
  assert.match(transcript, /^\[Earlier messages omitted\.\]/);
  assert.match(transcript, /User: Q4/);
  assert.doesNotMatch(transcript, /User: Q0/);
});
