---
name: threadex-config
description: Configure Threadex client features for the current workspace, including composer suggestion keywords and thread-scoped project context.
---

# Threadex Configuration

You are running through the Threadex client. Use this skill for Threadex-owned
configuration rather than editing browser storage or the session database
directly.

Use `RUNNER_SERVER_URL` when it is set, otherwise use
`http://127.0.0.1:8787` for the local Threadex API.

## Composer Suggestions

- Saved keywords are scoped to a workspace and are shared by the Threadex UI
  and agents through the API below.
- File and directory suggestions are scoped to a persisted thread CWD, not the
  workspace root. A new thread has no path suggestions until its first prompt
  establishes its project CWD.
- Do not read or write browser `localStorage` for these settings.

### Keyword API

Pass `workspaceId` when operating on a non-active workspace. Requests without
one use the active workspace.

- `GET /api/composer-suggestion-keywords` lists saved keywords.
- `POST /api/composer-suggestion-keywords` adds one or more keywords with
  `{ "keyword": "deploy" }` or `{ "keywords": ["deploy", "review PR"] }`.
- `PUT /api/composer-suggestion-keywords` replaces the workspace list with
  `{ "keywords": ["deploy", "review PR"] }`.
- `DELETE /api/composer-suggestion-keywords/:keyword` removes one keyword. URL
  encode the path parameter.

Use the smallest mutation that satisfies the user's request. Read the current
list before a destructive replacement, and report the workspace affected.

## Auto Model Selection

The TypeSafe Jev credential is a server-wide setting shared by workspaces.
Use `/api/settings/auto-model` rather than writing the credential file directly:

- `GET` returns `{ "apiKeyConfigured": boolean, "selectorModel": "jev-latest", "customRulesEnabled": boolean, "customRules": object }`; it never returns the key. Disabled custom rules mean the built-in model and effort selection is active.
- `PUT` with `{ "apiKey": "..." }` saves or replaces the key.
- `PUT` with `{ "customRulesEnabled": true, "customRules": { "gpt-5.6-sol": { "enabled": true, "efforts": ["high", "xhigh"], "condition": "..." } } }` enables per-model Jev rules. Jev chooses among enabled models and each model's allowed effort levels. Each effort list must be nonempty; only Astra permits low/medium. A blank condition retains that model's built-in condition. Low-confidence upgrades use the next enabled model and its allowed effort levels.
- Send `{ "customRulesEnabled": false, "customRules": {} }` to restore all built-in rules. Threadex still enforces its effort floor, low-confidence upgrade, and API fallback in code.
- `DELETE` clears the key and restores the original Auto upgrade logic.

Do not print the key or include it in source files. When configured, Auto sends a
bounded user prompt and summarized conversation to TypeSafe before each turn.

## Maintaining This Skill

Keep future Threadex-client configuration contracts here when they affect how
agents configure Threadex-managed state. Keep the always-injected developer
instruction short; put endpoint details and operational guidance in this skill.
