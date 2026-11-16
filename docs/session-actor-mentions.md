# Session Composer @mentions of workers

An agent session's Composer can address workers with `@Name`. The
mentioned actors execute the prompt **in that session**; no new task session is
created. Without a mention the Composer keeps using `/api/chat` unchanged.

## API

`GET /api/sessions/:sessionId/actor-mentions/candidates`

- 200 `{ projectId, projectName, actors: [{ id, name, avatar?, roleSummary, parentActorId }] }`:
  workers of the session's project that may execute with a model in the session's provider group.
- 404 `session_not_found`; 409 `session_project_unresolved` | `session_actor_bound`.

`POST /api/sessions/:sessionId/actor-mentions`

- Body `{ requestId, message, mentionedActorIds, model?, modelReasoningEffort? }`. `requestId` is reused when the same
  send is retried; `message` is the Composer text verbatim; `mentionedActorIds` lists 1–8 actors in order of appearance,
  without duplicates. `model`/`modelReasoningEffort` are the Composer's gear for this send; without a catalog model
  (for example Auto) the session's saved selection applies. A sent gear becomes the session's selection, as a chat send does.
- 200 `{ round: { id, status, error, namedActorIds, workItemIds }, turnIds }`. `turnIds` are the turns queued in this
  session. `no_claims`, `routing_failed` or empty `turnIds` mean nothing ran; `round.error` explains why.
- 400 `mention_invalid` | `mention_limit` | `mention_attachments_unsupported` | `mention_actor_not_found` |
  `mention_actor_wrong_project` | `mention_actor_not_permitted` (with `actorIds`); 409 `session_project_unresolved` |
  `session_actor_bound` | `session_not_accepting`; 404 `session_not_found`. Errors never fall back to `/api/chat`.

## Rules

- The session's project is the registered Codex project whose most specific root contains the session cwd. A session
  outside every registered project, or ambiguous between projects, cannot take mentions.
- Every mentioned actor must exist, belong to that project (`projectIds` of its root) and allow a model in the provider
  group of the session's selected model.
- In an actor task session the session's own actor keeps the session: it is not a candidate and cannot be mentioned
  there. `sessionTarget.hostWorkItemId` names the session's bound work. The user already named the actors, so no
  reply, claim, allocation, Decision or background job runs: the request directly reserves a turn-scoped host work item
  for the session's actor (`allocationId: "session-host"`, the send's model and effort) and one native sub-agent per
  mentioned actor (its default model when the session's provider group allows it, else its first permitted model), then
  queues the host turn in place: its message is the user's Composer text verbatim, with no server-written brief and no
  inter-actor `promptOrigin`, so it shows and counts as the user's own prompt. The sub-agents are defined and authorized
  for that turn and listed in the host's actor context; the host starts them by name with the session context it
  already has, integrates their results and never performs their work itself.
  Only that turn binds the host; the session's other turns keep the task binding. A session the task has since moved
  away from returns 409 `session_actor_bound`.
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
