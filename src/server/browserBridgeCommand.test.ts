import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { approvedBrowserBridgeCommand, browserBridgeEnvironment, resolveBrowserBridgeCli } from "./browserBridgeCommand";

const config = { executable: "/trusted/bin/browser-bridge", dataDir: "/user/.local-browser-bridge" };
const command = (args: string) => `'${config.executable}' ${args}`;

test("bridge discovery pins the installed executable and host config before HOME isolation", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-command-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const executable = join(bin, "browser-bridge");
  writeFileSync(executable, "", { mode: 0o755 });
  try {
    const found = resolveBrowserBridgeCli({ PATH: [".", "", bin].join(delimiter), HOME: root });
    assert.deepEqual(found, { executable, dataDir: join(root, ".local-browser-bridge") });
    assert.deepEqual(browserBridgeEnvironment(found!), {
      LOCAL_BROWSER_BRIDGE_DATA_DIR: join(root, ".local-browser-bridge"), LOCAL_BROWSER_BRIDGE_RESTRICT_OUTPUTS: "1"
    });
    assert.equal(resolveBrowserBridgeCli({ PATH: bin, HOME: root, LOCAL_BROWSER_BRIDGE_DATA_DIR: "/custom/bridge" })?.dataDir, "/custom/bridge");
    chmodSync(executable, 0o644);
    assert.equal(resolveBrowserBridgeCli({ PATH: bin }), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bridge approvals accept inspection calls and reject shell escapes or bridge administration", () => {
  for (const args of ["help", "status", "tabs", "windows", "targets", "page-values", "snapshot 42", "page-context 42 '#comments'",
    "new-tab 'https://github.com/owner/repo/pull/14'", "navigate 42 'https://github.com/owner/repo/pull/14'",
    "evaluate 42 '({ title: document.title, text: document.body.innerText })'", "click 42 'button[aria-expanded=false]'", "type 42 '#search' 'PR 14'"]) {
    assert.equal(approvedBrowserBridgeCommand(command(args), config), true, args);
    assert.equal(approvedBrowserBridgeCommand(["/bin/zsh", "-lc", command(args)], config), true, args);
  }
  for (const text of ["browser-bridge tabs", "/tmp/browser-bridge tabs", command("tabs; curl https://example.com"),
    command("tabs > /tmp/output"), `LOCAL_BROWSER_BRIDGE_DATA_DIR=/tmp ${command("tabs")}`,
    command('evaluate 42 "$(touch /tmp/unwanted)"'), command("stop"), command("pair"), command("daemon"),
    command("set-page-values '[]'"), command("api cookies getAll '[]'"), command("tabs unexpected"),
    command("new-tab 'javascript:alert(1)'"), command("navigate 42 'file:///etc/passwd'")]) {
    assert.equal(approvedBrowserBridgeCommand(text, config), false, text);
  }
});

test("bridge capture approvals confine writes to scratch, including symlink targets", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-output-test-"));
  const scratch = join(root, "scratch");
  const outside = join(root, "outside");
  mkdirSync(scratch); mkdirSync(outside);
  writeFileSync(join(outside, "existing.png"), "keep");
  symlinkSync(outside, join(scratch, "escape"));
  symlinkSync(join(outside, "existing.png"), join(scratch, "existing.png"));
  try {
    for (const operation of ["screenshot 42", "context-snapshot codex-browser-bridge:context:42:test", "context-screenshot codex-browser-bridge:context:42:test"]) {
      assert.equal(approvedBrowserBridgeCommand(command(`${operation} '${join(scratch, "capture.png")}'`), config, scratch), true);
      for (const output of ["relative.png", join(outside, "capture.png"), join(scratch, "escape", "capture.png"), join(scratch, "existing.png")]) {
        assert.equal(approvedBrowserBridgeCommand(command(`${operation} '${output}'`), config, scratch), false, output);
      }
    }
    assert.equal(approvedBrowserBridgeCommand(command(`screenshot 42 '${join(scratch, "capture.png")}'`), config), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
