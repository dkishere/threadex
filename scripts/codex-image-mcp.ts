import { imageMcpServer, jsonLines } from "../src/server/codexImageMcp";

const requestedTimeout = Number(process.env.THREADEX_IMAGE_TIMEOUT_MS || 180_000);
const timeout = Number.isFinite(requestedTimeout) ? Math.min(600_000, Math.max(1000, requestedTimeout)) : 180_000;
let disconnected = false;
const server = imageMcpServer(message => {
  if (!disconnected) process.stdout.write(`${JSON.stringify(message)}\n`);
}, undefined, timeout);
const close = () => { disconnected = true; server.close(); process.stdin.destroy(); };
process.stdout.on("error", close);
process.stdin.on("error", close);
process.stdin.on("data", jsonLines(message => { void server.handle(message); }, error => {
  process.stderr.write(`${error.message}\n`);
  close();
}));
process.stdin.on("end", close);
process.once("SIGTERM", close);
process.once("SIGINT", close);
