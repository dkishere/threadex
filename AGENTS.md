# Repository Instructions

## Directory Layout

- Client React code lives in `src/client`.
- Server/API/runner code lives in `src/server`.
- Utility scripts live in `scripts`.
- Generated or runtime data lives in `data`, `dist`, `node_modules`, and `tsconfig.tsbuildinfo`.

## Search Rules

Do not run repository-wide searches against `.`.

Avoid commands like:

```sh
rg "pattern" .
find .
grep -R "pattern" .
```

Search only the code or docs needed for the task. Good defaults:

```sh
rg -n "pattern" src/client src/server scripts README.md package.json vite.config.ts
rg --files src/client src/server scripts
```

If a wider search is genuinely required, explicitly exclude runtime and build data:

```sh
rg -n --glob '!data/**' --glob '!dist/**' --glob '!node_modules/**' --glob '!tsconfig.tsbuildinfo' "pattern" src scripts README.md package.json vite.config.ts
```

Never inspect `data/runner-logs`, `data/pending-runner-logs`, `data/quarantined-runner-logs`, `data/codex-homes`, or `data/account-codex-homes` with broad text search. Those files can contain large JSONL records, command output, and base64 data.

## Development Commands

- Client entrypoint: `src/client/main.tsx`
- Server entrypoint: `src/server/index.ts`
- Dev server: `npm run dev:server`
- Dev client: `npm run dev:client`
- Typecheck: `npm run typecheck`
- Build: `npm run build`
