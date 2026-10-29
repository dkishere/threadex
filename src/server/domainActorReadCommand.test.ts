import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { actorReadCommand } from "./domainActorReadCommand";
import { createActorInspection } from "./domainActorInspection";
import { actorModelHooks } from "./domainActorRunner";
import type { SessionStore } from "./sessionStore";
import type { SessionSummarizer } from "./sessionSummarizer";

test("project read commands run without Browser Bridge and retain the server project binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-read-command-"));
  try {
    await mkdir(join(root, "src")); await writeFile(join(root, "src", "target.txt"), "actor settings target\n");
    const inspect = createActorInspection({ userPrompt: "Check the target", workspaceCwd: root, signal: new AbortController().signal });
    assert.deepEqual(await inspect({ tool: "read-command", command: "cat", args: ["src/target.txt"] }), { ok: true, data: "actor settings target\n" });
    const matches = await inspect({ tool: "read-command", command: "rg", args: ["-n", "--", "actor settings", "src"] });
    assert.equal(matches.ok, true); assert.match(matches.data!, /target.txt:1:actor settings target/);
    assert.deepEqual(await inspect({ tool: "read-command", command: "rg", args: ["-n", "--", "absent", "src"] }), { ok: true, data: "No matches." });
    let turns = 0;
    const hooks = actorModelHooks({ getWorkspace: async () => ({ cwd: root }) } as unknown as SessionStore, { runBackgroundJsonTask: async (_ws: string, _task: string, prompt: string) => {
      if (++turns === 1) { assert.match(prompt, /read BEFORE deciding/); return JSON.stringify({ contextRead: { tool: "read-command", command: "cat", args: ["src/target.txt"] } }); }
      assert.match(prompt, /actor settings target/);
      return JSON.stringify({ intent: "work", inRole: true, claim: true, text: "I can investigate the settings field.", preparedPrompt: "Investigate the actor settings field identified in src/target.txt." });
    } } as unknown as SessionSummarizer, "http://unused");
    const result = await hooks.respond({ actor: { id: "settings", workspaceId: "ws", memory: { rolePrompt: "Actor settings", roleSummary: "Settings", longTerm: "", rolling: "" } },
      round: { userPrompt: "Investigate the referenced field" }, runningSessions: [], signal: new AbortController().signal } as unknown as Parameters<typeof hooks.respond>[0]);
    assert.equal(result.claim, true); assert.equal(turns, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("command validation rejects writes, execution, unsafe flags, escaped paths and broad searches", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-read-validation-"));
  const outside = await mkdtemp(join(tmpdir(), "actor-read-outside-"));
  try {
    await mkdir(join(root, "src")); await mkdir(join(root, "data"));
    await symlink(outside, join(root, "src", "escape"));
    const invalid: Array<[string, string[]]> = [
      ["rm", ["src"]], ["sh", ["-c", "cat src"]], ["node", ["script.js"]], ["cat", [outside]], ["cat", ["src/escape"]], ["cat", ["data"]],
      ["rg", ["--pre", "script", "--", "x", "src"]], ["rg", ["--", "x", "."]], ["rg", ["--files", "--", "/"]],
      ["rg", ["-n", "--", "x"]], ["ls", ["-R", "."]], ["git", ["reset", "--hard"]], ["git", ["clean", "-fd"]],
      ["git", ["-c", "alias.x=!rm", "x"]], ["git", ["diff", "--output=src/file"]], ["git", ["diff", "--ext-diff"]],
      ["git", ["log", "--show-signature"]], ["git", ["status", "--", outside]]
    ];
    for (const [command, args] of invalid) await assert.rejects(actorReadCommand({ command, args }, root), /.+/, `${command} ${args.join(" ")}`);
    const git = await actorReadCommand({ command: "git", args: ["diff", "--stat", "--", "src"] }, root);
    assert.equal(git.cwd, await realpath(root));
    assert.deepEqual(git.args, ["--no-pager", "-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv", "--stat", "--", "src"]);
    const rg = await actorReadCommand({ command: "rg", args: ["-n", "--", "$(touch /tmp/should-not-run)", "src"] }, root);
    assert.equal(rg.args[0], "--no-config"); assert.ok(rg.args.includes("$(touch /tmp/should-not-run)"), "pattern stays literal argv");
    await assert.rejects(actorReadCommand({ command: "pwd", args: [] }), /directory is unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
