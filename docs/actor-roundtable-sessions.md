# Group chat round tables in their own session

Owner: A1 (server, data and contract). A2 owns the group chat entry, link card,
navigation and the source link shown inside the new session.

A round table started from the Actors group chat no longer runs in place. The
server creates a dedicated session, starts the first round there with the
existing round table runner, and records only a link in the actor room
(`room.roundtables`). Rounds, participant answers, the conclusion and any next
rounds live in that session's existing `session_roundtable_round` records and
render with the existing round table UI. No group chat round, reply or work item
is created for it.

Shared types: `src/actorRoundtables.ts`.

| Method | Route | Result |
| --- | --- | --- |
| POST | `/api/domain-actors/:workspaceId/roundtables` | `ActorRoundtableView` |
| GET | `/api/domain-actors/:workspaceId/roundtables` | `{roundtables: ActorRoundtableView[]}`, newest first |
| GET | `/api/domain-actors/:workspaceId/roundtables/sessions/:sessionId` | `{roundtable: ActorRoundtableView \| null}` |

All routes require the signed-in user, like the other actor registry routes.

POST body (`StartActorRoundtable`):

```ts
{ requestId: string;          // 1–100 [A-Za-z0-9_-]
  message: string;            // trimmed nonempty, ≤ 16000 characters
  actors: RoundtableActor[];  // same actor list the existing round table picker produces
  sourceRoundId?: string;     // a group chat round in this workspace
  title?: string }            // optional; otherwise derived from the prompt
```

- Idempotent by `requestId`: a retry with the same input returns the same view;
  a changed input under the same ID is rejected (400).
- Title: short (≤ 48 characters), no actor prefix, `titleSource: "actor"` so the
  summariser does not rename it; a user rename still wins.
- The round prompt is the user's message followed by a delimited, bounded
  context excerpt of the source round (or the latest group rounds) and their
  replies, marked as untrusted background. The full history is never copied.
- The session uses the workspace's default cwd and approval policy. Consultant
  round table participants keep their existing read-only discussion runner; no
  task, assignment, delegation or extra permission is created.

`ActorRoundtableView.state` follows the session's latest round: `queued`
(queued), `running` (context/actors/host), `done`, `error`, `stopped`, or
`missing` when the session/round has gone. `conclusion` is a ≤ 600-character
excerpt of the latest finished round's synthesis or summary. Progress does not
change the room revision; the card should re-read the list (or the session
route) while a link is `queued`/`running`, or on the session's round table
progress events.

Legacy in-place round tables in ordinary sessions are unchanged and still
render; nothing is migrated or deleted. The ordinary session composer's round
table mode keeps its in-place behaviour.
