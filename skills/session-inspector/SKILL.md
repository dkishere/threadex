---
name: session-inspector
description: Use when a runner needs to search stored Threadex sessions, inspect or keyword-filter their turns, ask a read-only question from saved context, or monitor a local process through Threadex.
---

# Session Inspector

Use the Session Inspector for read-only access to stored Threadex history. Its optional MCP bridge also exposes the Threadex process monitor and, inside a managed parent session, `create_task` for an explicit context-fork handoff. `create_task` must receive a self-contained prompt and preserves the parent relationship while the child runs in the background.

The server injects this skill into every workspace at startup under
`<workspace codexHome>/skills/session-inspector`. Do not install a second copy or
fall back to opening DuckDB files directly.

Prefer the HTTP API when running inside this app's runner, because it reuses the
already-open Express `SessionStore` and avoids a second DuckDB process lock. The
optional `session_inspector` MCP server also exposes process-monitor tools when
MCP is enabled for a runner. Those tools call the Threadex API, so the
server remains the owner of process state.

## HTTP API

- `GET /api/sessions?q=...&limit=...&offset=...`: UI-style session search. The
  response contains `sessions` with `id`, `name`, `turnCount`, and `time`
  (also `title`, `created`, and `updated` for compatibility), plus a `page`
  object.
- `POST /api/session-inspector/session`: inspect one session by `sessionId` or `threadId`.
- `POST /api/session-inspector/search`: global search over stored session turns.
- `POST /api/session-inspector/ask`: answer a question from one session's saved
  turns with the `luna` model. This endpoint is read-only side chat: it uses a
  forked ephemeral agent context, persists outside `session_turn`, and does not
  create a turn, run a command, or edit the workspace.
- `GET /api/session-inspector/vector/status`: check vector-search readiness.
- `POST /api/session-inspector/vector/search`: search precomputed session description embeddings.
- `GET /api/process-monitors`: list process monitor state for the active workspace,
  including built-in read-only health records for the current API server and
  Vite client.
- `GET /api/wait-events`: list durable backend events and their per-session
  subscriptions for the active workspace.
- `POST /api/wait-subscriptions`: subscribe a session action to an existing
  retained wait event.
- `POST /api/process-monitors`: monitor an existing `pid` temporarily, or start and monitor an `exe` with `args` and a label.
- `POST /api/process-monitors/:id/adopt`: attach a complete durable restart launch spec to a live PID without restarting it.
- `POST /api/process-monitors/:id/restart`: restart an executable-backed monitor.
- `DELETE /api/process-monitors/:id`: remove a monitor and stop its managed process.

Use `RUNNER_SERVER_URL` or `http://127.0.0.1:8787` unless the runner job provides a different server URL.

### Search sessions

Use the UI-style endpoint when the user wants a list of sessions by name or
content:

```json
{"q":"embedding bug","limit":20,"offset":0}
```

Prefer the returned `session.id` for subsequent calls. Search is scoped to the
active workspace, like the UI. Use `workspaceId` with the inspector search API
when an explicit workspace filter is needed.

### Inspect turns

```json
{"sessionId":"local_...","q":"DuckDB","turnLimit":50,"turnOffset":0}
```

`q` is a case-insensitive filter over each turn's user and assistant text.
Use `status`, `turnId`, pagination, and `maxTextChars` to keep context bounded.

### Ask a session question

```json
{"sessionId":"local_...","question":"What caused the failure and how was it fixed?","q":"failure","turnOffset":0}
```

The answer is generated only from the selected session context. If the answer
is not present in the saved turns, report that instead of guessing. Do not use
the normal `/api/chat` endpoint for this task: it creates an executable agent
turn and may access the workspace.

### Prompt a session

Use `prompt_session` only when the user explicitly wants to add a real prompt to
another session. It starts the normal runner or queues a normal pending turn
when that session is already running, so the prompt and answer become part of
that session's log and future context.

## Embedding Descriptions

Use `npm run embed:session-descriptions` to generate or refresh embeddings for
`sessions.description` only. The script hashes each description and skips rows
whose hash and model already match.

The app server now also refreshes `sessions.description` and
`session_description_embedding` automatically after session switches and idle
periods. Use the embed script for backfills or when you need to reprocess
existing descriptions in bulk.
If you need to review the summarizer input itself, set
`SESSION_SUMMARIZER_PROMPT_DUMP_DIR` and inspect the generated prompt text files
locally.
The summarizer prompt includes every user prompt, a topic lead of at most 400
characters from each earlier agent response, and the complete final agent
response. Turns are listed newest-to-oldest. If the prompt would get too large,
it trims each turn proportionally instead of dropping turns outright.
Prompt files use a compact `#n` / `user:` / `agent context:` / `final agent:`
layout.

Summaries and keyword weights are generated in English so search terms stay
stable across sessions and vector/FTS retrieval works more predictably.
The session summarizer only writes two metadata fields: `sessions.description`
and `sessions.keyword_weights`. The description should stay in English and
should mention the work done, any blockers encountered, and the key actions
taken, while keywords should stay specific and lower-case. Its prompt/output
format is intentionally simple: two plain text lines, `description:` and
`keywords:`, to keep the mini model output stable.

Default local provider:

```bash
ollama pull bge-m3
npm run embed:session-descriptions -- --dry-run
npm run embed:session-descriptions
```

## MCP Tools

- `recover_current_session`: recover saved turns from the receiving Threadex
  session when opaque Codex compaction or an incomplete summary may have omitted
  an earlier correction, decision, final result, or implementation detail. It
  needs no session ID, defaults to the newest 20 completed turns, and supports
  an optional text filter and pagination.
- `get_session`: inspect one session by `sessionId` or `threadId`.
  - Use `turnLimit` / `turnOffset` for turn pagination.
  - Use `includeEvents`, `eventLimit`, `eventOffset`, and `eventName` for raw runner/app-server events.
  - Use `includeLiveItems` to include summarized tool calls, approvals, file changes, reasoning, and agent messages.
  - Use `q` and `status` to filter turns.
- `search_sessions`: global search over stored session turns.
  - Uses DuckDB FTS when possible and falls back to case-insensitive contains search.
  - Supports `workspaceId`, `sessionId`, `threadId`, `status`, `limit`, and `offset`.
- `ask_session`: ask a question about one saved session. The server supplies
  the selected turns to the `luna` model and returns only an answer. The
  interaction is recorded as side chat outside `session_turn`; it does not
  create a normal session turn or perform commands/edits.
- `prompt_session`: add a real prompt to a session. It uses `/api/chat` when the
  target session is idle and `/api/pending-turns` when it is running, so the
  normal runner writes the prompt into session log/context.
- `vector_status`: check whether DuckDB vector search prerequisites are available.
- `vector_search`: search `session_description_embedding` with a caller-supplied embedding vector.
  - Only `sessions.description` should be embedded.
  - Embeddings must already exist in DuckDB; this tool does not generate embeddings.
- `list_processes`: return a compact list of currently monitored processes. The
  Threadex API server and Vite client are included as built-in read-only
  health records. The server reports its current PID; the client probes Vite's
  health endpoint so externally managed restarts do not leave stale PID state.
- `monitor_process`: labels are display text and never discover a process. Use
  `pid` only for a temporary, non-restartable attachment that stores no launch
  args and disappears when that exact PID exits. For a durable monitor provide
  `exe` with the complete `args` vector (including a script/command for
  interpreters), `dockerImage`, or legacy `command`. Bare interpreters such as
  `node`, `sh`, `bash`, and `python` are rejected. Optionally provide
  `wakePrompt` for one follow-up prompt on completion or `timeoutSeconds` for a
  maximum lifetime. Do not create `threadex-server` or
  `threadex-client` monitors: both are already represented by built-in
  read-only health records and require external supervisors.
- `adopt_process_monitor`: add a complete durable restart launch spec to an
  already-running PID without restarting it.
- `restart_process_monitor`: restart an executable-backed monitor by id.
- `remove_process_monitor`: stop a managed process and remove its monitor.
- `list_wait_events`: list central durable wait events together with each
  session subscription and delivery state.
- `subscribe_wait_event`: subscribe another session to an existing event. Use
  `enqueue_prompt` with `actionPayload.message`, `retry_turn` with `turnId`, or
  `notify` for state-only observation. Fired events are retained and dispatch
  late subscriptions immediately.

## Defaults

Text fields are truncated to 20,000 characters by default. Increase `maxTextChars` for fuller context, or page through turns/events instead of requesting everything at once.

When the user asks for another session's context, prefer `search_sessions` first if only keywords are known, then call `get_session` with the returned `session.id` or `threadId`.
