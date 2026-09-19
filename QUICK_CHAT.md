# Quick Chat desktop adapter (experimental)

The middle-panel Quick Chat tab uses the installed ChatGPT App's hidden renderer. It does not start a Codex task. The account selector shows the connected App identity; saved Threadex Codex accounts and their `auth.json` files cannot currently switch this identity.

The adapter currently recognizes `app-initial-b21bd554b363.js`. Other App builds fail with an explicit unsupported-build error. It reads the App's model presets and validates them again before each request. It does not expose custom model or effort editing.

## Local connection

The App must have a renderer and a loopback debugging endpoint enabled. Threadex never focuses, navigates, or writes App UI state. It can use the current visible renderer to start a separate temporary completion without changing its displayed page. After saving ongoing App work and quitting it yourself, launch it with:

```sh
open -a ChatGPT --args --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222
```

Refresh Quick Chat after the App has initialized. `QUICK_CHAT_CDP_URL` can select another `http://127.0.0.1:<port>` endpoint. Keep this debugging endpoint local: it grants access to the signed-in App.

## Sessions and limitations

Requests use temporary ChatGPT conversations. Local transcripts and continuation IDs are saved in `quick-chat-sessions.json` under Threadex's data directory, with owner-only permissions. Temporary conversations may expire upstream; the adapter does not promise permanent continuation. Messages appear after the full reply, with a pending indicator during generation.

Sessions are bound to both the App account and user identity. Switching the account inside the App requires refreshing Threadex. `auth.json` account switching is unverified and is not implemented. Only the first supported hidden renderer is connected; the dropdown does not imply a multi-account connection pool.

An interrupted or uncertain request is persisted before dispatch and cannot be continued automatically. Start a new session after inspecting the error. App updates can break this private adapter; live smoke testing is required after adapting it to a new build.
