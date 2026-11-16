import { defineConfig } from "@playwright/test";

// This presentation fixture mocks all API reads and does not need a database or runner.
export default defineConfig({
  testDir: ".",
  testMatch: "session-header.spec.ts",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5197", screenshot: "only-on-failure" },
  webServer: {
    cwd: new URL("..", import.meta.url).pathname,
    command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5197",
    url: "http://127.0.0.1:5197",
    reuseExistingServer: false,
  },
});
