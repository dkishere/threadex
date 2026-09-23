import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionStore } from "./sessionStore";

test("side-chat history is scoped, bounded, and does not inspect the transcript", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "side-chat-history-"));
  const store = new SessionStore(join(root, "test.postgres"));
  try {
    await store.ready();
    await store.upsertSession({ id: "one", workspaceId: "default", cwd: root, title: "One" });
    await store.upsertSession({ id: "two", workspaceId: "default", cwd: root, title: "Two" });
    t.mock.method(store, "inspectSession", async () => { throw new Error("History must not inspect turns"); });
    assert.equal(await store.listSessionSideChats("missing"), null);
    assert.deepEqual((await store.listSessionSideChats("one"))?.sideChats, []);
    for (let index = 0; index < 101; index++) {
      await store.recordSessionSideChat({ id: `chat-${String(index).padStart(3, "0")}`, sessionId: "one", workspaceId: "default", question: `Question ${index}`, answer: `Answer ${index}`, model: "fixture" });
    }
    await store.recordSessionSideChat({ sessionId: "two", workspaceId: "default", question: "Other", answer: "Other", model: "fixture" });
    const page = await store.listSessionSideChats("one");
    assert.equal(page?.sideChats.length, 100);
    assert.equal(page?.sideChats[0].question, "Question 0");
    assert.equal(page?.sideChats.at(-1)?.question, "Question 99");
    assert.ok(page?.sideChats.every(chat => chat.sessionId === "one"));
    assert.deepEqual(page?.sideChatPage, { offset: 0, limit: 100, total: 101, hasMore: true });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
