import assert from "node:assert/strict";
import test from "node:test";
import { deferSnapshotWrite } from "./deferredSnapshot";

test("streaming replaces pending cache writes; idle and pagehide save the latest snapshot once", () => {
  let nextId = 0;
  const timers = new Map<number, () => void>();
  const idle = new Map<number, () => void>();
  const host = Object.assign(new EventTarget(), {
    setTimeout(callback: () => void) { const id = ++nextId; timers.set(id, callback); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    requestIdleCallback(callback: () => void) { const id = ++nextId; idle.set(id, callback); return id; },
    cancelIdleCallback(id: number) { idle.delete(id); }
  });
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  const writes: number[] = [];
  let cancel = () => {};
  for (let revision = 0; revision < 30; revision++) {
    cancel();
    cancel = deferSnapshotWrite(() => writes.push(revision), host as any, page);
  }
  assert.deepEqual([...writes], []);
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  assert.deepEqual([...writes], []);
  [...idle.values()][0]();
  assert.deepEqual(writes, [29]);
  host.dispatchEvent(new Event("pagehide"));
  assert.deepEqual(writes, [29]);
  cancel();
  const stop = deferSnapshotWrite(() => writes.push(30), host as any, page);
  page.visibilityState = "hidden";
  page.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(writes, [29, 30]);
  stop();
  assert.equal(timers.size, 0);
  assert.equal(idle.size, 0);
});
