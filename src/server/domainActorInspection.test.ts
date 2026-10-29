import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createActorInspection, type ActorInspectionDependencies } from "./domainActorInspection";
import { actorInputBudget } from "./domainActorContext";
import { actorModelHooks } from "./domainActorRunner";
import type { SessionStore } from "./sessionStore";
import type { SessionSummarizer } from "./sessionSummarizer";

const bridge = { executable: "/trusted/browser-bridge", dataDir: "/trusted/config" };
const context = { kind: "browser-bridge-context", tabId: 42, "extension-context-key": "codex-browser-bridge:context:42:test" };
const memory = { rolePrompt: "Manage actor settings UI", roleSummary: "Actor settings", longTerm: "", rolling: "" };
type ResponseInput = Parameters<ReturnType<typeof actorModelHooks>["respond"]>[0];
const input = (userPrompt: string): ResponseInput => ({ actor: { id: "settings", workspaceId: "ws", memory },
  round: { userPrompt }, runningSessions: [], signal: new AbortController().signal } as unknown as ResponseInput);

test("manager job pickup reads potentially relevant ambiguous page context before deciding from the target", async () => {
  let calls = 0;
  const commands: string[][] = [];
  const events: unknown[] = [];
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async (_ws: string, task: string, prompt: string) => {
    assert.equal(task, "actor_stakeholder");
    assert.match(prompt, /could reasonably concern your responsibilities/);
    assert.match(prompt, /Do not inspect when the supplied context is sufficient/);
    assert.match(prompt, /inspection never authorizes deletion/);
    if (++calls === 1) return JSON.stringify({ contextRead: { tool: "page-context", tabId: 42 } });
    assert.match(prompt, /Actor settings: remove the avatar field/);
    assert.equal(commands.length, 1, "tool runs before final claim");
    return JSON.stringify({ intent: "work", inRole: true, claim: true, text: "I will clarify the selected avatar field removal.",
      preparedPrompt: "Clarify whether to remove the avatar field or its saved value before changing anything." });
  } } as unknown as SessionSummarizer, "http://unused", { bridge, run: async (executable, args) => {
    assert.equal(executable, bridge.executable); commands.push(args); return "Actor settings: remove the avatar field";
  } });
  const response = await hooks.respond({ ...input(`刪除\n\`\`\`json\n${JSON.stringify(context)}\n\`\`\``), onEvent: event => events.push(event) });
  assert.equal(response.claim, true); assert.match(response.preparedPrompt!, /before changing anything/);
  assert.deepEqual(commands, [["page-context", "42"]]); assert.equal(events.length, 1);
});

test("sufficient context and clearly unrelated requests finish without a browser call", async () => {
  for (const userPrompt of ["Remove the avatar field in actor settings UI", "Translate this recipe to French"]) {
    let toolCalls = 0;
    const inRole = userPrompt.startsWith("Remove");
    const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async () => JSON.stringify({ intent: "work", inRole, claim: inRole,
      text: inRole ? "I can remove the identified field" : "Outside my role", ...(inRole ? { preparedPrompt: "Remove the avatar field in actor settings UI" } : {}) }) } as unknown as SessionSummarizer,
      "http://unused", { bridge, run: async () => { toolCalls++; throw new Error("unnecessary read"); } });
    await hooks.respond(input(`${userPrompt}\n\`\`\`json\n${JSON.stringify(context)}\n\`\`\``)); assert.equal(toolCalls, 0);
  }
});

test("read results can establish that a browser-sourced target belongs to another role", async () => {
  let calls = 0;
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async (_ws: string, _task: string, prompt: string) => {
    if (++calls === 1) return JSON.stringify({ contextRead: { tool: "page-context", tabId: 42 } });
    assert.match(prompt, /Audio playback device selector/);
    return JSON.stringify({ intent: "work", inRole: false, claim: false, text: "Audio device settings are outside actor settings UI." });
  } } as unknown as SessionSummarizer, "http://unused", { bridge, run: async () => "Audio playback device selector" });
  const result = await hooks.respond(input(JSON.stringify(context)));
  assert.equal(result.inRole, false); assert.equal(result.claim, false); assert.equal(calls, 2);
});

test("large tool results fit the admission budget with an explicit truncation warning", async () => {
  let calls = 0;
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async (_ws: string, _task: string, prompt: string) => {
    assert.ok(Buffer.byteLength(prompt) <= actorInputBudget(null) + 384);
    if (++calls === 1) return JSON.stringify({ contextRead: { tool: "page-context", tabId: 42 } });
    assert.match(prompt, /Context truncated/);
    assert.match(prompt, /selected target may be missing/);
    return JSON.stringify({ intent: "work", inRole: false, claim: false, text: "The selected target was omitted; which field do you mean?" });
  } } as unknown as SessionSummarizer, "http://unused", { bridge, run: async () => "Large page text ".repeat(2000) });
  await hooks.respond(input(JSON.stringify(context))); assert.equal(calls, 2);
});

test("attachment lookup admits only supplied targets; snapshots are captured separately from live context", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-inspection-test-"));
  const path = join(root, "context.json");
  await writeFile(path, JSON.stringify(context));
  const commands: string[][] = [];
  try {
    const inspect = createActorInspection({ userPrompt: "刪除", attachments: [{ id: "file", name: "arbitrary.json", type: "application/json", size: 1, path }], signal: new AbortController().signal },
      { bridge, run: async (_exe, args) => { commands.push(args); await writeFile(args[2], JSON.stringify({ text: "captured target" })); return "{}"; } });
    assert.equal((await inspect({ tool: "page-context", tabId: 42 })).ok, false);
    assert.equal((await inspect({ tool: "attachment", attachmentId: "other", path })).ok, false);
    assert.equal((await inspect({ tool: "attachment", attachmentId: "file" })).ok, true);
    const result = await inspect({ tool: "context-snapshot", key: context["extension-context-key"] });
    assert.equal(result.ok, true); assert.match(result.data!, /captured target/);
    assert.equal(commands[0][0], "context-snapshot");
    await assert.rejects(import("node:fs/promises").then(fs => fs.stat(commands[0][2])), /ENOENT/, "scratch is removed");
    for (const request of [{ tool: "click", tabId: 42 }, { tool: "delete", tabId: 42 }, { tool: "evaluate", tabId: 42 },
      { tool: "page-context", tabId: 99 }, { tool: "context-snapshot", key: "codex-browser-bridge:context:unrelated" }]) {
      assert.equal((await inspect(request)).ok, false);
    }
    assert.equal(commands.length, 1, "destructive and unrelated requests never reach Chrome");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const failure of ["missing", "expired", "permission denied", "extension disconnected"]) {
  test(`job pickup receives actual ${failure} limitation for targeted clarification`, async () => {
    let calls = 0;
    const dependencies: ActorInspectionDependencies = { bridge: failure === "missing" ? undefined : bridge,
      run: async () => { throw new Error(failure); } };
    const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async (_ws: string, _task: string, prompt: string) => {
      if (++calls === 1) return JSON.stringify({ contextRead: { tool: "context-snapshot", key: context["extension-context-key"] } });
      assert.match(prompt, /"ok":false/);
      assert.ok(prompt.includes(failure === "missing" ? "CLI is unavailable" : failure));
      return JSON.stringify({ intent: "work", inRole: false, claim: false, text: `${failure}: which field do you mean?` });
    } } as unknown as SessionSummarizer, "http://unused", dependencies);
    const result = await hooks.respond(input(JSON.stringify(context)));
    assert.equal(result.claim, false); assert.match(result.text, /which field/);
  });
}

test("inspection cancellation propagates and repeated reads are bounded", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createActorInspection({ userPrompt: "", signal: controller.signal })({ tool: "attachment" }), /abort/i);
  let calls = 0;
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async () => {
    calls++; return JSON.stringify({ contextRead: { tool: "click", tabId: 42 } });
  } } as unknown as SessionSummarizer, "http://unused", { bridge, run: async () => { throw new Error("must never run"); } });
  await assert.rejects(hooks.respond(input(JSON.stringify(context))), /context tool limit/);
  assert.equal(calls, 5);
});
