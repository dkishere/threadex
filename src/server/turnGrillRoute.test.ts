import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { SessionStore } from "./sessionStore";
import { createTurnGrillHandler } from "./turnGrillRoute";

test("grill rejects older turns and persists the latest turn's questions and follow-ups", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "grill-route-"));
  const store = new SessionStore(join(root, "test.postgres"));
  const server = createServer();
  try {
    await store.ready();
    await store.upsertWorkspace({ id: "grill-test", name: "Grill fixture", cwd: root, codexHome: join(root, "home") });
    await store.upsertSession({ id: "fixture", workspaceId: "grill-test", cwd: root, title: "Ordering fixture" });
    // IDs deliberately differ from chronological order; middle is neither first nor last.
    for (const id of ["z-oldest", "a-middle", "m-newest"]) {
      await store.recordSessionTurn({ id, sessionId: "fixture", userInput: `Prompt ${id}`, agentResponse: `Reply ${id}`, tokenIn: 0, tokenOut: 0, status: "done" });
    }
    await store.recordSessionTurnEvent({
      id: "large-unrelated-live-item", sessionId: "fixture", turnId: "a-middle", eventName: "item",
      payload: { id: "large-unrelated-live-item", itemType: "agent_message", eventType: "item.completed", text: "x".repeat(1_000_000) }
    });
    await store.recordSessionTurnEvent({
      id: "target-file-change", sessionId: "fixture", turnId: "m-newest", eventName: "item",
      payload: {
        id: "target-file-change", itemType: "file_change", eventType: "item.completed",
        changes: [{ path: "src/target.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }]
      }
    });
    let wholeSessionLiveItemReads = 0;
    const originalListSessionLiveItems = store.listSessionLiveItems.bind(store);
    store.listSessionLiveItems = async (sessionId) => {
      wholeSessionLiveItemReads += 1;
      return originalListSessionLiveItems(sessionId);
    };
    assert.deepEqual((await store.listSessionTurns("fixture")).map((turn) => turn.id), ["z-oldest", "a-middle", "m-newest"]);
    let calls = 0;
    let lastPrompt: any;
    const recordedModels: string[] = [];
    let extraQuestion = false;
    const app = express();
    app.use(express.json());
    const handler = createTurnGrillHandler({
      sessionStore: store, serverUrl: "http://unused", recordUsage: async (usage) => { recordedModels.push(usage.model); },
      runGrill: async (_home, prompt, session, _serverUrl, totalTurns) => {
        calls++;
        const payload = JSON.parse(prompt);
        lastPrompt = payload;
        assert.equal(session.id, "fixture");
        assert.equal(payload.userInput, "Prompt m-newest");
        assert.equal(payload.agentResponse, "Reply m-newest");
        assert.deepEqual(payload.sessionContext, {
          sessionUrl: "codex://threads/fixture?workspace=grill-test", sessionId: "fixture", workspaceId: "grill-test",
          turnId: "m-newest", currentTurnNumber: 3, totalTurns: 3
        });
        assert.equal(totalTurns, 3);
        if (extraQuestion) return { responseText: JSON.stringify([...payload.issues,
          { id: "q3", md: "New grounded concern", responseMd: "", status: "open" }]), usage: null, authIdentity: { externalAccountId: null, externalUserId: null } };
        return { responseText: JSON.stringify(payload.action === "start" ? [{ id: "q1", md: "**Evidence?**", responseMd: "", status: "open" }, { id: "q2", md: "Second question", responseMd: "", status: "open" }] : payload.issues.map((issue: object) => ({ ...issue, responseMd: "Add a focused fixture.", status: "resolved" }))), usage: null, authIdentity: { externalAccountId: null, externalUserId: null } };
      }
    });
    app.post("/api/sessions/:sessionId/turns/:turnId/grill", handler);
    app.get("/api/sessions/:sessionId/turns/:turnId/grill", handler);
    server.on("request", app);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}/api/sessions/fixture/turns`;
    const older = await fetch(`${base}/a-middle/grill`, { method: "POST" });
    assert.equal(older.status, 409);
    assert.equal(calls, 0);
    const response = await fetch(`${base}/m-newest/grill`, { method: "POST" });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.grill.issues[0].md, "**Evidence?**");
    assert.equal(calls, 1);
    assert.deepEqual(recordedModels, ["gpt-6-luna"]);
    assert.equal(wholeSessionLiveItemReads, 0);
    assert.deepEqual(lastPrompt.fileChanges, [{ path: "src/target.ts", kind: "update", additions: 1, deletions: 1 }]);
    assert.deepEqual((await (await fetch(`${base}/m-newest/grill`)).json()).grill, body.grill);
    const post = (input: unknown) => fetch(`${base}/m-newest/grill`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    assert.equal((await post({ action: "save", revision: 0, issues: body.grill.issues })).status, 409);
    body.grill.issues[0].md = "Edited question";
    assert.equal((await post({ action: "followup", revision: body.grill.revision, issues: body.grill.issues })).status, 409);
    assert.equal(calls, 1);
    const followup = await post({ action: "respond", revision: body.grill.revision, issues: body.grill.issues, prompt: "Check again" });
    assert.equal(followup.status, 200);
    const updated = (await followup.json()).grill;
    assert.equal(updated.issues[0].md, "Edited question");
    assert.equal(updated.issues[0].responseMd, "Add a focused fixture.");
    assert.equal(updated.rounds.length, 2);
    assert.equal(updated.rounds[0].issues[0].md, "**Evidence?**");
    assert.equal(updated.rounds[1].prompt, "Check again");
    assert.deepEqual(await store.getTurnGrill("fixture", "m-newest"), updated);
    assert.deepEqual(await store.listGrilledTurnIds("fixture"), ["m-newest"]);
    assert.deepEqual(await store.listGrilledTurnIds("unrelated"), []);
    const droppedResponse = await post({ action: "save", revision: updated.revision,
      issues: updated.issues.map((issue: any) => issue.id === "q1" ? { ...issue, dropped: true, selected: true } : issue) });
    assert.equal(droppedResponse.status, 200);
    const dropped = (await droppedResponse.json()).grill;
    assert.equal(dropped.issues[0].dropped, true);
    assert.equal(dropped.issues[0].selected, false);
    assert.deepEqual((await (await fetch(`${base}/m-newest/grill`)).json()).grill, dropped);
    assert.equal((await post({ action: "respond", revision: dropped.revision, issues: dropped.issues, issueId: "q1" })).status, 400);
    const answeredResponse = await post({ action: "respond", revision: dropped.revision, issues: dropped.issues });
    assert.equal(answeredResponse.status, 200);
    const answered = (await answeredResponse.json()).grill;
    assert.deepEqual(lastPrompt.issues.map((issue: any) => issue.id), ["q2"]);
    assert.ok(lastPrompt.rounds.every((round: any) => round.issues.every((issue: any) => issue.id !== "q1")));
    assert.deepEqual(answered.issues[0], dropped.issues[0]);
    const restoredResponse = await post({ action: "save", revision: answered.revision,
      issues: answered.issues.map((issue: any) => issue.id === "q1" ? { ...issue, dropped: false, selected: true, md: "Restored edited question" } : issue) });
    assert.equal(restoredResponse.status, 200);
    const restored = (await restoredResponse.json()).grill;
    assert.equal(restored.issues[0].dropped, false);
    assert.equal(restored.issues[0].selected, true);
    assert.equal(restored.issues[0].md, "Restored edited question");
    assert.deepEqual((await (await fetch(`${base}/m-newest/grill`)).json()).grill, restored);
    assert.deepEqual(await store.getTurnGrill("fixture", "m-newest"), restored);
    assert.equal(restored.issues[0].responseMd, updated.issues[0].responseMd);
    assert.ok(restored.rounds.some((round: any) => round.issues[0].dropped));
    const reviewedResponse = await post({ action: "followup", revision: restored.revision, issues: restored.issues, prompt: "Review the thread response" });
    assert.equal(reviewedResponse.status, 200);
    assert.equal(lastPrompt.action, "followup");
    assert.ok(lastPrompt.rounds.some((round: any) => round.action === "respond"));
    let reviewed = (await reviewedResponse.json()).grill;
    assert.ok(reviewed.issues.every((issue: any) => issue.status === "resolved"));
    const again = await post({ action: "followup", revision: reviewed.revision, issues: reviewed.issues.map((issue: any) => ({ ...issue, selected: false })) });
    assert.equal(again.status, 200);
    assert.deepEqual(lastPrompt.issues, []);
    reviewed = (await again.json()).grill;
    assert.equal(reviewed.issues.length, 2);
    const reopen = await post({ action: "save", revision: reviewed.revision, issues: reviewed.issues.map((issue: any) => ({ ...issue, md: `${issue.md} edited` })) });
    reviewed = (await reopen.json()).grill;
    assert.ok(reviewed.issues.every((issue: any) => issue.status === "open"));
    const manual = await post({ action: "save", revision: reviewed.revision, issues: reviewed.issues.map((issue: any) => ({ ...issue, status: "resolved" })) });
    assert.equal(manual.status, 200);
    assert.ok((await store.getTurnGrill("fixture", "m-newest"))!.issues.every((issue) => issue.status === "resolved"));
    reviewed = (await manual.json()).grill;
    extraQuestion = true;
    const discovery = await post({ action: "followup", revision: reviewed.revision, issues: reviewed.issues });
    assert.equal(discovery.status, 200);
    const discovered = (await discovery.json()).grill;
    assert.deepEqual(lastPrompt.issues, []);
    assert.deepEqual(lastPrompt.reservedIssueIds, ["q1", "q2"]);
    assert.equal(discovered.issues.length, 3);
    assert.equal(discovered.issues[2].selected, true);
    assert.equal(discovered.issues[2].status, "open");
    assert.deepEqual(discovered.issues.slice(0, 2), reviewed.issues);
    assert.deepEqual(await store.getTurnGrill("fixture", "m-newest"), discovered);
    await store.upsertSession({ id: "other", workspaceId: "grill-test", cwd: root, title: "Other" });
    const mismatch = `http://127.0.0.1:${address.port}/api/sessions/other/turns/m-newest/grill`;
    assert.equal((await fetch(mismatch)).status, 404);
    assert.equal((await fetch(mismatch, { method: "POST" })).status, 404);
  } finally {
    if (server.listening) await new Promise<void>((done) => server.close(() => done()));
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
