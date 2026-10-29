import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./apiClient";
import {
  orderedMentionedActors, removeActorMention, sessionActorMentionErrorMessage, sessionActorMentionFailure, sessionActorMentionHint,
  sessionActorMentionPayload, sessionActorMentionSuggestions, submitSessionActorMention, type SessionMentionActor
} from "./sessionActorMentions";

const actor = (id: string, name: string, extra: Partial<SessionMentionActor> = {}): SessionMentionActor =>
  ({ id, name, roleSummary: `${name} role`, parentActorId: null, ...extra });
const anya = actor("ui", "安妮亞 · 介面體驗");
const robin = actor("robin", "Robin");
const robin2 = actor("robin-2", "Robin 2");
const vera = actor("vera", "Vera", { parentActorId: "ui" });
const roster = [anya, robin, robin2, vera];

test("mentions follow their order in the text, are deduplicated and prefer longer names", () => {
  const text = "@Vera please check, then @安妮亞 · 介面體驗 and @Robin 2. Thanks @vera";
  assert.deepEqual(orderedMentionedActors(text, roster).map(item => item.id), ["vera", "ui", "robin-2"]);
  assert.deepEqual(orderedMentionedActors("@Robin and @Robin 2", roster).map(item => item.id), ["robin", "robin-2"]);
  assert.deepEqual(orderedMentionedActors("mail me@robin.dev or @Robinson", roster), []);
  assert.deepEqual(orderedMentionedActors("no mentions here", roster), []);
});

test("removing a chip removes every token for that actor so it is not sent", () => {
  const text = "@Robin fix it, @Vera review. @robin again";
  const next = removeActorMention(text, robin, roster);
  assert.equal(next, "fix it, @Vera review. again");
  assert.deepEqual(orderedMentionedActors(next, roster).map(item => item.id), ["vera"]);
  assert.equal(removeActorMention("@Robin 2 go", robin, roster), "@Robin 2 go");
  assert.equal(removeActorMention("ask @安妮亞 · 介面體驗 now", anya, roster), "ask now");
  assert.equal(removeActorMention("me@robin.dev @Robin", robin, roster), "me@robin.dev ");
});

test("the payload keeps the readable prompt and sends ordered unique actor ids", () => {
  const message = "@Vera and @Robin: split this, @Vera leads";
  const payload = sessionActorMentionPayload("req-1", message, orderedMentionedActors(message, roster));
  assert.deepEqual(payload, { requestId: "req-1", message, mentionedActorIds: ["vera", "robin"] });
  assert.deepEqual(Object.keys(payload).sort(), ["mentionedActorIds", "message", "requestId"]);
});

test("the POST goes to the session mention route with the contract body", async (t) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ round: { id: "r1", status: "dispatched", error: null, namedActorIds: ["vera"], workItemIds: ["w1"] }, turnIds: ["t1"] }), { status: 200 });
  });
  const body = sessionActorMentionPayload("req-2", "@Vera go", [vera]);
  const response = await submitSessionActorMention("tx 1", body);
  assert.equal(calls[0].url, "/api/sessions/tx%201/actor-mentions");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { requestId: "req-2", message: "@Vera go", mentionedActorIds: ["vera"] });
  assert.equal(sessionActorMentionFailure(response, roster), null);
});

test("rounds that queued no turn and server errors are shown, never treated as success", async (t) => {
  const round = (status: string, error: string | null, turnIds: string[] = []) =>
    ({ round: { id: "r", status, error, namedActorIds: ["vera", "robin"], workItemIds: [] }, turnIds });
  assert.equal(sessionActorMentionFailure(round("no_claims", "@Vera did not take it"), roster), "@Vera did not take it");
  assert.equal(sessionActorMentionFailure(round("routing_failed", null), roster), "@Vera, @Robin did not take this prompt.");
  assert.equal(sessionActorMentionFailure(round("dispatched", null), roster), "@Vera, @Robin did not take this prompt.");
  assert.equal(sessionActorMentionFailure(round("dispatched", null, ["t1"]), roster), null);

  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "Session cwd is not in a registered project.", code: "session_project_unresolved" }), { status: 409 }));
  const error = await submitSessionActorMention("tx", sessionActorMentionPayload("r", "@Vera", [vera])).catch(cause => cause);
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, "session_project_unresolved");
  assert.equal(sessionActorMentionErrorMessage(error), "Session cwd is not in a registered project.");
  assert.match(sessionActorMentionErrorMessage(new ApiError("x", 400, "mention_attachments_unsupported")), /Attachments cannot be sent/);
});

test("hints describe one worker, several workers and the limit", () => {
  assert.equal(sessionActorMentionHint([]), null);
  assert.equal(sessionActorMentionHint([vera]), "@Vera will run this prompt in this session");
  assert.equal(sessionActorMentionHint([vera, robin]), "2 workers will split this prompt (partial claim)");
  assert.match(sessionActorMentionHint(Array.from({ length: 9 }, (_, index) => actor(`a${index}`, `A${index}`)))!, /up to 8/);
});

test("@ suggestions only answer @ queries and insert the readable name", () => {
  assert.deepEqual(sessionActorMentionSuggestions("ver", roster), []);
  const [suggestion] = sessionActorMentionSuggestions("@ver", roster, id => roster.find(item => item.id === id)?.name);
  assert.deepEqual(suggestion, { kind: "actor", name: "Vera", scope: "actor", insertText: "@Vera ", description: "Sub-actor of 安妮亞 · 介面體驗 · Vera role", actor: { id: "vera", name: "Vera" } });
  assert.equal(sessionActorMentionSuggestions("@", roster).length, 4);
  assert.deepEqual(sessionActorMentionSuggestions("@安妮", roster).map(item => item.name), ["安妮亞 · 介面體驗"]);
});
