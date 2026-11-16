# Actor reorganization

Workers are reorganized regularly: sub-actors are promoted, responsibilities are
narrowed or moved, roots are added or archived. A reorganization is one atomic
registry change applied through the signed-in API, never through the browser UI
or direct database edits.

## API

`POST /api/domain-actors/:workspaceId/reorganizations` (signed-in user only)

```json
{
  "requestId": "reorg-2026-11-03",
  "reason": "Spread work held by busy roots",
  "dryRun": true,
  "operations": [
    { "op": "move", "actorId": "hatsune", "parentActorId": null, "expectedParentActorId": "sakura" },
    { "op": "memory", "actorId": "hatsune", "expectedVersion": 4, "memory": { "rolePrompt": "…", "roleSummary": "…" } },
    { "op": "update", "actorId": "anya", "changes": { "name": "…", "model": "…", "effort": "…", "allowedModels": ["…"], "projectIds": ["…"] } },
    { "op": "create", "actor": { "name": "…", "model": "…", "parentActorId": null, "projectIds": ["…"], "memory": { "rolePrompt": "…", "roleSummary": "…", "longTerm": "", "rolling": "" } } },
    { "op": "archive", "actorId": "old-worker" }
  ]
}
```

Returns `{ dryRun, reorganization }`, where `reorganization.changes` lists the full
registry entry of every touched actor before and after (null before creation or
after archiving). `GET /api/domain-actors/:workspaceId/reorganizations` returns the
saved audit. The polled `/room` response omits it.

### Actor tool

Bound actor sessions call `actor_reorganize` with the same body. `dryRun` needs no
authorization. Applying first asks Decision whether the user's own messages (the
work's canonical messages, delivered follow-ups, composer turns and mid-turn
answers or steers) explicitly request the reorganization and cover every
operation; a denial changes nothing. A repeated request ID returns its saved
record without a new check. The audit records the actor, work item, session and
turn. The caller's own current task is exempt from the live-activity check.
Native sub-agents cannot call it. The tool result lists changed profile fields
and memory versions and field names, never memory text. To prepare `memory`
operations, `actor_read_memory` accepts another workspace actor's `actorId`
(not from sub-agents).

Merging and splitting responsibilities are expressed with these operations: edit
`rolePrompt`/`roleSummary`/`longTerm` with `memory`, add or archive workers, and
move sub-actors.

## Rules

- Operations apply in order inside one room transaction; only the final registry
  must be valid, so a root can be demoted after its sub-actors move. Any failure
  persists nothing. `dryRun` returns the same result without saving.
- The request ID makes retries idempotent; reusing it for other operations fails.
- One sub-actor level: every sub-actor's parent is a root and its `rootActorId`.
- `move` checks `expectedParentActorId`; `memory` checks `expectedVersion`, merges
  only the named fields and adds source `reorganization:<requestId>`.
- Promotion keeps the projects an actor had through its former root. A change of
  any existing actor's effective projects requires `projectIds` on its final root
  in the same request. Projects must be registered (or already present). A
  sub-actor's models must be allowed by its root.
- Hierarchy moves wait only for live activity in both former and resulting trees:
  a running session, queued follow-up or loop, a dispatch, a pending assignment,
  parallel request, review or task update, or a queued, responding or leased
  round. Unfinished idle work does not block; it keeps its recorded owner and
  executor. (Single-actor hierarchy changes still require settled trees.)
  Profile and memory changes never wait.
- `archive` uses deletion checks and keeps the entry in `deletedActors`, reserving
  its ID. No operation re-creates an actor, reassigns work or moves sessions;
  task ownership stays with the recorded owner and executor.
- Decision candidates, pickup `treeActors` and project groups read the registry,
  so they follow the new structure from the next round.

## Checking a reorganization

`GET /api/domain-actors/:workspaceId/actors/routing-metrics?since=&until=`
(signed-in user) reports, per current actor, over work created in the window:
executions, delivered follow-ups (rework), reassignments away/to (misrouting),
handoffs sent/received, and memory fields longer than the per-field context
excerpt (`ACTOR_MEMORY_FIELD_EXCERPT_BYTES`, injected truncated).
`lastReorganizationAt` marks the latest applied reorganization; compare the
windows before and after it.
