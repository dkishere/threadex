import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { buildCodexExecArgs, createEphemeralAgentHome, type AgentCliExecInput } from "./agentCli.js";
import { modelTokenUsageFromCodexExecJson, normalizeModelTokenUsage } from "./modelTokenUsage.js";

function input(overrides: Partial<AgentCliExecInput> = {}): AgentCliExecInput {
  return {
    prompt: "Summarize this.",
    model: "gpt-5.6-luna",
    cwd: "/tmp",
    outputPath: "/tmp/last-message.txt",
    timeoutMs: 1000,
    ...overrides
  };
}

test("agent CLI reasoning effort is passed as a Codex config override", () => {
  const args = buildCodexExecArgs(input({ reasoningEffort: "low" }));
  const configIndex = args.indexOf('model_reasoning_effort="low"');
  assert.ok(configIndex > 0);
  assert.equal(args[configIndex - 1], "-c");
});

test("agent CLI supports none effort for latency-sensitive Luna helpers", () => {
  const args = buildCodexExecArgs(input({ reasoningEffort: "none" }));
  assert.ok(args.includes('model_reasoning_effort="none"'));
});

test("agent CLI callers without an effort keep the existing argument list", () => {
  const args = buildCodexExecArgs(input());
  assert.equal(args.some((argument) => argument.startsWith("model_reasoning_effort=")), false);
});

test("agent CLI accepts caller-owned config overrides", () => {
  const args = buildCodexExecArgs(input({
    configOverrides: ["features.shell_tool=false", "features.unified_exec=false"]
  }));
  assert.ok(args.includes("features.shell_tool=false"));
  assert.ok(args.includes("features.unified_exec=false"));
  assert.equal(args[args.indexOf("features.shell_tool=false") - 1], "-c");
});

test("ephemeral agent homes can copy auth without user config", () => {
  const source = mkdtempSync(resolve(tmpdir(), "agent-cli-source-"));
  writeFileSync(resolve(source, "auth.json"), "{}", "utf8");
  writeFileSync(resolve(source, "config.toml"), "[mcp_servers.example]", "utf8");
  const isolated = createEphemeralAgentHome({
    prefix: "agent-cli-isolated-",
    sourceHomeCandidates: [source],
    copyConfig: false
  });
  try {
    assert.equal(existsSync(resolve(isolated.home, "auth.json")), true);
    assert.equal(existsSync(resolve(isolated.home, "config.toml")), false);
  } finally {
    isolated.cleanup();
    rmSync(source, { recursive: true, force: true });
  }
});

test("normalizes app-server token usage for background model calls", () => {
  assert.deepEqual(normalizeModelTokenUsage({
    inputTokens: 120,
    cachedInputTokens: 20,
    outputTokens: 30,
    reasoningOutputTokens: 5,
    totalTokens: 150
  }), {
    inputTokens: 120,
    cachedInputTokens: 20,
    outputTokens: 30,
    reasoningOutputTokens: 5,
    totalTokens: 150
  });
});

test("prefers per-turn usage over cumulative usage for persistent helpers", () => {
  assert.deepEqual(normalizeModelTokenUsage({
    last: { inputTokens: 12, outputTokens: 3 },
    total: { inputTokens: 120, outputTokens: 30 }
  }), {
    inputTokens: 12,
    cachedInputTokens: 0,
    outputTokens: 3,
    reasoningOutputTokens: 0,
    totalTokens: 15
  });
});

test("extracts the final usage record from Codex exec JSONL", () => {
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    "non-json diagnostic",
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 90,
        cached_input_tokens: 10,
        output_tokens: 25,
        output_tokens_details: { reasoning_tokens: 4 }
      }
    })
  ].join("\n");
  assert.deepEqual(modelTokenUsageFromCodexExecJson(stdout), {
    inputTokens: 90,
    cachedInputTokens: 10,
    outputTokens: 25,
    reasoningOutputTokens: 4,
    totalTokens: 115
  });
});
