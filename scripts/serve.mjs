#!/usr/bin/env node

// Keep the existing serve port without shell-specific environment assignment.
// Import the watcher in this process so it receives shutdown signals directly.
process.env.PORT = "5173";
await import("./watch-server.mjs");
