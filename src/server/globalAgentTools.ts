import { randomUUID } from "node:crypto";
import {
  accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, resolve } from "node:path";
import { Router } from "express";

/**
 * Threadex-owned MCP servers and skills injected into every Codex and Claude Code turn that
 * Threadex starts. Nothing here writes the user's ~/.codex or ~/.claude: MCP servers travel as
 * turn-local configuration and skills are linked into Threadex-managed provider homes.
 */
export const GLOBAL_AGENT_TOOL_PROVIDERS = ["codex", "claude"] as const;
export type GlobalAgentToolProvider = typeof GLOBAL_AGENT_TOOL_PROVIDERS[number];

type GlobalToolTarget = { enabled: boolean; providers: GlobalAgentToolProvider[] };
export type GlobalStdioMcpServer = GlobalToolTarget & {
  name: string; transport: "stdio"; command: string; args: string[]; env: Record<string, string>;
};
export type GlobalHttpMcpServer = GlobalToolTarget & {
  name: string; transport: "http"; url: string; headers: Record<string, string>;
};
export type GlobalMcpServer = GlobalStdioMcpServer | GlobalHttpMcpServer;
export type GlobalSkillSource = GlobalToolTarget & { path: string };
export type GlobalAgentToolsConfig = { mcpServers: GlobalMcpServer[]; skills: GlobalSkillSource[] };

/** Returned in place of every env and header value; sending it back keeps the stored value. */
export const REDACTED_SECRET_VALUE = "********";
/** Names Threadex already uses for its own MCP servers. */
export const RESERVED_MCP_SERVER_NAMES = ["codex_image", "session_inspector"] as const;
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SKILL_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_ITEMS = 64;
const MANAGED_SKILLS_MANIFEST = ".threadex-global-skills.json";

export class GlobalAgentToolsValidationError extends Error {}

const emptyConfig = (): GlobalAgentToolsConfig => ({ mcpServers: [], skills: [] });

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
  throw new GlobalAgentToolsValidationError(message);
}

function readProviders(value: unknown, label: string): GlobalAgentToolProvider[] {
  if (value === undefined) return [...GLOBAL_AGENT_TOOL_PROVIDERS];
  if (!Array.isArray(value) || !value.length || value.some(item => !GLOBAL_AGENT_TOOL_PROVIDERS.includes(item))) {
    fail(`${label}: providers must list one or more of ${GLOBAL_AGENT_TOOL_PROVIDERS.join(", ")}.`);
  }
  return GLOBAL_AGENT_TOOL_PROVIDERS.filter(provider => value.includes(provider));
}

function readEnabled(value: unknown, label: string) {
  if (value === undefined) return true;
  if (typeof value !== "boolean") fail(`${label}: enabled must be true or false.`);
  return value;
}

function readStringRecord(value: unknown, label: string, field: string, keyPattern: RegExp) {
  if (value === undefined) return {};
  if (!isRecord(value)) fail(`${label}: ${field} must be an object of text values.`);
  for (const [key, item] of Object.entries(value)) {
    if (!keyPattern.test(key)) fail(`${label}: ${field} name "${key}" is invalid.`);
    if (typeof item !== "string") fail(`${label}: ${field} "${key}" must be text.`);
  }
  return { ...value } as Record<string, string>;
}

export function commandIsAvailable(command: string, env: NodeJS.ProcessEnv = process.env) {
  const executable = (path: string) => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
  };
  if (command.includes("/") || command.includes("\\")) return isAbsolute(command) && executable(command);
  const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  return (env.PATH ?? "").split(delimiter).filter(Boolean)
    .some(directory => extensions.some(extension => executable(resolve(directory, command + extension))));
}

function parseMcpServer(value: unknown, index: number): GlobalMcpServer {
  const fallbackLabel = `MCP server ${index + 1}`;
  if (!isRecord(value)) fail(`${fallbackLabel} must be an object.`);
  const name = value.name;
  if (typeof name !== "string" || !MCP_SERVER_NAME_PATTERN.test(name)) {
    fail(`${fallbackLabel}: name must be 1-64 letters, digits, "_" or "-".`);
  }
  const label = `MCP server "${name}"`;
  if ((RESERVED_MCP_SERVER_NAMES as readonly string[]).includes(name)) fail(`${label}: this name is reserved by Threadex.`);
  const target = { enabled: readEnabled(value.enabled, label), providers: readProviders(value.providers, label) };
  const transport = value.transport ?? (typeof value.url === "string" ? "http" : "stdio");
  if (transport === "stdio") {
    if (typeof value.command !== "string" || !value.command.trim()) fail(`${label}: command is required.`);
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some(arg => typeof arg !== "string"))) {
      fail(`${label}: args must be a list of text values.`);
    }
    return { name, transport, ...target, command: value.command.trim(), args: [...(value.args as string[] | undefined ?? [])],
      env: readStringRecord(value.env, label, "env", ENV_NAME_PATTERN) };
  }
  if (transport === "http") {
    let url: URL;
    try { url = new URL(String(value.url)); } catch { fail(`${label}: url must be an http(s) URL.`); }
    if (url.protocol !== "http:" && url.protocol !== "https:") fail(`${label}: url must be an http(s) URL.`);
    return { name, transport, ...target, url: url.toString(), headers: readStringRecord(value.headers, label, "headers", HEADER_NAME_PATTERN) };
  }
  fail(`${label}: transport must be "stdio" or "http".`);
}

function parseSkillSource(value: unknown, index: number): GlobalSkillSource {
  const fallbackLabel = `Skill source ${index + 1}`;
  if (!isRecord(value)) fail(`${fallbackLabel} must be an object.`);
  if (typeof value.path !== "string" || !isAbsolute(value.path.trim())) fail(`${fallbackLabel}: path must be an absolute directory path.`);
  const path = resolve(value.path.trim());
  const label = `Skill source "${path}"`;
  return { path, enabled: readEnabled(value.enabled, label), providers: readProviders(value.providers, label) };
}

/** Structural validation only; the runner re-checks the filesystem because it can change after saving. */
export function parseGlobalAgentToolsConfig(value: unknown): GlobalAgentToolsConfig {
  if (!isRecord(value)) fail("Configuration must be an object with mcpServers and skills.");
  const rawServers = value.mcpServers ?? [];
  const rawSkills = value.skills ?? [];
  if (!Array.isArray(rawServers) || rawServers.length > MAX_ITEMS) fail(`mcpServers must be a list of at most ${MAX_ITEMS} servers.`);
  if (!Array.isArray(rawSkills) || rawSkills.length > MAX_ITEMS) fail(`skills must be a list of at most ${MAX_ITEMS} sources.`);
  const mcpServers = rawServers.map(parseMcpServer);
  const skills = rawSkills.map(parseSkillSource);
  const duplicateServer = mcpServers.find((server, index) => mcpServers.findIndex(other => other.name === server.name) !== index);
  if (duplicateServer) fail(`MCP server name "${duplicateServer.name}" is used more than once.`);
  const duplicateSkill = skills.find((skill, index) => skills.findIndex(other => other.path === skill.path) !== index);
  if (duplicateSkill) fail(`Skill source "${duplicateSkill.path}" is listed more than once.`);
  return { mcpServers, skills };
}

export type ResolvedSkill = { name: string; path: string };

/** A source is either one skill directory (has SKILL.md) or a directory of skill directories. */
export function listSkillsInSource(sourcePath: string): ResolvedSkill[] {
  if (!statSync(sourcePath).isDirectory()) throw new Error("is not a directory");
  if (existsSync(resolve(sourcePath, "SKILL.md"))) return [{ name: basename(sourcePath), path: sourcePath }];
  return readdirSync(sourcePath, { withFileTypes: true })
    .filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && existsSync(resolve(sourcePath, entry.name, "SKILL.md")))
    .map(entry => ({ name: entry.name, path: resolve(sourcePath, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Save-time checks the user can fix immediately: missing commands and empty skill folders. */
function assertConfigUsable(config: GlobalAgentToolsConfig, env: NodeJS.ProcessEnv) {
  for (const server of config.mcpServers) {
    if (server.transport === "stdio" && !commandIsAvailable(server.command, env)) {
      fail(`MCP server "${server.name}": command "${server.command}" was not found. Use an absolute path or a command on PATH.`);
    }
  }
  for (const source of config.skills) {
    let skills: ResolvedSkill[];
    try { skills = listSkillsInSource(source.path); }
    catch { fail(`Skill source "${source.path}" does not exist or is not a readable directory.`); }
    if (!skills.length) fail(`Skill source "${source.path}" contains no SKILL.md (directly or in a subdirectory).`);
    const invalid = skills.find(skill => !SKILL_NAME_PATTERN.test(skill.name));
    if (invalid) fail(`Skill source "${source.path}": skill directory "${invalid.name}" has an unsupported name.`);
  }
}

export function redactGlobalAgentToolsConfig(config: GlobalAgentToolsConfig): GlobalAgentToolsConfig {
  const redact = (values: Record<string, string>) => Object.fromEntries(Object.keys(values).map(key => [key, REDACTED_SECRET_VALUE]));
  return {
    mcpServers: config.mcpServers.map(server => server.transport === "stdio"
      ? { ...server, args: [...server.args], env: redact(server.env) }
      : { ...server, headers: redact(server.headers) }),
    skills: config.skills.map(skill => ({ ...skill, providers: [...skill.providers] }))
  };
}

/** A redacted placeholder keeps the stored secret of the same server and key. */
function restoreRedactedSecrets(next: GlobalAgentToolsConfig, previous: GlobalAgentToolsConfig): GlobalAgentToolsConfig {
  const restore = (values: Record<string, string>, stored: Record<string, string> | undefined, label: string) =>
    Object.fromEntries(Object.entries(values).map(([key, value]) => {
      if (value !== REDACTED_SECRET_VALUE) return [key, value];
      if (stored?.[key] === undefined) fail(`${label} "${key}" has no saved value; enter the value again.`);
      return [key, stored[key]];
    }));
  return {
    ...next,
    mcpServers: next.mcpServers.map(server => {
      const stored = previous.mcpServers.find(item => item.name === server.name && item.transport === server.transport);
      return server.transport === "stdio"
        ? { ...server, env: restore(server.env, (stored as GlobalStdioMcpServer | undefined)?.env, `MCP server "${server.name}" env`) }
        : { ...server, headers: restore(server.headers, (stored as GlobalHttpMcpServer | undefined)?.headers, `MCP server "${server.name}" header`) };
    })
  };
}

export class GlobalAgentTools {
  constructor(readonly path: string, private readonly env: NodeJS.ProcessEnv = process.env) {}

  read(): GlobalAgentToolsConfig {
    return existsSync(this.path) ? parseGlobalAgentToolsConfig(JSON.parse(readFileSync(this.path, "utf8"))) : emptyConfig();
  }

  readRedacted() {
    return redactGlobalAgentToolsConfig(this.read());
  }

  save(value: unknown): GlobalAgentToolsConfig {
    const config = restoreRedactedSecrets(parseGlobalAgentToolsConfig(value), this.read());
    assertConfigUsable(config, this.env);
    if (!config.mcpServers.length && !config.skills.length) {
      rmSync(this.path, { force: true });
      return emptyConfig();
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, this.path);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
    return redactGlobalAgentToolsConfig(config);
  }
}

export function createGlobalAgentToolsRouter(settings: GlobalAgentTools) {
  const router = Router();
  const respond = (res: { json: (body: unknown) => void }, config: GlobalAgentToolsConfig) =>
    res.json({ config, redactedValue: REDACTED_SECRET_VALUE, reservedMcpServerNames: RESERVED_MCP_SERVER_NAMES, providers: GLOBAL_AGENT_TOOL_PROVIDERS });
  router.get("/", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { respond(res, settings.readRedacted()); }
    catch { res.status(500).json({ error: "Unable to load global MCP and skill settings." }); }
  });
  router.put("/", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { respond(res, settings.save(req.body?.config)); }
    catch (error) {
      if (error instanceof GlobalAgentToolsValidationError) res.status(400).json({ error: error.message });
      else res.status(500).json({ error: "Unable to save global MCP and skill settings." });
    }
  });
  return router;
}

// ---------------------------------------------------------------- runner injection

export type GlobalAgentToolInjection = {
  mcpServers: GlobalMcpServer[];
  skills: ResolvedSkill[];
  /** Safe to show: names, paths and reasons only, never env or header values. */
  warnings: string[];
};

/** Loads the turn's share of the global settings, skipping (with a warning) anything unusable. */
export function resolveGlobalAgentToolInjection(input: {
  path: string | undefined; provider: GlobalAgentToolProvider; readOnly: boolean; env?: NodeJS.ProcessEnv;
}): GlobalAgentToolInjection {
  const injection: GlobalAgentToolInjection = { mcpServers: [], skills: [], warnings: [] };
  if (!input.path || !existsSync(input.path)) return injection;
  let config: GlobalAgentToolsConfig;
  try { config = parseGlobalAgentToolsConfig(JSON.parse(readFileSync(input.path, "utf8"))); }
  catch (error) {
    injection.warnings.push(`Global MCP/skill settings were ignored: ${error instanceof GlobalAgentToolsValidationError ? error.message : "the settings file is not valid JSON."}`);
    return injection;
  }
  const applies = (item: GlobalToolTarget) => item.enabled && item.providers.includes(input.provider);
  // Plan and read-only turns stay read-only: MCP tools can have side effects Threadex cannot vet.
  if (!input.readOnly) {
    for (const server of config.mcpServers.filter(applies)) {
      if (server.transport === "stdio" && !commandIsAvailable(server.command, input.env ?? process.env)) {
        injection.warnings.push(`Global MCP server "${server.name}" was skipped: command "${server.command}" was not found.`);
      } else {
        injection.mcpServers.push(server);
      }
    }
  }
  const seen = new Set<string>();
  for (const source of config.skills.filter(applies)) {
    let skills: ResolvedSkill[];
    try { skills = listSkillsInSource(source.path); }
    catch { injection.warnings.push(`Global skill source "${source.path}" was skipped: it does not exist or is not a directory.`); continue; }
    if (!skills.length) injection.warnings.push(`Global skill source "${source.path}" contains no SKILL.md.`);
    for (const skill of skills) {
      if (!SKILL_NAME_PATTERN.test(skill.name)) {
        injection.warnings.push(`Global skill "${skill.name}" was skipped: unsupported directory name.`);
      } else if (seen.has(skill.name)) {
        injection.warnings.push(`Global skill "${skill.name}" from "${source.path}" was skipped: an earlier source already provides it.`);
      } else {
        seen.add(skill.name);
        injection.skills.push(skill);
      }
    }
  }
  return injection;
}

/** Codex `mcp_servers` table for thread/start and thread/resume config (sent over stdin, never argv). */
export function codexGlobalMcpServersConfig(servers: GlobalMcpServer[]) {
  return Object.fromEntries(servers.map(server => [server.name, server.transport === "stdio"
    ? { command: server.command, args: server.args, ...(Object.keys(server.env).length ? { env: server.env } : {}), enabled: true }
    : { url: server.url, ...(Object.keys(server.headers).length ? { http_headers: server.headers } : {}), enabled: true }]));
}

export type ClaudeMcpServerConfig =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

export function claudeGlobalMcpServersConfig(servers: GlobalMcpServer[]): Record<string, ClaudeMcpServerConfig> {
  return Object.fromEntries(servers.map(server => [server.name, server.transport === "stdio"
    ? { type: "stdio" as const, command: server.command, args: server.args, env: server.env }
    : { type: "http" as const, url: server.url, ...(Object.keys(server.headers).length ? { headers: server.headers } : {}) }]));
}

/**
 * Claude's SDK passes `mcpServers` as JSON in argv, where other local processes can read secrets.
 * Write the turn's servers to a private file instead; the caller removes it when the turn ends.
 */
export function writePrivateClaudeMcpConfig(servers: Record<string, unknown>, parentDirectory = tmpdir()) {
  const directory = mkdtempSync(resolve(parentDirectory, "threadex-mcp-"));
  const path = resolve(directory, "mcp-config.json");
  writeFileSync(path, JSON.stringify({ mcpServers: servers }), { encoding: "utf8", mode: 0o600, flag: "wx" });
  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    rmSync(directory, { recursive: true, force: true });
    process.removeListener("exit", cleanup);
  };
  // The Claude runner exits straight from its SIGTERM handler; still remove the secret file.
  process.once("exit", cleanup);
  return { directory, path, cleanup };
}

function readManagedSkillNames(skillsDirectory: string): string[] {
  try {
    const value = JSON.parse(readFileSync(resolve(skillsDirectory, MANAGED_SKILLS_MANIFEST), "utf8"));
    return Array.isArray(value?.skills) ? value.skills.filter((name: unknown): name is string =>
      typeof name === "string" && SKILL_NAME_PATTERN.test(name)) : [];
  } catch { return []; }
}

function linkTarget(path: string) {
  try { return lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : null; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/**
 * Links the global skills into a Threadex-managed provider home (`<CODEX_HOME>/skills` or
 * `<CLAUDE_CONFIG_DIR>/skills`). Only links recorded in the manifest are ever replaced or removed,
 * so built-in and pre-existing skills win over a global skill of the same name.
 */
export function syncGlobalSkillLinks(skillsDirectory: string, skills: ResolvedSkill[]) {
  const warnings: string[] = [];
  mkdirSync(skillsDirectory, { recursive: true, mode: 0o700 });
  const previouslyManaged = new Set(readManagedSkillNames(skillsDirectory));
  const desired = new Map(skills.map(skill => [skill.name, skill.path]));
  const managed: string[] = [];
  for (const name of previouslyManaged) {
    if (desired.has(name)) continue;
    const destination = resolve(skillsDirectory, name);
    if (linkTarget(destination)) rmSync(destination, { force: true });
  }
  for (const [name, source] of desired) {
    const destination = resolve(skillsDirectory, name);
    const target = linkTarget(destination);
    if (target === resolve(source)) { managed.push(name); continue; }
    if (target !== undefined && !(previouslyManaged.has(name) && target !== null)) {
      warnings.push(`Global skill "${name}" was skipped: this provider home already has its own "${name}" skill.`);
      continue;
    }
    if (target) rmSync(destination, { force: true });
    try {
      // Junctions link directories on Windows without requiring symlink privileges.
      symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      // An overlapping turn of the same workspace may have linked it first.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || linkTarget(destination) !== resolve(source)) throw error;
    }
    managed.push(name);
  }
  const manifestPath = resolve(skillsDirectory, MANAGED_SKILLS_MANIFEST);
  if (!managed.length) {
    rmSync(manifestPath, { force: true });
  } else {
    const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify({ skills: managed }), { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, manifestPath);
    } finally { rmSync(temporaryPath, { force: true }); }
  }
  return { linked: managed, warnings };
}
