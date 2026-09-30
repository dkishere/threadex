# Concurrent

Each turn has a Concurrent icon. Selecting a completed turn pins that turn as the
inclusive context boundary. The main composer has the same icon; enabling it
selects the most recent completed turn. Both icons highlight the shared selection.
Send in this mode creates a worker without switching away from main. Turn off the
mode to send an ordinary main-session prompt. Unfinished turns hide the icon
because native `lastTurnId` cannot target an in-progress turn.

The Concurrent button beside File changes opens the worker and result popover.
Closing the popover does not cancel composer selection. Cancel spawn in the
selection banner to return to a regular prompt. Routed Concurrent messages use
teal cards with sender, recipient, result and change list. The receiving agent's
response retains its ordinary layout without a surrounding card or widget.
Old API paths remain aliases for existing runners;
new clients, tools and injected skills use Concurrent names. Existing DB table,
IDs and receipt event names are retained so persisted work is not migrated away.

Workers have group-local IDs (`c1`, `c2`, …), ordinary Threadex session/turn records,
and ephemeral native contexts. They inherit the selected model, effort, approval
policy, attachments and skills. Main remains the coordinator and keeps its own
context. All workers share the project directory; detected concurrent edits to
the same file appear in the panel and roster. This is not a file merge service.

## Native capability evidence

The installed Codex app-server JSON schema and metadata-only RPC probes on
2026-09-24 established:

- `thread/fork` accepts `lastTurnId` (inclusive, completed turn) and
  `beforeTurnId` (exclusive). Threadex uses the saved native turn mapping, not a
  guessed correspondence between Threadex and native IDs.
- `thread/fork` with `ephemeral: true`, `excludeTurns: true`, and `lastTurnId`
  returned an independent thread ID with `path: null`.
- `ephemeral` cannot be combined with `deferGoalContinuation`.
- Ephemeral paginated forks require `excludeTurns: true`.
- `thread/turns/list` rejects ephemeral threads. Threadex therefore persists the
  runner event stream as it happens; it cannot backfill from a vanished rollout.

No model turn was started by these capability probes. Automated tests were not
added or run for this change, as requested. TypeScript checking and diff review
are static validation, not evidence of an end-to-end concurrency run.

The app-server is released after each worker turn. An explicit later follow-up
uses a fresh ephemeral fork of the original native boundary plus a bounded recap
of that worker's DB history, with references to retrieve full details. It is not
a native resume of the destroyed ephemeral thread. Missing native source history
fails visibly instead of silently creating an unrelated context.

Concurrent workers inherit the source role: a fork of the workspace Manager
retains Manager instructions, workspace tools and the read-only/no-shell runtime.
An ordinary session's worker remains an ordinary executor. Runner startup and
the Manager action API resolve the role from persisted Concurrent membership and
its current Manager source, including existing workers on later turns. Parentage
alone does not grant Manager role to implementation tasks created by that worker.
The worker retains its own session/local ID and assignment model/effort; its
canonical request belongs to its own delivery flow. Manager workers handle it
through Manager dispatch and supervision, not by treating themselves as another
thread that already received the request.

Manager Concurrent actions use the caller's active turn and session identity.
Request IDs are scoped to that actor, default child hierarchy follows it, and
attachment handoffs preserve the canonical request without requiring delivery
envelopes in the brief. Workspace boundaries, attachment verification and the
canonical Manager's existing authority checks remain in place. Fork setup records
the installed thread policy as a `developer_instructions` event for inspection.

The C8 follow-up `manager_action_6ff27f9fe5eba8c610a6e96fbb6d9d8f` in
`tx_collab_c89ec98761083046509d936a3c029f491fdd7d8e` exposed a role mismatch:
worker identity was present, while inherited Manager instructions had no matching
Manager tools/action access. The user's clarification requires preserving that
Manager role. Removing the common skill's "Manager boundary" paragraph did not
resolve the mismatch. The correction is validated statically and by typecheck;
no automated test or live task replay was performed.

## Delivery and recovery

`collaboration_group` stores the graph, member IDs, outbox, dependencies and
results in PostgreSQL. Single-statement compare-and-swap updates serialize changes
across API processes without relying on pooled connection transaction affinity.
An expiring dispatch lease and stable request/message/turn IDs support API restart
recovery. Failed dispatches back off without blocking unrelated messages.

`concurrent_status` exposes a bounded current roster to agents.
The built-in `threadex-concurrent` skill is installed for workspace discovery
and its complete content is injected into every participating runner's developer
instructions, including fresh ephemeral workers and later follow-ups. Workers do
not need a file-read turn. Dynamic identity, roster and file conflicts accompany
the skill; it explains routing, stable request IDs, waiting checkpoints and result
return. This does not grant an unrelated Workspace Manager group membership.
`concurrent_send` routes an existing member's follow-up to steer when running,
or a persistent pending turn when idle. `wait=true` records a dependency and
wakes the caller with the result. Cycles, self-dependencies, excessive per-turn
messages and excessive follow-up depth are rejected. A waiting checkpoint is not
reported as successful completion. Stopping a member cancels queued work and
notifies its waiters.

Every completed worker result is persisted with its conclusion, recorded change
list, local ID, session ID, turn ID and outcome. The program injects that result
into main's prompt (steer if active, queue if idle), telling main to integrate the
already-performed work using its own context. Failed/stopped work remains labelled
as such. Full output remains in the source session.

Steer retries reuse one command ID. Acceptance/rejection events, retained receipts
and the runner incarnation determine whether replay is safe. Only a known
not-sent outcome becomes a queued prompt. Unknown delivery after a process failure
stays `uncertain`, visible for transcript review; main can acknowledge or cancel
it. This deliberately avoids claiming exactly-once delivery across a native RPC
crash window that provides no transactional receipt.

## Endpoints

- `GET /api/concurrent/sessions/:sessionId`: group and current activity.
- `POST …/:sessionId/fork`: `requestId`, `task`, optional `turnId`, model/effort,
  approval policy, attachments and skills. Only main creates workers.
- `POST …/:sessionId/send`: `requestId`, `to`, `message`, `reason`, optional `wait`;
  agent calls include their source `turnId`.
- `POST …/:sessionId/control`: `localId`, `stopped`.
- `POST …/:sessionId/resolveDelivery`: message `id`, `action: delivered | cancel`.

Retry the same operation with its original request ID. Changing its payload
requires a new request ID. These endpoints use the existing local API security
middleware. Internal `/api/concurrent/steer` accepts only an active persisted
group dispatch to its recorded destination.
