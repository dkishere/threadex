import { spawnSync } from "node:child_process";

const commandLineTools = "/Library/Developer/CommandLineTools";
type GitProbe = (env: NodeJS.ProcessEnv) => { status: number | null; stderr: string };

/** Recover from an Xcode update blocking Apple's Git, including child agents. */
export function configureDeveloperToolsEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  probe: GitProbe = env => spawnSync("/usr/bin/git", ["--version"], {
    env, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"]
  })
): boolean {
  if (platform !== "darwin" || env.DEVELOPER_DIR) return false;
  const current = probe(env);
  if (current.status === 0 || !/not agreed to the Xcode license agreements/i.test(current.stderr ?? "")) return false;
  const fallback = { ...env, DEVELOPER_DIR: commandLineTools };
  if (probe(fallback).status !== 0) return false;
  env.DEVELOPER_DIR = commandLineTools;
  return true;
}
