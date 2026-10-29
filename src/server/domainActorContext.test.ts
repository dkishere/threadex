import assert from "node:assert/strict";
import test from "node:test";
import { actorCanonicalUserMessages, actorConversationHistory, actorExecutionMessage, actorForTaskContext, actorInputBudget, actorMemorySlice, actorModelContextWindow, actorRoomSourceNote, actorTaskTitle, boundedActorContext, CLAUDE_MIN_CONTEXT_WINDOW_TOKENS } from "./domainActorContext";
import { actorRoutingPrompt, splitActorPromptPageContext, type ActorRoom, type ActorWorkItem, type DomainActor } from "../domainActors";

test("actor admission window uses live observed usage, then the Claude floor, else unknown", async () => {
  const observed = { getModelContextWindow: async (model: string) => model === "gpt-6-luna" ? 258_400 : null };
  assert.equal(await actorModelContextWindow(observed, "gpt-6-luna"), 258_400);
  // Claude runs never report a window; a request with two Browser Bridge attachments must still be admitted.
  const claudeWindow = await actorModelContextWindow(observed, "claude-opus-5-5");
  assert.equal(claudeWindow, CLAUDE_MIN_CONTEXT_WINDOW_TOKENS);
  assert.equal(await actorModelContextWindow({}, "claude-haiku-5-5"), CLAUDE_MIN_CONTEXT_WINDOW_TOKENS);
  assert.equal(await actorModelContextWindow(observed, "gpt-5.4-mini"), null);
  assert.equal(await actorModelContextWindow(observed, undefined), null);
  const memory = { rolePrompt: "", roleSummary: "", longTerm: "", rolling: "" };
  const userPrompt = `處理呢兩個問題\n${JSON.stringify({ kind: "browser-bridge-context", data: "x".repeat(10_300) })}\n${JSON.stringify({ kind: "browser-bridge-context", data: "y".repeat(10_400) })}`;
  const instructionsBytes = 8_000;
  assert.throws(() => boundedActorContext({ userPrompt, memory, runningSessions: [], modelContextWindow: null, additionalPromptBytes: instructionsBytes }), /admission budget/);
  assert.equal(boundedActorContext({ userPrompt, memory, runningSessions: [], modelContextWindow: claudeWindow, additionalPromptBytes: instructionsBytes }).userPrompt, userPrompt);
});

test("actor task title is one short line without actor name or id prefixes", () => {
  const labels = ["對話紀錄與知識檢索", "threadex-transcript-knowledge"];
  assert.equal(actorTaskTitle("  Actor 決定\n session title  ", labels), "Actor 決定 session title");
  assert.equal(actorTaskTitle("對話紀錄與知識檢索：Claim 時決定 title", labels), "Claim 時決定 title");
  assert.equal(actorTaskTitle("[threadex-transcript-knowledge] 停止 summariser 改名", labels), "停止 summariser 改名");
  assert.equal(actorTaskTitle("「THREADEX-TRANSCRIPT-KNOWLEDGE actor: Fix title」", labels), "Fix title");
  assert.equal(actorTaskTitle("Summariser 跳過 actor title", labels), "Summariser 跳過 actor title", "a label only names a prefix when followed by a separator");
  assert.equal(actorTaskTitle("x".repeat(80), labels), `${"x".repeat(45)}...`);
  for (const invalid of [undefined, null, 42, "   ", "對話紀錄與知識檢索："]) assert.equal(actorTaskTitle(invalid, labels), undefined);
});

test("execution message shows the actor brief and verbatim original request with explicit legacy compatibility", () => {
  const original = "  按之前決定實作。\n保留空格  ";
  const brief = "按既有 API schema 新增查詢，保留錯誤格式，完成後驗證。";
  const message = actorExecutionMessage(original, { preparedPrompt: brief });
  assert.ok(message.includes(`Original user request (canonical authorization):\n${original}\n\n`));
  assert.ok(message.endsWith(`Actor-prepared execution brief:\n${brief}`));
  assert.match(actorExecutionMessage(original, {}), /Legacy task: no actor-prepared execution brief was saved/);
  assert.ok(actorExecutionMessage(original, {}).includes(original));
  assert.ok(actorExecutionMessage(original, { preparedPrompt: brief, delegatedTask: "只做查詢 API" }).endsWith("Actor-prepared execution brief (assigned portion only):\n只做查詢 API"));
});

test("Actors room source note names the group chat and adds a bounded excerpt of earlier visible rounds", () => {
  const actors = [{ id: "planner", name: "threadex-session-planning" }, { id: "ui", name: "threadex-ui" }];
  const rounds = [
    { id: "r0", namedActorIds: [], status: "assigned", userPrompt: "Oldest group request", replies: [] },
    { id: "r1", namedActorIds: ["planner"], status: "assigned", userPrompt: "PRIVATE planner chat", replies: [] },
    { id: "r2", namedActorIds: [], status: "routing_failed", userPrompt: "調查 fork 失敗", error: "Actors group chat 讀取失敗",
      replies: [{ actorId: "planner", status: "claimed", text: `Claimed ${"x".repeat(600)}` }, { actorId: "ui", status: "error", text: "", error: "Reply failed." },
        { actorId: "other", status: "opinion", text: "Third" }] },
    { id: "r3", namedActorIds: [], status: "no_claims", userPrompt: "Second group request", replies: [] },
    { id: "r4", namedActorIds: [], status: "queued", userPrompt: "上面又出現actors 係group chat 讀取失敗", replies: [] }
  ];
  const room = { workspaceId: "ws", actors, rounds } as unknown as ActorRoom;
  const note = actorRoomSourceNote(room, "r4", "planner")!;
  const [header] = note.split("\n");
  assert.equal(header, "[Threadex Actors room message] Source: Actors group chat (workspace ws; round r4). Sender: the user.");
  assert.match(note, /queued onto this existing task as a follow-up\. It is quoted verbatim\./);
  assert.ok(note.indexOf("- User: 調查 fork 失敗") < note.indexOf("- User: Second group request"), "oldest first");
  assert.match(note, /threadex-session-planning: Claimed x+…/); assert.match(note, /threadex-ui: \[error\] Reply failed\./);
  assert.match(note, /\(\+1 more replies\)/); assert.match(note, /\[round error\] Actors group chat 讀取失敗/);
  assert.doesNotMatch(note, /Oldest group request|PRIVATE planner chat|上面又出現|Third/);
  assert.ok(note.length < 1600, "the excerpt stays bounded");
  assert.match(actorRoomSourceNote({ ...room, rounds: [room.rounds[1]] }, "r1", "planner")!, /Source: Actors individual chat with threadex-session-planning[\s\S]*No earlier Actors individual chat with threadex-session-planning messages/);
  assert.equal(actorRoomSourceNote(room, "missing", "planner"), undefined);
});

test("room history includes other roots for two rounds, keeps self and excludes current, future and unfinished replies", () => {
  const rounds = Array.from({ length: 6 }, (_, index) => ({ id: String(index), status: "no_claims", userPrompt: `Question ${index}`,
    replies: ["self", "other-root"].map(actorId => ({ actorId, status: "opinion", text: `${actorId}:${index}` })) }));
  rounds[1].status = "responding";
  const history = actorConversationHistory({ rounds } as ActorRoom, "4", "self");
  assert.deepEqual(history.filter(row => row.actorId === "self").map(row => row.roundId), ["3", "2", "0"]);
  assert.deepEqual(history.filter(row => row.actorId === "other-root").map(row => row.roundId), ["3", "2"]);
  assert.ok(history.every(row => row.userPrompt === `Question ${row.roundId}`));
  assert.deepEqual(actorConversationHistory({ rounds } as ActorRoom, "absent", "self"), []);
  const persisted = { rounds } as ActorRoom;
  persisted.rounds[4].contextRoundIds = ["0", "2", "3"];
  rounds[1].status = "no_claims";
  assert.deepEqual(actorConversationHistory(persisted, "4", "self"), history, "a prior concurrent turn completing later cannot alter replay context");
});

test("room history keeps failed replies with their error so actors can explain them", () => {
  const rounds = [
    { id: "0", status: "no_claims", userPrompt: "咁做啦", replies: [{ actorId: "self", status: "error", text: "", error: "Stakeholder response failed: Invalid actor executor." }] },
    { id: "1", status: "no_claims", userPrompt: "Slow", replies: [{ actorId: "self", status: "timeout", text: "" }] },
    { id: "2", status: "responding", userPrompt: "Stakeholder response failed??", replies: [] }
  ];
  assert.deepEqual(actorConversationHistory({ rounds } as ActorRoom, "2", "self").map(row => [row.roundId, row.error]), [
    ["1", "No reply before the deadline."], ["0", "Stakeholder response failed: Invalid actor executor."]]);
});

test("routing sees the user's words with Browser Bridge JSON reduced to a page note", () => {
  const page = { kind: "browser-bridge-context", tabId: 1, url: "http://localhost:5173/?view=workspace-chat", title: "Threadex", selector: "p.x", "react-components": [{ name: "a}\"b" }] };
  const split = splitActorPromptPageContext(`${JSON.stringify(page)}\n\n佢要可以加sub actors`);
  assert.deepEqual(split, { page: { url: page.url, title: "Threadex", selector: "p.x" }, text: "佢要可以加sub actors" });
  assert.equal(actorRoutingPrompt(`${JSON.stringify(page)}\n\n佢要可以加sub actors`),
    "佢要可以加sub actors\n\n[Attached page context only, not the request topic: Threadex · http://localhost:5173/?view=workspace-chat · p.x]");
  for (const prompt of ["plain request", "{\"kind\":\"other\",\"url\":\"x\"} text", "{not json"]) assert.equal(actorRoutingPrompt(prompt), prompt);
});

function isolationRoom() {
  const actors = [
    { id: "x", rootActorId: "x", parentActorId: null },
    { id: "x-sub", rootActorId: "x", parentActorId: "x" },
    { id: "y", rootActorId: "y", parentActorId: null }
  ] as DomainActor[];
  const reply = (actorId: string, roundId: string) => ({ actorId, status: "opinion", text: `${actorId}:${roundId}` });
  const rounds = [
    { id: "g1", status: "no_claims", userPrompt: "Group 1", namedActorIds: [], replies: [reply("x", "g1"), reply("y", "g1")] },
    { id: "ix", status: "no_claims", userPrompt: "Private to X", namedActorIds: ["x"], replies: [reply("x", "ix"), reply("x-sub", "ix")] },
    { id: "iy", status: "no_claims", userPrompt: "Private to Y", namedActorIds: ["y"], replies: [reply("y", "iy")] },
    { id: "g2", status: "no_claims", userPrompt: "Group 2", namedActorIds: ["x", "y"], replies: [reply("x", "g2"), reply("y", "g2")] },
    { id: "cur-x", status: "responding", userPrompt: "Now X only", namedActorIds: ["x"], replies: [] },
    { id: "cur-g", status: "responding", userPrompt: "Now everyone", namedActorIds: [], replies: [] }
  ];
  return { actors, rounds } as unknown as ActorRoom;
}

test("an individual round is hidden from other trees in their group history", () => {
  const history = actorConversationHistory(isolationRoom(), "cur-g", "y");
  assert.equal(history.some(row => row.roundId === "ix"), false, "Y never sees X's individual round");
  assert.deepEqual(history.map(row => `${row.actorId}@${row.roundId}`), ["x@g2", "y@g2", "y@iy", "x@g1", "y@g1"]);
});

test("a current individual round only replays its own tree, excluding peer replies even from group rounds", () => {
  const history = actorConversationHistory(isolationRoom(), "cur-x", "x");
  assert.deepEqual(history.map(row => `${row.actorId}@${row.roundId}`), ["x@g2", "x@ix", "x-sub@ix", "x@g1"]);
  assert.equal(history.some(row => row.actorId === "y"), false);
});

test("a sub-actor executing in its root tree sees that root's individual rounds", () => {
  const groupHistory = actorConversationHistory(isolationRoom(), "cur-g", "x-sub");
  assert.ok(groupHistory.some(row => row.roundId === "ix" && row.actorId === "x"));
  assert.equal(groupHistory.some(row => row.roundId === "iy"), false);
  const privateHistory = actorConversationHistory(isolationRoom(), "cur-x", "x-sub");
  assert.deepEqual(privateHistory.map(row => `${row.actorId}@${row.roundId}`), ["x@g2", "x@ix", "x-sub@ix", "x@g1"]);
});

test("tree membership falls back to round snapshots and then treats unknown actors as their own root", () => {
  const room = isolationRoom();
  const snapshotOnly = { id: "z-sub", rootActorId: "z", parentActorId: "z" } as DomainActor;
  room.rounds.splice(0, 0, { id: "iz", status: "no_claims", userPrompt: "Private to Z's sub", namedActorIds: ["z-sub"], actorSnapshots: [snapshotOnly],
    replies: [{ actorId: "z-sub", status: "opinion", text: "z-sub:iz" }] } as unknown as ActorRoom["rounds"][number]);
  assert.equal(actorConversationHistory(room, "cur-g", "x").some(row => row.roundId === "iz"), false);
  assert.ok(actorConversationHistory(room, "cur-g", "z").some(row => row.roundId === "iz" && row.actorId === "z-sub"));
});

test("execution message preserves A then B then A corrections and omits only the first displayed original copy", () => {
  const message = actorExecutionMessage("A", { preparedPrompt: "Execute the latest instruction", canonicalUserMessages: ["A", "B", "A"] });
  assert.equal(message, "Original user request (canonical authorization):\nA\n\nAdditional original user instruction (canonical authorization):\nB\n\nAdditional original user instruction (canonical authorization):\nA\n\nActor-prepared execution brief:\nExecute the latest instruction");
  const withoutInitialCopy = actorExecutionMessage("A", { preparedPrompt: "Execute", canonicalUserMessages: ["B", "A"] });
  assert.ok(withoutInitialCopy.startsWith("Original user request (canonical authorization):\nB\n\nAdditional original user instruction (canonical authorization):\nA\n\nActor-prepared"));
});

test("canonical user context keeps only actor-selected visible rounds once in chronological order", () => {
  const room = isolationRoom();
  assert.deepEqual(actorCanonicalUserMessages(room, "cur-x", "x"), ["Now X only"], "unselected history is never stuffed into the task");
  assert.deepEqual(actorCanonicalUserMessages(room, "cur-x", "x", ["g2", "iy", "g1", "g2", "cur-g"]), ["Group 1", "Group 2", "Now X only"],
    "a private peer round or a later round cannot be promoted by selection");
  const message = actorExecutionMessage("Now X only", { canonicalUserMessages: actorCanonicalUserMessages(room, "cur-x", "x", ["g1"]), preparedPrompt: "Continue" });
  assert.ok(message.indexOf("Group 1") < message.indexOf("Now X only"));
  assert.equal(message.includes("Private to Y"), false);
});

test("conversation admission preserves whole recent turns, restores chronological order and reports the window boundary", () => {
  const entries = Array.from({ length: 8 }, (_, i) => ({ roundId: String(8 - i), actorId: "self", userPrompt: "問".repeat(400), text: "答".repeat(800) }));
  const context = boundedActorContext({ userPrompt: "Current", memory: { rolePrompt: "", roleSummary: "", longTerm: "", rolling: "" },
    runningSessions: [], conversationHistory: entries, modelContextWindow: 32000 });
  assert.ok(context.conversationHistory.length > 0 && context.omittedConversationHistory > 0);
  assert.deepEqual(context.conversationHistory, entries.slice(0, context.conversationHistory.length).reverse());
  assert.equal(context.conversationHistory.length + context.omittedConversationHistory, entries.length);
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= actorInputBudget(32000));
});

test("initial actor execution uses the frozen round role while follow-up turns load live memory", () => {
  const frozen = { id: "actor", memory: { rolePrompt: "Original role", roleSummary: "Original summary", version: 0 } } as unknown as DomainActor;
  const live = { ...frozen, memory: { ...frozen.memory, rolePrompt: "Updated role", roleSummary: "Updated summary", version: 1 } };
  const room = { rounds: [{ id: "round", actorSnapshots: [frozen] }] } as unknown as ActorRoom;
  const work = { roundId: "round" } as ActorWorkItem;
  assert.equal(actorForTaskContext(room, work, { taskTurnId: "initial" }, live, "initial"), frozen);
  assert.equal(actorForTaskContext(room, work, { taskTurnId: "initial" }, live, "followup"), live);
  const newlyCreatedSub = { ...live, id: "new-sub" };
  assert.equal(actorForTaskContext(room, work, { taskTurnId: "delegated" }, newlyCreatedSub, "delegated"), newlyCreatedSub);
});

test("actor context bounds large stored memory without truncating the canonical user prompt", () => {
  const userPrompt = "保留原句 verbatim\n  ";
  const memory = { rolePrompt: "角色".repeat(20_000), roleSummary: "摘要", longTerm: "knowledge".repeat(20_000), rolling: "recent".repeat(20_000) };
  const context = boundedActorContext({ userPrompt, memory, modelContextWindow: 16_384, runningSessions: Array.from({ length: 1000 }, (_, i) => ({ actorId: "actor", sessionId: `session-${i}`, turnId: `turn-${i}`, workItemId: `work-${i}`, status: "running" })) });
  assert.equal(context.userPrompt, userPrompt);
  assert.equal(context.memoryTruncated, true);
  assert.ok(context.omittedRunningSessions > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= actorInputBudget(16_384));
  assert.equal(memory.longTerm.length, 180_000);
});

test("actor memory can select another UTF-8 range and an oversized original request fails explicitly", () => {
  const selected = actorMemorySlice("0123繁體中文", 4, 6);
  assert.equal(selected.text, "繁體"); assert.equal(selected.nextOffset, 6);
  assert.ok(Buffer.byteLength(selected.text) <= 6);
  assert.throws(() => boundedActorContext({ userPrompt: "x".repeat(20_000), memory: { rolePrompt: "", roleSummary: "", longTerm: "", rolling: "" },
    modelContextWindow: 16_384, runningSessions: [] }), /canonical actor request exceeds/);
});
test("optional reserve never rejects a canonical request that fits the budget", () => {
  const memory = { rolePrompt: "r".repeat(500), roleSummary: "s", longTerm: "l", rolling: "g" };
  const window = 2 * (4096 + 4000);
  const userPrompt = "我".repeat(1200);
  const plain = boundedActorContext({ userPrompt, memory, runningSessions: [], modelContextWindow: window });
  const reserved = boundedActorContext({ userPrompt, memory, runningSessions: [], modelContextWindow: window, optionalReserveBytes: 3072 });
  assert.equal(reserved.userPrompt, userPrompt);
  assert.ok(Buffer.byteLength(JSON.stringify(reserved)) <= Buffer.byteLength(JSON.stringify(plain)));
  assert.throws(() => boundedActorContext({ userPrompt: userPrompt.repeat(3), memory, runningSessions: [], modelContextWindow: window, optionalReserveBytes: 3072 }), /canonical actor request/);
});
