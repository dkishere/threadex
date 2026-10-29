import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "action-notifications.spec.ts", workers: 1,
  outputDir: "/private/tmp/threadex-action-notifications-results", reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5307", screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5307 --strictPort", cwd: "..", url: "http://127.0.0.1:5307", reuseExistingServer: false,
    env: { SESSION_DATA_DIR: "/private/tmp/threadex-action-notifications-vite" } }
});
