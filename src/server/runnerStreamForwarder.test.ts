import assert from "node:assert/strict";
import test from "node:test";
import { RunnerStreamForwarder } from "./runnerStreamForwarder";

type Entry = { event: string; text: string; itemId?: string; origin?: string; annotated?: boolean };
const itemKey = (entry: Entry) => entry.itemId ? `${entry.origin ?? ""}:${entry.itemId}` : null;
const isTerminal = (entry: Entry) => ["result", "done", "error", "pending"].includes(entry.event);

test("conclusion text keeps streaming across polls while persistence is blocked", async () => {
  let releasePersistence!: () => void;
  const persistenceGate = new Promise<void>((resolve) => { releasePersistence = resolve; });
  const sent: string[] = [];
  const applied: string[] = [];
  const stream = new RunnerStreamForwarder<Entry>({
    itemKey, isTerminal,
    apply: async (entry) => { await persistenceGate; applied.push(entry.text); },
    emit: (entry) => sent.push(entry.text)
  });
  const first = { event: "item", itemId: "answer", text: "First" };
  const second = { ...first, text: "First, second" };
  await stream.forward([first]);
  await stream.forward([second]);
  assert.deepEqual(sent, [first.text, second.text]);
  assert.deepEqual(applied, []);

  const completion = stream.forward([{ event: "result", text: "Finished" }]);
  assert.deepEqual(sent, [first.text, second.text], "completion must wait for persistence");
  releasePersistence();
  await completion;
  assert.deepEqual(applied, [first.text, second.text, "Finished"]);
  assert.deepEqual(sent, applied);
});

test("replay coalesces items by origin and persists every event in order", async () => {
  const entries: Entry[] = [
    { event: "item", itemId: "answer", text: "partial" },
    { event: "item", itemId: "answer", origin: "child", text: "child answer" },
    { event: "codex", text: "notification" },
    { event: "item", itemId: "answer", text: "complete answer" },
    { event: "done", text: "done" }
  ];
  const sent: Entry[] = [];
  const applied: Entry[] = [];
  const stream = new RunnerStreamForwarder<Entry>({
    itemKey, isTerminal,
    apply: async (entry) => { applied.push(entry); },
    emit: (entry) => { sent.push(entry); }
  });
  await stream.forward(entries);
  assert.deepEqual(applied, entries);
  assert.deepEqual(sent, [entries[3], entries[1], entries[2], entries[4]]);
});

test("terminal errors retain annotations applied before delivery", async () => {
  const stream = new RunnerStreamForwarder<Entry>({
    itemKey, isTerminal,
    apply: async (entry) => { entry.annotated = true; },
    emit: (entry) => assert.equal(entry.annotated, true)
  });
  await stream.forward([{ event: "error", text: "Login required" }]);
});

test("persistence failure cannot publish a successful terminal event", async () => {
  const sent: string[] = [];
  const stream = new RunnerStreamForwarder<Entry>({
    itemKey, isTerminal,
    apply: async () => { throw new Error("Database unavailable"); },
    emit: (entry) => sent.push(entry.event)
  });
  await assert.rejects(stream.forward([
    { event: "item", itemId: "answer", text: "partial" },
    { event: "result", text: "complete" }
  ]), /Database unavailable/);
  assert.deepEqual(sent, ["item"]);
  await assert.rejects(stream.flush(), /Database unavailable/);
});
