# Actor task blockers

Task blockers are first-class records in the workspace actor room, so actors
(and the user) see them without reading task transcripts.

## Lifecycle

`open → solution_proposed → attempting → resolved`, or
`rejected | failed → escalated → resolved | dismissed`.

- Escalation to the workspace (all actors) happens when a proposal fails, the
  user rejects it, the owner actor declares the blocker unresolvable, or no
  proposal arrives within the deadline (default 30 minutes,
  `THREADEX_BLOCKER_PROPOSAL_TIMEOUT_MINUTES`). The deadline is applied lazily
  when the room is read; there is no timer loop.
- Self-clearing waits (approval, usage-limit retry, allocation dependency) are
  recorded and auto-resolved when the wait ends. They never escalate and are
  not shown in actor context.
- One active blocker per task session, kind and cause (deduplicated). Replayed
  runner events older than the last closing of the same cause never reopen it.

## Sources

| Source | Signal | Clears on |
| --- | --- | --- |
| `agent` | `actor_report_blocker` tool | `actor_blocker_update`, user action |
| `commentary` | summariser issue ledger `comment.blockers` | `comment.solutions` for the same issue |
| `approval` | `runner.approval.requested` | `runner.approval.resolved` (incl. expired) |
| `rate_limit` | `runner.pending` (not Stop) | `runner.runner.started` |
| `allocation` | `work.blockedBy` at dispatch | dispatch |
| `task_error` | `runner.error` | a later `runner.result` |

A new non-self-clearing blocker without a proposal asks its owner actor for a
solution (`proposeBlockerSolution`, owner's model). Proposals marked
`requiresApproval` (needs user approval, exceeds authorization, irreversible)
can only be proposed; `attempting` is refused until the user approves that
proposal. Cancelling a failed task
dismisses its blockers.

## Reminders, not gates

Blockers remind the user that a problem needs solving; they never stop the
agent. Authorization stays with the approval and intention-approval tools.

- Ask in place, not through a blocker: a task that needs the user's choice or
  clarification first uses its brief, attachments and browser bridge captures,
  proceeds on a reasonable low-risk default when one exists, and otherwise asks
  in the same turn with its native ask-user-input tool (Claude
  `AskUserQuestion`; Codex `request_user_input_async` while it still has
  independent work, otherwise `request_user_input`, because an async question
  is cancelled when its turn ends). `actor_report_blocker` is for what an
  answer cannot resolve: a repair, another actor's work or owner coordination.
  Routing a question through the owner costs an extra turn.
- When the owner assesses `needs_user` while the task session already has an
  open native question, nothing is asked again: the blocker is kept as a
  `remind` with the reason in its history.

- The owner assessment classifies a blocker as `needs_user`, `require_fix` or
  `remind`. `remind` covers a wait on another task, work still in progress, an
  external recovery, or a choice with an obvious low-risk default; it asks
  nothing, gets no proposal and is not escalated by the proposal deadline.
- A `needs_user` question is delivered to the original task and raises Needs
  you while it can still be answered, but it does not change the task's status,
  hold dependent work, block completion review, or stop the actor from
  proposing, attempting or resolving the blocker.
- Automatic closes (for example a later `runner.result` clearing a
  `task_error`) skip a blocker whose question still waits, so the reminder is
  kept until the actor or user closes it.
- Work items still in `needs_user` from decisions recorded before this change
  keep their status until the user dismisses or answers those decisions.

## Context delivery

`actorBlockerContext` gives each actor at most 5 own active blockers and 5
workspace escalations, each clipped to 400 characters.

- Stakeholder replies: `context.blockers` in every reply (each reply is a fresh call).
- Task sessions: a per-turn developer note only when the digest differs from the
  one last delivered to that session (`room.blockerDeliveries`); a closing
  sends one "no active blockers" note to withdraw earlier ones.

Escalation and closing of escalated blockers append `room.blockerNotices`
for the group chat. Other actors may propose for escalated blockers; taking on
work still goes through the normal claim/Decision flow.

## UI handoff (threadex-composer-ui)

Data arrives through the existing room endpoint and room-change notifications:

- `GET /api/domain-actors/:workspaceId/room` → `blockers[]` (`id`, `kind`,
  `source`, `status`, `description`, `evidence`, `ownerActorId`,
  `executorActorId`, `taskSessionId`, `workItemId`, `proposals[]`
  (`text`, `requiresApproval`, `outcome`), `history[]`, `escalation`
  (`reason`, `at`)) and `blockerNotices[]` (`kind`: escalated/resolved/dismissed,
  `text`, `blockerId`, `created`).
- `POST /api/domain-actors/:workspaceId/blockers/:blockerId/action` with
  `{ action: "approve" | "reject" | "resolve" | "dismiss", proposalId?, note? }`
  → the updated `ActorBlocker`. Errors are HTTP 400 `{ error }` with a
  readable reason: blocker already resolved/dismissed, proposal superseded by a
  later one, proposal not found, already approved, already
  rejected/failed/succeeded, or proposal does not need approval.
- Suggested presentation: badge on work items/actors with active
  non-self-clearing blockers; escalation cards in the group chat from
  `blockerNotices`; approve/reject on the pending proposal,
  resolve/dismiss on the blocker.

### Waiting for the user (notifications)

- `actorBlockerPendingDecision(blocker): ActorBlockerProposal | null` in
  `src/actorBlockers.ts` (no server-only imports; the client may import it).
  Non-null only when the blocker is active and its latest proposal has
  `requiresApproval: true`, no `outcome` and no `approval`. Approve, reject,
  a newer proposal, resolve, dismiss and task cancellation all make it `null`,
  so no "needs you" state survives them.
- `GET /api/domain-actors/blockers/pending` →
  `{ blockers: Array<ActorBlocker & { ownerActorName?, taskSessionTitle? }> }`
  across every workspace, newest `updated` first, overdue escalation applied.
  Only blockers whose pending decision is non-null are returned. The workspace
  tab action notifications (bell) do not list blocker solutions; proposals are
  decided from the task session and the actor views below.
- Approve: records `proposal.approval = { by: "user", at, note? }` and a
  history entry; the blocker status is unchanged (`solution_proposed` or
  `escalated`). The proposal shows `[approved by user]` in actor context, which
  changes the context digest, so the owner/executor learns it in its next
  stakeholder reply and as a developer note on the task session's next turn.
  Only then may the actor report `attempting` for exactly that proposal; it
  stays bound by every existing permission and approval. Approval does not
  queue a new task turn by itself.
- Reject: the proposal gets `outcome: "rejected"` and the rejection is only
  noted: the blocker moves to `dismissed` (history keeps `rejected` and the
  user's note; an escalated one also gets a dismissed notice). No owner
  reassessment, escalation, new user question or Needs-you state follows; only
  a new user request reopens the work. A self-clearing wait reopens because it
  ends on its own. A failed handoff or a system authorization denial is not a
  user rejection. Escalations recorded earlier with `proposal_rejected` stay
  visible to the user for cleanup but are excluded from actor context and never
  request an owner assessment.
- Live updates: blocker changes call the service `notify` hook, which the API
  server does not wire to the central event stream; they do **not** advance the
  client event cursor. Poll the pending endpoint (or the room) and refresh
  after your own action.

### Task > actor > project views

`actorBlockerOverview(room.blockers, { includeSelfClearing? })` (pure, shared)
returns `escalated[]` (project level) and `counts`, `actors[]` (per executing
actor, with `taskSessionIds`) and `tasks[]` (per task session, newest blocker
first). Counts use `actorBlockerStatusGroup`: open, proposed
(`solution_proposed`/`attempting`), rejected (`rejected`/`failed`), escalated,
resolved (`resolved`/`dismissed`), plus `total`, `active`, `pendingDecision`.
Each blocker counts once, under its executor, so a sub-actor's blockers are
never added to its parent; self-clearing waits are excluded by default.

The shell should not poll the full room. `GET
/api/domain-actors/:workspaceId/actors/summary` (the lightweight summary the
shell already polls) carries `blockers: Array<ActorBlocker & {
taskSessionTitle? }>` (`ActorSummaryBlocker` in `src/domainActors.ts`): every
active (`actorBlockerActive`), non-self-clearing blocker of the workspace,
read after overdue escalation, newest `updated` first, capped at
`ACTOR_SUMMARY_BLOCKER_LIMIT` = 50 (`src/server/domainActorSummary.ts`).
Resolved/dismissed history is therefore not in the summary; use the room for
it. Feed `summary.blockers` to `actorBlockerOverview` for the task, actor and
project levels. `taskSessionTitle` is present when the task session has a
title. The summary has no omitted count, so with more than 50 active blockers
the oldest are missing. Treat `blockers` as possibly absent from servers
older than this field.
