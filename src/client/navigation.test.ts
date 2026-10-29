import assert from "node:assert/strict";
import test from "node:test";
import { hasNavigationTarget, navigationUrl, readNavigationTarget, workspaceManagerSessionUrl } from "./navigation";

test("manager navigation does not carry its entry flag into an ordinary session", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { origin: "http://localhost" } } as Window & typeof globalThis;
  try {
    const href = "http://localhost/?workspaceId=a&sessionId=tx_manager_a&view=workspace-chat";
    assert.equal(navigationUrl({ workspaceId: "a", sessionId: "ordinary" }, href), "/?workspaceId=a&sessionId=ordinary");
    assert.doesNotMatch(navigationUrl({ workspaceId: "a", sessionId: "tx_manager_a" }, "http://localhost/"), /view=workspace-chat/);
    assert.match(navigationUrl({ workspaceId: "a", sessionId: "any-session-id", view: "workspace-chat" }, "http://localhost/"), /view=workspace-chat/);
    assert.match(navigationUrl({ workspaceId: "a", sessionId: null, view: "workspace-chat" }, "http://localhost/"), /view=workspace-chat/);
  } finally { globalThis.window = previousWindow; }
});

test("manager raw and return links keep the same session id and ordinary navigation stays ordinary", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { origin: "http://localhost" } } as Window & typeof globalThis;
  try {
    const manager = { workspaceId: "a", sessionId: "tx_manager_a" };
    const managerUrl = "http://localhost/?workspaceId=a&sessionId=tx_manager_a&view=workspace-chat";
    const rawUrl = workspaceManagerSessionUrl(manager, "raw", managerUrl);
    assert.equal(rawUrl, "/?workspaceId=a&sessionId=tx_manager_a");
    assert.equal(workspaceManagerSessionUrl(manager, "manager", `http://localhost${rawUrl}`),
      "/?workspaceId=a&sessionId=tx_manager_a#view=workspace-chat");
    assert.equal(navigationUrl({ workspaceId: "a", sessionId: "ordinary" }, managerUrl),
      "/?workspaceId=a&sessionId=ordinary");
  } finally { globalThis.window = previousWindow; }
});

test("actor view round-trips its actor id and is never emitted without one", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { origin: "http://localhost" } } as Window & typeof globalThis;
  try {
    const actorUrl = "http://localhost/?workspaceId=a&view=actor&actorId=root-1";
    const target = readNavigationTarget(actorUrl);
    assert.deepEqual(target, { workspaceId: "a", sessionId: null, view: "actor", actorId: "root-1" });
    const serialized = navigationUrl(target, "http://localhost/?workspaceId=a&sessionId=old");
    assert.equal(serialized, "/?workspaceId=a&view=actor&actorId=root-1");
    assert.deepEqual(readNavigationTarget(`http://localhost${serialized}`), target);
    assert.equal(hasNavigationTarget("http://localhost/?view=actor&actorId=root-1"), true);

    assert.equal(navigationUrl({ workspaceId: "a", sessionId: null, view: "actor", actorId: null }, actorUrl), "/?workspaceId=a");
    assert.equal(navigationUrl({ workspaceId: "a", sessionId: null, view: "actor", actorId: "  " }, actorUrl), "/?workspaceId=a");
    assert.equal(navigationUrl({ workspaceId: "a", sessionId: "ordinary" }, actorUrl), "/?workspaceId=a&sessionId=ordinary");
    assert.equal(navigationUrl({ workspaceId: "a", sessionId: null, view: "workspace-chat", actorId: "root-1" }, actorUrl),
      "/?workspaceId=a#view=workspace-chat");
    assert.equal(readNavigationTarget("http://localhost/?workspaceId=a&view=actor").view, undefined);
    assert.equal(hasNavigationTarget("http://localhost/?view=actor"), false);
  } finally { globalThis.window = previousWindow; }
});

test("group chat hash composes with session deep links and migrates legacy entries", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { origin: "http://localhost" } } as Window & typeof globalThis;
  try {
    const target = { workspaceId: "a", sessionId: "task", turnId: "turn-2", groupChat: true };
    const href = navigationUrl(target, "http://localhost/?view=workspace-chat&unrelated=1#other=kept");
    assert.equal(href, "/?unrelated=1&workspaceId=a&sessionId=task&turnId=turn-2#other=kept&view=workspace-chat");
    assert.deepEqual(readNavigationTarget(`http://localhost${href}`), target);
    assert.deepEqual(readNavigationTarget("http://localhost/?workspaceId=a&view=workspace-chat"),
      { workspaceId: "a", sessionId: null, view: "workspace-chat", groupChat: true });
    assert.equal(navigationUrl({ workspaceId: "a", sessionId: "task" }, `http://localhost${href}`),
      "/?unrelated=1&workspaceId=a&sessionId=task#other=kept");
    assert.equal(hasNavigationTarget("http://localhost/#view=workspace-chat"), true);
  } finally { globalThis.window = previousWindow; }
});

test("project group chat key stays in the hash with a session and is dropped outside the group chat", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { origin: "http://localhost" } } as Window & typeof globalThis;
  try {
    const chatUrl = navigationUrl({ workspaceId: "a", sessionId: null, view: "workspace-chat", chat: "proj-1" }, "http://localhost/");
    assert.equal(chatUrl, "/?workspaceId=a#view=workspace-chat&chat=proj-1");
    assert.deepEqual(readNavigationTarget(`http://localhost${chatUrl}`),
      { workspaceId: "a", sessionId: null, view: "workspace-chat", groupChat: true, chat: "proj-1" });
    // A session opened beside the chat keeps the chat key unless told otherwise.
    const stacked = navigationUrl({ workspaceId: "a", sessionId: "task", groupChat: true }, `http://localhost${chatUrl}`);
    assert.equal(stacked, "/?workspaceId=a&sessionId=task#view=workspace-chat&chat=proj-1");
    assert.deepEqual(readNavigationTarget(`http://localhost${stacked}`), { workspaceId: "a", sessionId: "task", groupChat: true, chat: "proj-1" });
    assert.equal(navigationUrl({ workspaceId: "a", sessionId: null, view: "workspace-chat", chat: "unassigned" }, `http://localhost${stacked}`),
      "/?workspaceId=a#view=workspace-chat&chat=unassigned");
    assert.equal(navigationUrl({ workspaceId: "a", sessionId: "task" }, `http://localhost${stacked}`), "/?workspaceId=a&sessionId=task");
    // The chat key alone is not a group chat.
    assert.deepEqual(readNavigationTarget("http://localhost/?workspaceId=a#chat=proj-1"), { workspaceId: "a", sessionId: null });
  } finally { globalThis.window = previousWindow; }
});
