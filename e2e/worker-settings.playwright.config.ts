import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "worker-settings.spec.ts", workers: 1,
  outputDir: "/private/tmp/threadex-worker-settings-results", reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5304", screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5304 --strictPort", cwd: "..", url: "http://127.0.0.1:5304", reuseExistingServer: false,
    env: { SESSION_DATA_DIR: "/private/tmp/threadex-worker-settings-vite" } }
});
