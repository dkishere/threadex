# Claude SendMessage events

Claude Code's `SendMessage` tool sends a message to a sub-agent, teammate or other
agent (for example to resume a background worker by its agent id). The Claude runner
(`src/server/claudeEvents.ts`, `ClaudeStreamMapper`) turns every call into one of two
existing event shapes, so live view, reload and replay reuse the transcript item and
`subagent_activity` pipelines. Types live in `src/eventProtocol.ts`.

## `SendMessageRecord`

| Field | Type | Meaning |
| --- | --- | --- |
| `toolUseId` | string | SendMessage tool_use id; identifies the message. |
| `sender` | `{ kind: "main" }` \| `{ kind: "subagent"; agentId }` | Who sent it; `agentId` is the sender's Agent/Task tool_use id (its `subagent` card id). |
| `to` | string | Recipient exactly as the model named it (runtime agent id, agent name or `"*"`). |
| `recipientAgentId?` | string | The recipient's Agent/Task tool_use id when this runner launched it (matched via the Agent call's `name` or the `agentId: …` in its launch receipt, or the result's `resumedAgentId`). Absent when unknown, e.g. an agent from an earlier turn. |
| `summary?` | string | The call's `summary`, ≤ 500 chars. |
| `message` | string | Message body, ≤ `SEND_MESSAGE_TEXT_MAX_CHARS` (8000). |
| `messageTruncated?` | `true` | Present only when `message` was clipped; the clipped text ends with `…`. |
| `omittedMessageChars?` | number | Characters dropped by the clip. |
| `status` | `"pending"` \| `"sent"` \| `"failed"` | `pending` until the tool_result; `failed` for an error/declined result or a JSON result with `success: false`. |
| `resultSummary?` | string | Tool result text, ≤ `SEND_MESSAGE_RESULT_MAX_CHARS` (1000). |
| `at` | ISO string | When the tool_use was seen. |
| `completedAt?` | ISO string | When the result was seen. |

`normalizeSendMessage(value)` validates and re-bounds a record (null when `toolUseId`,
`to`, `sender` or `at` is missing); clients should use it on untrusted payloads.

## Main session: `subagent` transcript item

A main-session call is a `StreamItem` with `itemType: "subagent"`, `tool: "send_message"`
and `id = toolUseId`:

- `item.started` with `status: "inProgress"` when the tool_use arrives, then one
  `item.completed` with `status: "completed" | "failed" | "declined"` on its result.
  Later repeated frames for the same id emit nothing.
- `sendMessage`: the `SendMessageRecord` (authoritative for rendering).
- Compatibility fields: `label` = `summary`, `prompt` = `message`,
  `receiverThreadIds` = `[recipientAgentId]` when known (otherwise `[]`), and
  `agents[0] = { id: recipientAgentId ?? to, name: to, status, message: resultSummary }`.
  With `receiverThreadIds` set, the existing grouping files the message under the
  recipient's spawn card (`identity:<Agent tool_use id>`).

Persistence: the live item store keeps `subagent` items as their full JSON payload
(`sessionStore.ts`, `liveItemFromRow` → `itemType === "subagent"`), so `sendMessage`
survives reload and replay without storage changes.

## Sub-agent: `subagent_activity` kind `send_message`

A call made inside a sub-agent (frame with `parent_tool_use_id`) is reported on that
sub-agent's activity stream:

- `agentId` = sender's Agent/Task tool_use id, the usual `(agentId, seq)` dedupe key,
  `at`, `elapsedMs`, `lastActivityAt`.
- `kind: "send_message"`, `sendMessage: SendMessageRecord` with
  `sender: { kind: "subagent", agentId }`.
- Emitted exactly once per `toolUseId`: when the child's tool_result arrives
  (`sent`/`failed`), or, if the sub-agent finishes first, just before its `finished`
  event with `status: "pending"`.
- The usual `tool` activity (`toolName: "SendMessage"`) is still emitted at the tool_use.

Reload: `turn.subagentActivity[].events` includes these entries. They count toward the
per-agent retention of `SUBAGENT_ACTIVITY_RETAINED_PER_AGENT` non-lifecycle events, so a
very chatty sub-agent can evict old ones from the projection (raw copies remain in
`session_turn_event`).
