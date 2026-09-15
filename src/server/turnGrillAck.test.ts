import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./sessionStore";
import { createTurnGrillHandler } from "./turnGrillRoute";
import { grillAwaitingAck, type TurnGrill } from "../turnGrill";

test("Grill acknowledgment persists, aggregates turns, and never consumes unseen responses or unrelated work", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "grill-ack-"));
  const path = join(root, "test.postgres");
  let store = new SessionStore(path);
  const app = express(); app.use(express.json());
  const server = createServer(app);
  let inferenceCalls = 0;
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  let gate = Promise.resolve();
  try {
    await store.ready();
    await store.upsertWorkspace({ id: "w", name: "ACK", cwd: root, codexHome: join(root, "home") });
    await store.upsertSession({ id: "s", workspaceId: "w", cwd: root, title: "ACK" });
    const addTurn = (id: string, status: "done" | "running" | "todo" = "done") => store.recordSessionTurn({ id, sessionId: "s", userInput: id, agentResponse: "answer", tokenIn: 0, tokenOut: 0, status });
    await addTurn("t1");
    const handler = createTurnGrillHandler({ sessionStore: store, serverUrl: "http://unused", recordUsage: async () => {},
      runGrill: async (_home, prompt) => {
        inferenceCalls++; entered?.(); await gate;
        const input = JSON.parse(prompt);
        return { responseText: JSON.stringify(input.action === "start"
          ? [{ id: "q1", md: "Question", responseMd: "", status: "open" }]
          : input.issues.map((issue: object) => ({ ...issue, responseMd: "New answer", status: "open" }))),
        usage: null, authIdentity: { externalAccountId: null, externalUserId: null } };
      } });
    app.get("/:sessionId/:turnId", handler); app.post("/:sessionId/:turnId", handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}/s`;
    const post = async (turnId: string, body: object): Promise<TurnGrill> => {
      const response = await fetch(`${base}/${turnId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data.grill;
    };
    let first = await post("t1", { action: "start" });
    assert.equal(first.contentVersion, 1); assert.ok(grillAwaitingAck(first));
    first = await post("t1", { action: "ack", observedVersion: 1 });
    assert.equal(grillAwaitingAck(first), false); assert.equal(inferenceCalls, 1);
    first = await post("t1", { action: "save", revision: first.revision, issues: first.issues.map((issue) => ({ ...issue, md: "User edit", dropped: true })) });
    assert.equal(first.contentVersion, 1); assert.equal(grillAwaitingAck(first), false);
    first = await post("t1", { action: "save", revision: first.revision, issues: first.issues.map((issue) => ({ ...issue, selected: true, dropped: false })) });
    assert.equal(grillAwaitingAck(first), false);

    for (const action of ["respond", "followup"] as const) {
      const observed = first.contentVersion!;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      gate = new Promise<void>((resolve) => { release = resolve; });
      const request = post("t1", { action, revision: first.revision, observedVersion: observed });
      await started;
      const running = (await (await fetch(`${base}/t1`)).json()).grill;
      assert.equal(running.status, "running"); assert.equal(grillAwaitingAck(running), false);
      // An ACK during inference must not break its completion CAS or release its lock.
      await post("t1", { action: "ack", observedVersion: observed });
      release!(); first = await request;
      assert.equal(first.contentVersion, observed + 1); assert.ok(grillAwaitingAck(first));
      first = await post("t1", { action: "ack", observedVersion: observed });
      assert.ok(grillAwaitingAck(first), "stale acknowledgment preserves new content");
    }
    entered = undefined; gate = Promise.resolve();
    await addTurn("t2");
    const second = await post("t2", { action: "start" });
    assert.equal((await store.listGrillSummaries("w")).filter((item) => item.pending).length, 2);
    first = await post("t1", { action: "ack", observedVersion: first.contentVersion });
    assert.deepEqual((await store.listGrillSummaries("w")).filter((item) => item.pending).map((item) => item.turnId), ["t2"]);
    assert.deepEqual(await store.listGrillSummaries("other-workspace"), []);

    await addTurn("work", "running");
    const linked = await store.acknowledgeTurnGrill("s", "t2", second.contentVersion!, "work");
    assert.equal(grillAwaitingAck(linked), false);
    await addTurn("unrelated");
    const finish = (id: string, runnerExitCode = 0) => store.updateSessionTurn({ id, status: "done", agentResponse: "Implemented", tokenIn: 0, tokenOut: 0, runnerExitCode });
    await finish("unrelated");
    assert.equal(grillAwaitingAck(await store.getTurnGrill("s", "t2")), false);
    await finish("work", 1);
    assert.equal(grillAwaitingAck(await store.getTurnGrill("s", "t2")), false, "failed work adds no response");
    await finish("work");
    const completed = (await store.getTurnGrill("s", "t2"))!;
    assert.equal(grillAwaitingAck(completed), false); assert.equal(completed.contentVersion, second.contentVersion);
    assert.equal(completed.workTurns?.work, "completed");
    await finish("work");
    assert.equal((await store.getTurnGrill("s", "t2"))!.contentVersion, completed.contentVersion, "duplicate terminal callbacks are idempotent");
    assert.equal((await store.getTurnGrill("s", "t1"))!.contentVersion, first.contentVersion);
    await store.acknowledgeTurnGrill("s", "t2", second.contentVersion!);
    assert.equal(grillAwaitingAck(await store.getTurnGrill("s", "t2")), false);
    await store.close(); store = new SessionStore(path); await store.ready();
    assert.equal(grillAwaitingAck(await store.getTurnGrill("s", "t1")), false);
    assert.equal(grillAwaitingAck(await store.getTurnGrill("s", "t2")), false);
    await store.acknowledgeTurnGrill("s", "t2", completed.contentVersion!);
    assert.equal((await store.listGrillSummaries("w")).some((item) => item.pending), false);
    await addTurn("queued-work", "todo");
    await store.acknowledgeTurnGrill("s", "t2", completed.contentVersion!, "queued-work");
    await finish("queued-work");
    assert.equal(grillAwaitingAck(await store.getTurnGrill("s", "t2")), false, "queued work completion does not reopen ACK");
    const noGaps: TurnGrill = { ...first, revision: 1, issues: [], contentVersion: 1, acknowledgedVersion: 0 };
    await addTurn("no-gaps");
    assert.ok(await store.saveTurnGrill("s", "no-gaps", 0, noGaps));
    assert.equal(grillAwaitingAck(await store.getTurnGrill("s", "no-gaps")), false);
    assert.equal((await store.listGrillSummaries("w")).find((item) => item.turnId === "no-gaps")!.pending, false);
  } finally {
    release?.(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close(); await rm(root, { recursive: true, force: true });
  }
});
