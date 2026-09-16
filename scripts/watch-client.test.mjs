import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
