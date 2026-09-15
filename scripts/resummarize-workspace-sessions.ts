#!/usr/bin/env node

import { SessionStore } from "../src/server/sessionStore";
import { SessionSummarizer } from "../src/server/sessionSummarizer";

type Args = {
  db?: string;
  workspaceId?: string;
  sessionId?: string;
  limit?: number;
  dryRun?: boolean;
};

const args = parseArgs(process.argv.slice(2));
const store = new SessionStore(args.db);
const summarizer = new SessionSummarizer(store);

try {
  const workspace = args.workspaceId ? await store.getWorkspace(args.workspaceId) : await store.getActiveWorkspace();
  if (!workspace) {
    throw new Error(args.workspaceId ? `Workspace not found: ${args.workspaceId}` : "No active workspace is available.");
  }

  const selectedSession = args.sessionId ? await store.getSession(args.sessionId) : null;
  if (args.sessionId && !selectedSession) {
    throw new Error(`Session not found: ${args.sessionId}`);
  }
  const sessions = selectedSession ? [selectedSession] : args.sessionId ? [] : await store.listSessions(workspace.id);
  const selected = args.limit ? sessions.slice(0, args.limit) : sessions;

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          sessions: sessions.length,
          selected: selected.length
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  let summarized = 0;
  let skipped = 0;
  let failed = 0;

  for (const [index, session] of selected.entries()) {
    try {
      await summarizer.forceSummarizeSession(session.id);
      summarized += 1;
      console.log(`Summarized ${index + 1}/${selected.length}: ${session.id}`);
    } catch (error) {
      failed += 1;
      skipped += 1;
      console.warn(`Skipped ${session.id}: ${errorMessage(error)}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: failed === 0,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        sessions: sessions.length,
        selected: selected.length,
        summarized,
        skipped,
        failed
      },
      null,
      2
    )
  );

  if (failed > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
} finally {
  await store.close();
}

function parseArgs(argv: string[]): Args {
  const parsed: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") {
      parsed.db = requireValue(argv, ++index, arg);
    } else if (arg === "--workspace-id") {
      parsed.workspaceId = requireValue(argv, ++index, arg);
    } else if (arg === "--session-id") {
      parsed.sessionId = requireValue(argv, ++index, arg);
    } else if (arg === "--limit") {
      parsed.limit = parsePositiveInteger(requireValue(argv, ++index, arg), arg);
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

function requireValue(argv: string[], index: number, flag: string) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  throw new Error(`${flag} must be a positive integer.`);
}

function printHelp() {
  console.log(`Usage:
  npm run summarize:workspace-sessions -- [options]

Options:
  --db ID               Legacy alias for the PostgreSQL store/schema id
  --workspace-id ID     Only resummarize one workspace
  --session-id ID       Only resummarize one session
  --limit N             Only resummarize the first N sessions
  --dry-run             Count sessions without rewriting metadata
`);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
