import assert from "node:assert/strict";
import test from "node:test";
import { inputQuestions, inputResponse } from "../userInputRequest";

const params = { questions: [
  { id: "choice", header: "Scope", question: "Which scope?", options: [{ label: "UI", description: "UI only" }] },
  { id: "notes", header: "Notes", question: "Any notes?" }
] };
test("answers preserve question IDs and free text without accepting approval decisions", () => {
  const value = { answers: { choice: { answers: ["UI"] }, notes: { answers: ["Keep keyboard support"] } } };
  assert.deepEqual(inputResponse(value, params), value);
  assert.equal(inputResponse("accept", params), null);
  assert.equal(inputResponse({ answers: {} }, params), null);
  assert.equal(inputResponse({ answers: { ...value.answers, extra: { answers: ["x"] } } }, params), null);
  assert.equal(inputResponse({ answers: { ...value.answers, choice: { answers: ["invented"] } } }, params), null);
  assert.equal(inputResponse({ answers: { ...value.answers, notes: { answers: [""] } } }, params), null);
});
test("custom options require isOther and malformed questions fail closed", () => {
  const q = params.questions[0];
  assert.deepEqual(inputResponse({ answers: { choice: { answers: ["Both"] } } }, { questions: [{ ...q, isOther: true }] }), { answers: { choice: { answers: ["Both"] } } });
  assert.deepEqual(inputQuestions({ questions: [q, q] }), []);
  assert.deepEqual(inputQuestions({ questions: [{ ...q, options: ["wrong"] }] }), []);
});
