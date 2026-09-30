import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

test("an API restart hands borrowed code-server ownership to the serve watcher", {
  timeout: 15_000,
  skip: process.platform === "win32"
}, async () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-serve-handoff-"));
  const children = [];
  let output = "";
  const events = () => {
    try { return readFileSync(resolve(root, "events"), "utf8").trim().split("\n"); }
    catch { return []; }
  };
  const codePid = () => {
    try { return Number(readFileSync(resolve(root, "data/process-supervisors/web-vscode.pid"), "utf8")); }
    catch { return null; }
  };
  const alive = pid => {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const waitFor = async predicate => {
    const deadline = Date.now() + 4_000;
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail(`Timed out: ${output}\n${events().join("\n")}`);
      await delay(25);
    }
  };
  const stop = async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  };
  try {
    for (const dir of ["scripts", "src/server", "node_modules/tsx/dist"]) mkdirSync(resolve(root, dir), { recursive: true });
    for (const script of ["watch-server.mjs", "watch-client.mjs", "web-vscode-dev.mjs"]) {
      copyFileSync(new URL(script, import.meta.url), resolve(root, "scripts", script));
    }
    writeFileSync(resolve(root, "src/server/index.ts"), "// isolated API fixture\n");
    writeFileSync(resolve(root, "code-server.mjs"), `#!/usr/bin/env node
      import { appendFileSync, writeFileSync } from 'node:fs';
      writeFileSync('process-' + process.pid, process.pid + ' ' + process.ppid + ' ' + process.argv.join(' '));
      appendFileSync('events', 'code-start:' + process.pid + '\\n');
      setInterval(() => {}, 1000);
      process.on('SIGTERM', () => process.exit(0));
    `, { mode: 0o755 });
    writeFileSync(resolve(root, "node_modules/tsx/dist/cli.mjs"), `
      import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
      import { spawn } from 'node:child_process';
      import { prepareWebVsCodeDevLaunch, writeWebVsCodeSupervisorPid } from '../../../scripts/web-vscode-dev.mjs';
      let code;
      // Model an older API that owns code-server; its replacement uses the
      // current supervised-API gate and relies on the separate watcher.
      if (!existsSync('api-started')) {
        writeFileSync('api-started', '1');
        const launch = prepareWebVsCodeDevLaunch(process.cwd());
        code = spawn(launch.command, launch.args, { env: launch.env, detached: true, stdio: 'ignore' });
        writeWebVsCodeSupervisorPid(launch, code.pid);
      }
      appendFileSync('events', 'api-start\\n');
      setInterval(() => {}, 1000);
      process.on('SIGTERM', () => {
        appendFileSync('events', 'api-stop\\n');
        if (code) {
          code.once('exit', () => process.exit(0));
          process.kill(-code.pid, 'SIGTERM');
        } else process.exit(0);
      });
    `);
    writeFileSync(resolve(root, "build.mjs"), "console.log('isolated build completed');\n");
    // The sandbox denies child-process ps calls. Supply only that read-only
    // metadata from our fixtures; launches, signals and exits remain real.
    // No fixture binds a TCP port, so the simulated listener lookup is empty.
    writeFileSync(resolve(root, "process-inspection.mjs"), `
      import childProcess from 'node:child_process';
      import { existsSync, readFileSync } from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const original = childProcess.execFileSync;
      childProcess.execFileSync = (command, args, options) => {
        if (command === 'lsof') return existsSync('foreign-listener') ? readFileSync('foreign-listener', 'utf8') : '';
        if (command !== 'ps') return original(command, args, options);
        const pid = Number(args[1]);
        process.kill(pid, 0);
        return readFileSync('process-' + pid, 'utf8');
      };
      syncBuiltinESMExports();
    `);
    const env = {
      ...process.env, SESSION_DATA_DIR: resolve(root, "data"),
      SESSION_DATABASE_URL: "unused-fixture", WEB_VSCODE_URL: "",
      WEB_VSCODE_AUTOSTART: "true", WEB_VSCODE_PORT: "0",
      CODE_SERVER_COMMAND: resolve(root, "code-server.mjs"), npm_execpath: resolve(root, "build.mjs")
    };
    const start = (script, args = []) => {
      const child = spawn(process.execPath, ["--import", resolve(root, "process-inspection.mjs"), resolve(root, "scripts", script), ...args], {
        cwd: root, env, stdio: ["ignore", "pipe", "pipe"]
      });
      children.push(child);
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      return child;
    };
    const server = start("watch-server.mjs");
    await waitFor(() => events().some(event => event.startsWith("code-start:")));
    const borrowedPid = codePid();
    let codeWatcher = start("watch-client.mjs", ["--web-vscode-only"]);
    await waitFor(() => output.includes("already running under another Threadex"));
    await stop(codeWatcher);
    assert.equal(alive(borrowedPid), true, "standby shutdown must not signal the borrowed owner");
    assert.equal(codePid(), borrowedPid);
    codeWatcher = start("watch-client.mjs", ["--web-vscode-only"]);
    await waitFor(() => output.split("already running under another Threadex").length === 3);

    // Process Monitor sends exactly this signal to the PID in server.pid.
    const supervisorPid = Number(readFileSync(resolve(root, "data/process-supervisors/server.pid"), "utf8"));
    assert.equal(supervisorPid, server.pid);
    process.kill(supervisorPid, "SIGUSR1");
    await waitFor(() => events().filter(event => event === "api-start").length === 2);
    await waitFor(() => codePid() !== borrowedPid && alive(codePid()));
    const replacementPid = codePid();
    assert.equal(alive(borrowedPid), false);

    process.kill(supervisorPid, "SIGUSR1");
    await waitFor(() => events().filter(event => event === "api-start").length === 3);
    assert.equal(codePid(), replacementPid);
    assert.equal(alive(replacementPid), true);
    await stop(codeWatcher);
    await waitFor(() => !alive(replacementPid));
    assert.equal(codePid(), null);

    // A foreign listener is a terminal conflict, not an ownership handoff.
    const starts = events().filter(event => event.startsWith("code-start:")).length;
    writeFileSync(resolve(root, "foreign-listener"), String(server.pid));
    const conflictedWatcher = start("watch-client.mjs", ["--web-vscode-only"]);
    const [code] = await once(conflictedWatcher, "exit");
    assert.equal(code, 0);
    assert.match(output, /in use by another process/);
    assert.equal(events().filter(event => event.startsWith("code-start:")).length, starts);
    assert.equal(alive(server.pid), true);
  } finally {
    for (const child of children.reverse()) await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});
