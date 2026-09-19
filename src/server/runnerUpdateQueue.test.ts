import assert from "node:assert/strict";
import test from "node:test";
import { RunnerUpdateQueue } from "./runnerUpdateQueue";

test("callback and repeated stream replay apply an event only once", async () => {
  const queue = new RunnerUpdateQueue();
  const applied: string[] = [];
  const deliver = (id: string) => queue.run(id, async () => { applied.push(id); });
  await Promise.all([deliver("start"), deliver("start"), deliver("item")]);
  for (let index = 0; index < 5000; index++) await deliver(`delta-${index}`);
  await Promise.all([deliver("start"), deliver("item"), deliver("result"), deliver("result")]);
  assert.equal(applied.length, 5003);
  assert.equal(applied.at(-1), "result");
});

test("failed updates can retry without blocking other turns", async () => {
  const queue = new RunnerUpdateQueue();
  await assert.rejects(queue.run("failed", async () => { throw new Error("DB unavailable"); }));
  const applied: string[] = [];
  await queue.run("other-turn", async () => { applied.push("other"); });
  await queue.run("failed", async () => { applied.push("retry"); });
  assert.deepEqual(applied, ["other", "retry"]);
});
