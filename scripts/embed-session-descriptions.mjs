#!/usr/bin/env node

import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const storeId = args.storeId ?? args.db ?? process.env.SESSION_STORE_ID ?? process.env.SESSION_DB_PATH ?? "default";
const provider = args.provider ?? process.env.SESSION_EMBED_PROVIDER ?? "ollama";
const model = args.model ?? process.env.SESSION_EMBED_MODEL ?? (provider === "ollama" ? "mxbai-embed-large" : "");
const baseUrl = stripTrailingSlash(
  args.baseUrl ?? process.env.SESSION_EMBED_BASE_URL ?? (provider === "ollama" ? "http://127.0.0.1:11434" : "")
);
const apiKey = args.apiKey ?? process.env.SESSION_EMBED_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const batchSize = args.query ? 1 : (args.batchSize ?? 16);

if (!model) {
  throw new Error("--model or SESSION_EMBED_MODEL is required.");
}
if (!baseUrl) {
  throw new Error("--base-url or SESSION_EMBED_BASE_URL is required.");
}

if (args.query) {
  const embedding = (await embedTexts([args.query]))[0];
  console.log(JSON.stringify({ model, dimensions: embedding.length, embedding }));
  process.exit(0);
}

const { tsImport } = await import("tsx/esm/api");
const { SessionStore } = await tsImport(resolve(rootDir, "src/server/sessionStore.ts"), import.meta.url);
const store = new SessionStore(storeId);

try {
  await store.ready();

  const sessions = await store.listSessionsForDescriptionEmbedding({
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
  });
  const pending = sessions
    .map((session) => ({ ...session, descriptionHash: hashText(session.description) }))
    .filter((session) => args.force || session.descriptionHash !== session.existingHash || model !== session.existingModel);
  const selected = args.limit ? pending.slice(0, args.limit) : pending;

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          provider,
          model,
          candidates: sessions.length,
          pending: pending.length,
          selected: selected.length,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  let embedded = 0;
  for (let index = 0; index < selected.length; index += batchSize) {
    const batch = selected.slice(index, index + batchSize);
    const embeddings = await embedTexts(batch.map((session) => session.description));
    if (embeddings.length !== batch.length) {
      throw new Error(`Embedding provider returned ${embeddings.length} embeddings for ${batch.length} inputs.`);
    }

    for (let itemIndex = 0; itemIndex < batch.length; itemIndex += 1) {
      const embedding = normalizeEmbedding(embeddings[itemIndex]);
      await store.upsertSessionDescriptionEmbedding({
        sessionId: batch[itemIndex].id,
        embedding,
        model,
        descriptionHash: batch[itemIndex].descriptionHash,
      });
      embedded += 1;
    }

    console.log(`Embedded ${Math.min(index + batch.length, selected.length)}/${selected.length} descriptions`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        provider,
        model,
        candidates: sessions.length,
        pending: pending.length,
        embedded,
      },
      null,
      2,
    ),
  );
} finally {
  await store.close();
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--provider") {
      parsed.provider = requireValue(argv, ++index, arg);
    } else if (arg === "--model") {
      parsed.model = requireValue(argv, ++index, arg);
    } else if (arg === "--base-url") {
      parsed.baseUrl = requireValue(argv, ++index, arg);
    } else if (arg === "--api-key") {
      parsed.apiKey = requireValue(argv, ++index, arg);
    } else if (arg === "--store-id" || arg === "--db") {
      parsed.storeId = requireValue(argv, ++index, arg);
    } else if (arg === "--workspace-id") {
      parsed.workspaceId = requireValue(argv, ++index, arg);
    } else if (arg === "--session-id") {
      parsed.sessionId = requireValue(argv, ++index, arg);
    } else if (arg === "--limit") {
      parsed.limit = parsePositiveInteger(requireValue(argv, ++index, arg), arg);
    } else if (arg === "--batch-size") {
      parsed.batchSize = parsePositiveInteger(requireValue(argv, ++index, arg), arg);
    } else if (arg === "--query") {
      parsed.query = requireValue(argv, ++index, arg);
    } else if (arg === "--force") {
      parsed.force = true;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  throw new Error(`${flag} must be a positive integer.`);
}

function printHelp() {
  console.log(`Usage:
  npm run embed:session-descriptions -- [options]

Options:
  --provider ollama|openai-compatible   Default: ollama
  --model MODEL                         Default: mxbai-embed-large for ollama
  --base-url URL                        Default: http://127.0.0.1:11434 for ollama
  --store-id ID                         Optional store/schema id; --db is accepted as a legacy alias
  --workspace-id ID                     Only embed sessions in a workspace
  --session-id ID                       Only embed one local session
  --limit N                             Embed at most N stale/missing descriptions
  --batch-size N                        Default: 16
  --force                               Re-embed even when description hash/model match
  --dry-run                             Count work without writing embeddings
  --query TEXT                          Print one query embedding JSON instead of updating DB
`);
}

async function embedTexts(texts) {
  if (provider === "ollama") {
    return embedWithOllama(texts);
  }
  if (provider === "openai-compatible") {
    return embedWithOpenAICompatible(texts);
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

async function embedWithOllama(texts) {
  const response = await fetch(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
  });

  if (response.ok) {
    const parsed = await response.json();
    if (Array.isArray(parsed.embeddings)) {
      return parsed.embeddings;
    }
  }

  if (texts.length === 1) {
    const fallback = await fetch(`${baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: texts[0] }),
    });
    const parsed = await responseJsonOrThrow(fallback);
    if (Array.isArray(parsed.embedding)) {
      return [parsed.embedding];
    }
  }

  const text = await response.text().catch(() => "");
  throw new Error(`Ollama embedding request failed: HTTP ${response.status}${text ? ` ${text}` : ""}`);
}

async function embedWithOpenAICompatible(texts) {
  const response = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model, input: texts }),
  });
  const parsed = await responseJsonOrThrow(response);
  if (!Array.isArray(parsed.data)) {
    throw new Error("Embedding response is missing data array.");
  }
  return parsed.data.map((item) => item.embedding);
}

async function responseJsonOrThrow(response) {
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: text };
  }
  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && typeof parsed.error === "object" && typeof parsed.error.message === "string"
        ? parsed.error.message
        : parsed && typeof parsed === "object" && typeof parsed.error === "string"
          ? parsed.error
          : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return parsed;
}

function normalizeEmbedding(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Embedding provider returned an empty or invalid embedding.");
  }
  const embedding = value.map((item) => Number(item));
  if (!embedding.every((item) => Number.isFinite(item))) {
    throw new Error("Embedding provider returned non-numeric values.");
  }
  return embedding;
}

function hashText(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function stripTrailingSlash(value) {
  return value.replace(/\/$/, "");
}
