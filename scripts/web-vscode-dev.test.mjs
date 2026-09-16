import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  inspectWebVsCodeDevServer,
  isThreadexWebVsCodeCommand,
  prepareWebVsCodeDevLaunch,
  reclaimOrphanedWebVsCodeDevServer,
  resolveWebVsCodeDevLaunch
} from "./web-vscode-dev.mjs";

test("development Web VS Code uses the client supervisor data paths", () => {
  const launch = resolveWebVsCodeDevLaunch("/workspace/threadex", {
    SESSION_DATA_DIR: "/tmp/threadex-data",
    WEB_VSCODE_PORT: "9988",
    CODE_SERVER_COMMAND: "/custom/code-server"
  }, () => false);

  assert.equal(launch.enabled, true);
  assert.equal(launch.command, "/custom/code-server");
  assert.equal(launch.port, 9988);
  assert.deepEqual(launch.args.slice(0, 2), ["--bind-addr", "127.0.0.1:9988"]);
  assert.equal(launch.env.THREADEX_REVIEW_REQUEST_DIR, "/tmp/threadex-data/code-server/review-requests");
  assert.equal(launch.env.THREADEX_WALKTHROUGH_ACTION_DIR, "/tmp/threadex-data/code-server/walkthrough-actions");
  assert.equal(launch.env.THREADEX_WALKTHROUGH_RESULT_DIR, "/tmp/threadex-data/code-server/walkthrough-results");
});

test("development Web VS Code respects external and disabled configurations", () => {
  assert.deepEqual(
    resolveWebVsCodeDevLaunch("/workspace", { WEB_VSCODE_URL: "https://code.example" }),
    { enabled: false, reason: "WEB_VSCODE_URL is configured" }
  );
  assert.deepEqual(
    resolveWebVsCodeDevLaunch("/workspace", { WEB_VSCODE_AUTOSTART: "false" }),
    { enabled: false, reason: "WEB_VSCODE_AUTOSTART=false" }
  );
});

test("development startup installs the bundled review extension", () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-web-vscode-dev-"));
  const source = resolve(root, "extensions", "threadex-review");
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(resolve(source, "package.json"), "{}", "utf8");
    const launch = prepareWebVsCodeDevLaunch(root, {
      SESSION_DATA_DIR: resolve(root, "data"),
      CODE_SERVER_COMMAND: "/custom/code-server"
    });
    assert.equal(launch.enabled, true);
    const installed = resolve(launch.extensionsDir, "threadex.threadex-review-0.1.0-universal", "package.json");
    assert.equal(existsSync(installed), true);
    const registry = JSON.parse(readFileSync(resolve(launch.extensionsDir, "extensions.json"), "utf8"));
    assert.equal(registry.at(-1).identifier.id, "threadex.threadex-review");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("development startup resolves a Windows command shim for Node", () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(resolve(tmpdir(), "threadex-web-vscode-command-test-"));
  try {
    const launch = prepareWebVsCodeDevLaunch("/workspace/threadex", {
      ...process.env,
      SESSION_DATA_DIR: resolve(root, "data"),
      CODE_SERVER_COMMAND: "code-server"
    });
    assert.match(launch.command, /code-server\.(?:cmd|bat)$/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the bundled walkthrough keeps native comments inline by default", () => {
  const manifest = JSON.parse(readFileSync(resolve("extensions", "threadex-review", "package.json"), "utf8"));
  assert.equal(manifest.contributes?.configurationDefaults?.["comments.openView"], "never");
});

test("the review file diff action stays out of the tree row hover actions", () => {
  const manifest = JSON.parse(readFileSync(resolve("extensions", "threadex-review", "package.json"), "utf8"));
  const action = manifest.contributes?.menus?.["view/item/context"]?.find(
    (item) => item.command === "threadexReview.openDiff"
  );
  assert.ok(action);
  assert.doesNotMatch(action.group, /^inline(?:@|$)/);
});

test("only a fully matching Threadex code-server launcher is reclaimable", () => {
  const launch = resolveWebVsCodeDevLaunch("/workspace/threadex", {
    SESSION_DATA_DIR: "/tmp/threadex-data",
    WEB_VSCODE_PORT: "9988",
    CODE_SERVER_COMMAND: "/custom/code-server"
  }, () => false);
  const ownedCommand = [
    "/custom/code-server",
    "--bind-addr 127.0.0.1:9988",
    "--user-data-dir /tmp/threadex-data/code-server/user-data",
    "--extensions-dir /tmp/threadex-data/code-server/extensions"
  ].join(" ");

  assert.equal(isThreadexWebVsCodeCommand(ownedCommand, launch), true);
  assert.equal(isThreadexWebVsCodeCommand("code-server --bind-addr 127.0.0.1:9988", launch), false);
  assert.equal(isThreadexWebVsCodeCommand(ownedCommand.replace("9988", "9999"), launch), false);
});

test("an orphaned code-server listener is attributed to its matching launcher", () => {
  const launch = resolveWebVsCodeDevLaunch("/workspace/threadex", {
    SESSION_DATA_DIR: "/tmp/threadex-data",
    WEB_VSCODE_PORT: "9988"
  }, () => false);
  const launcher = {
    pid: 41,
    ppid: 1,
    command: "code-server --bind-addr 127.0.0.1:9988 --user-data-dir /tmp/threadex-data/code-server/user-data --extensions-dir /tmp/threadex-data/code-server/extensions"
  };
  const system = {
    getListeningProcessId: () => 42,
    getProcess: (pid) => (pid === 41 ? launcher : pid === 42 ? { pid: 42, ppid: 41, command: "node code-server/out/node/entry" } : null),
    signal: () => {}
  };

  assert.deepEqual(inspectWebVsCodeDevServer(launch, system), {
    state: "owned",
    process: launcher,
    source: "listener-parent"
  });
});

test("reclaiming an orphan signals only its dedicated launcher process group", async () => {
  const launch = resolveWebVsCodeDevLaunch("/workspace/threadex", {
    SESSION_DATA_DIR: "/tmp/threadex-data",
    WEB_VSCODE_PORT: "9988"
  }, () => false);
  const processes = new Map([
    [41, {
      pid: 41,
      ppid: 1,
      command: "code-server --bind-addr 127.0.0.1:9988 --user-data-dir /tmp/threadex-data/code-server/user-data --extensions-dir /tmp/threadex-data/code-server/extensions"
    }],
    [42, { pid: 42, ppid: 41, command: "node code-server/out/node/entry" }]
  ]);
  const signals = [];
  const system = {
    getListeningProcessId: () => processes.has(42) ? 42 : null,
    getProcess: (pid) => processes.get(pid) ?? null,
    signal: () => assert.fail("the single-process fallback should not run"),
    signalProcessGroup: (pid, signal) => {
      signals.push([pid, signal]);
      processes.delete(41);
      processes.delete(42);
    }
  };

  assert.deepEqual(await reclaimOrphanedWebVsCodeDevServer(launch, system), { state: "available" });
  assert.deepEqual(signals, [[41, "SIGTERM"]]);
});
