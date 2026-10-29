# Actor session reuse

Ordinary session selection admits tasks from the claimant's visible conversation
history even without an explicit `contextRoundIds` selection. Decision prefers
consecutive edits of the same nature in the same work context, including edits
after completion. An independent objective still starts a separate task. Actor,
executor, project directory and model permissions constrain every candidate.

Before group-chat picking, Decision can fast track actionable follow-ups to the
previous group task. Its state contains the current user prompt and at most three
recent distinct group tasks' user prompts, ordered oldest first. For a reused
task, its latest group prompt is used. Private conversations, assistant replies,
prepared briefs and transcripts are excluded from this comparison. This boundary
does not truncate actor conversation history or execution context elsewhere.

Fast track requires an explicit `continue` choice with confidence at least 0.8.
Ambiguity, unrelated work, discussion, model/executor changes, failed Decision,
incompatible project or policy, pending reassignment and split work use normal
routing. The Decision must not infer attachment contents from a short prompt.
Attachments are preserved for execution when a continuation is selected.

The selected task keeps its session, actor binding and model. Delivery uses the
existing task-reference reservation and deterministic follow-up turn ID through
`/api/pending-turns`. Active work is preserved; the continuation waits in Queue.
Binding and permissions are checked again before delivery. An uncertain receipt
retains the selected target and retries the same request rather than creating
replacement work. Ordinary post-picking reuse can select a new permitted model
and continues to require an idle session.
