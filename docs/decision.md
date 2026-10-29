# Decision service

`src/server/decision/` provides predicate, choice and score decisions through
Jev, OpenAI Decisions, an isolated Codex/Claude Code simulation, or a
test-only fake. Callers build task data explicitly and retain responsibility for
authorization, routing failure presentation and model upgrades.

Settings → Decision replaces the previous Auto model settings. The old endpoint,
Jev credential and custom rules remain compatible. Backend order is per purpose;
the default is Jev only. Configuring another key does not enable data sharing with
that backend until it appears in the purpose order. LLM uses the existing helper
model settings (summarizer and long-input models) and Codex/Claude Code login,
with uncalibrated estimates. It does not use an API key or the Responses API.
The model selects the CLI provider: Claude models use the workspace's selected
Claude account; Codex models use the workspace Codex home. Existing helper auth,
isolation and account identity checks apply. Old `.llm` keys are ignored.
LLM attempts default to 30 seconds; API attempts default to 8 seconds. An explicit
request timeout overrides these defaults. Timeouts cancel the underlying helper.
No hidden owner or model selection exists in policy.

Policy validates every answer before accepting a backend, including finite
probabilities/confidence, option membership, score bounds and distributions.
Only projected answers, fixed model/backend IDs, elapsed time, usage and enumerated
failure reasons cross the audit boundary. Provider bodies, task state, credentials
and raw errors are not stored in decision records or usage metadata.

The durable key comprises workspace, turn, round, work item and purpose. Give
dependent calls distinct work-item IDs or purposes. A result (including failure)
is saved before use; retries and restarts reuse it. In-process concurrent requests
coalesce and database insert-on-conflict retains the first saved result. Callers
must retain their existing exclusive round/turn ownership across server processes;
the decision layer is not a distributed work-claim lock. Auto separately records
its final model/effort before dispatch. Retry replay also reads that turn's upgrade
events and preserves stronger live model/effort settings, including upgrades whose
event was not saved. A fresh turn can still select a cheaper model.
Usage is independently validated before answer validation and retained for every
attempt that reports it, including rejected answers and decoded provider failures.
Each attempt is idempotently written to `token_usage` with `usage_type = 'decision'`
and a stable decision/attempt ID; retry and restart do not bill it twice. Older
audits retain their original final-result usage row for compatibility.
Unreported usage is not fabricated; a failed request has an audit-only usage row.

`actors.ts` supplies typed SH predicates and claim tiebreak callers, separate
backend thresholds, an `other` choice, and the one-claim bypass. Ties, low confidence,
no candidates and provider failure return `routing_failed`. These callers are not
wired into roundtables: the current application has no SH/claim ownership workflow.
A future owner-routing caller must persist its work-item identity, display routing
failure, and wait for explicit user assignment. Heartbeat triage is not implemented.

## Provider contract decisions

- [Jev Noul](https://docs.typesafe.ai/primitives/noul) uses `type: noul` and returns
  `noul`; choice uses a criteria map.
- [Jev Score](https://docs.typesafe.ai/primitives/score) uses 2–10 ordered criteria.
  The optional `levels` extension supplies descriptive criteria. Without it the
  adapter uses rubric-defined minimum/maximum endpoints. Both score adapters map
  the returned level index linearly to the caller's `min`/`max`. Supply descriptive
  levels for meaningful intermediate categories.
- [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions)
  supports multiple independent questions in one request, so the adapter batches
  them rather than using the draft's provisional parallel requests. Named answers
  and choice probability arrays are normalized into the common interface.
- LLM supplies the answer schema to the isolated Codex runner and in the helper
  prompt for both providers; every parsed answer must pass the common validator.
  It is always `calibrated: false`. Questions and helper instructions treat state
  as data. Decision usage is recorded by the durable service, not also as a
  background helper charge.

Unit tests inject the fake at the Decision boundary. No real provider calls or
credentials are required to run them.
