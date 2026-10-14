import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** Account homes supply authentication only. Native state belongs to a workspace. */
export function claudeAuthHome(env: NodeJS.ProcessEnv = process.env) {
  return resolve(env.THREADEX_CLAUDE_CONFIG_DIR || env.CLAUDE_CONFIG_DIR || resolve(homedir(), ".claude"));
}

export function workspaceClaudeHome(dataDir: string, workspaceId: string, authHome: string) {
  // IDs may come from imported workspaces; do not allow path traversal or collisions.
  return resolve(dataDir, "claude-homes", createHash("sha256").update(workspaceId).digest("hex"),
    createHash("sha256").update(resolve(authHome)).digest("hex"));
}

type Credentials = { claudeAiOauth: { accessToken: string; refreshToken?: string; expiresAt?: number; [key: string]: unknown } };
export type ClaudeCredentialStore = {
  read: (home: string) => Credentials | null;
  write: (home: string, credentials: Credentials | null) => void;
};

function credentialService(home: string) {
  return `Claude Code-credentials-${createHash("sha256").update(resolve(home)).digest("hex").slice(0, 8)}`;
}

function parseCredentials(raw: string): Credentials | null {
  const value = JSON.parse(raw);
  // Copy only the Claude login, never MCP credentials, project state or preferences.
  const oauth = value?.claudeAiOauth;
  return typeof oauth?.accessToken === "string" && oauth.accessToken
    ? { claudeAiOauth: oauth } : null;
}

function readKeychainRecord(service: string): Record<string, unknown> | null {
  try {
    return JSON.parse(execFileSync("/usr/bin/security", ["find-generic-password", "-s", service, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }));
  } catch (error) {
    if ((error as { status?: number }).status === 44) return null; // errSecItemNotFound
    throw new Error("Cannot read Claude login from Keychain. Unlock Keychain or log in to the selected Claude account again.");
  }
}

function readKeychain(service: string): Credentials | null {
  const record = readKeychainRecord(service);
  return record ? parseCredentials(JSON.stringify(record)) : null;
}

function mergeCredential(raw: Record<string, unknown>, credentials: Credentials | null) {
  const next = { ...raw };
  if (credentials) next.claudeAiOauth = credentials.claudeAiOauth;
  else delete next.claudeAiOauth;
  return next;
}

export function keychainServiceFor(home: string, readRecord = readKeychainRecord) {
  // A default CLI login with no CLAUDE_CONFIG_DIR uses the unsuffixed service.
  // An existing empty OAuth record is authoritative too: Claude clears it on
  // logout/refresh failure. Falling back to a file resurrects revoked tokens.
  if (readRecord(credentialService(home)) !== null) return credentialService(home);
  if (resolve(home) === resolve(homedir(), ".claude") && readRecord("Claude Code-credentials") !== null) return "Claude Code-credentials";
  return null;
}

export const claudeCredentialStore: ClaudeCredentialStore = {
  read(home) {
    if (process.platform === "darwin") {
      const service = keychainServiceFor(home);
      if (service) return readKeychain(service);
    }
    try { return parseCredentials(readFileSync(resolve(home, ".credentials.json"), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("Cannot read Claude login credentials. Log in to the selected Claude account again.");
    }
  },
  write(home, credentials) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const path = resolve(home, ".credentials.json");
    // Refreshes can create a Keychain entry even if the first login was supplied
    // by file. Keep an existing entry in sync; never put secrets in argv/errors.
    const service = process.platform === "darwin" ? keychainServiceFor(home) : null;
    if (service) {
      if (credentials) {
        const quoted = JSON.stringify(JSON.stringify(mergeCredential(readKeychainRecord(service) ?? {}, credentials)));
        const result = spawnSync("/usr/bin/security", ["-i"], {
          input: `add-generic-password -U -s ${JSON.stringify(service)} -a ${JSON.stringify(process.env.USER || "")} -w ${quoted}\n`,
          encoding: "utf8", stdio: ["pipe", "ignore", "pipe"], timeout: 5000
        });
        // Interactive security can exit zero after a failed subcommand.
        if (result.error || result.status !== 0 || /SecKeychain|error|failed/i.test(result.stderr ?? "")) throw new Error("Cannot synchronize Claude login credentials with Keychain.");
      } else {
        execFileSync("/usr/bin/security", ["delete-generic-password", "-s", service], { stdio: "ignore", timeout: 5000 });
      }
    }
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot update Claude login credentials: the credential file is unreadable."); }
    const updated = mergeCredential(existing, credentials);
    if (!Object.keys(updated).length) { rmSync(path, { force: true }); return; }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(updated), { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
      chmodSync(path, 0o600);
    } finally { rmSync(temporary, { force: true }); }
  }
};

/** Call inside the runner, so no credentials enter job files or runner events. */
export function prepareClaudeHome(home: string, sourceHome: string, store = claudeCredentialStore) {
  if (resolve(home) === resolve(sourceHome)) throw new Error("Claude execution home must be separate from its authentication home.");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const initial = store.read(sourceHome);
  store.write(home, initial);
  return {
    syncAuth() {
      const refreshed = store.read(home);
      const current = store.read(sourceHome);
      // A logout, relogin or another runner's refresh wins over this old turn.
      if (!initial || JSON.stringify(current) !== JSON.stringify(initial) || !refreshed) return;
      if (JSON.stringify(refreshed) !== JSON.stringify(initial) &&
        (refreshed.claudeAiOauth.expiresAt ?? 0) >= (initial.claudeAiOauth.expiresAt ?? 0)) store.write(sourceHome, refreshed);
    }
  };
}
