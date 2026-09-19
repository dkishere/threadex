import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { RunnerProcessRegistry } from "./runnerProcessRegistry";

test("immediate Stop terminates a spawned runner even when the saved PID snapshot is empty", () => {
  const killed: number[] = [];
  const registry = new RunnerProcessRegistry(pid => {
    if (!pid) return false;
    killed.push(pid);
    return true;
  });
  const attempt = registry.begin("attempt-1");
  const stalePid = null;
  attempt.attach(123);
  assert.equal(registry.stop("attempt-1", stalePid), true);
  assert.deepEqual(killed, [123]);
});

test("Stop during asynchronous startup is retained until the process attaches", () => {
  const killed: number[] = [];
  const registry = new RunnerProcessRegistry(pid => {
    if (!pid) return false;
    killed.push(pid);
    return true;
  });
  const first = registry.begin("attempt-1");
  assert.equal(registry.stop("attempt-1", null), false);
  first.attach(123);
  assert.deepEqual(killed, [123]);
  const retry = registry.begin("attempt-2");
  retry.attach(456);
  first.dispose();
  assert.deepEqual(killed, [123]);
  registry.stop("attempt-2", null);
  assert.deepEqual(killed, [123, 456]);
});

test("after server restart Stop uses the persisted PID", () => {
  const killed: Array<number | null> = [];
  const registry = new RunnerProcessRegistry(pid => { killed.push(pid); return true; });
  registry.stop("existing-attempt", 789);
  assert.deepEqual(killed, [789]);
});

test("a Stop received before PID attachment actually exits the late process", async () => {
  const registry = new RunnerProcessRegistry(pid => {
    if (!pid) return false;
    process.kill(pid, "SIGTERM");
    return true;
  });
  const attempt = registry.begin("late-process");
  registry.stop("late-process", null);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = once(child, "exit");
  try {
    await once(child, "spawn");
    attempt.attach(child.pid!);
    const [, signal] = await exited;
    assert.equal(signal, "SIGTERM");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    attempt.dispose();
  }
});
