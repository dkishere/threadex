import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const page = await readFile(fileURLToPath(new URL("../examples/website-client.html", import.meta.url)));
const port = Number.parseInt(process.env.LOCAL_BROWSER_BRIDGE_EXAMPLE_PORT || "9410", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("LOCAL_BROWSER_BRIDGE_EXAMPLE_PORT must be a valid port.");

const server = createServer((request, response) => {
  if (request.url !== "/" && request.url !== "/index.html") { response.statusCode = 404; response.end("Not found"); return; }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(page);
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`Website Bridge example: http://127.0.0.1:${port}/\n`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
