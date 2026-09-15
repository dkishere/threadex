# Install Threadex

Threadex is a local, single-user UI around the Codex app-server, with PostgreSQL
history, detached runners, and optional browser/editor integrations.

## Platform expectations

| Environment | Status |
| --- | --- |
| macOS | Primary development environment. |
| Linux | Expected to work with the dependencies below; not yet certified by a clean Linux integration run. |
| Windows with WSL2 | Recommended Windows route: run Node, Codex, Git and Threadex inside the same Linux distribution. Not yet integration-tested here. |
| Native Windows | Experimental. Unix process controls, directory symlinks, CLI launchers and cross-drive paths still need work. Do not rely on restart/stop/recovery behavior. |

## Prerequisites

- Node.js **22.12 or newer** and npm (Node 22 LTS is a suitable baseline).
- Git on PATH, including for per-turn change reviews.
- Docker with Linux containers, or an existing PostgreSQL 16 server.
- An installed, authenticated Codex CLI that provides `codex app-server`.
  Follow the [Codex CLI setup documentation](https://developers.openai.com/codex/cli).
  Authenticate as the same OS user that runs Threadex. Model availability depends
  on your account; choose an available model in Threadex settings.
- On Linux/WSL, `ps` (usually the `procps` package) and `lsof` for process management.

Do not copy `node_modules` from another computer or operating system. Install
dependencies on the destination so platform-specific packages are selected there.

## Quick start: macOS / Linux

```bash
git clone https://github.com/dkishere/threadex.git
cd threadex
npm ci
node --version
codex --version
docker info

# Optional integrations can be enabled after the basic app works.
export WEB_VSCODE_AUTOSTART=false
npm run dev
```

Open **http://localhost:5173**. The server watcher automatically starts a local
PostgreSQL container if no database URL is supplied. Docker must already be running.
Allow the first image pull and database initialization to finish.

The default database uses container `threadex-pg-migration`, named volume
`threadex-pg-data`, and port `127.0.0.1:55432`. Check it with:

```bash
npm run pg:dev -- status
curl --fail http://localhost:8787/api/health
```

Create/select a workspace and account in the UI, choose an available model, and
send a short prompt. Then verify a follow-up and a page refresh during a turn.
These exercise your local CLI/auth setup, which a build check cannot verify.

If Codex is not found, use the actual executable path:

```bash
export AGENT_CLI_PATH=/absolute/path/to/codex
```

On macOS, Threadex automatically prefers the CLI bundled at
`/Applications/Codex.app/Contents/Resources/codex` when present.

### Use an existing database

Create a dedicated database and role with permission to create/update tables.
Set the URL before starting Threadex; automatic schema initialization runs at startup.

```bash
export SESSION_DATABASE_URL='postgres://USER:PASSWORD@HOST:5432/threadex'
export WEB_VSCODE_AUTOSTART=false
npm run dev
```

URL-encode special characters in credentials. With a database URL set, the dev
watcher skips the Docker helper. The local default credentials are for a
loopback-only development database.

## Windows via WSL2

Install a Linux distribution using [Microsoft's WSL instructions](https://learn.microsoft.com/windows/wsl/install).
In its Linux terminal, install Node 22.12+, Git, `procps`, `lsof`, and the Linux
Codex CLI. Authenticate Codex inside WSL. Use Docker Desktop's WSL integration
with Linux containers, or supply a PostgreSQL URL accessible from WSL.

Clone into the Linux filesystem, for example `~/projects/threadex`, and follow
the quick start above from that terminal. Open http://localhost:5173 in your
Windows browser. Keep workspace projects and CLI paths in the same WSL environment.
Do not mix Windows `node.exe`/`codex.cmd` with Linux paths.

Browser Bridge on a Windows Chrome profile is a separate integration: its daemon
and extension must be able to reach each other. Windows/WSL loopback connectivity
and filesystem sharing are not validated by this guide. Start with core chat first.

## Built client (without Vite)

```bash
npm ci
npm run build
npm run pg:dev -- start
export WEB_VSCODE_AUTOSTART=false
npm start
```

Open **http://localhost:8787**. `npm start` serves `dist/` but does not start
PostgreSQL for you. Skip `pg:dev` when using your own database URL.
The server still runs TypeScript through `tsx`; retain `src/`, `scripts/`, `skills/`,
`extensions/`, and installed dependencies. `dist/` alone is not a server deployment.

Read [SECURITY.md](SECURITY.md) before remote access. Use the built client and
password setup for remote access; do not publicly expose the Vite development
server, PostgreSQL, code-server, or Browser Bridge ports.

## Optional integrations

### Web VS Code and change review

Install [code-server](https://coder.com/docs/code-server/install) in the same
environment as Threadex. Then restart Threadex with:

```bash
export WEB_VSCODE_AUTOSTART=true
# Only needed if it is not on PATH:
# export CODE_SERVER_COMMAND=/absolute/path/to/code-server
npm run dev
```

The default editor port is 8790. Threadex installs its bundled review extension.
Core chat does not require this editor. For an existing editor deployment, see
`WEB_VSCODE_URL` in [README.md](README.md); workspace and review paths must be accessible there.

### Local Browser Bridge

```bash
npm ci --prefix local-browser-bridge
npm run browser-bridge:build
npm run browser-bridge:start
```

Load `local-browser-bridge/extension/` as an unpacked extension in Chrome developer
mode. Keep the daemon running in its own terminal. The first extension pairs
automatically; see [the bridge guide](local-browser-bridge/README.md) for replacement
pairing and CLI installation on PATH. This integration is optional for core chat.

## Configuration

Set environment variables in the shell or your process manager. Threadex's server
does **not** automatically load a `.env` file. For a local, trusted shell-format
file, explicitly export its variables before starting; never commit credentials.

| Variable | Purpose |
| --- | --- |
| `SESSION_DATABASE_URL` | Existing PostgreSQL connection URL. |
| `SESSION_DATA_DIR` | Runtime files; defaults to this checkout's `data/`. |
| `AGENT_CLI_PATH` | Explicit Codex executable. |
| `AGENT_CLI_HOME` | Source Codex home/auth; see README for account/workspace homes. |
| `CODEX_WORKDIR` | Default project working directory for new threads. |
| `WEB_VSCODE_AUTOSTART` | Set `false` when code-server is not installed. |
| `PORT` | API port, default 8787. |
| `VITE_API_TARGET` | Dev proxy destination if the API port/address changes. |
| `RUNNER_SERVER_URL` | Address runners use to reach the API; set when changing its endpoint. |

See [README.md](README.md) for background-model and other advanced settings.
Background features may need model names available to your account.

## Moving an existing installation

A fresh clone does not contain your sessions or accounts. Before moving:

1. Finish/stop active turns and stop Threadex and its runners.
2. Back up PostgreSQL using `pg_dump` and restore into the destination PostgreSQL.
   The Docker named volume is **outside this repository**; copying `data/` does
   not copy the database. Keep a backup until the destination is verified.
3. Privately transfer `data/`, the relevant Codex homes, and workspace projects.
   These contain credentials, session transcripts, attachments and security state.
4. Reconfigure executable paths and environment variables. Reinstall dependencies.
5. Review stored workspace/session paths, Codex homes, upload/log paths and old
   process state. Changing `SESSION_DATA_DIR` does not rewrite database paths.
   There is currently no automated cross-OS/path migration tool. Do not assume
   old running PIDs are valid on the new host.
6. Rebuild/re-pair optional integrations and verify old attachments/history as
   well as a new chat turn before retiring the old installation.

For the simplest transfer, keep the same absolute paths on a compatible OS.
Cross-OS history migration requires a separately reviewed path mapping.

## Troubleshooting and verification

- **Database connection refused:** start Docker and `npm run pg:dev -- start`,
  or verify `SESSION_DATABASE_URL`. Check port 55432 conflicts.
- **CLI not found/auth missing:** check `AGENT_CLI_PATH`, the service user's PATH,
  and Codex authentication in that same environment.
- **API startup mentions a missing skill or symlink permission:** retain the
  repository's `skills/` directory and use a writable data directory. Native
  Windows directory symlinks can require additional OS permissions.
- **Editor launch errors:** set `WEB_VSCODE_AUTOSTART=false` or install code-server.
- **New machine shows stale paths:** follow the migration section; a database
  restore does not translate filesystem paths automatically.
- **Native Windows stop/restart fails:** use WSL2; native Windows process lifecycle
  support is incomplete.

Source checks:

```bash
npm run typecheck
npm run build
npm test
```

Some integration tests require PostgreSQL or local process capabilities. These
commands do not establish native Windows support or validate live account access.
