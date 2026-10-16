import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { claudeSandboxOptions, claudeToolBoundary } from "./claudeSandbox";

test("file edits resolve symlinks and protect agent state even inside an allowed temp root", () => {
  const root = mkdtempSync(resolve(tmpdir(), "claude-boundary-"));
  const cwd = resolve(root, "project");
  const privateHome = resolve(root, "claude-home");
  mkdirSync(cwd); mkdirSync(privateHome);
  symlinkSync(privateHome, resolve(cwd, "alias"));
  symlinkSync("/etc", resolve(cwd, "escape"));
  const check = (path: string) => claudeToolBoundary({ cwd, mode: "workspace-write", tool: "Edit", args: { file_path: path }, protectedPaths: [privateHome] });
  try {
    assert.equal(check("src/new.ts"), null);
    assert.match(check("alias/new/file.ts")!, /protected/);
    assert.match(check("escape/new/file.ts")!, /outside/);
    assert.match(check(".git/config")!, /protected/);
    assert.match(check("/etc/new-file")!, /outside/);
    assert.equal(claudeToolBoundary({ cwd, mode: "danger-full-access", tool: "Edit", args: { file_path: "/etc/new-file" } }), null);
    assert.match(claudeToolBoundary({ cwd, mode: "read-only", tool: "Bash", args: { command: "touch x" } })!, /read-only/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("restricted turns fail closed and full access must be explicit", () => {
  const options = claudeSandboxOptions("workspace-write", "/repo", ["/state"]);
  assert.ok("failIfUnavailable" in options.sandbox);
  assert.equal(options.sandbox.enabled, true);
  assert.equal(options.sandbox.failIfUnavailable, true);
  assert.equal(options.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(options.sandbox.network?.deniedDomains, ["*"]);
  assert.equal(options.managedSettings?.sandbox.network.allowManagedDomainsOnly, true);
  assert.ok(options.sandbox.filesystem?.denyWrite.includes("/state"));
  assert.deepEqual(claudeSandboxOptions("danger-full-access", "/repo"), { sandbox: { enabled: false } });
});

test("only writable turns may use loopback", () => {
  const writable = claudeSandboxOptions("workspace-write", "/repo").sandbox;
  const readOnly = claudeSandboxOptions("read-only", "/repo").sandbox;
  assert.ok("network" in writable && "network" in readOnly);
  assert.equal(writable.network.allowLocalBinding, true);
  assert.equal(readOnly.network.allowLocalBinding, false);
});

test("only writable turns share the uv cache and the Docker socket", () => {
  const writable = claudeSandboxOptions("workspace-write", "/repo").sandbox;
  const readOnly = claudeSandboxOptions("read-only", "/repo").sandbox;
  assert.ok("network" in writable && "network" in readOnly);
  assert.ok(writable.network.allowUnixSockets.includes("/var/run/docker.sock"));
  assert.ok(writable.filesystem.allowWrite.some(path => path.endsWith("uv")));
  assert.deepEqual(readOnly.network.allowUnixSockets, []);
  assert.deepEqual(readOnly.filesystem.allowWrite, []);
});
