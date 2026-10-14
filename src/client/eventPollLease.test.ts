import assert from "node:assert/strict";
import test from "node:test";
import { EventPollLease } from "./eventPollLease";

// Same-name exclusive locks with ifAvailable, as the browser shares them
// between tabs of one origin.
function fakeLocks() {
  let held = false;
  return {
    request: async (_name: string, _options: unknown, callback: (lock: object | null) => unknown) => {
      if (held) return callback(null);
      held = true;
      try { return await callback({}); } finally { held = false; }
    }
  } as unknown as LockManager;
}

test("only one tab holds the event poll lease until it releases it", async () => {
  const locks = fakeLocks();
  const first = new EventPollLease(locks);
  const second = new EventPollLease(locks);
  assert.equal(await first.acquire(), true);
  assert.equal(await first.acquire(), true);
  assert.equal(await second.acquire(), false);
  assert.equal(second.held, false);
  first.releaseLease();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.held, false);
  assert.equal(await second.acquire(), true);
  assert.equal(await first.acquire(), false);
});
