import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { mirrorProcessOutputToFile } from "./src/supervisorOutput";

const dataDir = resolve(process.env.SESSION_DATA_DIR ?? resolve(process.cwd(), "data"));
if (!process.argv.includes("build")) {
  mirrorProcessOutputToFile(resolve(dataDir, "process-supervisors", "client.log"));
}

export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      ignored: [
        "**/data/**",
        "**/dist/**",
        "**/node_modules/**",
        "**/.git/**",
        "**/tsconfig.tsbuildinfo",
      ],
    },
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://localhost:8787",
        // Keep the browser-facing host so the API's same-origin check matches.
        changeOrigin: false
      }
    }
  }
});
