import assert from "node:assert/strict";
import test from "node:test";
import { resolveSessionWorkspace } from "./sessionWorkspace";

const workspaces = new Map([
  ["default", { id: "default", codexHome: "/codex/default" }],
  ["threadex", { id: "threadex", codexHome: "/codex/threadex" }]
]);

async function resolve(input: { requestedWorkspaceId?: unknown; sessionWorkspaceId?: string | null }) {
  return resolveSessionWorkspace({
    requestedWorkspaceId: input.requestedWorkspaceId,
    sessionWorkspaceId: input.sessionWorkspaceId,
    getWorkspace: async (id) => workspaces.get(id) ?? null,
    getActiveWorkspace: async () => workspaces.get("threadex")!
  });
}

test("an existing session workspace overrides a stale requested workspace", async () => {
  const workspace = await resolve({
    requestedWorkspaceId: "threadex",
    sessionWorkspaceId: "default"
  });

  assert.equal(workspace.id, "default");
  assert.equal(workspace.codexHome, "/codex/default");
});

test("a new session uses its explicitly requested workspace", async () => {
  assert.equal((await resolve({ requestedWorkspaceId: "default" })).id, "default");
});

test("a session with a missing owning workspace fails instead of using another Codex home", async () => {
  await assert.rejects(
    resolve({ requestedWorkspaceId: "default", sessionWorkspaceId: "missing" }),
    /Workspace not found: missing/
  );
});

test("an unscoped new session falls back to the active workspace", async () => {
  assert.equal((await resolve({})).id, "threadex");
});
