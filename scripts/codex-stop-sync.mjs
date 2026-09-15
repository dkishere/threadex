#!/usr/bin/env node

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hookInput = await readStdinJson();
const managedByThreadex = process.env.THREADEX_MANAGED_RUNNER === "1";

const payload = {
  sessionId: stringValue(hookInput.session_id),
  turnId: stringValue(hookInput.turn_id),
  transcriptPath: stringValue(hookInput.transcript_path),
  cwd: stringValue(hookInput.cwd),
  codexHome: process.env.CODEX_HOME || resolve(homedir(), ".codex"),
  hookEventName: stringValue(hookInput.hook_event_name),
  managedByThreadex,
  managerSessionId: managedByThreadex ? stringValue(process.env.THREADEX_SESSION_ID) : undefined,
  managerTurnId: managedByThreadex ? stringValue(process.env.THREADEX_TURN_ID) : undefined,
  queuedAt: new Date().toISOString(),
};

if (!payload.transcriptPath) {
  process.exit(0);
}

const serverUrl = (
  process.env.THREADEX_HOOK_SERVER_URL ||
  process.env.THREADEX_SERVER_URL ||
  process.env.RUNNER_SERVER_URL ||
  `http://127.0.0.1:${process.env.PORT || "8787"}`
).replace(/\/$/, "");
const queuePath = resolve(
  process.env.SESSION_CODEX_HOOK_QUEUE_PATH || resolve(projectRoot, "data/codex-hook-queue.ndjson"),
);

try {
  await postJson(`${serverUrl}/api/codex/hooks/stop`, payload);
} catch {
  appendQueue(queuePath, payload);
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function postJson(url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function appendQueue(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(payload)}\n`, "utf8");
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
