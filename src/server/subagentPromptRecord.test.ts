import assert from "node:assert/strict";
import test from "node:test";
import { resolveSubagentPromptTarget, SubagentPromptReminder, subagentPromptRecord } from "./subagentPromptRecord";

test("native task-name-only spawn results resolve to the matching child, rejecting ambiguity", () => {
  const item = { itemType: "subagent", tool: "activity", label: "/root/check", receiverThreadIds: ["child"] };
  assert.equal(resolveSubagentPromptTarget({ taskName: "/root/check" }, [item]), "child");
  assert.equal(resolveSubagentPromptTarget({ threadId: "child" }, []), "child");
  assert.throws(() => resolveSubagentPromptTarget({ taskName: "/root/missing" }, [item]), /not found/);
  assert.throws(() => resolveSubagentPromptTarget({ taskName: "/root/check" }, [item, { ...item, receiverThreadIds: ["other"] }]), /ambiguous/);
});

test("native child-start events trigger one prompt reminder on the owning root only", async () => {
  const reminder = new SubagentPromptReminder();
  const messages: string[] = [];
  const inject = async (text: string) => { messages.push(text); };
  const item = { ...subagentPromptRecord({ threadId: "child", kind: "spawn", prompt: "task" }),
    itemType: "subagent" as const, tool: "activity", status: "started", label: "/root/check", originThreadId: "root", prompt: undefined };
  await reminder.observe({ ...item, originThreadId: "child" }, "root", inject);
  await reminder.observe({ ...item, prompt: "already captured" }, "root", inject);
  await reminder.observe(item, "root", inject);
  await reminder.observe(item, "root", inject);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /"threadId":"child"/);
  assert.match(messages[0], /record_subagent_prompt/);
});

test("a failed native reminder delivery can retry", async () => {
  const reminder = new SubagentPromptReminder();
  const item = { ...subagentPromptRecord({ threadId: "child", kind: "spawn", prompt: "task" }),
    itemType: "subagent" as const, tool: "activity", status: "started", originThreadId: "root", prompt: undefined };
  await assert.rejects(reminder.observe(item, "root", async () => { throw new Error("offline"); }));
  let delivered = false;
  await reminder.observe(item, "root", async () => { delivered = true; });
  assert.equal(delivered, true);
});
import { normalizeSubagentTranscript } from "./subagentTranscript";

test("recording preserves exact multilingual text and retries use the same ID", () => {
  const input = { threadId: "child", kind: "spawn", prompt: "  檢查 `src/main.ts`\n唔好修改。\n" };
  const record = subagentPromptRecord(input);
  assert.equal(record.id, subagentPromptRecord(input).id);
  assert.equal(record.itemType === "subagent" && record.prompt, input.prompt);
  const result = normalizeSubagentTranscript({ sessionId: "session", threadId: "child",
    threadReadResult: { thread: { id: "child", forkedFromId: "parent", turns: [] } },
    liveItemsByTurn: { parent: [record, subagentPromptRecord({ ...input, threadId: "other", prompt: "wrong child" })] } });
  assert.equal(result.delegatedPrompt, input.prompt);
});

test("recording rejects empty, oversized and invalid identifiers", () => {
  for (const input of [null, {}, { threadId: "../child", kind: "spawn", prompt: "text" },
    { threadId: "child", kind: "spawn", prompt: " " },
    { threadId: "child", kind: "spawn", prompt: "x".repeat(64001) }]) {
    assert.throws(() => subagentPromptRecord(input));
  }
});
