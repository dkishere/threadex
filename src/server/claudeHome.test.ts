import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { claudeAuthHome, claudeCredentialStore, keychainServiceFor, prepareClaudeHome, workspaceClaudeHome, type ClaudeCredentialStore } from "./claudeHome";

const credential = (token: string, expiresAt = 1) => ({ claudeAiOauth: { accessToken: token, refreshToken: `${token}-refresh`, expiresAt } });

test("cleared Keychain records remain authoritative over stale credential files", () => {
  const cleared = { claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } };
  const home = resolve(homedir(), ".claude");
  const service = keychainServiceFor(home, () => cleared);
  assert.match(service!, /^Claude Code-credentials-[a-f0-9]{8}$/);
  assert.equal(keychainServiceFor(home, name => name === "Claude Code-credentials" ? cleared : null), "Claude Code-credentials");
  assert.equal(keychainServiceFor("/isolated-account", () => null), null);
  assert.equal(keychainServiceFor("/isolated-account", name => name === "Claude Code-credentials" ? cleared : null), null);
});

test("workspace homes separate the same account, and account switches keep their own state", () => {
  assert.notEqual(workspaceClaudeHome("/data", "a", "/auth"), workspaceClaudeHome("/data", "b", "/auth"));
  assert.notEqual(workspaceClaudeHome("/data", "a", "/auth"), workspaceClaudeHome("/data", "a", "/other-auth"));
  assert.equal(workspaceClaudeHome("/data", "a", "/auth"), workspaceClaudeHome("/data", "a", "/auth"));
  assert.match(workspaceClaudeHome("/data", "../../elsewhere", "/auth"), /^\/data\/claude-homes\/[a-f0-9]+\/[a-f0-9]+$/);
  assert.equal(claudeAuthHome({ THREADEX_CLAUDE_CONFIG_DIR: "/preferred", CLAUDE_CONFIG_DIR: "/fallback" }), "/preferred");
});

test("home setup copies only authentication, preserves workspace state and removes stale auth", () => {
  const root = mkdtempSync(resolve(tmpdir(), "claude-home-test-"));
  const source = resolve(root, "account");
  const a = workspaceClaudeHome(root, "a", source);
  const b = workspaceClaudeHome(root, "b", source);
  try {
    claudeCredentialStore.write(source, credential("fixture"));
    writeFileSync(resolve(source, ".credentials.json"), JSON.stringify({ ...credential("fixture"), unrelatedCredential: "keep-at-source" }));
    writeFileSync(resolve(source, "settings.json"), '{"hooks":{"unwanted":true}}');
    writeFileSync(resolve(source, "CLAUDE.md"), "Account instructions must not leak");
    prepareClaudeHome(a, source);
    prepareClaudeHome(b, source);
    assert.deepEqual(claudeCredentialStore.read(a), credential("fixture"));
    assert.equal(JSON.parse(readFileSync(resolve(a, ".credentials.json"), "utf8")).unrelatedCredential, undefined);
    claudeCredentialStore.write(source, credential("fixture-refreshed", 2));
    assert.equal(JSON.parse(readFileSync(resolve(source, ".credentials.json"), "utf8")).unrelatedCredential, "keep-at-source");
    assert.equal(statSync(resolve(a, ".credentials.json")).mode & 0o777, 0o600);
    assert.equal(existsSync(resolve(a, "settings.json")), false);
    assert.equal(existsSync(resolve(b, "CLAUDE.md")), false);
    writeFileSync(resolve(a, "settings.json"), '{"workspace":"a"}');
    prepareClaudeHome(a, source);
    assert.equal(readFileSync(resolve(a, "settings.json"), "utf8"), '{"workspace":"a"}');
    assert.equal(existsSync(resolve(b, "settings.json")), false);
    claudeCredentialStore.write(source, null);
    prepareClaudeHome(a, source);
    assert.equal(claudeCredentialStore.read(a), null);
    assert.throws(() => prepareClaudeHome(a, a), /separate/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("refresh synchronization never overwrites a relogin, logout or another runner's refresh", () => {
  const root = mkdtempSync(resolve(tmpdir(), "claude-auth-test-"));
  const home = resolve(root, "workspace");
  const source = resolve(root, "account");
  const saved = new Map<string, ReturnType<typeof credential> | null>();
  const store: ClaudeCredentialStore = { read: key => saved.get(key) ?? null,
    write: (key, value) => { saved.set(key, value as ReturnType<typeof credential> | null); } };
  try {
    for (const changed of [undefined, null, credential("relogin", 20), credential("other-refresh", 3)]) {
      saved.set(source, credential("original"));
      const lease = prepareClaudeHome(home, source, store);
      saved.set(home, credential("refreshed", 2));
      if (changed !== undefined) saved.set(source, changed);
      lease.syncAuth();
      assert.deepEqual(saved.get(source), changed === undefined ? credential("refreshed", 2) : changed);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
