import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { cloneMappings, normalizePageValueMappings, type PageValueMapping } from "./pageValues.js";

export type BridgeConfig = {
  port: number;
  cliToken: string;
  extensionToken: string;
  extensionId: string | null;
  pageValueMappings: PageValueMapping[];
};

export function dataDirectory(): string {
  return process.env.LOCAL_BROWSER_BRIDGE_DATA_DIR || join(homedir(), ".local-browser-bridge");
}

export async function loadConfig(directory = dataDirectory(), overrides: Partial<BridgeConfig> = {}): Promise<BridgeConfig> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "config.json");
  let config: BridgeConfig;
  let created = false;
  try {
    config = JSON.parse(await readFile(path, "utf8")) as BridgeConfig;
  } catch (error: unknown) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    config = { port: 9327, cliToken: token(), extensionToken: token(), extensionId: null, pageValueMappings: [] };
    created = true;
  }
  const normalizedMappings = normalizeStoredMappings(config.pageValueMappings);
  const normalizedMappingsChanged = JSON.stringify(config.pageValueMappings ?? []) !== JSON.stringify(normalizedMappings);
  const loaded = { ...config, pageValueMappings: normalizedMappings, ...overrides };
  if (created || normalizedMappingsChanged || Object.keys(overrides).length > 0) await saveConfig(loaded, directory);
  return loaded;
}

export async function saveConfig(config: BridgeConfig, directory = dataDirectory()): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "config.json");
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function token(): string { return randomBytes(32).toString("base64url"); }
function normalizeStoredMappings(value: unknown): PageValueMapping[] { try { return normalizePageValueMappings(value ?? []); } catch { return []; } }
