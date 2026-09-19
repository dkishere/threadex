import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

test("monitor restart builds before replacement, cancels on failure, and serializes repeated requests", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-watch-server-"));
  let watcher;
  let output = "";
  const eventsPath = resolve(root, "events");
  const events = () => {
    try { return readFileSync(eventsPath, "utf8").trim().split("\n"); }
    catch { return []; }
  };
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail(`Timed out: ${output}`);
      await delay(25);
    }
  };
  try {
    for (const dir of ["scripts", "src/server", "node_modules/tsx/dist"]) mkdirSync(resolve(root, dir), { recursive: true });
    copyFileSync(new URL("./watch-server.mjs", import.meta.url), resolve(root, "scripts/watch-server.mjs"));
    writeFileSync(resolve(root, "src/server/index.ts"), "// fixture\n");
    writeFileSync(resolve(root, "node_modules/tsx/dist/cli.mjs"), `
      import { appendFileSync } from 'node:fs';
      const record = (event) => appendFileSync('events', event + '\\n');
      record('server-start');
      setInterval(() => {}, 1000);
      process.on('SIGTERM', () => { record('server-stop'); process.exit(0); });
    `);
    writeFileSync(resolve(root, "build.mjs"), `
      import { appendFileSync, existsSync } from 'node:fs';
      appendFileSync('events', 'build-start\\n');
      console.log('fixture build output');
      setTimeout(() => {
        const failed = existsSync('fail-build');
        appendFileSync('events', (failed ? 'build-failed' : 'build-done') + '\\n');
        process.exit(failed ? 1 : 0);
      }, 400);
    `);
    watcher = spawn(process.execPath, [resolve(root, "scripts/watch-server.mjs"), "--no-pg-dev"], {
      cwd: root,
      env: { ...process.env, SESSION_DATA_DIR: resolve(root, "data"), npm_execpath: resolve(root, "build.mjs") },
      stdio: ["ignore", "pipe", "pipe"]
    });
    watcher.stdout.on("data", (data) => { output += data; });
    watcher.stderr.on("data", (data) => { output += data; });
    await waitFor(() => events().length === 1);
    watcher.kill("SIGUSR1");
    await waitFor(() => events().length === 5);
    assert.deepEqual(events(), ["server-start", "build-start", "build-done", "server-stop", "server-start"]);
    assert.match(readFileSync(resolve(root, "data/process-supervisors/server.log"), "utf8"), /fixture build output/);

    writeFileSync(resolve(root, "fail-build"), "1");
    watcher.kill("SIGUSR1");
    await waitFor(() => output.includes("server restart cancelled"));
    assert.deepEqual(events().slice(5), ["build-start", "build-failed"]);
    rmSync(resolve(root, "fail-build"));

    watcher.kill("SIGUSR1");
    await waitFor(() => events().length === 8);
    watcher.kill("SIGUSR1");
    await waitFor(() => events().length === 15);
    assert.deepEqual(events().slice(7), ["build-start", "build-done", "server-stop", "server-start", "build-start", "build-done", "server-stop", "server-start"]);
  } finally {
    if (watcher && watcher.exitCode === null && watcher.signalCode === null) {
      const exited = once(watcher, "exit");
      watcher.kill("SIGTERM");
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
