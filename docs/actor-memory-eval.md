# Actor memory extraction evaluation

Actor memory maintenance keeps three kinds of content, in priority order: user
decisions, recurring issues with their verified solutions, and common methods.
`longTerm` places `standingDecisions`, `recurringIssues` and `methods` first,
then responsibility boundaries and the actor tree. `rolling` holds only
unfinished commitments, blockers and facts that may be promoted later. One-off
events, per-run test counts and unrelated stakeholder events are compressed or
omitted. Each entry cites one source reference: the task session id (`tx_…`),
or the round id when there is no session. The guidance lives in
`actorMemoryMaintenancePrompt` in `src/server/domainActorRunner.ts`; memory
fields remain strings, so existing memory stays readable and is not migrated.

The output also carries `roleChangeQuote`, the verbatim request text that
redefines the actor's role, or `""`. The service (`acceptedRoleChange`) keeps
the saved `rolePrompt`/`roleSummary` unless that quote appears in the round's
request and the new role holds no session, task or round references; task
results never change the role. Task results are maintained for their executor
and owner, and for stakeholders whose reply offered a claim or an in-role
opinion; a reply declaring the request outside the actor's role, and that
actor's later task results, are not maintained (`memoryRelevant`).

The maintenance call uses an inexpensive model (Claude Haiku or Luna). Prompt
unit tests check the guidance, not whether that model follows it.

## Cases and procedure

[The fixture](../src/server/fixtures/actorMemory.eval.json) contains synthetic
cases: a one-off fix, a user decision alongside an unapproved actor proposal, a
recurring issue promoted from rolling, a verification method, a decision that
supersedes another in the same scope, and an unrelated stakeholder event.

Generate the current production maintenance prompt for a case:

```sh
node --import tsx scripts/actor-memory-eval.ts one-off
node --import tsx scripts/actor-memory-eval.ts decision
node --import tsx scripts/actor-memory-eval.ts recurring-issue
node --import tsx scripts/actor-memory-eval.ts method
node --import tsx scripts/actor-memory-eval.ts supersede
node --import tsx scripts/actor-memory-eval.ts stakeholder-unrelated
```

Supply the emitted prompt to the maintenance model, keeping the fixture rubric
out of its input. Record the model, date and output, then check the output
against `validateActorMemory` and every rubric line. Repeat cases to distinguish
a consistent result from a single successful answer. These commands make no
model calls; record fresh inference results before claiming the guidance works.

## Known limits outside extraction

These belong to actor orchestration and context injection:

- Actor context excerpts each memory field equally from its start
  (`boundedActorContext`); unused budget is not reassigned, so ordering inside
  `longTerm` is the only priority mechanism.
- Maintenance receives the full memory and is rejected, not compacted, when it
  exceeds the admission budget.
