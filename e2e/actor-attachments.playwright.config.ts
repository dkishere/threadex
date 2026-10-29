import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "actor-attachments.spec.ts", workers: 1,
  outputDir: "/private/tmp/threadex-actor-attachments-results", reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5301", screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5301 --strictPort", cwd: "..", url: "http://127.0.0.1:5301", reuseExistingServer: false }
});
