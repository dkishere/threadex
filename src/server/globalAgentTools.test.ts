import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GlobalAgentTools, REDACTED_SECRET_VALUE, claudeGlobalMcpServersConfig, codexGlobalMcpServersConfig,
  createGlobalAgentToolsRouter, resolveGlobalAgentToolInjection, syncGlobalSkillLinks, writePrivateClaudeMcpConfig
} from "./globalAgentTools";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "threadex-global-tools-"));
  const skills = join(dir, "skills-source");
  for (const name of ["alpha", "beta"]) {
    mkdirSync(join(skills, name), { recursive: true });
    writeFileSync(join(skills, name, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n`);
  }
  const single = join(dir, "gamma");
  mkdirSync(single);
  writeFileSync(join(single, "SKILL.md"), "---\nname: gamma\ndescription: test\n---\n");
  return { dir, skills, single, configPath: join(dir, "global-agent-tools.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const stdioServer = { name: "docs", transport: "stdio", command: process.execPath, args: ["server.js"], env: { API_TOKEN: "secret-token-value" } };
const httpServer = { name: "remote", transport: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer secret-header" }, providers: ["claude"] };

test("API stores secrets privately, returns them redacted and keeps them when the placeholder is sent back", async () => {
  const paths = fixture();
  const app = express();
  app.use(express.json());
  app.use("/settings", createGlobalAgentToolsRouter(new GlobalAgentTools(paths.configPath)));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/settings`;
  const put = (config: unknown) => fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config }) });
  try {
    const saved = await put({ mcpServers: [stdioServer, httpServer], skills: [{ path: paths.skills }] });
    assert.equal(saved.status, 200);
    const body = await saved.json();
    assert.equal(JSON.stringify(body).includes("secret"), false);
    assert.deepEqual(body.config.mcpServers[0].env, { API_TOKEN: REDACTED_SECRET_VALUE });
    assert.deepEqual(body.config.mcpServers[0].providers, ["codex", "claude"]);
    assert.equal(body.config.skills[0].enabled, true);
    assert.equal(statSync(paths.configPath).mode & 0o777, 0o600);

    const loaded = await fetch(endpoint);
    assert.equal(loaded.headers.get("cache-control"), "no-store");
    const loadedBody = await loaded.json();
    assert.equal(JSON.stringify(loadedBody).includes("secret"), false);

    // Round-tripping the redacted document must not overwrite the stored secrets.
    assert.equal((await put(loadedBody.config)).status, 200);
    const stored = JSON.parse(readFileSync(paths.configPath, "utf8"));
    assert.equal(stored.mcpServers[0].env.API_TOKEN, "secret-token-value");
    assert.equal(stored.mcpServers[1].headers.Authorization, "Bearer secret-header");

    const rejected = [
      { mcpServers: [stdioServer, stdioServer] },
      { mcpServers: [{ ...stdioServer, name: "codex_image" }] },
      { mcpServers: [{ ...stdioServer, name: "bad name" }] },
      { mcpServers: [{ ...stdioServer, command: "threadex-command-that-does-not-exist" }] },
      { mcpServers: [{ ...httpServer, url: "file:///etc/passwd" }] },
      { mcpServers: [{ ...stdioServer, name: "fresh", env: { NEW_KEY: REDACTED_SECRET_VALUE } }] },
      { mcpServers: [{ ...stdioServer, providers: [] }] },
      { skills: [{ path: "relative/path" }] },
      { skills: [{ path: join(paths.dir, "missing") }] }
    ];
    for (const config of rejected) {
      const response = await put(config);
      assert.equal(response.status, 400, JSON.stringify(config));
      assert.equal(typeof (await response.json()).error, "string");
    }
    assert.equal(JSON.parse(readFileSync(paths.configPath, "utf8")).mcpServers.length, 2);

    assert.deepEqual((await (await put({ mcpServers: [], skills: [] })).json()).config, { mcpServers: [], skills: [] });
    assert.equal(existsSync(paths.configPath), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    paths.cleanup();
  }
});

test("runner injection filters by provider, enabled and read-only, and skips broken items with safe warnings", () => {
  const paths = fixture();
  try {
    writeFileSync(paths.configPath, JSON.stringify({
      mcpServers: [stdioServer, httpServer,
        { ...stdioServer, name: "off", enabled: false },
        { ...stdioServer, name: "gone", command: "/nonexistent/threadex-mcp", env: { TOKEN: "secret-gone" } }],
      skills: [{ path: paths.skills }, { path: paths.single, providers: ["codex"] }, { path: join(paths.dir, "deleted") },
        { path: join(paths.skills, "alpha") }]
    }));
    const codex = resolveGlobalAgentToolInjection({ path: paths.configPath, provider: "codex", readOnly: false });
    assert.deepEqual(codex.mcpServers.map(server => server.name), ["docs"]);
    assert.deepEqual(codex.skills.map(skill => skill.name), ["alpha", "beta", "gamma"]);
    assert.equal(codex.warnings.length, 3);
    assert.match(codex.warnings.join("\n"), /"gone" was skipped/);
    assert.match(codex.warnings.join("\n"), /deleted" was skipped/);
    assert.match(codex.warnings.join("\n"), /"alpha" .* already provides it/);
    assert.equal(codex.warnings.join("\n").includes("secret"), false);

    const claude = resolveGlobalAgentToolInjection({ path: paths.configPath, provider: "claude", readOnly: false });
    assert.deepEqual(claude.mcpServers.map(server => server.name), ["docs", "remote"]);
    assert.deepEqual(claude.skills.map(skill => skill.name), ["alpha", "beta"]);

    const readOnly = resolveGlobalAgentToolInjection({ path: paths.configPath, provider: "claude", readOnly: true });
    assert.deepEqual(readOnly.mcpServers, []);
    assert.deepEqual(readOnly.skills.map(skill => skill.name), ["alpha", "beta"]);

    writeFileSync(paths.configPath, "{not json");
    const broken = resolveGlobalAgentToolInjection({ path: paths.configPath, provider: "codex", readOnly: false });
    assert.deepEqual([broken.mcpServers, broken.skills], [[], []]);
    assert.match(broken.warnings[0], /ignored/);
    assert.deepEqual(resolveGlobalAgentToolInjection({ path: join(paths.dir, "absent.json"), provider: "codex", readOnly: false }),
      { mcpServers: [], skills: [], warnings: [] });
  } finally { paths.cleanup(); }
});

test("provider MCP configs use each CLI's own schema", () => {
  const servers = [
    { ...stdioServer, transport: "stdio" as const, enabled: true, providers: ["codex" as const] },
    { ...httpServer, transport: "http" as const, enabled: true, providers: ["claude" as const] }
  ];
  assert.deepEqual(codexGlobalMcpServersConfig(servers), {
    docs: { command: process.execPath, args: ["server.js"], env: { API_TOKEN: "secret-token-value" }, enabled: true },
    remote: { url: "https://mcp.example.com/mcp", http_headers: { Authorization: "Bearer secret-header" }, enabled: true }
  });
  assert.deepEqual(claudeGlobalMcpServersConfig(servers), {
    docs: { type: "stdio", command: process.execPath, args: ["server.js"], env: { API_TOKEN: "secret-token-value" } },
    remote: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer secret-header" } }
  });
});

test("private Claude MCP config file is owner-only and removed on cleanup", () => {
  const paths = fixture();
  try {
    const file = writePrivateClaudeMcpConfig({ docs: { type: "stdio", command: "x", args: [], env: { TOKEN: "s" } } }, paths.dir);
    assert.equal(statSync(file.path).mode & 0o777, 0o600);
    assert.equal(statSync(file.directory).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(readFileSync(file.path, "utf8")).mcpServers.docs.env, { TOKEN: "s" });
    file.cleanup();
    assert.equal(existsSync(file.directory), false);
    file.cleanup();
  } finally { paths.cleanup(); }
});

test("skill links only replace or remove links Threadex manages", () => {
  const paths = fixture();
  try {
    const home = join(paths.dir, "provider-home", "skills");
    mkdirSync(join(home, "beta"), { recursive: true }); // a built-in or user skill of the same name
    writeFileSync(join(home, "beta", "SKILL.md"), "own");
    const alpha = { name: "alpha", path: join(paths.skills, "alpha") };
    const beta = { name: "beta", path: join(paths.skills, "beta") };
    const gamma = { name: "gamma", path: paths.single };

    const first = syncGlobalSkillLinks(home, [alpha, beta, gamma]);
    assert.deepEqual(first.linked, ["alpha", "gamma"]);
    assert.match(first.warnings[0], /"beta" was skipped/);
    assert.equal(readlinkSync(join(home, "alpha")), alpha.path);
    assert.equal(lstatSync(join(home, "beta")).isDirectory(), true);

    // Idempotent for overlapping turns, then removes only links it created.
    assert.deepEqual(syncGlobalSkillLinks(home, [alpha, gamma]).linked, ["alpha", "gamma"]);
    const moved = { name: "alpha", path: join(paths.skills, "beta") };
    syncGlobalSkillLinks(home, [moved]);
    assert.equal(readlinkSync(join(home, "alpha")), moved.path);
    assert.equal(existsSync(join(home, "gamma")), false);
    syncGlobalSkillLinks(home, []);
    assert.equal(existsSync(join(home, "alpha")), false);
    assert.equal(readFileSync(join(home, "beta", "SKILL.md"), "utf8"), "own");
    assert.equal(existsSync(join(home, ".threadex-global-skills.json")), false);
    assert.equal(existsSync(join(paths.skills, "alpha", "SKILL.md")), true);
  } finally { paths.cleanup(); }
});
