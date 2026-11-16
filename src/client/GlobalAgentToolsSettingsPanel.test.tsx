import assert from "node:assert/strict";
import test from "node:test";
import { configFromDrafts, draftsFromConfig, type GlobalAgentToolsConfig } from "./GlobalAgentToolsSettingsPanel";

const redactedConfig: GlobalAgentToolsConfig = {
  mcpServers: [
    { name: "files", transport: "stdio", enabled: true, providers: ["codex", "claude"], command: "npx", args: ["-y", "files-server"], env: { API_KEY: "********" } },
    { name: "remote", transport: "http", enabled: false, providers: ["claude"], url: "https://example.com/mcp", headers: { Authorization: "********" } }
  ],
  skills: [{ path: "/skills", enabled: true, providers: ["codex"] }]
};

test("round trip sends redacted secret values back unchanged", () => {
  const { serverDrafts, skillDrafts } = draftsFromConfig(redactedConfig);
  assert.equal(serverDrafts[0].secretEntries[0].entryValue, "********");
  assert.deepEqual(configFromDrafts(serverDrafts, skillDrafts), redactedConfig);
});

test("typing a new secret value overrides the redacted one", () => {
  const { serverDrafts, skillDrafts } = draftsFromConfig(redactedConfig);
  serverDrafts[1].secretEntries[0].entryValue = "Bearer new";
  const config = configFromDrafts(serverDrafts, skillDrafts);
  assert.deepEqual(config.mcpServers[1].transport === "http" && config.mcpServers[1].headers, { Authorization: "Bearer new" });
});
