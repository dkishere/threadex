import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { openPostgresSessionConnection, postgresSchemaFromStoreId } from "../../src/server/sessionDb.js";
import { SessionStore } from "../../src/server/sessionStore.js";
import { scenarioSessions, seededSessions } from "./scenarios.js";

const root = resolve(import.meta.dirname, "../..");
const dataDir = resolve(process.env.SESSION_DATA_DIR ?? resolve(root, ".e2e-data"));
const dbPath = resolve(process.env.SESSION_DB_PATH ?? resolve(dataDir, "session-manager.duckdb"));

rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(resolve(dataDir, "runner-logs"), { recursive: true });
mkdirSync(resolve(dataDir, "codex-home"), { recursive: true });

// SESSION_DB_PATH now selects a PostgreSQL schema, so deleting the legacy data
// directory alone does not reset E2E state between runs.
const testSchema = postgresSchemaFromStoreId(dbPath);
if (!testSchema || !/^sm_[a-f0-9]{24}$/.test(testSchema)) {
  throw new Error(`Refusing to reset unexpected E2E PostgreSQL schema: ${testSchema ?? "default"}`);
}
const resetConnection = await openPostgresSessionConnection(undefined, null);
try {
  await resetConnection.run(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
} finally {
  await resetConnection.close();
}

const store = new SessionStore(dbPath);
await store.ready();

await store.upsertWorkspace({
  id: "e2e-background",
  name: "Background Monitor",
  codexHome: resolve(dataDir, "background-codex-home"),
  cwd: root
});
await store.upsertSession({
  id: "e2e-background-session",
  threadId: "thread-e2e-background-session",
  workspaceId: "e2e-background",
  cwd: root,
  title: "Background Active Session",
  description: "Deterministic inactive-workspace monitor fixture"
});
await store.recordSessionTurn({
  id: "e2e-background-turn",
  sessionId: "e2e-background-session",
  userInput: "Wait in the background",
  agentResponse: "",
  tokenIn: 0,
  tokenOut: 0,
  status: "running"
});
await store.upsertSession({
  id: "e2e-background-session-2",
  threadId: "thread-e2e-background-session-2",
  workspaceId: "e2e-background",
  cwd: root,
  title: "Background Second Session",
  description: "Second deterministic inactive-workspace monitor fixture"
});
await store.recordSessionTurn({
  id: "e2e-background-turn-2",
  sessionId: "e2e-background-session-2",
  userInput: "Also wait in the background",
  agentResponse: "",
  tokenIn: 0,
  tokenOut: 0,
  status: "todo"
});

for (const session of seededSessions) {
  await store.upsertSession({
    id: session.id,
    threadId: `thread-${session.id}`,
    workspaceId: "default",
    cwd: root,
    title: session.title,
    description: `Deterministic E2E fixture for ${session.title}`
  });
  await store.recordSessionTurn({
    id: `${session.id}-baseline`,
    sessionId: session.id,
    userInput: `Prompt for ${session.title}`,
    agentResponse: `Snapshot response for ${session.title}`,
    tokenIn: 10,
    tokenOut: 20,
    status: "done"
  });
}

await store.setWorkspaceModelPreferences("default", {
  selectedModel: "gpt-5.6-luna",
  selectedEffort: "xhigh",
  gearProfiles: [
    { model: "gpt-5.6-terra", effort: "low" },
    { model: "gpt-5.6-luna", effort: "xhigh" },
    { model: "gpt-5.4", effort: "medium" }
  ],
  activeGearIndex: 1
});

const composerScrollSession = scenarioSessions.composerScroll;
await store.upsertSession({
  id: composerScrollSession.id,
  threadId: `thread-${composerScrollSession.id}`,
  workspaceId: "default",
  cwd: root,
  title: composerScrollSession.title,
  description: "Deterministic long transcript fixture for composer scrolling"
});
for (let index = 0; index < 28; index += 1) {
  await store.recordSessionTurn({
    id: `${composerScrollSession.id}-turn-${index + 1}`,
    sessionId: composerScrollSession.id,
    userInput: `Scrollable prompt ${index + 1}`,
    agentResponse: `Scrollable response ${index + 1}\n${"Additional fixture content keeps the transcript scrollable.\n".repeat(8)}`,
    tokenIn: 10,
    tokenOut: 20,
    status: "done"
  });
}

await store.upsertWorkspace({
  id: "e2e-profile-analytics",
  name: "Profile Analytics",
  codexHome: resolve(dataDir, "profile-codex-home"),
  cwd: root
});
await store.upsertAccount({ id: "e2e-profile-saved-account", name: "Saved profile account" });
await store.upsertAccount({ id: "e2e-profile-deleted-account", name: "Deleted profile account" });
for (const account of [
  { id: "e2e-profile-saved-account", inputTokens: 10, cachedInputTokens: 4, outputTokens: 20 },
  { id: "e2e-profile-deleted-account", inputTokens: 111, cachedInputTokens: 44, outputTokens: 222 }
]) {
  const sessionId = `${account.id}-session`;
  const turnId = `${account.id}-turn`;
  await store.upsertSession({
    id: sessionId,
    threadId: `thread-${sessionId}`,
    workspaceId: "e2e-profile-analytics",
    accountId: account.id,
    cwd: root,
    title: account.id,
    description: "Profile analytics account filtering fixture"
  });
  await store.recordSessionTurn({
    id: turnId,
    sessionId,
    accountId: account.id,
    userInput: "Profile input",
    agentResponse: "Profile output",
    tokenIn: account.inputTokens,
    tokenOut: account.outputTokens,
    status: "done"
  });
  await store.recordTokenUsage([{
    id: `agent:turn:${turnId}`,
    usageType: "agent",
    source: "app_server",
    workspaceId: "e2e-profile-analytics",
    sessionId,
    turnId,
    accountId: account.id,
    model: "gpt-profile",
    inputTokens: account.inputTokens,
    cachedInputTokens: account.cachedInputTokens,
    outputTokens: account.outputTokens,
    totalTokens: account.inputTokens + account.outputTokens
  }]);
}
await store.deleteAccount("e2e-profile-deleted-account");

await store.switchSession(scenarioSessions.bootstrap.id);
await store.close();

await import("../../src/server/index.js");
