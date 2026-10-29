// Opt-in live probe: invokes Claude and Codex image generation using existing logins.
// npm_config_cache=/path/to/cache node --import tsx scripts/probe-codex-image-mcp.ts
import assert from "node:assert/strict";
import { codexImageMcpConfig, CODEX_IMAGE_TOOL } from "../src/server/codexImageMcp";
import { claudeEnvironment, loadSdk } from "../src/server/claudeRunner";

const sdk = await loadSdk();
const query = sdk.query({ prompt: (async function* () {
  yield { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content:
    `Call ${CODEX_IMAGE_TOOL} once with prompt "A minimal green cube on a white background, square image". After receiving the image, reply with its local PNG path. Do not use other tools.` } };
})(), options: {
  cwd: process.cwd(), tools: [], settingSources: [],
  mcpServers: codexImageMcpConfig({ cwd: process.cwd(), readOnly: false }),
  permissionMode: "default", maxTurns: 3,
  canUseTool: async (name: string, input: Record<string, unknown>) => name === CODEX_IMAGE_TOOL
    ? { behavior: "allow", updatedInput: input }
    : { behavior: "deny", message: "This probe allows only the Codex ACP image tool." },
  env: claudeEnvironment(process.env, {}),
  ...(process.env.THREADEX_CLAUDE_PATH ? { pathToClaudeCodeExecutable: process.env.THREADEX_CLAUDE_PATH } : {})
} });
const timer = setTimeout(() => { query.close?.(); }, 240_000);
let discovered = false;
let called = false;
let image = false;
let file = false;
try {
  for await (const raw of query) {
    const event = raw as any;
    if (event.type === "system" && event.subtype === "init") {
      discovered = event.tools?.includes(CODEX_IMAGE_TOOL) === true;
      console.log(JSON.stringify({ event: "discovery", discovered, servers: event.mcp_servers }));
    }
    if (event.type === "assistant") {
      for (const content of event.message?.content ?? []) {
        if (content.type === "tool_use" && content.name === CODEX_IMAGE_TOOL) called = true;
      }
    }
    if (event.type === "user") {
      for (const content of event.message?.content ?? []) {
        if (content.type !== "tool_result") continue;
        if (content.is_error) console.log(JSON.stringify({ event: "tool_error", content: content.content }));
        for (const block of Array.isArray(content.content) ? content.content : []) {
          if (block.type === "image") image = true;
          if (block.type === "text" && /threadex-generated-images-.*\.png/s.test(block.text)) file = true;
        }
      }
    }
    if (event.type === "result") console.log(JSON.stringify({ event: "result", subtype: event.subtype, errors: event.errors, text: event.result }));
  }
  console.log(JSON.stringify({ discovered, called, image, file }));
  assert.ok(discovered && called && image && file, "Claude must discover and call the tool and receive image content and a local path.");
} catch (error) {
  console.error(JSON.stringify({ discovered, called, image, file, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally { clearTimeout(timer); query.close?.(); }
