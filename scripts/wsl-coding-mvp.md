# Local Windows / WSL2 coding proof

Run from Windows at the Threadex project directory. This standalone runner uses
the same app-server JSON-RPC transport as Threadex, over `wsl.exe` stdio. It does
not modify live sessions or provide a backend selector in the UI.

Install the pinned Linux binary once (temporary storage; reinstall after cleanup):

```powershell
wsl -d Fedora -- npm install --prefix /tmp/threadex-wsl-mvp-tools --no-audit --no-fund @openai/codex@0.154.0
node scripts/wsl-coding-mvp.mjs
```

Requires a working Windows Codex login in `~/.codex/auth.json`, Linux Node and
Git. Optional environment variables: `THREADEX_WSL_DISTRO`,
`THREADEX_WSL_AUTH_FILE` (Windows path), `THREADEX_WSL_MODEL`.

Each run creates an isolated Linux `/tmp/threadex-wsl-mvp-<uuid>/work` directory,
copies only authentication into a private home, and removes that auth copy when
the runner finishes. Abrupt host termination can leave the temporary copy behind.
Windows config, plugins and MCP servers are intentionally not imported.

The smoke task verifies Linux, creates two code files through tracked apply_patch,
and runs Node tests. Completed items stream to Windows; the event transcript is
saved to `artifacts/wsl-mvp/events.json` (overwritten each run). The app-server
runs with workspace-write sandbox and no interactive approvals. A 180-second
deadline interrupts active work. Files remain in Linux for inspection.

First local result on Fedora WSL2: initialization 2438 ms, coding turn 28706 ms;
Linux `pwd` / `uname` reported 43 / 42 ms, test command 300 ms with exit code 0.
These measure this smoke run, not a controlled Windows or macOS comparison.

Production integration still needs persisted per-thread backend selection,
Linux project/toolchain setup, account/home management, resume and cancellation
tests, Windows-to-WSL server callbacks, and attachment/preview path handling.
