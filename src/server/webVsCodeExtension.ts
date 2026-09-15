import { cpSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const EXTENSION_ID = "threadex.threadex-review";
const EXTENSION_VERSION = "0.1.0";
const EXTENSION_DIRECTORY_NAME = `${EXTENSION_ID}-${EXTENSION_VERSION}-universal`;

type ExtensionRegistryEntry = {
  identifier?: { id?: string };
  [key: string]: unknown;
};

export function shouldAutoStartWebVsCodeServer(env: NodeJS.ProcessEnv, hasProcess: boolean) {
  return !env.SESSION_SERVER_SUPERVISOR_PID?.trim()
    && !env.WEB_VSCODE_URL?.trim()
    && env.WEB_VSCODE_AUTOSTART !== "false"
    && !hasProcess;
}

export function installBundledWebVsCodeReviewExtension(sourceDirectory: string, extensionsDirectory: string) {
  if (!existsSync(sourceDirectory)) return null;
  const targetDirectory = resolve(extensionsDirectory, EXTENSION_DIRECTORY_NAME);
  const legacyTargetDirectory = resolve(extensionsDirectory, `${EXTENSION_ID}-${EXTENSION_VERSION}`);
  rmSync(legacyTargetDirectory, { recursive: true, force: true });
  cpSync(sourceDirectory, targetDirectory, { recursive: true, force: true });

  const registryPath = resolve(extensionsDirectory, "extensions.json");
  const registry = readJsonArray(registryPath)
    .filter((entry) => entry.identifier?.id !== EXTENSION_ID);
  registry.push({
    identifier: { id: EXTENSION_ID },
    version: EXTENSION_VERSION,
    location: { $mid: 1, path: targetDirectory, scheme: "file" },
    relativeLocation: EXTENSION_DIRECTORY_NAME,
    metadata: {
      installedTimestamp: Date.now(),
      pinned: true,
      source: "vsix",
      targetPlatform: "universal",
      updated: false,
      private: true,
      isPreReleaseVersion: false,
      hasPreReleaseVersion: false
    }
  });
  atomicWriteJson(registryPath, registry);

  const obsoletePath = resolve(extensionsDirectory, ".obsolete");
  const obsolete = readJsonObject(obsoletePath);
  for (const key of Object.keys(obsolete)) {
    if (key === `${EXTENSION_ID}-${EXTENSION_VERSION}` || key === EXTENSION_DIRECTORY_NAME) {
      delete obsolete[key];
    }
  }
  atomicWriteJson(obsoletePath, obsolete);
  return targetDirectory;
}

function readJsonArray(path: string): ExtensionRegistryEntry[] {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object") : [];
  } catch {
    return [];
  }
}

function readJsonObject(path: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function atomicWriteJson(path: string, value: unknown) {
  const temporaryPath = `${path}.threadex-tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value), "utf8");
  renameSync(temporaryPath, path);
}
