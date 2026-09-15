# Threadex

A local TypeScript, Node, PostgreSQL, and React app that wraps the Codex app-server in
a browser chat UI. It is built to keep Codex turns alive across Express reloads,
persist session history locally, replay runner logs, and manage local Codex
workspaces/accounts from one place.

## Agent Fast Map

Use this section first when you come back to the repo and want to avoid a blind
`rg`.

| Need | Start here |
| --- | --- |
| Run the app | `npm run dev`, then open `http://localhost:5173` |
| Backend routes, runner lifecycle, approvals | `src/server/index.ts` |
| Detached Codex app-server worker | `src/server/promptRunner.ts` |
| PostgreSQL schema and persistence helpers | `src/server/sessionStore.ts` |
| Automatic session keyword extraction | `src/server/sessionSummarizer.ts` |
| App-server event normalization | `src/server/codexEvents.ts` |
| Codex executable, sandbox, approval policy | `src/server/codexConfig.ts` |
| React UI, SSE handling, localStorage snapshot | `src/client/App.tsx` |
| Styling | `src/client/styles.css` |
| Import Codex Desktop/CLI history | `scripts/import-local-sessions.mjs` |
| Embed session descriptions | `scripts/embed-session-descriptions.mjs` |
| Legacy DuckDB admin UI helper | `scripts/duckdb-ui.mjs` |
| Local Codex app-server protocol notes | `skills/codex-app-server/SKILL.md` |
| Runner session inspector skill | `skills/session-inspector/SKILL.md` |
| Active Local Browser Bridge | `local-browser-bridge/README.md` |

Common entry points inside `src/client/App.tsx`:

- `submit` starts a turn through `/api/chat`.
- `handleStreamEvent` applies SSE events to the visible chat.
- `applyStreamItem`, `upsertLiveItem`, and `MessageTimeline` render live Codex
  items.
- `ApprovalEvent` posts approval decisions.
- `loadSessions`, `switchSession`, `loadWorkspaces`, and `loadAccounts` hydrate
  sidebar/workspace/account state.
- `readStoredSession` and `writeStoredSession` own browser persistence.

Common entry points inside `src/server/index.ts`:

- `/api/chat` creates, resumes, reconnects, or retries runner turns.
- `getOrCreateSession` resolves the active workspace/account/session.
- `spawnPromptRunner` writes a job file and launches `src/server/promptRunner.ts`.
- `sessionSummarizer` generates concise session titles after switches and idle
  periods.
- `streamRunnerLog` tails NDJSON logs as SSE.
- `applyRunnerUpdate` persists runner events and final turn state.
- `checkRunningTurns` is the watchdog for dead or stale runners.
- Account auth is stored privately in PostgreSQL; only `hasAuth` and an auth version
  are exposed through account APIs.

## How It Works

The browser never talks directly to `codex app-server`.

```text
React UI
  -> POST /api/chat
  -> Express creates/reuses a local session and spawns promptRunner
  -> promptRunner starts `codex app-server`
  -> promptRunner calls thread/start or thread/resume, then turn/start
  -> promptRunner writes append-only NDJSON logs
  -> Express tails those logs to the browser as SSE
  -> Express best-effort persists events and final turn state to PostgreSQL
```

The NDJSON log is the source of truth while a turn is running. PostgreSQL persistence
is best-effort and can be rebuilt/replayed from logs for many cases. This is why
server restarts can reconnect to an existing `turnId` instead of spawning a
duplicate Codex run.

## Requirements

- Follow [INSTALLATION.md](INSTALLATION.md) for a fresh install, Windows/WSL2 instructions, and migration notes.
- Node.js 22.12 or newer (Node 22 LTS recommended)
- Docker, unless `SESSION_DATABASE_URL`/`DATABASE_URL` points to an existing PostgreSQL server
- Codex authentication already configured for the local CLI/app environment
- `npm install` completed in this repo

On macOS the server automatically prefers the bundled Codex desktop CLI at:

```text
/Applications/Codex.app/Contents/Resources/codex
```

Set `AGENT_CLI_PATH` if you want a different binary. `CODEX_PATH` is still
accepted as a compatibility fallback for the current Codex adapter.

## Run

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

## Local Browser Bridge

Threadex uses the standalone Local Browser Bridge daemon and extension;
the old in-process `8787/browser-relay` stack is retired and is not included in
this distribution or registered by the server or agent skill.

Build the bridge, load `local-browser-bridge/extension/` as an unpacked Chrome
extension, and start the daemon:

```bash
npm install --prefix local-browser-bridge
npm run browser-bridge:build
npm run browser-bridge:start
```

The first extension install pairs automatically. Use
`node local-browser-bridge/dist/bin/browser-bridge.js pair` only when replacing
an extension that was paired previously. See `local-browser-bridge/README.md` for
the CLI, page context, and security model.

The Vite client proxies `/api` to the Express server on:

```text
http://localhost:8787
```

Useful scripts:

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the protected local PostgreSQL container, Express watcher, and Vite client |
| `npm run dev:server` | Starts the protected local PostgreSQL container and Express API watcher |
| `npm run dev:server:plain` | Starts only the Express API watcher; requires an existing PostgreSQL URL |
| `npm run dev:client` | Starts Vite on port 5173 and local Web VS Code on port 8790 |
| `npm run pg:dev -- start` | Creates/starts the local PostgreSQL Docker container and named volume |
| `npm run start` | Runs the Express API without watch mode |
| `npm run build` | TypeScript build plus Vite production build |
| `npm run typecheck` | TypeScript no-emit check |
| `npm run import:local-sessions` | Imports local Codex JSONL sessions into PostgreSQL |
| `npm run sync:local-sessions` | Checks source modification/last-action times and imports only when manager is stale |
| `npm run migrate:duckdb-to-postgres` | One-off migration from the old DuckDB file into PostgreSQL |
| `npm run codex:stop-sync-hook` | Runs the Codex `Stop` hook helper; normally invoked by `.codex/hooks.json` |
| `npm run embed:session-descriptions` | Embeds stale/missing `sessions.description` rows |
| `npm run summarize:workspace-sessions` | Forces session title regeneration for the active workspace |
| `npm run mcp:session-inspector` | Starts the session inspector/manager MCP server |

## Environment

Common environment variables:

```bash
PORT=8787
WEB_VSCODE_PORT=8790
WEB_VSCODE_AUTOSTART=true
# WEB_VSCODE_REVIEW_EXCLUDES=.git/,node_modules/,data/,dist/,build/
# WEB_VSCODE_URL=https://existing-code-server.example/
# CODE_SERVER_COMMAND=/path/to/code-server
AGENT_CLI_PROVIDER=codex
AGENT_CLI_PATH=/Applications/Codex.app/Contents/Resources/codex
AGENT_CLI_HOME=~/.codex
CODEX_WORKDIR=/path/to/project
CODEX_SKIP_GIT_CHECK=true
CODEX_SANDBOX_MODE=workspace-write
CODEX_APPROVAL_POLICY=on-request
SESSION_DATABASE_URL=postgres://threadex:threadex@127.0.0.1:55432/threadex
SESSION_PG_SCHEMA=public
SESSION_EMBED_PROVIDER=ollama
SESSION_EMBED_MODEL=mxbai-embed-large
SESSION_EMBED_BASE_URL=http://127.0.0.1:11434
SESSION_SUMMARIZER_ENABLED=true
SESSION_SUMMARIZER_MODEL=gpt-5.6-luna
SESSION_SUMMARIZER_REASONING_EFFORT=low
SESSION_SUMMARIZER_IDLE_MS=300000
SESSION_SUMMARIZER_SWEEP_MS=60000
SESSION_SUMMARIZER_PENDING_RETRY_MS=300000
SESSION_SUMMARIZER_MAX_INPUT_CHARS=500000
SESSION_SUMMARIZER_TIMEOUT_MS=120000
SESSION_SUMMARIZER_RUNNER_MAX_RUNS=100
SESSION_SUMMARIZER_RUNNER_MAX_AGE_MS=1800000
SESSION_SUMMARIZER_PROMPT_DUMP_DIR=data/session-summarizer-prompts
RUNNER_COMMAND_OUTPUT_HARD_LIMIT_CHARS=16777216
SESSION_COMMENTARY_HEADLINE_MODEL=gpt-5.6-luna
SESSION_COMMENTARY_HEADLINE_REASONING_EFFORT=none
SESSION_COMMENTARY_HEADLINE_TIMEOUT_MS=12000
SESSION_QUESTION_MODEL=luna
SESSION_QUESTION_TIMEOUT_MS=90000
SESSION_QUESTION_AGENT_HOME=~/.codex
SESSION_ROUTER_MODEL=gpt-5.6-luna
SESSION_ROUTER_TIMEOUT_MS=90000
SESSION_ROUTER_AGENT_HOME=~/.codex
RUNNER_SERVER_URL=http://127.0.0.1:8787
RUNNER_LOG_POLL_MS=250
RUNNER_WATCHDOG_MS=15000
RUNNER_STARTUP_GRACE_MS=45000
RUNNER_STALE_MS=120000
TURN_RING_LOG_PATH=data/turn-ring.jsonl
TURN_RING_MAX_BYTES=104857600
THREADEX_INHIBIT_SLEEP=true
APPROVAL_WAIT_MS=600000
RUNNER_APPROVAL_WAIT_MS=600000
SESSION_INSPECTOR_MCP_MODE=auto
```

`CODEX_WORKDIR` controls the cwd sent to Codex for new threads. The default is
the app folder. `CODEX_SANDBOX_MODE` and `CODEX_APPROVAL_POLICY` are passed to
`codex app-server` through config flags in `src/server/codexConfig.ts`.

The session sidebar opens the session project in Web VS Code in a new browser
tab. At turn start, Threadex captures a shadow Git index under
`data/code-server/turn-baselines`; the project never receives a `.git` directory
or staging changes. Each completed-turn change list uses that baseline to create
one source-level review session in the bundled Threadex Review VS Code extension.
Each changed file is a single row in the combined Explorer review tree, showing
the whole-file `+`/`−` line total; opening it goes directly to the native
language-aware diff. Block highlights and CodeLens actions remain available in
the working editor for Accept, Reject, and inspecting individual changes.
The adjacent question-mark toolbar button opens a read-only **Code Walkthrough**
for the active session. In Web VS Code, select code and run **Threadex: Explain
Selection** from the editor context menu or Command Palette (or use **Explain
File** for a small file). The same command works on either side of a Threadex
native diff: comments are labelled as `baseline` or `working` and remain inside
the compare editor. Baseline selections are verified against the immutable
snapshot embedded in the server-owned review request; working selections are
verified against the current workspace file. Threadex sends a bounded,
fingerprinted selection to a
local action queue, verifies the active workspace, session, resolved file path,
range, and source hash, then asks an isolated read-only Codex agent for the
Markdown explanation. The returned explanation is attached to that exact range
as a native VS Code comment thread with a CodeLens and decoration. Repeated
questions on the same range are grouped as multiple comments in one inline
block, while other ranges and files remain separate walkthrough blocks. The
block, tree, hover, and CodeLens all show the source path and line range.
Markdown tables, lists, and code are supported; compact Mermaid flowcharts from
the agent are converted by the extension's constrained parser into inert inline
SVG rather than executing Mermaid or arbitrary HTML. The bundled extension
keeps VS Code's separate Comments panel closed by default; walkthroughs stay in
their editor inline blocks unless the user explicitly opens that panel. If the file
changes before the result returns, Threadex marks it stale and asks for a new
selection rather than attaching it to the wrong source. Walkthrough requests do
not expose Accept or Reject, and their command handlers reject mutations even
when invoked directly.
No source-repository commit is required. In development, the `dev:client`
supervisor starts `code-server` on the loopback-only `WEB_VSCODE_PORT` and owns
its restart/shutdown lifecycle alongside Vite. Outside the development watcher,
the API server starts it by default. Runtime state lives under `data/code-server`.
`WEB_VSCODE_REVIEW_EXCLUDES` accepts a comma-separated override for directories
excluded from shadow baselines.
The bundled Web VS Code process receives private local action/result directory
paths automatically. If `WEB_VSCODE_URL` points at an externally managed
code-server, configure equivalent `THREADEX_WALKTHROUGH_ACTION_DIR` and
`THREADEX_WALKTHROUGH_RESULT_DIR` paths in that process before using Code
Walkthrough.
Install `code-server` first (for example, `brew install code-server` on macOS),
or set `CODE_SERVER_COMMAND`. Set `WEB_VSCODE_URL` to use an already-running
instance; this also disables automatic startup. Set `WEB_VSCODE_AUTOSTART=false`
to manage the default local instance yourself.

On macOS, each active prompt runner starts a `caffeinate` process to prevent
display, idle, disk, and system sleep until that runner exits. Set
`THREADEX_INHIBIT_SLEEP=0` to disable this behavior.

`SESSION_INSPECTOR_MCP_MODE` defaults to `auto`. The
`skills/session-inspector` skill documents the HTTP API and MCP tools. In
`auto`, MCP is attached to every resumed native thread so
`recover_current_session` can restore saved user/final-assistant turns omitted
by opaque Codex compaction. Ordinary resumed turns get a continuity-only tool
set (`recover_current_session`, `get_session`, and `search_sessions`) rather
than mutation, Todo, or process controls. MCP is also attached to new threads
whose prompts explicitly inspect/search stored session history or monitor a process. Use
`off` to disable it or `always` to expose it on every runner turn. The older
`ENABLE_SESSION_INSPECTOR_MCP=true/false` still works as an override.
`ask_session` is a read-only side chat persisted outside `session_turn`. Each
target session gets an in-memory ephemeral app-server thread with a selectable
model and only the read-only `get_session`/`search_sessions` inspector tools;
the thread uses the target workspace account without creating a Codex rollout.
`prompt_session` is the MCP path for adding a real prompt to a target session;
it starts or queues the normal runner, so it becomes part of that session's log
and future context.

`SESSION_SUMMARIZER_MODEL` controls the small model used for automatic session
title generation. The summarizer runs as soon as that session has no running
or pending turn, so it does not delay metadata until a fixed idle period or
wait for other sessions. A periodic idle sweep is retained only as a recovery
path if an activity notification is missed. It writes the session title only;
automatic keyword generation is paused. Existing keyword weights, descriptions,
and description embeddings are left unchanged.
The idle recovery delay, sweep, input-width, and timeout knobs keep the internal
summarizer cost bounded.
Set `SESSION_SUMMARIZER_PROMPT_DUMP_DIR` to a writable directory if you want to
review the exact prompt locally. The server writes one text file per summary or
rewrite attempt with the session id, model, hash, and full prompt body.
The summarizer uses an isolated Luna app-server runner per workspace account in
an empty temporary workspace, with an auth-only Codex home. Every summary starts
a fresh ephemeral thread, so earlier summaries never become input context for a
later request. The app-server process is recycled after 100 summaries or 30
minutes by default; recycling deletes its temporary Codex home and workspace.
It never loads user config, skills, MCP servers, apps, dynamic tools, or host/global
Codex auth. If that workspace account has no available credits, the summary remains
pending and is retried after `SESSION_SUMMARIZER_PENDING_RETRY_MS` (five minutes by
default).
The turn context includes every user prompt, a topic lead of at most 400
characters from each earlier agent response, and the complete final agent
response. Turns are presented newest-to-oldest so the original objective stays
close to the final title reminder. If the total input is oversized, each turn
is trimmed proportionally instead of dropping whole turns early.
Prompt dumps use `#n`, `user:`, `agent context:`, and `final agent:` lines so
you can review exactly what the summarizer saw.

Titles follow the primary language of the user's request. The summarizer asks
the model for a concise title and receives a lightweight one-line response:

```text
title: Short specific session title
```

Prompt dumps stay local, so you can inspect the exact turn context the model
saw without exposing it in the user-visible transcript.

## API Surface

Main browser API:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Health check |
| `GET /api/sessions` | Initial per-project session pages for the active workspace; pass `cwd` and `offset` to page one project |
| `GET /api/sessions/list` | Alias for `/api/sessions` |
| `POST /api/sql` | Run a read-only database query for local inspection |
| `POST /api/sessions/switch` | Switch or clear active local session |
| `POST /api/sessions/fork` | Fork a session from a completed agent message turn |
| `GET /api/sessions/:sessionId/children` | List direct child sessions so context-fork completion can be verified |
| `GET/POST /api/session-inspector/session` | Inspect one session by `sessionId` or `threadId` with pagination and filters |
| `GET/POST /api/session-inspector/search` | Global full-text/recent search across stored sessions |
| `POST /api/session-inspector/ask` | Read-only side-chat turn on an isolated ephemeral app-server thread; supports `model`/`modelReasoningEffort` and persists answers outside `session_turn` |
| `GET /api/session-inspector/vector/status` | Check optional vector-search readiness |
| `POST /api/session-inspector/vector/search` | Search precomputed `session_description_embedding` rows with a supplied embedding |
| `GET /api/session-auto-model/:sessionId` | Read the per-session Auto model state |
| `POST /api/session-auto-model/upgrade` | Apply a monotonic Auto model/effort upgrade requested by the agent tool |
| `PUT /api/session-model-preferences/:sessionId` | Store the selected model, effort, gear profiles, and active gear for a session |
| `POST /api/experimental/session-routing` | Embed a user prompt, vector-search likely sessions, and ask the small router model for a route id/`START_NEW` plus an executor prompt |
| `GET /api/workspaces` | List workspaces and active workspace |
| `POST /api/workspaces/create` | Create and switch to a workspace |
| `POST /api/workspaces/switch` | Switch active workspace |
| `GET /api/accounts` | List accounts and workspace bindings |
| `POST /api/accounts/import-current` | Store the current workspace Codex auth in the account database |
| `POST /api/accounts/switch` | Switch active account |
| `POST /api/accounts/bind` | Bind an account to a workspace |
| `POST /api/accounts/unbind` | Unbind an account from a workspace |
| `POST /api/accounts/delete` | Delete a saved account and remove all workspace bindings |
| `POST /api/chat` | Start, resume, reconnect, or retry a Codex turn; returns SSE |
| `POST /api/session-tasks` | Create/link a background child task; pass `startImmediately: true` to start its Codex turn |
| `POST /api/runner/stream` | Reconnect to a known runner log by `turnId` |
| `GET /api/process-monitors` | List compact process monitors for the active workspace |
| `GET /api/process-monitors/:monitorId/logs` | Read the captured stdout/stderr tail for a process monitor |
| `POST /api/process-monitors` | Start a process, temporarily track a PID, or attach a PID with a restart spec |
| `POST /api/process-monitors/:monitorId/adopt` | Attach a durable restart launch spec to an already-running PID |
| `POST /api/process-monitors/:monitorId/stop` | Stop a monitored process while retaining its monitor and launch spec |
| `POST /api/process-monitors/:monitorId/restart` | Restart a monitor with a saved launch spec |
| `DELETE /api/process-monitors/:monitorId` | Stop and remove a monitor |
| `GET /api/wait-events` | List durable backend events and per-session subscription delivery state |
| `POST /api/wait-subscriptions` | Subscribe a session action to an existing retained event |
| `POST /api/runner/update` | Runner callback for event persistence |
| `GET /api/approvals` | List pending approvals, optionally by `sessionId` or `turnId` |
| `POST /api/approvals/request` | Runner/app-server approval callback |
| `POST /api/approvals/:approvalId/wait` | Runner waits for browser decision |
| `POST /api/approvals/:approvalId/decision` | Browser submits approval decision |

Process monitors are tracked by the server's polling loop and do not create
agent turns while a PID/command/Docker image is running. A monitor may include a
`wakePrompt`, which creates a backward-compatible follow-up subscription for its
originating session. Every process run also publishes a retained `process.exited`
event, so multiple sessions can subscribe to the same completion. Rate-limited
turns use the same durable event system and share `quota.available` events instead
of owning separate reset timers. `entryPoints` optionally stores HTTP(S) URLs that are
shown as web links in the process monitor detail popover. `timeoutSeconds` limits the
monitor lifetime. Completed executable monitors remain available for restart;
Interpreter executable monitors (`node`, shells, Python, and similar) must include
the script or command options in `args`. Labels are display-only and do not find a
process. PID-only monitors are temporary, store no launch args, cannot restart,
and disappear when that exact PID exits. Pair a live PID with exactly one launch
spec (`exe` plus `args`, `dockerImage`, or `command`) to retain it after exit and
make it restartable without interrupting it; `adopt` provides the same upgrade path
for an existing PID-only monitor. The Threadex API
server itself and the Vite client use external supervisors. Their built-in monitors
expose Restart whenever a supervisor or restart control is available; the action is
data-driven by monitor metadata rather than the display label, and it cannot remove
or stop either built-in directly. `npm run dev:server` uses `scripts/watch-server.mjs`
and `npm run dev:client` uses `scripts/watch-client.mjs`; the client supervisor
also owns the development code-server process. Both supervisors are always
included in monitor listings as built-in read-only health records: the server
record uses its current process PID, while the client record probes Vite on port
5173 so an externally managed restart cannot leave a stale `exited` PID record.
Docker monitors run as `docker run --rm <dockerImage> ...` and remain restartable;
`dockerRunArgs` can supply Docker flags before the image, while `args` are passed
as the container command. For example, a web monitor can use
`dockerImage: "nginx", dockerRunArgs: ["-p", "8080:80"], entryPoints: ["http://localhost:8080"]`.
Monitors started or restarted by Threadex combine stdout and stderr in their captured log. Pass `logFile` as
a workspace-relative path to write to a specific file; the setting is persisted and
preserved when an existing PID is adopted with a new command or when the monitor is
restarted. Without `logFile`, logs are kept in the server data directory. Attached
processes cannot capture output that was already sent elsewhere, but their live PID
can be stopped directly. Attached PIDs are signalled individually; processes launched
by Threadex are stopped as their own process groups.

`/api/chat` accepts:

- `message`
- `sessionId`
- `resumeThreadId`
- `contextFork` (asks the current parent agent to prepare a same-language, self-contained handoff and call
  the `create_task` MCP tool from the `session_inspector` server, exposed in local Codex tool naming as
  `mcp__session_inspector__create_task`; the child is created and tracked by Threadex)
- `forcePlan` (the composer Todo MCP toggle; the initial turn records and asks one focused grill-me round,
  then answer turns remain in planner mode until `todo_set_plan` creates the paused plan)
- `retryPending`
- `turnId`
- `model`
- `modelReasoningEffort`
- `attachments`
- `workspaceId`
- `accountId`
- `loadBalanceInWorkspace`
- session metadata: `title`, `description`/`desc`, `keywordWeights`,
  `parentSessionId`

Todo item delegation creates at most one worker task per item. Ordinary prompts
inside that worker resume the same session and the worker is not exposed to task
creation tools. A child may be created from a worker only when the user explicitly
uses the context-fork action; the `/api/session-tasks` endpoint enforces the same
caller rule instead of relying only on model instructions.

## Streaming Shape

This app uses SSE. The runner translates Codex app-server notifications into a
stable event shape consumed by `src/client/App.tsx`.

Browser-facing event types:

- `session`
- `codex`
- `item`
- `delta`
- `approval.requested`
- `approval.resolved`
- `pending`
- `result`
- `done`
- `error`

Common app-server methods seen in runner logs:

- `thread/started`
- `turn/started`
- `item/started`
- `item/agentMessage/delta`
- `item/reasoning/summaryTextDelta`
- `item/reasoning/textDelta`
- `item/commandExecution/outputDelta`
- `item/completed`
- `thread/tokenUsage/updated`
- `turn/completed`

`src/server/codexEvents.ts` is the compatibility layer. Add support for new
app-server item types there before touching UI rendering.

## Data Paths

Generated local state lives under `data/`:

| Path | Purpose |
| --- | --- |
| `data/runner-jobs/*.json` | Prompt runner job payloads |
| `data/runner-logs/*.ndjson` | Append-only runner event logs |
| `data/runner-logs/*.stdout.log` | Runner stdout sidecar logs |
| `data/runner-logs/*.stderr.log` | Runner stderr sidecar logs |
| `data/pending-runner-logs/*.ndjson` | Pending log copies for replay |
| `data/turn-ring.jsonl` | DB-independent user prompt and agent response ring log (100 MiB by default) |
| `data/uploads/<turn-id>/` | Uploaded attachments saved for a turn |
| `data/account-pool/` | Account auth snapshots |
| `data/codex-homes/<workspace-id>/` | Workspace-specific Codex homes |

The default local database is PostgreSQL in Docker:

| Resource | Purpose |
| --- | --- |
| `threadex-pg-migration` | Local PostgreSQL container created by `npm run pg:dev -- start` |
| `threadex-pg-data` | Named Docker volume that keeps database data if the container is deleted |

Legacy DuckDB migration/cache paths:

| Path | Purpose |
| --- | --- |
| `data/threadex.duckdb` | Old DuckDB database used as a migration source |
| `.duckdb/home` | DuckDB home directory |
| `.duckdb/extensions` | DuckDB extension directory |

The browser stores the current visible transcript, active local session id,
Codex thread id, active turn id, and load-balance flag in `localStorage` as a
reconnect fallback. Selected model, effort, gear profiles, and active gear are
stored per persisted session in the backend database; an unsent New session
keeps those preferences in localStorage until its first prompt creates the DB
session.

Selecting **Auto** in a composer gear starts that session at GPT-5.6 Luna with
high reasoning. The runner adds an Auto-mode prompt prefix and exposes
`session_inspector.upgrade_model`. The agent is instructed to finish inexpensive
context gathering first, then call the tool only before a substantive technical
or business decision. A valid request runs without a separate user approval and
may jump directly to Terra or Sol and up to xhigh effort, but cannot lower either
model or effort. Threadex then
continues the same user request in the same Codex thread with the upgraded
setting. Auto state and its monotonic revision are isolated per local session.

## PostgreSQL Schema

`SessionStore` uses PostgreSQL by default. `SESSION_DATABASE_URL` or
`DATABASE_URL` can point at any PostgreSQL server; without either value,
`npm run dev:server` starts the local Docker container and uses:

```text
postgres://threadex:threadex@127.0.0.1:55432/threadex
```

Tests and isolated stores derive a temporary PostgreSQL schema from the supplied
store id. Set `SESSION_PG_SCHEMA` when you want to force a specific schema.

To migrate local DuckDB data into PostgreSQL:

```bash
npm run pg:dev -- start
npm run migrate:duckdb-to-postgres -- \
  --duckdb data/threadex.duckdb \
  --postgres "$(npm run -s pg:dev -- url)" \
  --truncate
```

If the old DuckDB file is locked by a legacy process, the migration script copies
a temporary DuckDB/WAL snapshot and migrates from that snapshot.

`npm run pg:dev -- start` creates the local PostgreSQL container with a stable
named Docker volume (`threadex-pg-data`), `--restart unless-stopped`, and
a keep label. If the container is deleted, rerun the same command to recreate it
against the existing volume. Avoid `docker volume prune` or Docker Desktop reset
unless you intentionally want to delete the PG data volume too.

When upgrading an existing local volume that used the former default
credentials, `npm run pg:dev -- start` automatically renames its role
and database to `threadex` without deleting data. For custom existing
credentials, set `SESSION_PG_USER`, `SESSION_PG_PASSWORD`, and
`SESSION_PG_DATABASE` explicitly instead.

An existing Docker volume keeps its physical name during this migration, so its
contents stay available in place; newly created installations use
`threadex-pg-data`.

Core tables created by `SessionStore`:

| Table | Purpose |
| --- | --- |
| `sessions` | Local session metadata and associated Codex thread id |
| `workspaces` | Named workspace cwd and Codex home |
| `active_workspace` | Singleton pointer to active workspace |
| `accounts` | Imported/snapshotted Codex accounts and quota snapshots |
| `workspace_account` | Account bindings per workspace |
| `active_account` | Active account selection per workspace |
| `active_session` | Active local session selection per workspace |
| `session_turn` | User prompt, final response, account snapshot, status, tokens, runner PID/log |
| `session_auto_model` | Per-session Auto enablement, current model/effort, and monotonic revision |
| `session_model_preferences` | Per-session selected model, effort, gear profiles, and active gear |
| `session_live_item` | One current/final item row per `(turn_id, item_id)`, with replay ordering metadata |
| `session_turn_event` | Audit-worthy runner/app-server events; item start/update/completion history is intentionally excluded |
| `codex_command_call` | Command execution summaries for later analysis |
| `session_summary_state` | Stale-hash tracking for automatic session summarisation |
| `keyword_appearance` | Per-workspace session-count stats for keyword weighting |
| `session_description_embedding` | Optional precomputed embeddings for session description vector search |
| `token_usage` | Central token and quota ledger for `agent`, `summarizer`, `background`, and `account` usage; keyed to workspace, session, turn, and account where available |
| `process_monitor` | Durable labels and runtime state for monitored command/PID processes |
| `account_token_usage_ratio` | Legacy source table, backfilled into `token_usage` on startup |
| `session_turn_token_usage_sample` | Legacy source table, backfilled into `token_usage` on startup |

Importer-only tables:

| Table | Purpose |
| --- | --- |
| `local_session_file` | Imported source JSONL file metadata |
| `local_session_event` | Legacy raw-event archive table; new imports use unified `session_turn_event` rows |

`SessionStore` maintains PostgreSQL full-text search over
`session_turn.user_input` and `session_turn.agent_response`.

Example query:

```sql
SELECT
  id,
  session_id,
  ts_rank(
    setweight(to_tsvector('simple', coalesce(user_input, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(agent_response, '')), 'B'),
    plainto_tsquery('simple', 'postgres search')
  ) AS score
FROM session_turn
WHERE
  setweight(to_tsvector('simple', coalesce(user_input, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(agent_response, '')), 'B')
  @@ plainto_tsquery('simple', 'postgres search')
ORDER BY score DESC;
```

Vector search is optional and intentionally description-only. `SessionStore`
creates `session_description_embedding`; generate embeddings locally with Ollama:

```bash
ollama pull bge-m3
npm run embed:session-descriptions -- --dry-run
npm run embed:session-descriptions
```

The embed script only reads `sessions.description`, stores a description hash,
and skips rows whose hash/model already match. It also supports
`--provider openai-compatible --base-url ... --model ...` for local
OpenAI-compatible embedding servers.

## Session Summariser

Session titles are maintained automatically by the server. When a session is
switched away from, or when it sits idle long enough, the backend gathers a
compact per-turn prompt/agent excerpt, sends that to a temporary internal
summarizer thread, and then updates:

- `sessions.title` unless the user has explicitly set the title

Automatic keyword generation is paused. The summarizer does not generate or
update descriptions or description embeddings.

Useful defaults:

```bash
SESSION_SUMMARIZER_ENABLED=true
SESSION_SUMMARIZER_MODEL=gpt-5.6-luna
SESSION_SUMMARIZER_REASONING_EFFORT=low
SESSION_SUMMARIZER_IDLE_MS=300000
SESSION_SUMMARIZER_SWEEP_MS=60000
SESSION_SUMMARIZER_PENDING_RETRY_MS=300000
SESSION_SUMMARIZER_MAX_INPUT_CHARS=500000
SESSION_SUMMARIZER_TIMEOUT_MS=120000
SESSION_SUMMARIZER_RUNNER_MAX_RUNS=100
SESSION_SUMMARIZER_RUNNER_MAX_AGE_MS=1800000
SESSION_SUMMARIZER_PROMPT_DUMP_DIR=data/session-summarizer-prompts
```

Set `SESSION_SUMMARIZER_ENABLED=false` for isolated test or maintenance runs
that must not reorder sessions through background summary updates.

## Commentary Headlines

Completed commentary remains the agent's original prose. The runner sends every
completed commentary item to a read-only GPT-5.6 Luna helper at `none` reasoning
effort and uses its compact headline/type for the collapsed status card. The
main agent is told to write plain prose and never produce the headline JSON
envelope; the runner applies a temporary default card until Luna responds. Luna runs in a separate
ephemeral home and empty workspace, without user config, skills, MCP servers,
apps, or dynamic tools. A single isolated thread is reused per runner so later
headlines can benefit from prompt caching. If the helper is disabled,
unavailable, times out, or returns a generic label, the original detail remains
available and the card uses a deterministic English fallback.

The helper also maintains a turn-wide issue ledger. Each issue can have a concrete
solution or an explicit blocker (why progress cannot continue and what is needed).
Blockers remain unresolved in the UI and copied issue context; a later solution
replaces the blocker. While the root Codex turn is active, the runner sends issues
without either outcome through `thread/inject_items`, asking for a natural-language
commentary response. Each issue is successfully injected only once per runner
ledger, including across native-turn continuations. Failed injections are logged
and may retry on the next summarised update. Completed turns receive no injection.

Useful defaults:

```bash
SESSION_COMMENTARY_HEADLINE_MODEL=gpt-5.6-luna
SESSION_COMMENTARY_HEADLINE_REASONING_EFFORT=none
SESSION_COMMENTARY_HEADLINE_TIMEOUT_MS=12000
```

Set `SESSION_COMMENTARY_HEADLINE_PROVIDER=off` to disable the helper. Tests can
use `SESSION_COMMENTARY_HEADLINE_PROVIDER=mock` together with
`SESSION_COMMENTARY_HEADLINE_MOCK_RESPONSE`.

## Import Local Codex Sessions

Import from `~/.codex/sessions`, `~/.codex/archived_sessions`, and
`~/.codex/session_index.jsonl`:

```bash
npm run import:local-sessions
```

Useful variants:

```bash
npm run import:local-sessions -- --limit 5 --no-raw-events
npm run import:local-sessions -- --session-id 019f2456-c894-7310-9fd7-f4699070690b --no-raw-events
npm run import:local-sessions -- --codex-home /path/to/.codex
npm run import:local-sessions -- --clean-imported
npm run sync:local-sessions -- --check
npm run sync:local-sessions -- --codex-home /path/to/.codex --no-raw-events
```

The importer is idempotent. Sessions whose recorded cwd is inside this repo are
assigned to the `threadex` workspace; other imported sessions stay in
`default`. App-created local session ids use a `local_` prefix.
Use `--codex-home` or `SESSION_LOCAL_CODEX_HOME` to import from a non-default
Codex home. The maintenance scripts intentionally ignore the process
`CODEX_HOME` default because Codex-managed shells set it to this app's
workspace-specific home.

This repo also ships a project-local Codex `Stop` hook in `.codex/hooks.json`.
After you review and trust it with `/hooks`, completed non-manager Codex turns
are synced automatically. If the Threadex server is listening,
`scripts/codex-stop-sync.mjs` posts the completed transcript to
`/api/codex/hooks/stop`, and the server imports it through its existing PostgreSQL
connection. If the server is not reachable, the script appends a JSONL record to
`data/codex-hook-queue.ndjson`; the server drains that queue on startup. Turns
launched by Threadex set `THREADEX_MANAGED_RUNNER=1` and are
ignored by the hook to avoid duplicate manager-owned `session_turn` rows.
Override `THREADEX_HOOK_SERVER_URL` or `SESSION_CODEX_HOOK_QUEUE_PATH`
when the hook should target another manager instance or queue file.

The API server also polls recent session transcript files for each workspace as
a fallback for already-open Codex tasks that have not loaded the project hook
yet. Once a transcript has been imported, the poller keeps tracking that exact
file too, so a thread created on an earlier date continues to sync new turns.
Polling defaults to every 15 seconds after a 5 second quiet window and ignores
Codex internal subagent/reviewer transcripts. Set
`CODEX_SESSION_FILE_POLL_INTERVAL_MS=0` to disable it, or adjust
`CODEX_SESSION_FILE_POLL_QUIET_MS` if your filesystem writes transcripts more
slowly.

The sync command scans the selected local Codex home plus the default workspace
Codex home (`THREADEX_DEFAULT_WORKSPACE_CODEX_HOME`, otherwise `~/.codex`). It compares each rollout file's filesystem
`modified_at` with `local_session_file.file_mtime`, and compares the Codex index
`updated_at` (the last action time) with `sessions.updated`. If anything is
missing or stale it runs the same `import-local-sessions.mjs` importer above,
then verifies the result.
Use `--check` for a read-only CI/health check; it exits with status 1 when stale.
Actual sync/import requires access to PostgreSQL.

## Database Inspection

Run the app with PostgreSQL:

```bash
npm run dev
```

For server-only development:

```bash
npm run dev:server
```

Inspect the local database with any PostgreSQL client using:

```bash
npm run pg:dev -- url
```

Legacy DuckDB inspection remains available only for old database files:

```bash
npm run legacy:duckdb-ui -- data/threadex.duckdb
```

## Runner And Retry Semantics

Each Codex turn gets a browser-generated or server-generated `turnId`.

When a turn starts:

1. `/api/chat` writes the full user prompt to `data/turn-ring.jsonl`, then records
   a `session_turn` with `status = 'running'`.
2. The server writes `data/runner-jobs/<turn-id>.json`.
3. The server spawns `src/server/promptRunner.ts` detached from the request.
4. If `SESSION_INSPECTOR_MCP_MODE` enables it, the runner starts with the
   read-only `session_inspector` MCP server.
5. The runner writes `data/runner-logs/<turn-id>.ndjson`.
6. The server tails that log as SSE.
7. The runner posts each log entry back to `/api/runner/update`.
   Every managed thread also receives a global search-safety instruction: resolve
   the owning project before searching, never recursively search a filesystem or
   workspace root, and never broadly search Threadex runtime data.
8. `applyRunnerUpdate` upserts item state into `session_live_item`, writes other
   audit-worthy events to `session_turn_event`, and updates command-call summaries
   and final `session_turn` state. Command items retain only the latest 64 KiB
   output tail in PostgreSQL; the runner NDJSON remains the full-output source.
   A single command stream is stopped after 16 MiB by default so a command that
   reads its own growing runner log cannot create an unbounded feedback loop.
9. Final, pending, error, and watchdog responses are written to the turn ring
   before the matching database update. The JSONL file is mode `0600`; once the
   configured byte limit would be exceeded, its oldest complete records are
   removed while the newest records are retained.

If the SSE connection drops, the browser can reconnect with:

```bash
POST /api/runner/stream
{ "turnId": "..." }
```

Posting the same `turnId` to `/api/chat` also reconnects to the existing runner
log when available.

If Codex reports a usage-limit error, the turn becomes `status = 'todo'` and can
be retried later with `retryPending: true`.

The watchdog runs every `RUNNER_WATCHDOG_MS`:

- Newly claimed turns without an attached PID are treated as starting for
  `RUNNER_STARTUP_GRACE_MS`, so snapshot/status reads cannot stop them during
  runner setup. Orphaned claims are released after that grace period.
- Dead runner processes are moved back to `todo`.
- Live runners with no heartbeat/log movement after `RUNNER_STALE_MS` get a
  `runner.watchdog.stale` event.
- Pending-turn scheduling also runs the same liveness check when a queued turn
  is blocked by an existing `running` turn, so a dead or abandoned runner can be
  released without waiting for another watchdog tick.
- Dead-runner diagnostics include tails from NDJSON, stdout, and stderr logs.

## Accounts And Load Balancing

Accounts are stored as snapshots under `data/account-pool/`. Workspace account
bindings define only the load-balancing candidate pool; any saved account can
still be selected manually in any workspace. Runners always use the active workspace's Codex home so native
Codex session logs stay under `data/codex-homes/<workspace-id>/sessions`.

Important rules:

- New load-balanced sessions pick from usable active workspace bindings by
  preferring accounts ready to start their next reported 5-hour cooldown,
  preferring accounts with weekly quota that would otherwise go unused,
  valuing manual resets more when the 7-day reset is later, and then using
  5-hour remaining before 7-day remaining for even spread. Weekly-only plans
  are balanced directly by weekly capacity instead of a synthetic cooldown.
- Existing sessions keep their stored `account_id` until auto load balancing
  selects another usable account. Account rotation rebinds that same session
  while preserving its thread, so retries and ordinary follow-ups continue in
  context instead of becoming new tasks.
- Auto-load-balanced turns allow a one-second immediate-follow-up grace period.
  After that grace expires, the next prompt may rotate to a newly selected
  account, but it keeps the same Threadex session id and Codex thread so
  ordinary follow-ups never become new tasks merely because of load balancing.
- Before a runner starts, the selected account snapshot is copied into the
  workspace Codex home.
- After a runner finishes, refreshed `auth.json` is copied back to the account
  snapshot.

All token and quota usage is recorded in `token_usage`: normal Codex turns use
`usage_type = 'agent'`, the internal metadata run uses `usage_type =
'summarizer'`, commentary headlines, session questions, and routing calls use
`usage_type = 'background'`, and quota-ratio observations use `usage_type =
'account'`. Profile analytics shows each background task as its own model trend.
The startup migration idempotently backfills legacy usage tables. Account quota
snapshots refresh only on the background interval, so a completed turn never
starts another app-server just to read rate limits. Tune this with `ACCOUNT_QUOTA_REFRESH_INTERVAL_MS` and
`ACCOUNT_QUOTA_REFRESH_INITIAL_DELAY_MS`; set the interval to `0` to disable it.

## Attachments

The browser sends attachments as data URLs in `/api/chat`. The server stores
them under `data/uploads/<turn-id>/` and passes saved paths to the runner.

`promptRunner` builds the turn input as:

- Original message text.
- A short attachment manifest.
- Text-like attachment contents when safe to inline.
- Image attachments as image inputs for Codex.

Touch `saveUploadedAttachments`, `formatStoredUserInput`, and
`buildAttachmentPrompt` when changing attachment behavior.

## Approvals

Approvals flow through the server instead of directly through the browser:

```text
codex app-server server request
  -> promptRunner requestApprovalDecision
  -> POST /api/approvals/request
  -> browser shows ApprovalEvent
  -> POST /api/approvals/:approvalId/decision
  -> promptRunner receives decision from /wait
  -> promptRunner responds to app-server JSON-RPC request
```

Relevant places:

- Backend approval store: `pendingApprovals` in `src/server/index.ts`
- Decision normalization: `normalizeApprovalDecision`
- Session-wide exec policy amendment: `execpolicyAmendmentFromDecision`
- UI approval buttons: `ApprovalEvent` and `approvalAvailableDecisions` in
  `src/client/App.tsx`

## Codex App-Server Protocol Notes

Use `skills/codex-app-server/SKILL.md` before making protocol-level changes. It
contains the local request flow, schema-generation commands, and a probe script.

Current runner request flow:

```text
initialize
initialized
thread/resume or thread/start
turn/start
```

Do not hard-code protocol changes from memory. Generate schemas from the
installed Codex binary when adding new app-server methods.

## Debug Recipes

Check API health:

```bash
curl -sS http://localhost:8787/api/health
```

Find a stuck turn:

```sql
SELECT id, session_id, status, runner_pid, runner_heartbeat, runner_log_path, last_event_name
FROM session_turn
ORDER BY created DESC
LIMIT 20;
```

Inspect the latest event trail:

```sql
SELECT turn_id, event_name, created, payload
FROM session_turn_event
ORDER BY created DESC
LIMIT 50;
```

Inspect command executions:

```sql
SELECT session_id, turn_id, command_part_1, command_part_2, status, exit_code, response_length, updated
FROM codex_command_call
ORDER BY updated DESC
LIMIT 50;
```

Check runner sidecars:

```bash
ls -lt data/runner-logs | head
tail -n 80 data/runner-logs/<turn-id>.ndjson
tail -n 80 data/runner-logs/<turn-id>.stderr.log
```

Common failure points:

- App-server cannot read local Codex state: check `CODEX_PATH`, `CODEX_HOME`,
  workspace `codexHome`, and sandbox permissions.
- Browser reconnect starts duplicate-looking UI state: inspect
  `localStorage.activeTurnId` and whether `/api/chat` received the same
  `turnId`.
- PostgreSQL unavailable: run `npm run pg:dev -- status`, then
  `npm run pg:dev -- start` if the local container is missing or stopped.
- Missing final response but turn completed: inspect `readCompletedTurnFallback`
  and the `turn/completed` payload in runner NDJSON.
- Approval hangs: inspect `pendingApprovals`, `/api/approvals`, and
  `RUNNER_APPROVAL_WAIT_MS`.

## Development Notes

- Prefer changing the server-side stream item shape in `src/server/codexEvents.ts`
  before adding UI special cases.
- Keep `/api/chat` idempotent for reconnects: same `turnId` should tail the
  existing log, not spend another Codex turn.
- Keep runner logs append-only. They are the recovery path when Express restarts
  or database writes fail.
- Be careful with account load balancing. A session with a stored Codex thread
  should keep using the same account.
- `data/`, `.duckdb/`, and the local PostgreSQL Docker volume are runtime state,
  not source code.

## Verification

Before handing off backend or UI changes, at least run:

```bash
npm run typecheck
```

For broader confidence:

```bash
npm run build
```

For UI changes, run `npm run dev` and exercise:

- New session send.
- Existing session switch.
- Reconnect after refreshing mid-turn.
- Approval request/decision if the changed path touches approvals.
- Pending retry if the changed path touches usage-limit handling.


### Lightweight outcome tracking

The composer Todo toggle now enables outcome tracking in the current session, including queued prompts. The main agent uses `outcome_plan_get` and `outcome_plan_set` to maintain a nested tree of concrete deliverables and acceptance conditions. It can revise, move, add or remove items but cannot write status. The toggle no longer starts the legacy grill/review workflow. Once a session has an outcome plan, later turns maintain it automatically; turning off the composer toggle only stops requesting activation for the next prompt.

Grill starts from the flame icon on the latest completed agent turn. Its review panel contains a compact question list, a turn-level response, and one shared composer. Users can select, edit, drop or restore questions. Ask thread submits the selected questions together; Griller follow-up only becomes available after a saved thread response, enforced by both the UI and API. Both actions operate on the whole turn, and per-question inference requests are rejected. Start work sends selected responses and the optional composer instructions to the main thread while preserving its existing draft. Review history stays under the original turn and a flame tag marks reviewed turns in the left-hand list. Starting a new Grill on an older turn requires forking it first.

Grill state and question-history snapshots are persisted in `session_turn_grill`, with revision checks for concurrent edits. `GET /api/sessions/:sessionId/turns/:turnId/grill` loads the review; `POST` accepts `start`, `save`, `respond`, or `followup`, with `revision`, `issues`, and optional `prompt`. Each inference uses an isolated ephemeral Luna thread, reconstructing discussion from saved rounds (and earlier parent messages for responses), then cleans up its temporary home. This is context replay, not a native `thread/fork` or a permanent sidebar session. Interrupted requests retain their questions and follow-up for retry; abandoned running states recover after six minutes. Focused checks: `node --import tsx --test src/server/turnGrill*.test.ts` and `npm run test:e2e -- e2e/turn-grill.spec.ts`.

After a completed turn and once the session queue drains, the session summariser assesses status from bounded conversation and tool-result evidence. Status is pending, active, unverified, done or blocked; a completion claim without acceptance evidence remains unverified. Parent completion requires completed children and its own acceptance. Updates are revision-checked, persisted and published to the live panel. Failed or malformed assessments retain the last status. The current implementation does not update status during a running turn.

Plan edits preserve stable IDs. Changes to an item's content/acceptance or descendants invalidate its previous assessment; moving an unchanged item retains it. Legacy Todo plans and explicit planning mode remain available separately.
