import assert from "node:assert/strict";
import test from "node:test";
import { navigationUrl, workspaceManagerSessionUrl } from "./navigation";

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
      "/?workspaceId=a&sessionId=tx_manager_a&view=workspace-chat");
    assert.equal(navigationUrl({ workspaceId: "a", sessionId: "ordinary" }, managerUrl),
      "/?workspaceId=a&sessionId=ordinary");
  } finally { globalThis.window = previousWindow; }
});
