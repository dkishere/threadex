# Auto model selection

Open gearbox configuration and choose **Auto** as the model for any existing
gear. There are still six gear slots.

In **Settings → Auto model**, save, replace or remove a TypeSafe API key. The key
is shared by all workspaces on this server, stored with owner-only permissions
in `SESSION_DATA_DIR/typesafe-api-key`, and never returned by the settings API.
`TYPESAFE_API_KEY` can supply a default until a setting is explicitly saved or
cleared. Removing the key also overrides that environment default.

With a key, every Auto turn calls TypeSafe's `jev-latest` before the runner
starts. Independent Choice questions select Luna, Terra, Sol or Astra and
low/medium/high/xhigh/ultra effort. The routing criteria favor the least costly
setting judged sufficient for the task; this is a heuristic, not a guarantee
of optimal quality or cost. Legacy models remain available in manual gears.

The state includes the current prompt (up to 12,000 characters) and a bounded
version of the session summariser's context (up to 20,000 characters). It prefers
the commentary summariser's extracts, issues, solutions and blockers over raw
commentary; unsummarised turns use a bounded final response. It retains the
original objective and up to 23 recent prior turns. Current/future queued turns
and raw tool output are excluded. Truncation preserves both ends of long inputs.

Without a key, Auto follows its original logic: start at Luna/high when enabled,
retain the session's setting, and let the agent request upgrades. A failed,
invalid, low-confidence or timed-out Jev request keeps that existing setting.
Requests time out after eight seconds. Successful selections may move down for
a new turn; upgrades within a turn remain monotonic.

Settings API (under Threadex's normal API authentication):

- `GET /api/settings/auto-model`: configuration status only.
- `PUT /api/settings/auto-model` with `{ "apiKey": "..." }`: save/replace.
- `DELETE /api/settings/auto-model`: remove and restore original routing.

Selection events persist model, effort, provider, confidence and a safe status
reason. They do not contain the key or routing input. Runner usage records store
the selected model and effort as usual.

Provider contract: [TypeSafe HTTP API](https://docs.typesafe.ai/api).
