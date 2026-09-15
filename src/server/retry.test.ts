import assert from "node:assert/strict";
import test from "node:test";
import { runWithSingleRetry } from "./retry.js";

test("single retry recovers a transient helper failure", async () => {
  let calls = 0;
  const result = await runWithSingleRetry(async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary app-server exit");
    return "semantic headline";
  });
  assert.equal(result, "semantic headline");
  assert.equal(calls, 2);
});

test("single retry preserves a repeated helper failure", async () => {
  let calls = 0;
  await assert.rejects(
    runWithSingleRetry(async () => {
      calls += 1;
      throw new Error("unavailable");
    }),
    /unavailable/
  );
  assert.equal(calls, 2);
});
