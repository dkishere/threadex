# Session Composer @mentions of workers

An ordinary agent session's Composer can address workers with `@Name`. The
mentioned actors execute the prompt **in that session**; no new task session is
created. Without a mention the Composer keeps using `/api/chat` unchanged.

## API

`GET /api/sessions/:sessionId/actor-mentions/candidates`

- 200 `{ projectId, projectName, actors: [{ id, name, avatar?, roleSummary, parentActorId }] }`:
  workers of the session's project that may execute with a model in the session's provider group.
- 404 `session_not_found`; 409 `session_project_unresolved` | `session_actor_bound`.

`POST /api/sessions/:sessionId/actor-mentions`

- Body `{ requestId, message, mentionedActorIds }`. `requestId` is reused when the same send is retried;
  `message` is the Composer text verbatim; `mentionedActorIds` lists 1–8 actors in order of appearance, without duplicates.
- 200 `{ round: { id, status, error, namedActorIds, workItemIds }, turnIds }`. `turnIds` are the turns queued in this
  session. `no_claims`, `routing_failed` or empty `turnIds` mean nothing ran; `round.error` explains why.
- 400 `mention_invalid` | `mention_limit` | `mention_attachments_unsupported` | `mention_actor_not_found` |
  `mention_actor_wrong_project` | `mention_actor_not_permitted` (with `actorIds`); 409 `session_project_unresolved` |
  `session_actor_bound` | `session_not_accepting`; 404 `session_not_found`. Errors never fall back to `/api/chat`.

## Rules

- The session's project is the registered Codex project whose most specific root contains the session cwd. A session
  outside every registered project, or ambiguous between projects, cannot take mentions.
- Every mentioned actor must exist, belong to that project (`projectIds` of its root) and allow a model in the provider
  group of the session's selected model. Actor task sessions cannot take mentions.
- The round has `sessionTarget`; its candidates are only the mentioned actors. Nobody else is ever picked, repicked or
  added for coverage gaps.
- One mention: no stakeholder picking. The actor replies with an execution brief and claims; the executor is that
  actor (or its chosen sub-actor) and the model follows the usual claim/Decision rules within the session's provider
  group. A declined mention ends as `no_claims` and runs nothing.
- Several mentions: the existing partial-claim flow (allocation, tie-break, coverage) runs among the mentioned actors.
  The integration host runs as a turn of the session and the other assignments are its native sub-agents. Mentioned
  actors without a claim and allocation `review.uncovered` work are reported in `round.error`.
- Mention work items have `sessionScope: "turn"`: the actor binding covers only their own turns (`taskTurnId`,
  `activeTurnId`, native child recovery turns). The user's other turns in the session have no actor binding. Session
  continuation and actor-chat task references never target mention work. Cancel stops only the work's own turn.
- The session's approval policy applies to mention turns; startTask never changes the session's title or model
  preferences.
