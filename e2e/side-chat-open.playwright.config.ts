import { defineConfig } from "@playwright/test";

// The fixture mocks all API reads and needs no database or runner.
export default defineConfig({
  testDir: ".", testMatch: "side-chat-open.spec.ts", workers: 1,
  use: { baseURL: "http://127.0.0.1:5299", headless: true },
  webServer: { command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5299 --strictPort",
    cwd: "..", url: "http://127.0.0.1:5299", reuseExistingServer: false },
  reporter: "list"
});
