import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkspaceRecord } from "./sessionStore";

const sessionInspectorSkillName = "session-inspector";
const builtinSkillNames = [sessionInspectorSkillName, "browser-bridge", "threadex-config"] as const;

function injectSkill(workspace: WorkspaceRecord, sourceRoot: string, skillName: string) {
  const source = resolve(sourceRoot, skillName);
  if (!existsSync(resolve(source, "SKILL.md"))) {
    throw new Error(`Built-in skill source is missing: ${source}`);
  }

  const destination = resolve(workspace.codexHome, "skills", skillName);
  mkdirSync(resolve(workspace.codexHome, "skills"), { recursive: true, mode: 0o700 });
  try {
    const existing = lstatSync(destination);
    if (existing.isSymbolicLink() && resolve(workspace.codexHome, "skills", readlinkSync(destination)) === source) {
      return destination;
    }
    rmSync(destination, { recursive: true, force: true });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  symlinkSync(source, destination, "dir");
  return destination;
}

export function injectSessionInspectorSkill(workspace: WorkspaceRecord, sourceRoot: string) {
  return injectSkill(workspace, sourceRoot, sessionInspectorSkillName);
}

export function injectSessionInspectorSkills(workspaces: WorkspaceRecord[], sourceRoot: string) {
  return workspaces.map((workspace) => injectSessionInspectorSkill(workspace, sourceRoot));
}

export function injectBuiltinSkills(workspace: WorkspaceRecord, sourceRoot: string) {
  const destinations = builtinSkillNames.map((skillName) => injectSkill(workspace, sourceRoot, skillName));
  injectBrowserBridgeRule(workspace);
  return destinations;
}

export function injectBuiltinSkillsForWorkspaces(workspaces: WorkspaceRecord[], sourceRoot: string) {
  return workspaces.flatMap((workspace) => injectBuiltinSkills(workspace, sourceRoot));
}

function injectBrowserBridgeRule(workspace: WorkspaceRecord) {
  const rulesDirectory = resolve(workspace.codexHome, "rules");
  mkdirSync(rulesDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    resolve(rulesDirectory, "browser-bridge.rules"),
    `prefix_rule(pattern=${JSON.stringify(["browser-bridge"])}, decision="allow", justification="Allow the authenticated Local Browser Bridge CLI to reach its loopback daemon")\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}
