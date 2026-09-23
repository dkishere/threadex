import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { ProcessMonitorService } from "./processMonitor.js";
import { SessionStore } from "./sessionStore.js";

test("temporary PID monitors disappear after the process exits", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "process-monitor-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const service = new ProcessMonitorService(store);
  try {
    await store.ready();
    const workspace = await store.getActiveWorkspace();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 50)"], { stdio: "ignore" });
    assert.ok(child.pid);
    const monitor = await service.monitor(workspace, { label: "temporary", pid: child.pid });
    assert.equal(monitor.removeOnExit, true);
    await waitFor(async () => (await service.list(workspace.id)).length === 0, 2_000);
  } finally {
    service.stop();
    await store.close();
  }
});

test("executable monitors can restart and remove their managed process", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "process-monitor-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const service = new ProcessMonitorService(store);
  try {
    await store.ready();
    const workspace = await store.getActiveWorkspace();
    const monitor = await service.monitor(workspace, {
      label: "long-running",
      exe: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10000)"],
      entryPoints: [
        "http://localhost:3000/health",
        "https://example.com/status",
        "http://localhost:3000/health"
      ]
    });
    assert.equal(monitor.status, "running");
    assert.equal(monitor.managed, true);
    assert.deepEqual(monitor.entryPoints, [
      "http://localhost:3000/health",
      "https://example.com/status"
    ]);
    const restarted = await service.restart(workspace, monitor.id);
    assert.equal(restarted.status, "running");
    assert.notEqual(restarted.pid, monitor.pid);
    await service.remove(workspace.id, monitor.id);
    assert.equal(await store.getProcessMonitor(monitor.id), null);
  } finally {
    service.stop();
    await store.close();
  }
});

test("a missing executable is recorded as a monitor error without an unhandled child error", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "process-monitor-missing-executable-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const service = new ProcessMonitorService(store);
  try {
    await store.ready();
    const workspace = await store.getActiveWorkspace();
    const missingExecutable = resolve(root, "missing-npm");

    await assert.rejects(
      () => service.monitor(workspace, {
        label: "missing executable",
        exe: missingExecutable,
        args: ["run", "generate"]
      }),
      /ENOENT/
    );

    const [monitor] = await service.list(workspace.id);
    assert.equal(monitor?.status, "error");
    assert.match(monitor?.error ?? "", /ENOENT/);
  } finally {
    service.stop();
    await store.close();
  }
});

test("an interrupted starting monitor is recovered as an error", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "process-monitor-interrupted-start-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const service = new ProcessMonitorService(store);
  try {
    await store.ready();
    const workspace = await store.getActiveWorkspace();
    const created = await store.createProcessMonitor({
      workspaceId: workspace.id,
      label: "interrupted launch",
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: workspace.cwd,
      status: "starting",
      managed: true
    });

    const [monitor] = await service.list(workspace.id);
    assert.equal(monitor?.id, created.id);
    assert.equal(monitor?.status, "error");
    assert.equal(monitor?.error, "Process launch did not produce a process id.");
  } finally {
    service.stop();
    await store.close();
  }
});

test("process monitors are isolated by workspace", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "process-monitor-workspace-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const service = new ProcessMonitorService(store);
  try {
    await store.ready();
    await store.upsertWorkspace({
      id: "workspace-a",
      name: "Workspace A",
      codexHome: resolve(root, "codex-a"),
      cwd: resolve(root, "workspace-a")
    });
    await store.upsertWorkspace({
      id: "workspace-b",
      name: "Workspace B",
      codexHome: resolve(root, "codex-b"),
      cwd: resolve(root, "workspace-b")
    });
    const workspaceA = await store.getWorkspace("workspace-a");
    const workspaceB = await store.getWorkspace("workspace-b");
    assert.ok(workspaceA);
    assert.ok(workspaceB);

    const monitor = await store.createProcessMonitor({
      workspaceId: workspaceA.id,
      label: "workspace-a-monitor",
      cwd: workspaceA.cwd,
      status: "exited",
      managed: false
    });

    assert.deepEqual((await service.list(workspaceA.id)).map((record) => record.id), [monitor.id]);
    assert.deepEqual(await service.list(workspaceB.id), []);
    await assert.rejects(() => service.readLog(workspaceB.id, monitor.id), /Process monitor not found/);
    await assert.rejects(() => service.restart(workspaceB, monitor.id), /Process monitor not found/);
    await assert.rejects(() => service.remove(workspaceB.id, monitor.id), /Process monitor not found/);
    assert.equal((await store.getProcessMonitor(monitor.id))?.workspaceId, workspaceA.id);
  } finally {
    service.stop();
    await store.close();
  }
});

test("managed process logs capture stdout and stderr and support bounded tail reads", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "process-monitor-log-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const service = new ProcessMonitorService(store, { logDir: resolve(root, "logs") });
  try {
    await store.ready();
    const workspace = await store.getActiveWorkspace();
    const monitor = await service.monitor(workspace, {
      label: "logged-process",
      removeOnExit: false,
      exe: process.execPath,
      args: ["-e", "process.stdout.write('stdout-line\\n'); process.stderr.write('stderr-line\\n')"]
    });
    await waitFor(async () => (await store.getProcessMonitor(monitor.id))?.status === "exited", 2_000);
    const fullLog = await service.readLog(workspace.id, monitor.id);
    assert.match(fullLog.content, /stdout-line/);
    assert.match(fullLog.content, /stderr-line/);
    assert.equal(fullLog.truncated, false);
    assert.ok(fullLog.updatedAt);

    const tail = await service.readLog(workspace.id, monitor.id, 8);
    assert.equal(Buffer.byteLength(tail.content), 8);
    assert.equal(tail.truncated, true);
  } finally {
    service.stop();
    await store.close();
  }
});

test("explicit log files survive launch-spec changes and capture the restarted command", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "process-monitor-explicit-log-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const service = new ProcessMonitorService(store, { logDir: resolve(root, "default-logs") });
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
  try {
    await store.ready();
    const workspace = await store.getActiveWorkspace();
    assert.ok(child.pid);
    const temporary = await service.monitor(workspace, { label: "changeable", pid: child.pid });
    const adopted = await service.adopt(workspace, temporary.id, {
      pid: child.pid,
      command: `${process.execPath} -e "process.stdout.write('changed-command\\n')"`,
      logFile: "logs/explicit-process.log",
      removeOnExit: false
    });
    assert.equal(adopted.logFile, resolve(workspace.cwd, "logs/explicit-process.log"));
    assert.equal(adopted.command, `${process.execPath} -e "process.stdout.write('changed-command\\n')"`);
    const restarted = await service.restart(workspace, adopted.id);
    await waitFor(async () => (await store.getProcessMonitor(restarted.id))?.status === "exited", 2_000);
    const log = await service.readLog(workspace.id, restarted.id);
    assert.match(log.content, /changed-command/);
  } finally {
    service.stop();
    try { child.kill("SIGTERM"); } catch {}
    await store.close();
  }
});

test("metric probes persist their name, command, and latest value for externally attached processes", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "process-monitor-metric-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const service = new ProcessMonitorService(store);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
  try {
    await store.ready();
    const workspace = await store.getActiveWorkspace();
    assert.ok(child.pid);
    const monitor = await service.monitor(workspace, {
      label: "external-with-progress",
      pid: child.pid,
      metrics: [{ name: "Import progress", command: "printf '3/5 files'", nameSuffix: true }]
    });
    assert.deepEqual(monitor.metricMonitors, [{ name: "Import progress", command: "printf '3/5 files'", nameSuffix: true }]);
    assert.deepEqual(monitor.metricReadings, [{
      name: "Import progress",
      command: "printf '3/5 files'",
      nameSuffix: true,
      value: "3/5 files",
      status: "ok",
      updatedAt: monitor.metricReadings[0]?.updatedAt ?? null,
      error: null
    }]);
    assert.ok(monitor.metricReadings[0]?.updatedAt);
  } finally {
    service.stop();
    try { child.kill("SIGTERM"); } catch {}
    await store.close();
  }
});

test("metric probes require distinct names and commands", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "process-monitor-metric-validation-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const service = new ProcessMonitorService(store);
  try {
    await store.ready();
    const workspace = await store.getActiveWorkspace();
    await assert.rejects(
      () => service.monitor(workspace, {
        label: "invalid-metrics",
        exe: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10000)"],
        metrics: [{ name: "progress", command: "echo one" }, { name: "progress", command: "echo two" }]
      }),
      /Metric names must be unique/
    );
  } finally {
    service.stop();
    await store.close();
  }
});

test("bare Node executable monitors are rejected instead of immediately appearing exited", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "process-monitor-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const service = new ProcessMonitorService(store);
  try {
    await store.ready();
    const workspace = await store.getActiveWorkspace();
    await assert.rejects(
      () => service.monitor(workspace, { label: "misconfigured-node", exe: process.execPath }),
      /args must include a script or interpreter options when exe is node/
    );
    assert.deepEqual(await service.list(workspace.id), []);
  } finally {
    service.stop();
    await store.close();
  }
});

test("bare shell and interpreter monitors are rejected with restart guidance", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "process-monitor-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const service = new ProcessMonitorService(store);
  try {
    await store.ready();
    const workspace = await store.getActiveWorkspace();
    for (const exe of ["sh", "/bin/bash", "python3"]) {
      await assert.rejects(
        () => service.monitor(workspace, { label: `misconfigured-${exe}`, exe }),
        /args must include a script or interpreter options/
      );
    }
    assert.deepEqual(await service.list(workspace.id), []);
  } finally {
    service.stop();
    await store.close();
  }
});

test("adopting a restart launch spec preserves automatic cleanup", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "process-monitor-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const service = new ProcessMonitorService(store);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
  try {
    await store.ready();
    const workspace = await store.getActiveWorkspace();
    assert.ok(child.pid);
    const temporary = await service.monitor(workspace, { label: "temporary-node", pid: child.pid });
    const adopted = await service.adopt(workspace, temporary.id, {
      pid: child.pid,
      exe: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10000)"]
    });
    assert.equal(adopted.pid, child.pid);
    assert.equal(adopted.executable, process.execPath);
    assert.deepEqual(adopted.args, ["-e", "setTimeout(() => {}, 10000)"]);
    assert.equal(adopted.managed, true);
    assert.equal(adopted.removeOnExit, true);
    const restarted = await service.restart(workspace, adopted.id);
    assert.equal(restarted.status, "running");
    assert.notEqual(restarted.pid, child.pid);
    await service.remove(workspace.id, adopted.id);
  } finally {
    service.stop();
    try { child.kill("SIGTERM"); } catch {}
    await store.close();
  }
});

test("an existing PID can be attached with a launch spec, stopped directly, then restarted", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "process-monitor-attached-launch-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const service = new ProcessMonitorService(store);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
  try {
    await store.ready();
    const workspace = await store.getActiveWorkspace();
    assert.ok(child.pid);
    const attached = await service.monitor(workspace, {
      label: "attached-with-command",
      pid: child.pid,
      exe: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10000)"]
    });
    assert.equal(attached.managed, true);
    assert.equal(attached.removeOnExit, true);
    assert.equal(attached.pid, child.pid);

    const stopped = await service.stopProcess(workspace.id, attached.id);
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.pid, null);
    await waitFor(async () => child.exitCode !== null || child.signalCode !== null, 2_000);

    const restarted = await service.restart(workspace, attached.id);
    assert.equal(restarted.status, "running");
    assert.equal(restarted.managed, true);
    assert.ok(restarted.pid);
    await service.remove(workspace.id, attached.id);
  } finally {
    service.stop();
    try { child.kill("SIGTERM"); } catch {}
    await store.close();
  }
});

test("stopping an attached process signals only its PID, not its external process group", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "process-monitor-exact-pid-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const service = new ProcessMonitorService(store);
  const siblingPidPath = resolve(root, "sibling.pid");
  const leaderScript = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const sibling = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });",
    "writeFileSync(process.argv[1], String(sibling.pid));",
    "setTimeout(() => {}, 10000);"
  ].join(" ");
  const leader = spawn(process.execPath, ["-e", leaderScript, siblingPidPath], { detached: true, stdio: "ignore" });
  let siblingPid: number | null = null;
  try {
    await store.ready();
    const workspace = await store.getActiveWorkspace();
    assert.ok(leader.pid);
    await waitFor(async () => existsSync(siblingPidPath), 2_000);
    siblingPid = Number(readFileSync(siblingPidPath, "utf8"));
    assert.ok(Number.isInteger(siblingPid) && siblingPid > 0);
    const attached = await service.monitor(workspace, {
      label: "external-group-leader",
      pid: leader.pid,
      command: `${process.execPath} -e "setTimeout(() => {}, 10000)"`
    });

    await service.stopProcess(workspace.id, attached.id);
    await waitFor(async () => leader.exitCode !== null || leader.signalCode !== null, 2_000);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    assert.doesNotThrow(() => process.kill(siblingPid!, 0));
  } finally {
    service.stop();
    try { leader.kill("SIGTERM"); } catch {}
    if (siblingPid) {
      try { process.kill(siblingPid, "SIGTERM"); } catch {}
    }
    await store.close();
  }
});

test("adopted launch args survive closing and reopening the store", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "process-monitor-test-"));
  const databasePath = resolve(root, "sessions.postgres");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
  let monitorId = "";
  const firstStore = new SessionStore(databasePath);
  const firstService = new ProcessMonitorService(firstStore);
  try {
    await firstStore.ready();
    const workspace = await firstStore.getActiveWorkspace();
    assert.ok(child.pid);
    const temporary = await firstService.monitor(workspace, { label: "persistent-node", pid: child.pid });
    monitorId = temporary.id;
    await firstService.adopt(workspace, temporary.id, {
      pid: child.pid,
      exe: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10000)"],
      entryPoints: ["http://localhost:4321"]
    });
  } finally {
    firstService.stop();
    await firstStore.close();
  }

  const reopenedStore = new SessionStore(databasePath);
  try {
    await reopenedStore.ready();
    const reopened = await reopenedStore.getProcessMonitor(monitorId);
    assert.ok(reopened);
    assert.equal(reopened.executable, process.execPath);
    assert.deepEqual(reopened.args, ["-e", "setTimeout(() => {}, 10000)"]);
    assert.deepEqual(reopened.entryPoints, ["http://localhost:4321/"]);
  } finally {
    try { child.kill("SIGTERM"); } catch {}
    await reopenedStore.close();
  }
});

test("entry points must contain only HTTP(S) URLs", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "process-monitor-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const service = new ProcessMonitorService(store);
  try {
    await store.ready();
    const workspace = await store.getActiveWorkspace();
    await assert.rejects(
      () => service.monitor(workspace, {
        label: "invalid-entry-point",
        exe: process.execPath,
        entryPoints: ["http://localhost:3000", "javascript:alert(1)"]
      }),
      /entryPoints must contain only HTTP\(S\) URLs/
    );
  } finally {
    service.stop();
    await store.close();
  }
});

test("Docker image monitor metadata persists with docker run arguments", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "process-monitor-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  try {
    await store.ready();
    const workspace = await store.getActiveWorkspace();
    const monitor = await store.createProcessMonitor({
      workspaceId: workspace.id,
      label: "docker-service",
      dockerImage: "nginx:latest",
      dockerRunArgs: ["-p", "8080:80"],
      args: [],
      cwd: workspace.cwd,
      status: "running",
      managed: true
    });
    assert.equal(monitor.dockerImage, "nginx:latest");
    assert.deepEqual(monitor.dockerRunArgs, ["-p", "8080:80"]);
    await store.deleteProcessMonitor(monitor.id);
  } finally {
    await store.close();
  }
});

test("Docker monitor input validates image references and launch options", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "process-monitor-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  const service = new ProcessMonitorService(store);
  try {
    await store.ready();
    const workspace = await store.getActiveWorkspace();
    await assert.rejects(
      () => service.monitor(workspace, {
        label: "invalid-docker-image",
        dockerImage: "nginx latest"
      }),
      /dockerImage must be a valid Docker image reference/
    );
    await assert.rejects(
      () => service.monitor(workspace, {
        label: "docker-args-without-image",
        exe: process.execPath,
        dockerRunArgs: ["-p", "8080:80"]
      }),
      /dockerRunArgs requires dockerImage/
    );
  } finally {
    service.stop();
    await store.close();
  }
});

test("a completed executable can wake a follow-up and remain restartable", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "process-monitor-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  let wake: { prompt: string; sessionId: string; threadId: string | null } | null = null;
  const service = new ProcessMonitorService(store, {
    onWake: async (request) => {
      wake = { prompt: request.prompt, sessionId: request.sessionId, threadId: request.threadId };
    }
  });
  try {
    await store.ready();
    const workspace = await store.getActiveWorkspace();
    const monitor = await service.monitor(workspace, {
      label: "wakeable",
      removeOnExit: false,
      exe: process.execPath,
      args: ["-e", "setTimeout(() => {}, 50)"],
      wakePrompt: "Continue after the process completed.",
      wakeSessionId: "session-for-wake",
      wakeThreadId: "thread-for-wake"
    });
    assert.equal(monitor.wakeStatus, "pending");
    await waitFor(async () => wake !== null, 2_000);
    assert.deepEqual(wake, {
      prompt: "Continue after the process completed.",
      sessionId: "session-for-wake",
      threadId: "thread-for-wake"
    });
    await waitFor(async () => (await store.getProcessMonitor(monitor.id))?.wakeStatus === "done", 2_000);
    await service.remove(workspace.id, monitor.id);
  } finally {
    service.stop();
    await store.close();
  }
});

test("every completed process publishes the exit hook without requiring a wake prompt", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "process-monitor-exit-event-test-"));
  const store = new SessionStore(resolve(root, "sessions.postgres"));
  let exitedMonitorId: string | null = null;
  const service = new ProcessMonitorService(store, {
    onExit: async (monitor) => {
      exitedMonitorId = monitor.id;
      assert.equal(monitor.status, "exited");
      assert.equal(monitor.lastExitCode, 0);
    }
  });
  try {
    await store.ready();
    const workspace = await store.getActiveWorkspace();
    const monitor = await service.monitor(workspace, {
      label: "event-only",
      exe: process.execPath,
      args: ["-e", "setTimeout(() => {}, 25)"]
    });
    await waitFor(async () => exitedMonitorId === monitor.id, 2_000);
    await waitFor(async () => (await store.getProcessMonitor(monitor.id)) === null, 2_000);
  } finally {
    service.stop();
    await store.close();
  }
});

for (const mode of ["managed", "attached", "wake"] as const) {
  test(`default ${mode} monitor is removed after completion`, async () => {
    const root = mkdtempSync(resolve(tmpdir(), "process-monitor-cleanup-test-"));
    const store = new SessionStore(resolve(root, "sessions.postgres"));
    let woke = false;
    const service = new ProcessMonitorService(store, {
      onWake: async ({ monitor }) => {
        assert.ok(await store.getProcessMonitor(monitor.id));
        woke = true;
      }
    });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await store.ready();
      const workspace = await store.getActiveWorkspace();
      if (mode === "attached") {
        child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 500)"], { stdio: "ignore" });
        assert.ok(child.pid);
      }
      const monitor = await service.monitor(workspace, {
        label: `cleanup-${mode}`,
        exe: process.execPath,
        args: ["-e", "setTimeout(() => {}, 50)"],
        ...(child ? { pid: child.pid } : {}),
        ...(mode === "wake" ? { wakePrompt: "Continue.", wakeSessionId: "cleanup-session" } : {})
      });
      assert.equal(monitor.removeOnExit, true);
      await waitFor(async () => {
        await service.list(workspace.id);
        return (await store.getProcessMonitor(monitor.id)) === null;
      }, 2_000);
      assert.equal(woke, mode === "wake");
    } finally {
      service.stop();
      child?.kill();
      await store.close();
    }
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.fail("Timed out waiting for process monitor state.");
}
