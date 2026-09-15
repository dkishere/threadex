#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const configuredCli = process.env.LOCAL_BROWSER_BRIDGE_CLI;
const sourceTreeCli = fileURLToPath(new URL("../../../local-browser-bridge/dist/bin/browser-bridge.js", import.meta.url));
const threadexCli = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "../../../local-browser-bridge/dist/bin/browser-bridge.js");
const cliPath = [configuredCli, sourceTreeCli, threadexCli]
  .find((candidate) => typeof candidate === "string" && existsSync(candidate));

if (!cliPath) {
  process.stderr.write(
    "browser-bridge: Local Browser Bridge is not built. Run `npm run browser-bridge:build` in Threadex.\n"
  );
  process.exitCode = 1;
} else {
  process.env.LOCAL_BROWSER_BRIDGE_RESTRICT_OUTPUTS = "1";
  const child = spawn(process.execPath, [cliPath, ...process.argv.slice(2)], { stdio: "inherit" });
  child.once("error", (error) => {
    process.stderr.write(`browser-bridge: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
