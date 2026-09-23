import assert from "node:assert/strict";
import test from "node:test";
import { AUTO_CONTEXT_MAX_CHARS, AUTO_PROMPT_MAX_CHARS, buildAutoModelState, selectAutoModel } from "./autoModelSelector";
import type { SessionRecord, SessionTurnRecord } from "./sessionStore";

const session = { id: "session", workspaceId: "workspace", cwd: "/project" } as SessionRecord;
function turn(id: string, userInput = id, agentResponse = "done"): SessionTurnRecord {
  return { id, sessionId: "session", userInput, agentResponse, status: "done", created: "2026-09-18", pendingReason: null } as SessionTurnRecord;
}
const answer = (model = "gpt-6-sol", effort = "high", confidence = 0.9) => ({
  answers: { model: { choice: model, confidence }, effort: { choice: effort, confidence } }
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

test("Jev choice uses the documented authenticated endpoint and validates both answers", async () => {
  const selection = await selectAutoModel({ state: "bounded state", apiKey: "test-key", fetch: async (url, init) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "jev-latest");
    assert.equal(body.state, "bounded state");
    assert.deepEqual(Object.keys(body.questions.model.criteria), ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"]);
    assert.equal(Object.hasOwn(body.questions.model.criteria, "gpt-5.6-terra"), false);
    assert.ok(body.questions.model.criteria["gpt-6-astra"]);
    assert.equal(body.questions.effort.type, "choice");
    assert.ok(init?.signal);
    return Response.json(answer("gpt-6-astra", "ultra"));
  } });
  assert.equal(selection.model, "gpt-6-astra");
  assert.equal(selection.effort, "ultra");
  assert.equal(selection.provider, "typesafe");
});

test("Luna custom routing sends and preserves max effort", async () => {
  const selection = await selectAutoModel({
    state: "commit and push", apiKey: "test-key", customRulesEnabled: true,
    customRules: { "gpt-6-luna": { enabled: true, efforts: ["max"], condition: "" } },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(Object.keys(body.questions["effort_gpt-6-luna"].criteria), ["max"]);
      assert.match(body.questions.model.criteria["gpt-6-luna"], /Routine Git/);
      return Response.json({ answers: { model: { choice: "gpt-6-luna", confidence: 0.9 }, "effort_gpt-6-luna": { choice: "max", confidence: 0.9 } } });
    }
  });
  assert.equal(selection.model, "gpt-6-luna");
  assert.equal(selection.effort, "max");
  assert.equal(selection.provider, "typesafe");
});

test("custom rules restrict model choices and set effort for the selected model", async () => {
  const custom = "Use for database work in this environment.";
  const selection = await selectAutoModel({
    state: "bounded state",
    apiKey: "test-key",
    customRulesEnabled: true,
    customRules: {
      "gpt-6-luna": { enabled: false, efforts: ["high"], condition: "" },
      "gpt-6-sol": { enabled: true, efforts: ["high", "xhigh"], condition: custom }
    },
    fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.questions.model.criteria, { "gpt-6-sol": custom });
    assert.equal(body.questions.effort, undefined);
    assert.deepEqual(Object.keys(body.questions["effort_gpt-6-sol"].criteria), ["high", "xhigh"]);
    return Response.json({ answers: { model: { choice: "gpt-6-sol", confidence: 0.9 }, "effort_gpt-6-sol": { choice: "xhigh", confidence: 0.9 } } });
  } });
  assert.equal(selection.model, "gpt-6-sol");
  assert.equal(selection.effort, "xhigh");
});

test("non-Astra selections have a hard high effort floor while Astra retains its selected effort", async () => {
  for (const model of ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"]) {
    for (const effort of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
      const selection = await selectAutoModel({
        state: "task", apiKey: "test-key", fetch: async () => Response.json(answer(model, effort))
      });
      assert.equal(selection.effort, model !== "gpt-6-astra" && ["low", "medium"].includes(effort) ? "high" : effort);
    }
  }
});

test("no key never calls TypeSafe and preserves the old Auto setting", async () => {
  const initial = await selectAutoModel({ state: "ignored", fetch: async () => { throw new Error("must not call"); } });
  assert.equal(initial.model, "gpt-6-luna");
  assert.equal(initial.effort, "high");
  const upgraded = await selectAutoModel({ state: "ignored", fallback: { model: "gpt-6-sol", effort: "xhigh" } });
  assert.equal(upgraded.model, "gpt-6-sol");
  assert.equal(upgraded.effort, "xhigh");
  const migrated = await selectAutoModel({ state: "ignored", fallback: { model: "gpt-5.6-terra", effort: "high" } });
  assert.equal(migrated.model, "gpt-6-luna");
});

test("low-confidence Jev choices upgrade by one model tier and remain Jev selections", async () => {
  const cases = [
    ["gpt-6-luna", "gpt-6-sol"],
    ["gpt-6-sol", "gpt-6-astra"],
    ["gpt-6-astra", "gpt-6-astra"]
  ] as const;
  for (const [chosen, expected] of cases) {
    const result = await selectAutoModel({
      state: "task", apiKey: "secret", fetch: async () => Response.json(answer(chosen, "high", 0.1))
    });
    assert.equal(result.provider, "typesafe");
    assert.equal(result.model, expected);
    assert.equal(result.confidence, 0.1);
    assert.match(result.reason, /upgraded/);
  }
});

test("errors and malformed choices retain the prior setting without leaking provider content", async () => {
  const cases: Array<typeof fetch> = [
    async () => new Response("secret provider body", { status: 401 }),
    async () => new Response("not json"),
    async () => Response.json(answer("__proto__")),
    async () => Response.json(answer("gpt-6-sol", "invalid")),
    async () => Response.json(answer("gpt-6-sol", "high", 3)),
    async () => { throw new Error("secret provider error"); }
  ];
  for (const fetch of cases) {
    const result = await selectAutoModel({ state: "private state", apiKey: "secret", fallback: { model: "gpt-6-sol", effort: "xhigh" }, fetch });
    assert.equal(result.provider, "fallback");
    assert.equal(result.model, "gpt-6-sol");
    assert.equal(result.effort, "xhigh");
    assert.doesNotMatch(JSON.stringify(result), /secret|private state/);
  }
});

test("slow requests abort within the configured deadline", async () => {
  const keepAlive = setTimeout(() => {}, 500);
  try {
    const result = await selectAutoModel({ state: "state", apiKey: "key", timeoutMs: 10, fetch: async (_url, init) => {
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
    } });
    assert.equal(result.provider, "fallback");
    assert.match(result.reason, /timed out/);
  } finally { clearTimeout(keepAlive); }
});
