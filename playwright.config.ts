import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname);
const dataDir = resolve(root, ".e2e-data");
const apiUrl = "http://127.0.0.1:8791";
const clientUrl = "http://127.0.0.1:5191";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: {
    timeout: 8_000
  },
  outputDir: "test-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }]
  ],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: clientUrl,
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  webServer: [
    {
      command: "npm run e2e:server",
      url: `${apiUrl}/api/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        PORT: "8791",
        SESSION_DATA_DIR: dataDir,
        SESSION_DB_PATH: resolve(dataDir, "session-manager.duckdb"),
        CODEX_HOME: resolve(dataDir, "codex-home"),
        CODEX_WORKDIR: root,
        CODEX_ACC_STORE_DIR: resolve(dataDir, "codex-acc"),
        DUCKDB_HOME_DIRECTORY: resolve(dataDir, "duckdb-home"),
        DUCKDB_EXTENSION_DIRECTORY: resolve(root, ".duckdb/extensions"),
        EVENT_RING_CAPACITY: "8",
        ACCOUNT_QUOTA_REFRESH_INTERVAL_MS: "0",
        SESSION_SUMMARIZER_ENABLED: "false",
        SESSION_SUMMARIZER_IDLE_MS: "3600000",
        SESSION_SUMMARIZER_SWEEP_MS: "3600000",
        SESSION_SUMMARIZER_PROVIDER: "mock",
        SESSION_SUMMARIZER_MOCK_RESPONSE: "E2E summary"
      }
    },
    {
      command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5191",
      url: clientUrl,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        VITE_API_TARGET: apiUrl
      }
    }
  ]
});
