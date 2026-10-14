# Claude models in Threadex

Threadex can run a session turn on Claude instead of Codex. Pick **Claude Opus 5.5**, **Claude Sonnet 5.5** or **Claude Haiku 5.5** in the model gear selector; everything else (transcript, approvals, steering, session_inspector tools) works through the same runner events as Codex.

## Setup

1. Install the SDK in this repository (it is loaded only when a Claude model is used):

   ```sh
   npm install @anthropic-ai/claude-agent-sdk
   ```

2. Add a Claude account: open the account menu in the header, find the **Claude** section and choose **Add**. Threadex runs `claude auth login` for that account and shows the login link (and the Terminal command, if the browser does not open). Claude Code must be installed (`claude` on `PATH`, or set `THREADEX_CLAUDE_PATH`).
   Without any Claude account, Claude models use this computer's default Claude login.

3. Restart the Threadex server.

## Claude accounts

- Each Claude account has its own authentication home under `data/account-claude-homes/<id>`, so several subscriptions can be logged in side by side. Turns use separate execution homes as described below. Accounts are stored in their own tables (`claude_accounts`, `workspace_claude_account`, `session_claude_account`) and never enter the Codex account pool, quota refresh or load balancing.
- Which account a Claude turn uses: the account pinned to the session ("Use in this session"), otherwise the workspace's Claude account (click a card), otherwise the most recently used logged-in account.
- Usage: **Refresh** runs `/usage` for the account (a local command, no model call) and shows the 5-hour and weekly windows when the report includes them. During runs, rate-limit events update the account too.
- When an account hits its limit, the turn is saved as pending and retried after the reset time, like Codex usage limits. Claude limits never switch the Codex account.
- If a login expires, the turn shows the error and the card shows **Log in**.
- Removing an account runs `claude auth logout` for it and deletes its config directory.

## How it works

### Workspace isolation

- Ordinary turns use `data/claude-homes/<workspace-hash>/<auth-home-hash>` as `CLAUDE_CONFIG_DIR`. Two workspaces using the same login have separate settings, native transcripts, memory and plugin state. Switching accounts also selects a separate native home. This separates agent state; it does not create a Git worktree or duplicate project files.
- Only the Claude OAuth credential is copied from the selected account (or default login). Account settings, hooks, MCP configuration, `CLAUDE.md` and project history are not copied. The workspace home supplies user settings; project/local settings still belong to the session's project. A refreshed credential is synchronized back only while the source login is unchanged, so logout, relogin and another runner's refresh take precedence. Credentials stay out of runner job files and events.
- Native thread lookup includes the execution home and cwd. Existing account-home threads are not adopted into a new workspace home: the first isolated turn starts a native thread with the saved Threadex conversation, including user follow-ups. Original history remains available.
- `workspace-write` enables Claude's native Bash sandbox with startup failure if sandboxing is unavailable. File tools have a separate `PreToolUse` path check, including symlink resolution and protected agent/Git configuration. `never` approval cannot bypass these boundaries. With interactive approvals, a specific out-of-bounds edit or unsandboxed command requires approval; `read-only` refuses mutations. `danger-full-access` is the explicit unrestricted mode. External network stays denied, but `workspace-write` allows loopback (`allowLocalBinding`) so local test databases and dev servers work without approval. This is an accepted risk: loopback also reaches Threadex's own API, which trusts direct local requests and so lets a writable turn approve its own escalations, and Threadex's Postgres. `read-only` keeps loopback closed. As with Codex, these are tool execution boundaries, not separate OS users or containers; MCP servers retain their own authority.
- Background helpers use temporary authentication-only homes, removed afterwards. Persistent side chats have private homes keyed by the workspace, logical session and authentication source; they never persist transcripts in the account home.

The sandbox API and settings precedence follow the [Claude Agent SDK reference](https://platform.claude.com/docs/en/agent-sdk/typescript) and [Claude sandbox documentation](https://code.claude.com/docs/en/sandboxing). Use a current SDK with `failIfUnavailable` and `managedSettings` support. Native Windows needs WSL2 or another supported sandbox environment.

Focused verification: `node --import tsx --test src/server/claudeHome.test.ts src/server/claudeSandbox.test.ts src/server/claudeRunner.test.ts src/server/claudeOneShot.test.ts src/server/sessionProviderThreads.test.ts`. These use fixture credentials and controlled SDK responses; they do not verify a live subscription or OS sandbox execution.

- `src/server/promptRunner.ts` dispatches turns whose model starts with `claude-` to `runClaudeRunnerTurn()`.
- `src/server/claudeRunner.ts` drives `query()` from the Agent SDK with streaming input, the Claude Code system prompt plus Threadex instructions (`systemPrompt.append`), the `session_inspector` MCP server and a `canUseTool` callback that reuses Threadex approvals (`/api/approvals`).
- `src/server/claudeEvents.ts` maps SDK messages to Threadex `StreamItem`s: text and thinking stream as `agent_message`/`reasoning`, `Bash`/`Read`/`Grep`/`Glob` become `command_execution`, `Edit`/`Write`/`MultiEdit` become `file_change` (full-file diff when the SDK reports the original file), `TodoWrite` becomes `todo_list`, `Agent` becomes `subagent`, compaction becomes `context_compaction`.
- Thread ids are stored as `claude:<session id>`, so a Claude session is resumed with `resume` and never handed to Codex. `session_provider_thread` retains each provider's thread separately, scoped to its native storage directory and working directory. Codex → Claude → Codex resumes the original Codex thread and appends the intervening saved turns, labeled with turn IDs and agent names. The reverse direction works the same way. Existing native context stays in place, allowing provider cache reuse when available; cache hits are not guaranteed.
- Each `session_turn` records `provider` and `native_thread_id` when the runner reports its actual session. `sessions.thread_id` remains the current thread for compatibility. Historical events retain earlier thread IDs when a retry replaces a native session.
- On upgrade, opening the database creates the provider-thread table and adds the turn columns before serving requests. It backfills missing turn metadata for **both Codex and Claude** from each turn's latest saved session/result event. Repeated starts preserve populated fields and existing bindings; turns without reliable native-ID evidence remain null. This historical backfill is independent of whether the original native storage is still available.
- A provider's history checkpoint advances only after a successful result. Failed or interrupted attempts may receive the handoff again on retry. A new or missing native thread receives the full saved recovery history. This includes saved prompts, user steers and final responses, not the other agent's complete internal context or tool transcript. Old Codex bindings are enrolled lazily from saved session/result events. Legacy Claude threads from a different storage home start fresh with saved history on their first run in the workspace home; subsequent switches resume that workspace thread. `recover_current_session` remains available for further history lookup.

| Threadex setting | Claude behaviour |
| --- | --- |
| Approval `on-request` / `untrusted` | `permissionMode: "default"`; tool prompts appear as Threadex approval cards |
| Approval `granular` | Claude `auto` classification, falling back to `acceptEdits` when unavailable; workspace boundaries remain enforced |
| Approval `never` | `acceptEdits`; tools run within the sandbox, boundary escalation is denied |
| Plan mode, force-plan, read-only sandbox | `plan`; mutating tools are refused and `ExitPlanMode` publishes the plan as the reply |
| `AskUserQuestion` | Threadex user-input card |
| Approve session | Rule kept for this Claude session only (never written to settings files) |
| Steer while running | Queued into the same Claude session |

## Environment variables

| Variable | Effect |
| --- | --- |
| `THREADEX_CLAUDE_USE_API_KEY=1` | Keep `ANTHROPIC_API_KEY` for Claude runs (by default it is removed so the subscription login is used) |
| `THREADEX_CLAUDE_CONFIG_DIR` | Default authentication source when no Threadex Claude account is selected; ordinary turns still use their workspace execution home |
| `THREADEX_CLAUDE_PATH` | Claude Code executable for logins and runs (default: `claude` on `PATH` for login/status, the SDK's bundled binary for runs) |

## Not yet supported on Claude

- Concurrent forks (rejected with a clear error), Auto model upgrades, Todo force-plan retry enforcement, context-fork child verification and commentary headlines.
- Side chat, summaries, titles and other background jobs still use Codex.
- No automatic rotation between Claude accounts when one hits its limit (check Anthropic's terms before sharing load across subscriptions).
- Turn records still show the session's Codex account name; the Claude account used is written to the runner log entry `claude.usage`.
- Usage and cost per turn are written to the runner log as `claude.usage`.
