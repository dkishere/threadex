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

## Experimental Session Categories

Category output language follows source sessions by default, not existing labels.
POST `language: "auto" | "en" | "zh-Hant"` sets a workspace override (backed up).
POST `relabel: true` translates existing names/descriptions via Luna without
changing category IDs, structure or memberships; it saves a backup first.
POST `categoryLabels: [{id, name, description}]` updates a complete set of labels
atomically with a backup, retaining structure/memberships and without scheduling classification.

New workspaces start with an empty category list. Enabling runs the v2 planner
directly using the workspace name and sessions; no Runner/UI/Server presets.
Non-Threadex workspaces include their own sessions across CWDs. The Threadex
workspace retains its existing source-project CWD scope.

Version 2: POST `{workspaceId, replan: true}` backs up the complete current state
to an immutable timestamped file before Luna plans a replacement taxonomy from
all scoped session metadata. `backupPath` records its location. The prompt starts
with an imagined functional PRD, followed by technical specification/domains;
there is no fixed number of dimensions. `memberships` maps session IDs to arrays
of category IDs; `assignments` remains a legacy primary-category projection.
Manual additions preserve existing memberships. Thresholds trigger semantic
review, never require splitting. Review may add zero, one, or several children,
with overlapping memberships and no minimum group size or coverage quota.
Version 2 pauses context generation/injection (`contextPaused`); focus on taxonomy.
The older version 1 behavior below applies only to unmigrated workspaces.

The sidebar has separate Sessions and Categories tabs. Categories are opt-in per
workspace and currently cover sessions under the Threadex source project only.
Use `/api/experimental/session-categories`, never edit its backing files directly.

- `GET ?workspaceId=...` returns enabled state, threshold, categories, assignments,
  project sessions, `classifierStatus` and `poolStatus` (running/error).
- `POST` accepts `workspaceId` and any of: `enabled` (boolean), `threshold`
  (integer 4–200), `parentId` + `name` (create child), `categoryId` + `context`
  (save manual shared notes, maximum 4000 characters), `categoryId` + `sessionId`
  (move a project session), `reclassify: true` (force Luna to revisit classifications),
  or `refreshPools: true` (regenerate AI pools).
- Luna classifies sessions through the authenticated session-summarizer route. It
  receives the title, description and first user request, chooses the most specific
  category by primary objective, records a confidence/reason, and holds decisions
  below 0.75 in their existing parent. Automatic child groups need 2–3 distinct
  topics with at least three supporting sessions each. Manual moves are locked.
  The old keyword tree is retained as `previousTree` during migration.
- Incomplete classification arrays are retried as smaller batches. Malformed split
  membership gets one repair attempt; if it remains invalid, Threadex records the
  checked evidence and keeps those sessions safely in the parent category.
- Enabling/reclassifying schedules Luna using workspace auth. Completed session
  summaries schedule incremental classification only for new or changed sessions.
  Automatic split review is limited to top-level product areas on first setup;
  explicit reclassification can review them again. Context pools are generated
  once after the initial classification and later refresh only through
  `refreshPools: true`. AI pools use up to eight recent
  sessions and two completed turns each; they are bounded references, not full
  history. Model failures are exposed in `poolStatus.error` and can be retried.
- AI notes (`aiContext`, `aiSources`, `aiUpdatedAt`) stay separate from editable
  manual notes. Both inherit down the category tree and enter the next turn's
  reference context. Disabling retains saved notes but stops injection/refresh.
- Luna classifies from session metadata and original intent; splitting creates a
  nested topic category, never a conversation fork. There are at most 100
  categories and five levels. Existing session lineage and the Sessions list are
  unchanged.

## Maintaining This Skill

Keep future Threadex-client configuration contracts here when they affect how
agents configure Threadex-managed state. Keep the always-injected developer
instruction short; put endpoint details and operational guidance in this skill.
