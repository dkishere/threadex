# Workers by project and per-project group chats

Owner: A1 (threadex-session-planning) for the data model, API and chat isolation.
A2 (threadex-composer-ui) consumes this contract for the Workers list and chat UI.

## What a project is

A project is a Codex project registered in the workspace's `CODEX_HOME`
(`state_*.sqlite`, tables `projects` / `project_roots`), the same registry the
actor task binding (`src/server/domainActorProject.ts`) and
`GET /api/workspaces/projects?workspaceId=` already use. It is neither the
workspace nor its cwd: one workspace registers several projects, and a root may
be shared (the Threadex workspace cwd is a root of both `session-manager` and
`bdd`). Project IDs are only meaningful inside their workspace.

## Worker membership

- Root workers carry `projectIds?: string[]` (user decision: explicit
  assignment). Absent or `[]` means **Unassigned**. Sub-actors belong to their
  root's projects and cannot be assigned separately.
- Nothing is backfilled: every existing worker starts Unassigned until the user
  assigns it. Default-binding corrections belong to threadex-workspace-security.
- A worker may belong to several projects; it is listed in, and takes part in
  the chat of, each of them. Its memory and model settings are shared.

## API

All routes are under `/api/domain-actors/:workspaceId` and keep their existing
authentication.

| Method | Route | Change |
| --- | --- | --- |
| GET | `/actors/summary` | Entries include `projectIds` (roots). New `groups: ActorProjectGroup[]`; absent only if the project registry could not be read. |
| PATCH | `/actors/:actorId` | Accepts `{ projectIds: string[] }` for a root worker. Each ID must be registered in this workspace, except IDs the worker already has. `[]` unassigns. Sub-actors are rejected. |
| GET | `/room?chat=<key>` | `rounds` holds only the group rounds of that chat (`key` = project ID or `unassigned`); individual rounds are omitted. Without `chat` the full room is returned (actor views, unchanged). |
| POST | `/requests` | Body accepts `chatProjectId: string \| null` (absent = `null` = Unassigned chat). In a project chat, named actors must be members and the task binding is that project (`newSessionProjectId` defaults to it; another project is rejected). Ignored for an individual request (exactly one named actor). Retries resend the round's `chatProjectId`. |

Registered projects for an assignment picker come from the existing
`GET /api/workspaces/projects?workspaceId=` (`{ workspaceId, projects: {id, name}[] }`).

`ActorProjectGroup` (`src/domainActors.ts`):

```ts
{ key: string; projectId: string | null; name: string; registered: boolean; actorIds: string[] }
```

- Order: registered projects in Codex registry order (including projects with no
  workers), then project IDs a worker still names but the workspace no longer
  registers (`registered: false`, `name` = ID, sorted by ID), then the
  `Unassigned` group (`key: "unassigned"`, `projectId: null`), always last.
- `actorIds` are root worker IDs in registry order. Render each root's
  sub-actors under it, using `rootActorId` from the summary entries.
- Use `actorProjectGroups`, `actorInProjectChat`, `actorRoundChatKey` and
  `UNASSIGNED_ACTOR_PROJECT` from `src/domainActors.ts` instead of reimplementing.

## Group chat isolation

Each group has exactly one group chat, keyed by the group `key`. The server
partitions it; the client must request `room?chat=` and must not filter the full
room itself.

- Candidates, named actors, Decision stakeholder picking, "all actors unrelated"
  re-picking, fast track, existing-session continuation candidates, the previous
  owner, conversation history and the two-round peer context only use that
  chat's rounds and members.
- Individual chats with one worker are unchanged and remain private to its tree.
- Events: there is no push channel. Poll `room?chat=` (existing 2.5 s cadence);
  `revision` is workspace-wide, so the newer-revision rule still holds. Keep
  drafts, pending receipts and attachments per chat key.

## Existing history

Nothing is deleted, moved or rewritten. `actorRoundChatKey` projects legacy
rounds (no `chatProjectId`) at read time: a round whose saved `taskBinding` names
a project (`explicit` or `message` source) reads as that project's chat; every
other legacy round stays in the Unassigned chat, which therefore is the
location of the former workspace-wide group chat.

Retrying a legacy round from the chat it reads into (`chatProjectId:
actorRoundChatKey(round)`) is accepted as the same request and is not rebound to
that project; sending it from a different chat is rejected as changed input.

## Not partitioned

- Escalated blockers and their group-chat notices stay workspace-wide
  (`blockerNotices`, summary `blockers`): every worker of every project chat is
  told. Narrowing them to a project would need a blocker → project mapping
  (for example the blocked work item's round `taskBinding.projectId`).
- Group round tables (`roundtables`, `actorRoundtableContext`) still read the
  latest group rounds of the whole workspace and carry no chat key.
- Task notifications carry no chat key and open the Unassigned chat.
