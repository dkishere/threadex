import assert from "node:assert/strict";
import test from "node:test";
import { navigationUrl } from "./navigation";

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
