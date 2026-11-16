# Group follow-up of an unowned session (Pick owner)

A session without an actor owner (an ordinary session or a round table session) can be followed up in its project's
group chat, where an actor takes it over. The **Group follow-up** button appears in the session title bar and on round
table cards in the group chat. It sends nothing: it attaches the session as a badge to that project's group chat
composer (the title bar opens that chat first). The user types the follow-up and sends; with a session badge the
composer posts to the endpoint below instead of `/requests`. The badge cannot be combined with files, Round table mode
or @mentions, and only the session's own project chat can send it.

## API

`GET /api/sessions/:sessionId/pick-owner`

- 200 `{ eligible, reason, projectId, projectName, actorCount, pending }`. `reason` is null when eligible, else
  `session_actor_bound` | `session_project_unresolved` | `project_has_no_actors` | `pick_owner_pending`.
  `pending` is `{ requestId, roundId, status }` while a request has not ended; `roundId` is null before its round is saved.
- 404 `session_not_found`. The client shows the button only when eligible, and disabled while pending.

`POST /api/sessions/:sessionId/pick-owner`

- Body `{ requestId, message, chatProjectId? }`: `requestId` is 1–100 letters, digits, `_`, `-` and a retry of the same
  send reuses it; `message` is the composer text; `chatProjectId`, when sent, must be the session's project.
- 202 `{ requestId, chatProjectId, projectName }`: the round runs in the background and is shown in that project's
  group chat.
- 400 `pick_owner_invalid`; 404 `session_not_found`; 409 with the GET reasons (`pick_owner_pending` carries `pending`)
  or `session_not_accepting`. A new requestId while one is pending is rejected; its own retry is accepted.

## Rules

- Eligibility, in order: the session has no session-scoped actor work (`actorSessionWork`); it belongs to exactly one
  registered project; that project has a worker with a model in the session's provider group; nothing is pending.
  Turn-scoped @mention work does not make a session owned.
- The project of a round table session is the group chat it was opened in; otherwise it is the registered project whose
  most specific root contains the session cwd (as for @mentions). Unknown or ambiguous projects are rejected.
- The round is an ordinary project group chat round (`chatProjectId` = project) with
  `sessionTarget: { sessionId, projectId, model, takeover: true }` and no named actors: picking, all-unrelated repicks,
  coverage, tie-break and model Decisions run as usual among the project's workers. The Decision and stakeholder
  instruction texts are unchanged. The round's prompt is the user's message verbatim followed by the attached session
  (title, `threadex://` link, summary, latest user request in it and what taking over means).
- `/requests` never accepts a `sessionTarget` from its body; only the @mention and Pick owner routes set one.
- The claimant's work item runs in that same session with `sessionTakeover: true` and no `sessionScope`: its binding
  covers every later turn, the session keeps its title and model preferences, a reassignment keeps the session, and
  later group chat follow-ups may continue it. Its first turn carries out the user's follow-up there, with the session's
  full history.
- No claim ends as `no_claims` (or `routing_failed` when every worker reported it unrelated); the session stays unowned
  and can be offered again.
