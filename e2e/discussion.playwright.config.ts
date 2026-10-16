import { defineConfig } from "@playwright/test";

// Component acceptance checks use API fixtures; no live Threadex server is restarted.
export default defineConfig({
  testDir: ".", testMatch: ["side-chat-detached.spec.ts", "actor-picker.spec.ts"], workers: 1,
  use: { baseURL: "http://127.0.0.1:5298", headless: true },
  webServer: { command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5298 --strictPort",
    cwd: "..", url: "http://127.0.0.1:5298", reuseExistingServer: false },
  reporter: "list"
});
