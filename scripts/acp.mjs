// Expose the minimal Threadex ACP agent over standard newline-delimited stdio.
// Usage: RUNNER_SERVER_URL=http://127.0.0.1:8787 node scripts/acp.mjs
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const base = (process.env.RUNNER_SERVER_URL || `http://127.0.0.1:${process.env.PORT || 8787}`).replace(/\/$/, "");
const connection = randomUUID();
const lines = createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
lines.on("line", async line => {
  let message;
  try {
    message = JSON.parse(line);
    const response = await fetch(`${base}/api/acp`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Threadex-ACP-Connection": connection },
      body: JSON.stringify(message)
    });
    if (!response.ok) throw new Error(`Threadex ACP HTTP ${response.status}: ${await response.text()}`);
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const row = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (row.trim()) send(JSON.parse(row));
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) send(JSON.parse(buffer));
  } catch (error) {
    if (!message) send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON." } });
    else if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error.message } });
    else process.stderr.write(`${error.message}\n`);
  }
});
