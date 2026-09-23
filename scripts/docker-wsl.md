# Local Docker Engine in WSL

The migrated databases run in Ubuntu-24.04's independent Docker Engine.
Docker Desktop is stopped. Its original volumes are retained as pre-cutover
copies, not live replicas; do not start the old database containers alongside
the new ones.

Start Threadex with `npm run serve:wsl`. This uses existing built client assets,
keeps WSL running, waits for Windows localhost forwarding, and starts Threadex
against PostgreSQL at 127.0.0.1:55432. Build separately when needed.

Manage containers from PowerShell with:

```powershell
wsl -d Ubuntu-24.04 -u root -- docker ps
wsl -d Ubuntu-24.04 -u root -- docker stats --no-stream
```

The Windows `docker` context still points to the stopped Docker Desktop engine.
No Docker API TCP endpoint or custom named-pipe bridge was installed.

Live containers and volumes:

- `threadex-pg-migration`: `threadex-pg-data-wsl-final`, port 55432.
- `gnm-retrieval-pilot-20260921`: `gnm-retrieval-pilot-20260921-wsl-final`, port 18123.

ClickHouse retains its original restart policy (`no`). After a WSL restart,
start it explicitly when needed:

```powershell
wsl -d Ubuntu-24.04 -u root -- docker start gnm-retrieval-pilot-20260921
```

Migration logs are in `outputs/docker-wsl-migration-20260921`.
Both stopped source volumes and destination volumes had matching file-content
SHA-256 manifests before cutover. Container inspection metadata in that folder
may contain environment secrets; do not publish it.

The migration script is a one-time operation and refuses existing final volumes.
Do not rerun it after cutover. Old volumes cannot be used for a lossless rollback
without first copying changes made since cutover back to the old engine.
