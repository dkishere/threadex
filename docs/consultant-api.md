# Worker and consultant contract

Owner: A1 (actor types, registry mapping and backend). A2 owns Settings; A3 owns Session Inspector integration. This change does not modify either UI. Both dependent allocations were still claimed, not running, when A1 checked the actor tree; this document is their integration contract.

## Registry and type mapping for A2

- `src/actorTypes.ts` exports `ActorType = "worker" | "consultant"` and plural display labels `Workers` / `Consultants`.
- Existing Settings → Agent Actors entries are **consultants**. Their server-wide library remains at `GET/PUT /api/settings/roundtable-actors`, with compatible alias `/api/settings/consultants`. Response: `{revision, actors: RoundtablePreset[]}`. Every parsed actor includes `type: "consultant"`; all existing fields, IDs, defaults, avatars and optimistic revision checks remain. PUT accepts legacy objects missing `type` and rejects a conflicting type.
- Existing All Actors entries are **workers**. Their workspace-scoped registry remains at `/api/domain-actors/:workspaceId/actors`, with room/summary/create/update/memory routes unchanged. Current registry objects and summaries include `type: "worker"`. Create/update accept the legacy absent type or explicit worker, rejecting conflicting types.
- Keep the existing Settings **Agent Actors** navigation structure. Show the type explicitly; select the appropriate existing registry/editor for each type. Worker tree identities, model permissions, memory, work/session bindings and revision remain in the domain actor store.
- The registries have different scopes and identities. Equal strings used as IDs in different registries do not mean they are the same record. Use registry/type plus ID when presenting a combined collection; do not merge by name or ID, recreate entries or copy one registry over the other.
- Legacy reads normalize types without a persistent rewrite; the next ordinary save/change writes the type. Repeated reads/saves cannot duplicate actors. Historical immutable round and work snapshots remain intact; an absent type there is interpreted from its source registry. Optional `type` in legacy TypeScript shapes preserves source compatibility. Explicit contradictory type values fail before mutation rather than being overwritten.

## Consultation API for A3

Shared request/result types are in `src/consultants.ts`; base endpoint is `/api/consultants`. Direct HTTP requires the existing signed-in user authentication. Workers use the capability-checked actor action instead.

| Method | Route | Result |
| --- | --- | --- |
| GET | `/api/consultants` | Existing `{revision, actors}` consultant library |
| GET | `/api/consultants/sessions/:sessionId/requests` | `{consultations: Consultation[]}` for this host |
| POST | `/api/consultants/sessions/:sessionId/requests` | Start/recover one consultation, returning `Consultation` |
| GET | `/api/consultants/sessions/:sessionId/requests/:requestId` | Current `Consultation` including partial answers |
| POST | `/api/consultants/sessions/:sessionId/requests/:requestId/cancel` | Stop inference and return retained `Consultation` |

POST body:

```ts
{
  requestId: string; // 1–100 ASCII letters, digits, underscores or hyphens
  mode: "question" | "round_table";
  consultantIds: string[]; // exactly 1 for question; 2–8 distinct for round_table
  question: string; // trimmed nonempty, at most 16000 characters
  context?: string; // at most 16000 characters, focused untrusted evidence
  trigger?: "on_demand" | "user_requested"; // defaults to on_demand; neither expands permissions
  sourceTurnId?: string; // validated as belonging to this host
}
```

Retry uncertain delivery with the same host, requestId and input. A changed payload under the same ID is rejected. A retry retains original consultant snapshots even if the library changes or the preset is removed. Retrying a terminal error returns its saved error; a deliberate new attempt needs a new request ID. Requests never create a task, session, turn, assignment or actor, and can run alongside a busy host worker.

`Consultation` contains `requestId`, `sessionId`, `workspaceId`, optional `sourceTurnId`, `mode`, `question`, `context`, `trigger`, `created`, `updated`, `status`, `answers`, `synthesis`, `error`. Overall states are `queued | running | done | error | stopped`. Every answer retains its consultant snapshot, `status: waiting | running | done | error | stopped`, `text` and nullable `error`.

Show individual answers and errors while polling status. `done` means every selected consultant and required synthesis succeeded. Partial failure produces overall `error` while retaining successful answers and any synthesis. An empty provider response is a failure. A synthesis failure preserves all consultant answers. A vanished host or worker crash becomes an explicit error, with no silent relaunch. Cancellation is idempotent, aborts in-flight runners, skips synthesis when interrupted, and retains completed text. Stop timeout reports the existing discussion-worker error rather than claiming completion.

Consultations use existing detached `DiscussionJobs`, surviving an API submitter/restart; progress/results live alongside the durable job. All participants initially see identical frozen question/context plus a host-session link and source turn ID. Existing read-only Session Inspector tools can fetch more relevant host history. This is a fresh isolated consultation, not the host's execution thread or a continuation of a consultant's past private conversation. Round table runs independent participant answers, followed by an attributed synthesis that preserves disagreement and failed participants; it does not fabricate agreement or automatically start additional rounds. A subsequent discussion is a new request with relevant prior results supplied as context.

## Worker tools and authority

Domain worker CLI exposes `consultant_list`, `consultant_ask`, `consultant_round_table`, `consultant_status`, `consultant_cancel`. Discover schemas with the existing Session Inspector `help <name>` command. List accepts `offset` / `limit` (default 10, maximum 20), returns a `nextOffset` and bounded role summaries, and omits full role prompts and image data. Ask uses `consultantId`; round table uses `consultantIds`. Worker calls cannot select another host: CLI binds its own session/turn, and server resolves its actor from the current running task plus actor capability. Forged caller/host fields do not alter that binding. Source turn is set server-side. Presets outside the worker's allowed models are hidden/rejected; synthesis also stays within those models.

Both autonomous `on_demand` use within assigned work and explicit `user_requested` use follow that same path and permission boundary. Runner instructions describe this ability at task creation and subsequent starts/resumes. Both paths are tested through CLI transport, authenticated server action and real service admission.

The consultant uses the existing round-table inference runner: discussion/analysis, read-only host inspection and private disposable scratch. It receives no actor capability, worker turn binding, execution/delegation tools or new task permission. Answers are untrusted advice; the worker must verify applicable claims and act only within its existing user authorization. No Managed mode or concurrent worker assignment is enabled by consultation.

## Verification

The focused mapping/API/CLI/read-only runner suites passed 66 tests with isolated role variables. Persisted-store, actor runner/summary and real detached discussion-worker suites passed another 38 tests (104 distinct tests total). The final changed API/worker-instruction/CLI subset passed 71 tests. `npm run typecheck` and the targeted `git diff --check` passed. Loopback API/CLI and PostgreSQL tests used approved local test access after sandbox listeners were blocked. Provider inference is stubbed in automated tests; no live provider call was made. These tests verify transport, persistence, lifecycle, permissions and error handling; A2/A3 retain Settings and Inspector UI integration/acceptance verification ownership.
