# Actor completion review contract

The completion-review producer owns `ActorWorkItem.completionReviews` in
`src/domainActors.ts`. The dialog/badge consumer must use
`actorPublishableConclusions(workItem)` from that module. A runner result or
`workItem.status === "completed"` alone does not permit publication.

On `runner.result`, the service persists one review per work item, session and
turn, independently of the ring event ID. Review runs in the background so the
runner result acknowledgement does not wait for model inference. Room change
notifications are sent when review begins and ends. The production review hook
uses the isolated JSON assessment runner with a 120-second deadline. It judges
the saved result against the canonical request, later user input and assigned
portion; this is evidence review, not an additional code checkout or test run.
It reuses the existing Grill mid-turn-input collector to preserve user answers
and steers, including secret-answer redaction. The interactive Grill route's
user-selected questions, acknowledgements and discussion rounds remain separate
from this automatic binary completion/publication decision.

Each review contains `id`, `workItemId`, executor `actorId`, `ownerActorId`,
`roundId`, `taskSessionId`, `taskTurnId` and `executionRevision`. Its status is
`pending`, `passed`, `issues_found` or `error`. Only `passed` with no issues
creates `review.conclusion`, containing a stable `id`, `reviewId`, `actorId`,
`workItemId`, `taskSessionId`, `taskTurnId`, `text` and `created`.

The conclusion text is the saved actor result. Publish it into that executor's
own dialog, using its ID to deduplicate popups/unread badges. `ownerActorId` is
available separately for delegation context. The publication helper excludes
historical execution revisions, sessions and superseded turns, even if their
reviews passed. Historical review/conclusion records remain available for task
inspection; their existence alone is not a new publication signal.

Missing/unsuccessful saved outcomes, unavailable review providers, invalid
verdicts and helper exceptions fail closed with an error and no conclusion.
Issue verdicts retain their concrete issues. A live persisted lease prevents
duplicate reviewers across service instances. A replay may reclaim an expired
lease; room reads also close expired pending reviews as interrupted errors.
Terminal reviews are not automatically repeated: a user follow-up produces a
new turn and a new review. There is no repeated notification for repeated
canonical requirements or replayed runner events.

The consumer captures this helper's output in `ActorRoom.conclusions` inside
`DomainActorStore.change`, in the same transaction as the review update. A room
read also adopts eligible results from producer-only rooms during upgrade. IDs
are deduplicated; no verdict is inferred by the consumer. Once consumed, a
conclusion remains in the dialog after later turns supersede its source review.
Late reviews that fail the producer's current-execution gate never enter this
history. Original rounds and review records remain intact.

The executor's Individual dialog renders the saved Markdown conclusion and an
Open task link. Its Individual tab and actor list row show the count of results
awaiting acknowledgement. Group mode and other actors' dialogs do not display
the conclusion; the tab count lets a user switch without losing a group draft.
The summary endpoint returns only `unreadConclusions`, not conclusion text.

Like the existing review badge, this badge clears on explicit Ack, not merely
on opening a view. The signed-in-user endpoint
`POST /api/domain-actors/:workspaceId/actors/:actorId/conclusions/:conclusionId/ack`
persists acknowledgement of that exact conclusion. A stale Ack cannot clear a
newer result, and retries are idempotent. Failure leaves the badge and a retry
action visible. The local summary refreshes after Ack; other tabs use the
existing summary polling interval.

Integration tests drive the real completion observer, publication gate, store
and summary with fake review inference. Browser tests cover executor isolation,
pending/issues suppression, duplicate delivery, group draft retention, failed
Ack/retry, reload and history retention. Database tests cover concurrent
consumers, upgrade adoption and acknowledgement surviving reopen. Live model
quality is outside these deterministic tests.
