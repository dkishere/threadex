import assert from "node:assert/strict";
import test from "node:test";
import { AUTO_CONTEXT_MAX_CHARS, AUTO_PROMPT_MAX_CHARS, buildAutoModelState, selectAutoModel, shouldEnableAutoModel } from "./autoModelSelector";
import { createDecisionPolicy } from "./decision/policy";
import { fakeBackend } from "./decision/fake";
import type { Decision, DecisionAnswer } from "./decision/types";
import type { SessionRecord, SessionTurnRecord } from "./sessionStore";

const session = { id: "session", workspaceId: "workspace", cwd: "/project" } as SessionRecord;
function turn(id: string, userInput = id, agentResponse = "done"): SessionTurnRecord {
  return { id, sessionId: "session", userInput, agentResponse, status: "done", created: "2026-09-18", pendingReason: null } as SessionTurnRecord;
}


test("Auto gear resolves to routing mode before dispatching a Codex model", () => {
  assert.equal(shouldEnableAutoModel("auto", undefined), true);
  assert.equal(shouldEnableAutoModel("auto", false), true);
  assert.equal(shouldEnableAutoModel("gpt-6-luna", true), true);
  assert.equal(shouldEnableAutoModel("gpt-6-luna", false), false);
});

test("Jev receives bounded prompt plus summariser extracts, excluding raw commentary and future turns", () => {
  const state = JSON.parse(buildAutoModelState({
    session, currentTurnId: "current", prompt: "START" + "x".repeat(40_000) + "END",
    turns: [turn("previous", "Implement feature", "RAW FINAL"), turn("current"), turn("future", "FUTURE PROMPT")],
    liveItemsByTurn: { previous: [{ comment: { detail: "RAW COMMENTARY", extracts: [{ shortMsg: "Implemented feature" }], issues: ["Missing test"], solutions: [{ issueKey: 1, solution: "Added test" }] } }, { aggregatedOutput: "RAW COMMAND OUTPUT" }] }
  }));
  assert.equal(state.currentUserPrompt.length, AUTO_PROMPT_MAX_CHARS);
  assert.match(state.currentUserPrompt, /^START/);
  assert.match(state.currentUserPrompt, /END$/);
  assert.ok(state.summarizedContext.length <= AUTO_CONTEXT_MAX_CHARS);
  assert.match(state.summarizedContext, /Implemented feature/);
  assert.match(state.summarizedContext, /Added test/);
  assert.doesNotMatch(state.summarizedContext, /RAW|FUTURE/);
});

test("empty sessions and long unsummarised histories still produce bounded usable context", () => {
  const fresh = JSON.parse(buildAutoModelState({ session, currentTurnId: "new", prompt: "Hello", turns: [] }));
  assert.equal(fresh.summarizedContext, "No previous turns.");
  const state = JSON.parse(buildAutoModelState({ session, currentTurnId: "new", prompt: "Continue", turns: Array.from({ length: 100 }, (_, i) => turn(String(i), `Task ${i} ` + "x".repeat(20_000), `Result ${i} ` + "y".repeat(20_000))) }));
  assert.ok(state.summarizedContext.length <= AUTO_CONTEXT_MAX_CHARS);
  assert.match(state.summarizedContext, /Task 99/);
  assert.match(state.summarizedContext, /Task 0/);
});


const fake = (answers: Record<string, DecisionAnswer>): Decision => createDecisionPolicy({
  backends: [fakeBackend(answers)], policy: () => ({ order: ["fake"], threshold: {} })
});
const answers = (model = "gpt-6-sol", effort = "high", confidence = 0.9): Record<string, DecisionAnswer> => ({
  model: { kind: "choice", choice: model, confidence }, effort: { kind: "choice", choice: effort, confidence }
});

test("model selection sends independent choices through Decision and preserves routing instructions", async () => {
  const result = await selectAutoModel({ state: "bounded state", decide: async req => {
    assert.equal(req.purpose, "model_select");
    assert.equal(req.state, "bounded state");
    const model = req.questions.find(q => q.id === "model");
    assert.equal(model?.kind, "choice");
    if (model?.kind !== "choice") throw new Error("missing model choice");
    assert.deepEqual(Object.keys(model.options), ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"]);
    assert.match(model.instructions, /Routine terminal execution/);
    assert.match(model.instructions, /來回無進展都升級/);
    assert.match(model.instructions, /Any prompt work, even a small wording change, requires at least the Sol\/Opus tier and never Luna/);
    assert.match(model.options["gpt-6-luna"], /never a Luna task, however small/);
    return fake(answers("gpt-6-astra", "ultra"))(req);
  } });
  assert.equal(result.model, "gpt-6-astra");
  assert.equal(result.effort, "ultra");
  assert.equal(result.backend, "fake");
});

test("custom models constrain both model and effort, including low-confidence upgrade", async () => {
  const result = await selectAutoModel({
    state: "task", customRulesEnabled: true,
    customRules: {
      "gpt-6-luna": { enabled: true, efforts: ["max"], condition: "" },
      "gpt-6-astra": { enabled: true, efforts: ["low"], condition: "Hard tasks" }
    },
    decide: async req => {
      const q = req.questions.find(q => q.id === "model");
      assert.ok(q?.kind === "choice");
      assert.deepEqual(Object.keys(q.options), ["gpt-6-luna", "gpt-6-astra"]);
      return fake({
        model: { kind: "choice", choice: "gpt-6-luna", confidence: 0.1 },
        "effort_gpt-6-luna": { kind: "choice", choice: "max", confidence: 0.9 },
        "effort_gpt-6-astra": { kind: "choice", choice: "low", confidence: 0.9 }
      })(req);
    }
  });
  assert.equal(result.model, "gpt-6-astra");
  assert.equal(result.effort, "low");
});

test("low confidence upgrades one tier and non-Astra models keep high effort floor", async () => {
  for (const [chosen, expected] of [["gpt-6-luna", "gpt-6-sol"], ["gpt-6-sol", "gpt-6-astra"], ["gpt-6-astra", "gpt-6-astra"]]) {
    const result = await selectAutoModel({ state: "task", decide: fake(answers(chosen, "high", 0.1)) });
    assert.equal(result.model, expected);
    assert.match(result.reason, /upgraded/);
  }
  for (const model of ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"]) {
    for (const effort of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
      const result = await selectAutoModel({ state: "task", decide: fake(answers(model, effort)) });
      assert.equal(result.effort, model !== "gpt-6-astra" && ["low", "medium"].includes(effort) ? "high" : effort);
    }
  }
});

test("unavailable or malformed decisions retain the previous setting without leaking task data", async () => {
  const unavailable: Decision = async () => ({ ok: false, attempts: [{ backend: "fake", reason: "not_configured" }] });
  for (const decide of [unavailable, fake(answers("__proto__")), fake(answers("gpt-6-sol", "bad")), fake(answers("gpt-6-sol", "high", 3))]) {
    const result = await selectAutoModel({ state: "PRIVATE TASK", fallback: { model: "gpt-6-sol", effort: "xhigh" }, decide });
    assert.equal(result.provider, "fallback");
    assert.equal(result.model, "gpt-6-sol");
    assert.equal(result.effort, "xhigh");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE TASK/);
  }
  assert.equal((await selectAutoModel({ state: "", decide: unavailable })).model, "gpt-6-luna");
});
