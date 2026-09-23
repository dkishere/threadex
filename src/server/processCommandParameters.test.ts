import assert from "node:assert/strict";
import test from "node:test";
import { interpolateCommandArgs, normalizeCommandParameters, resolveCommandValues } from "../processCommandParameters";

const definitions = [
  { name: "mode", desc: "Execution mode", type: "option", default: "fast", options: ["fast", "full"] },
  { name: "query", desc: "Search text", type: "string", default: "" },
  { name: "limit", desc: "Maximum results", type: "number", default: 10 }
];

test("parameter defaults and explicit values preserve types, zero and empty text", () => {
  const parameters = normalizeCommandParameters(definitions);
  assert.deepEqual(resolveCommandValues(parameters), { mode: "fast", query: "", limit: 10 });
  assert.deepEqual(resolveCommandValues(parameters, { mode: "full", query: "", limit: 0 }), { mode: "full", query: "", limit: 0 });
  const values = resolveCommandValues(parameters, { query: "hello world'; $(echo injected)", limit: 2.5 });
  assert.deepEqual(interpolateCommandArgs(["--query", "{{query}}", "--limit={{limit}}", "{{mode}}"], values),
    ["--query", "hello world'; $(echo injected)", "--limit=2.5", "fast"]);
});

test("invalid definitions and defaults are rejected at registration", () => {
  for (const invalid of [
    [{ name: "x", desc: "", type: "boolean", default: true }],
    [{ name: "x", desc: "", type: "number", default: "10" }],
    [{ name: "x", desc: "", type: "string" }],
    [{ name: "x", desc: "", type: "option", default: "fast", options: [] }],
    [{ name: "x", desc: "", type: "option", default: "fast", options: ["full"] }],
    [{ name: "x", desc: "", type: "option", default: "fast", options: ["fast", "fast"] }],
    [{ name: "bad-name", desc: "", type: "string", default: "" }],
    [definitions[0], definitions[0]],
    { name: "x" }
  ]) assert.throws(() => normalizeCommandParameters(invalid), /parameter/i);
});

test("launch rejects unknown names, wrong types, invalid options and nonfinite numbers", () => {
  const parameters = normalizeCommandParameters(definitions);
  for (const invalid of [{ extra: "x" }, { limit: "5" }, { limit: Infinity }, { limit: NaN }, { mode: "unknown" }, { query: 5 }, { query: "\0" }, null, []]) {
    assert.throws(() => resolveCommandValues(parameters, invalid), /parameter/i);
  }
  assert.throws(() => interpolateCommandArgs(["{{missing}}"], { query: "test" }), /Unknown parameter/);
  assert.deepEqual(interpolateCommandArgs(["{{query}}"], { query: "{{missing}}" }), ["{{missing}}"]);
});
