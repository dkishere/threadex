import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "watch-client.mjs");

test("dev client owns Web VS Code's process group and reclaims prior orphans", () => {
  const source = readFileSync(scriptPath, "utf8");

  assert.match(source, /detached:\s*process\.platform !== "win32"/);
  assert.doesNotMatch(source, /\.unref\(\)/);
  assert.match(source, /await Promise\.all\(\[\s*stopChild\(viteChild, "Vite"\),\s*stopChild\(webVsCodeChild, "Web VS Code", true\)/s);
  assert.match(source, /function stopChild\(childProcess, label, processGroup = false\)/);
  assert.match(source, /process\.kill\(-childProcess\.pid, signal\)/);
  assert.match(source, /reclaimOrphanedWebVsCodeDevServer\(launch\)/);
  assert.match(source, /Restarting is paused to avoid an EADDRINUSE loop/);
  assert.match(source, /startup skipped: \$\{launch\.command\} was not found/);
});

test("serve's Web VS Code watcher skips Vite and leaves the client supervisor alone", () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), "threadex-serve-web-vscode-"));
  try {
    const run = spawnSync(process.execPath, [scriptPath, "--web-vscode-only"], {
      env: { ...process.env, SESSION_DATA_DIR: dataDir, WEB_VSCODE_AUTOSTART: "false" },
      encoding: "utf8",
      timeout: 5_000
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /WEB_VSCODE_AUTOSTART=false/);
    assert.equal(existsSync(resolve(dataDir, "process-supervisors", "client.pid")), false);
    assert.equal(existsSync(resolve(dataDir, "process-supervisors", "web-vscode-launcher.pid")), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
