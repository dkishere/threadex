---
name: threadex-concurrent
description: Coordinate Threadex Concurrent workers and main using group-local IDs, teammate messages, dependency follow-ups, and automatic result return. Use when participating in an existing Threadex Concurrent group.
---

# Threadex Concurrent

Threadex injects this entire skill into participating runners automatically, including fresh workers and follow-up turns. This injected copy counts as reading the skill: do not open or `cat` its file. Your injected identity and roster identify your group, local ID, main session and teammates; refresh live state with `concurrent_status` on the session-inspector MCP server before routing work.

## Talk to teammates

First anchor yourself to the injected local ID, Threadex session ID and current turn. The roster entry marked `isSelf` is you, including when its status says running or queued. Display IDs such as C1 and local IDs such as c1 identify the same participant. A worker's canonical assigned request is work for that worker to handle in its own session according to its injected role. Inherited main-session handoffs or statements that your worker is already handling it describe you; they do not transfer your responsibility elsewhere. Use saved outcomes to distinguish completed work from an acknowledgement that never performed the task.

An incoming task is your assignment. A follow-up is addressed to you and may request work, correct it, or supply information. A result or delivery notice is evidence to assess and may unblock your remaining work; it is not an instruction to repeat reported work. Current corrections take precedence over historical assumptions. The original assigned request supplies continuity, not a reason to undo later changes in scope.

Use the session-inspector MCP tools `concurrent_status` and `concurrent_send`. These address existing Threadex sessions, not native subagents. Use the roster's stable local IDs (`main`, `c1`, `c2`, …), never guessed native thread IDs. If you own the work, perform it here; do not route it to yourself or merely acknowledge its delivery. Route a dependency or follow-up to another member only when that other member owns the needed work. This Concurrent group authorizes messages within this group, not unrelated delegation or external messages.

Call `concurrent_send` with these arguments (substitute the real teammate and request):

```json
{
  "requestId": "c1-needs-c2-schema-1",
  "to": "c2",
  "message": "Please confirm the persisted result fields and their types so I can finish the result panel.",
  "reason": "My result panel depends on your schema change.",
  "wait": true
}
```

- Use `wait: true` when you need the teammate's result. Continue independent work; when nothing independent remains, end with a clear waiting checkpoint. Threadex queues your continuation when the result arrives. Do not poll or repeatedly send the same request.
- Use `wait: false` for a correction, nonblocking information, or a follow-up whose result you do not need before finishing.
- Reuse the same `requestId` and payload on retries. A genuinely new request needs a new ID. A running teammate receives steer; an idle teammate receives a queued turn. Delivery does not mean completion.
- If delivery is uncertain, report it to main for transcript review; do not resend under a new ID. Respect rejected cycles and stopped workers; do not bypass them by inventing another request.
- Workers share the directory. Coordinate ownership of overlapping files before editing; there is no automatic merge. Only main creates workers. Keep later user requests in their receiving session unless an intra-group dependency requires communication.

## Return work

Finish with your conclusion, concrete change list, verification actually performed, and unresolved issues. Identify incomplete or failed work accurately. Threadex automatically persists and forwards the result, recorded changes, local ID, session ID and turn ID to main; do not send a duplicate completion message manually. Main integrates already-performed work using its own context rather than repeating it.

The native worker is ephemeral and released after its turn. A later explicit follow-up creates a fresh fork at the original boundary with saved DB context; the vanished native thread cannot be resumed. Use saved-session inspection only when the supplied recap omits details you need.
