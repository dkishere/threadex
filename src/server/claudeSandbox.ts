import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AppServerThreadOptions } from "./codexConfig";

export type ClaudeSandboxMode = AppServerThreadOptions["sandbox"];
const edits = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function canonical(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) return path;
    return resolve(canonical(parent), relative(parent, path));
  }
}

function within(root: string, path: string) {
  const part = relative(root, path);
  return !part || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

/** File tools run outside Bash's OS sandbox. Gate even auto-accepted edits. */
export function claudeToolBoundary(input: {
  cwd: string; mode: ClaudeSandboxMode; tool: string; args: Record<string, unknown>; protectedPaths?: string[];
}): string | null {
  if (input.mode === "danger-full-access") return null;
  if (input.mode === "read-only" && (edits.has(input.tool) || input.tool === "Bash")) return "This Threadex turn is read-only.";
  if (input.tool === "Bash" && input.args.dangerouslyDisableSandbox === true) return "Threadex requires this command to run inside the workspace sandbox.";
  if (!edits.has(input.tool)) return null;
  const path = input.args.file_path ?? input.args.notebook_path;
  if (typeof path !== "string" || !path) return "A file path is required.";
  try {
    const target = canonical(resolve(input.cwd, path));
    const roots = [input.cwd, tmpdir(), "/tmp"].map(root => canonical(resolve(root)));
    const protectedPaths = [...(input.protectedPaths ?? []), ...[".git", ".agents", ".codex", ".claude"].map(name => resolve(input.cwd, name))];
    if (protectedPaths.some(root => within(canonical(resolve(root)), target))) return "This path contains protected workspace configuration or agent state.";
    if (!roots.some(root => within(root, target))) return "This file is outside the Threadex workspace and temporary directories.";
  } catch { return "Threadex could not verify this file's workspace boundary."; }
  return null;
}

export function claudeSandboxOptions(mode: ClaudeSandboxMode, cwd: string, protectedPaths: string[] = [], allowEscalation = false) {
  if (mode === "danger-full-access") return { sandbox: { enabled: false } };
  const sandbox = {
    enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: allowEscalation,
    autoAllowBashIfSandboxed: false, excludedCommands: [],
    enableWeakerNestedSandbox: false, enableWeakerNetworkIsolation: false,
    // The managed-domain lock also makes the native sandbox admin-required:
    // repository settings cannot add excluded commands or writable directories.
    // Writable turns may use loopback so local test databases and dev servers work without
    // sandbox escapes. Accepted risk: loopback also reaches Threadex's own API, which trusts
    // direct local requests (security.ts), and its Postgres. Read-only turns stay closed.
    // Writable turns also share the uv cache and the Docker socket so routine builds and image
    // checks need no escape. Accepted risk: Docker socket access is effectively host access.
    network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true, allowManagedDomainsOnly: true,
      allowAllUnixSockets: false,
      allowUnixSockets: mode === "read-only" ? [] : ["/var/run/docker.sock", resolve(homedir(), ".docker", "run", "docker.sock")],
      allowLocalBinding: mode !== "read-only" },
    filesystem: {
      disabled: false,
      allowWrite: mode === "read-only" ? [] : [resolve(cwd), tmpdir(), "/tmp", process.env.UV_CACHE_DIR || resolve(homedir(), ".cache", "uv")],
      denyWrite: [...protectedPaths, ...[".git", ".agents", ".codex", ".claude"].map(name => resolve(cwd, name)), ...(mode === "read-only" ? [resolve(cwd)] : [])]
    }
  };
  return { sandbox, managedSettings: { sandbox } };
}
