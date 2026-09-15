import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { installBundledWebVsCodeReviewExtension, shouldAutoStartWebVsCodeServer } from "./webVsCodeExtension";

test("development server supervisors leave Web VS Code to dev:client", () => {
  assert.equal(shouldAutoStartWebVsCodeServer({}, false), true);
  assert.equal(shouldAutoStartWebVsCodeServer({ SESSION_SERVER_SUPERVISOR_PID: "123" }, false), false);
  assert.equal(shouldAutoStartWebVsCodeServer({ WEB_VSCODE_URL: "https://code.example" }, false), false);
  assert.equal(shouldAutoStartWebVsCodeServer({ WEB_VSCODE_AUTOSTART: "false" }, false), false);
  assert.equal(shouldAutoStartWebVsCodeServer({}, true), false);
});

test("copies and registers the bundled review extension while clearing obsolete state", () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-vscode-extension-"));
  const source = resolve(root, "source");
  const extensions = resolve(root, "extensions");
  try {
    mkdirSync(source, { recursive: true });
    mkdirSync(extensions, { recursive: true });
    writeFileSync(resolve(source, "package.json"), '{"name":"threadex-review"}', "utf8");
    writeFileSync(resolve(extensions, "extensions.json"), "[]", "utf8");
    writeFileSync(resolve(extensions, ".obsolete"), '{"threadex.threadex-review-0.1.0":true}', "utf8");

    const installed = installBundledWebVsCodeReviewExtension(source, extensions);

    assert.equal(installed, resolve(extensions, "threadex.threadex-review-0.1.0-universal"));
    const registry = JSON.parse(readFileSync(resolve(extensions, "extensions.json"), "utf8"));
    assert.equal(registry[0].identifier.id, "threadex.threadex-review");
    assert.deepEqual(JSON.parse(readFileSync(resolve(extensions, ".obsolete"), "utf8")), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
