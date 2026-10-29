# Roundtable conclusion regression evaluation

The decision contract separates substantive positions from `openQuestions` and
`scope`. Only positions contribute to consensus or disagreements. Position views
remain visible above actor details. Legacy conclusions without the new arrays
remain readable; stored conclusions are not reclassified automatically.

The host uses at least medium effort for new rounds, retaining higher selected
efforts. This is a synthesis budget choice, not evidence that low effort caused
the original error. It can increase latency and token use. Actor and general
session effort preferences are unchanged.

## Cases and procedure

[The fixture](../src/server/fixtures/roundtableConclusion.eval.json) contains
verbatim excerpts from the reported failure, its source turn, and four synthetic
controls: compatible qualifications, genuine opposition, questions without a
recommendation, and conflicting research findings. The original case is an
excerpted regression input, not a replay of the entire native thread.

Generate the current production instructions and user message for each case:

```sh
node --import tsx scripts/roundtable-conclusion-eval.ts rollout-scope
node --import tsx scripts/roundtable-conclusion-eval.ts complementary
node --import tsx scripts/roundtable-conclusion-eval.ts opposed
node --import tsx scripts/roundtable-conclusion-eval.ts questions-only
node --import tsx scripts/roundtable-conclusion-eval.ts research
```

Supply the emitted messages to the conclusion model without tools, keeping the
fixture rubric out of its input. Record the model, effort, date and output. Check
the output against `parseRoundtableConclusion` and every case's rubric; repeat
cases to distinguish a consistent improvement from a single successful answer.
For a prompt-only comparison keep model and effort fixed; assess any effort
change separately. Include a native-thread replay if evaluating the effect of
large pre-existing context.

These commands generate prompts and make no model calls. Parser, persistence and
UI tests verify the display contract, not the model's semantic classification.
Fresh inference results must be recorded separately before claiming an evaluated
reduction in false disagreements.

## Deterministic checks

```sh
node --import tsx --test src/server/roundtableConclusion.test.ts src/server/roundtableRunner.test.ts src/server/roundtableService.test.ts
npm run test:e2e -- e2e/roundtable.spec.ts
npm run typecheck
```

The browser test covers shared and single-actor views with details, genuine
opposition, attribution for questions and scope, and the mobile layout. Service
tests verify readable history retains the new fields and host dispatch has a
medium effort floor without changing stored session or actor preferences.
