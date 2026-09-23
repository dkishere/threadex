import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { setImmediate as nextTick } from "node:timers/promises";
import type { Request, Response } from "express";
import { createWorkspaceSnapshotHandler } from "./workspaceSnapshotRoute";

function response() {
  return Object.assign(new EventEmitter(), {
    body: undefined as unknown,
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name] = value; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; }
  });
}

test("snapshot responses finish before slow recovery, and overlapping requests share recovery", async () => {
  let recoveries = 0;
  let release!: () => void;
  const recovery = new Promise<void>(resolve => { release = resolve; });
  const snapshot = { eventCursor: 10, activeSession: { turns: [{ status: "running" }] } };
  const handler = createWorkspaceSnapshotHandler({
    readSnapshot: async () => snapshot,
    reconcileRunningTurns: async () => { recoveries++; await recovery; }
  });
  const get = async () => {
    const res = response();
    await handler({} as Request, res as unknown as Response, () => {});
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, snapshot);
    assert.match(res.headers["Server-Timing"], /^snapshot;dur=\d+\.\d$/);
    return res;
  };
  const first = await get();
  await nextTick();
  assert.equal(recoveries, 0, "recovery must wait for the response to finish writing");
  first.emit("finish");
  await nextTick();
  assert.equal(recoveries, 1);
  const second = await get();
  second.emit("finish");
  await nextTick();
  assert.equal(recoveries, 1, "an unfinished recovery must not block or duplicate on another snapshot");
  release();
  await nextTick();
  const third = await get();
  third.emit("finish");
  await nextTick();
  assert.equal(recoveries, 2, "later snapshots can recover newly dead runners");
});

test("snapshot read errors return an error without starting runner recovery", async () => {
  let recoveries = 0;
  const handler = createWorkspaceSnapshotHandler({
    readSnapshot: async () => { throw new Error("Snapshot unavailable"); },
    reconcileRunningTurns: async () => { recoveries++; }
  });
  const res = response();
  await handler({} as Request, res as unknown as Response, () => {});
  res.emit("finish");
  await nextTick();
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: "Snapshot unavailable" });
  assert.equal(recoveries, 0);
});
