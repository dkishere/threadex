// The background runner validates this exact argv and the read-only gh command
// before granting escalation. Restore HOME only in the CLI subprocess so native
// credential stores work without changing the actor's isolated HOME.
import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

const [hostHome, executable, ...args] = process.argv.slice(2);
if (!hostHome || !executable || !isAbsolute(hostHome) || !isAbsolute(executable)) {
  process.stderr.write("Expected an absolute host home and GitHub CLI executable.\n");
  process.exitCode = 1;
} else {
  const result = spawnSync(executable, args, { env: { ...process.env, HOME: hostHome }, stdio: "inherit" });
  if (result.error) process.stderr.write(`GitHub CLI failed: ${result.error.message}\n`);
  process.exitCode = result.status ?? 1;
}
