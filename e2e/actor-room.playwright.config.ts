import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: ["actor-room.spec.ts", "manager-session.spec.ts"], workers: 1,
  outputDir: "/private/tmp/threadex-actor-room-results", reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5299", screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5299 --strictPort", cwd: "..", url: "http://127.0.0.1:5299", reuseExistingServer: false,
    env: { SESSION_DATA_DIR: "/private/tmp/threadex-actor-room-vite" } }
});
