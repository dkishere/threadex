import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createServer } from "node:http";
import { createTurnGrillHandler } from "./turnGrillRoute";
import type { SessionStore } from "./sessionStore";
import type { TurnGrill } from "../turnGrill";
import { USER_INPUT_METHOD } from "../userInputRequest";

test("running Grill remains readable, excludes concurrent writes, preserves failed requests and recovers abandoned work", async () => {
  let saved: TurnGrill | null = null;
  const session = { id: "s", workspaceId: "w", cwd: "", accountId: null };
  const turn = { id: "t", sessionId: "s", status: "done", userInput: "Review", agentResponse: "Done" };
  const store = {
    getSession: async () => session, getSessionTurn: async () => turn,
    getTurnGrill: async () => saved,
    saveTurnGrill: async (_session: string, _turn: string, revision: number, next: TurnGrill) => {
      if ((saved?.revision ?? 0) !== revision) return false;
      saved = structuredClone(next); return true;
    },
    getWorkspace: async () => ({ id: "w", codexHome: "/unused" }),
    listSessionTurnLiveItems: async () => [], listSessionSteerMessages: async () => ({ t: [
      { id: "manual", content: "Use the existing endpoint", attachments: [], forcePlan: false, created: "2026-09-23T10:01:00Z" },
      { id: "async:thread:question", content: "Answer echoed as steer", attachments: [], forcePlan: false, created: "2026-09-23T10:03:00Z" }
    ] }),
    listSessionApprovalLiveItems: async () => ({ t: [{
      itemType: "approval", method: USER_INPUT_METHOD, status: "resolved", sortCreated: "2026-09-23T10:02:00Z",
      params: { questions: [{ id: "scope", header: "Scope", question: "Which endpoint?" }] },
      decision: { answers: { scope: { answers: ["The existing endpoint"] } } }
    }] }), listSessionDeveloperInstructions: async () => ({}),
    listSessionTurns: async () => [turn]
  } as unknown as SessionStore;
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  let started!: () => void;
  const running = new Promise<void>((done) => { started = done; });
  let fail = false;
  const prompts: Array<Record<string, unknown>> = [];
  const handler = createTurnGrillHandler({ sessionStore: store, serverUrl: "http://unused", recordUsage: async () => {}, runGrill: async (_home, prompt) => {
    prompts.push(JSON.parse(prompt));
    started(); await gate;
    return { responseText: fail ? "malformed JSON" : JSON.stringify([{ id: "q1", md: "Question", responseMd: JSON.parse(prompt).action === "start" ? "" : "Thread answer", status: "open" }]), usage: null, authIdentity: { externalAccountId: null, externalUserId: null } };
  } });
  const app = express(); app.use(express.json()); app.get("/:sessionId/:turnId", handler); app.post("/:sessionId/:turnId", handler);
  const server = createServer(app);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/s/t`;
  const post = (body = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const request = post(); await running;
    const current = (await (await fetch(url)).json()).grill;
    assert.equal(current.status, "running");
    assert.equal((await post()).status, 409);
    // GET must not remove the active POST's lock.
    assert.equal((await post()).status, 409);
    // A long-running review remains running while its in-memory job still exists.
    saved = { ...saved!, updated: new Date(Date.now() - 600_000).toISOString() };
    assert.equal((await (await fetch(url)).json()).grill.status, "running");
    release(); assert.equal((await request).status, 200);
    assert.deepEqual(prompts[0].midTurnInputs, [
      { kind: "steer", created: "2026-09-23T10:01:00Z", content: "Use the existing endpoint", attachmentNames: [], forcePlan: false },
      { kind: "qa", created: "2026-09-23T10:02:00Z", questions: [{ question: "Which endpoint?", answer: "The existing endpoint" }] }
    ]);
    const ready = (await (await fetch(url)).json()).grill;
    assert.equal((await post({ action: "followup", revision: ready.revision, issues: ready.issues })).status, 409);
    assert.equal((await post({ action: "respond", revision: ready.revision, issues: ready.issues, issueId: "q1" })).status, 400);
    fail = true;
    assert.equal((await post({ action: "respond", revision: ready.revision, issues: ready.issues, prompt: "Keep this follow-up" })).status, 500);
    const failed = (await (await fetch(url)).json()).grill;
    assert.equal(failed.status, "error"); assert.equal(failed.rounds.length, 1);
    assert.equal(failed.request.prompt, "Keep this follow-up");
    // A server restart loses the active job even when its saved timestamp is fresh.
    saved = { ...failed, status: "running", updated: new Date().toISOString() };
    const recovered = (await (await fetch(url)).json()).grill;
    assert.equal(recovered.status, "error"); assert.match(recovered.error, /interrupted/);
    assert.equal(recovered.revision, failed.revision + 1);
    fail = false;
    const retried = await post({ action: "respond", revision: recovered.revision, issues: recovered.issues, prompt: recovered.request.prompt });
    assert.equal(retried.status, 200);
    assert.deepEqual(prompts.at(-1)?.midTurnInputs, prompts[0].midTurnInputs);
    assert.equal((await retried.json()).grill.issues[0].responseMd, "Thread answer");
  } finally {
    release(); await new Promise<void>((done) => server.close(() => done()));
  }
});
