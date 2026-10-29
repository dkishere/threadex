import { createInterface } from "node:readline";
const scenario = process.argv[2];
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=" };
let promptId;
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  switch (message.method) {
    case "initialize": send({ id: message.id, result: { protocolVersion: 1 } }); break;
    case "session/new":
      if (scenario === "auth") send({ id: message.id, error: { code: -32000, message: "Authentication required" } });
      else send({ id: message.id, result: { sessionId: "image-session" } });
      break;
    case "session/set_mode":
      if (message.params.modeId !== "read-only") process.exit(10);
      send({ id: message.id, result: {} }); break;
    case "session/prompt": {
      if (scenario === "exit") process.exit(12);
      if (scenario === "hang") break;
      if (scenario === "permission") {
        promptId = message.id;
        send({ id: "permission", method: "session/request_permission", params: { sessionId: "image-session", options: [{ optionId: "allow", kind: "allow_always" }] } });
        break;
      }
      if (scenario === "invalid-json") { process.stdout.write("not-json\n"); break; }
      if (scenario !== "no-image") {
        const content = scenario === "bad-image" ? { ...image, data: "bm90IGEgcG5n" } : image;
        // Both chunk and tool-call images occur; duplicates must be removed.
        send({ method: "session/update", params: { sessionId: "image-session", update: { sessionUpdate: "tool_call_update", content: [{ type: "content", content }] } } });
        send({ method: "session/update", params: { sessionId: "image-session", update: { sessionUpdate: "agent_message_chunk", content } } });
      }
      send({ id: message.id, result: { stopReason: "end_turn" } }); break;
    }
    case "session/cancel": process.exit(0);
    default:
      if (message.id === "permission") {
        if (message.result.outcome.outcome !== "cancelled") process.exit(11);
        send({ id: promptId, result: { stopReason: "cancelled" } });
      }
  }
});
