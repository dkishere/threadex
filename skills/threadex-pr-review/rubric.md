# Threadex PR Review Rubric

Score every unit on every dimension against these anchors. Each cell is judged
on its own evidence: do not raise or lower one dimension because of another,
and do not grade a unit relative to other units in the same PR.

## Profile dimensions

Risk and complexity describe the unit, not its quality. They do not imply a
defect; the finalize step combines them with coverage.

### Risk

How much damage a defect in this unit could cause, including security.

| Level | Anchor |
|---|---|
| `low` | Local, easily reversed effect; no persistent state, runner, protocol or security boundary. |
| `medium` | User-visible behaviour, or a shared module with several callers. |
| `high` | Persistent session data, runner lifecycle, concurrency, an API/CLI/event/skill contract, or a security boundary. |
| `critical` | Can lose or corrupt data, break every session or workspace, or bypass a sandbox, approval, authentication or provenance control. |

`factors` lists every factor that applies; use `none` alone for `low` units
with none of them.

| Factor | Applies when the unit touches |
|---|---|
| `persistent-state` | Session database, stored session/turn/actor records, migrations, files under `data/`. |
| `runner-lifecycle` | Spawning, resuming, interrupting or recovering Codex/Claude runners; watchdog; queues. |
| `concurrency` | Ordering, races, retries, polling, locks, parallel workers or concurrent groups. |
| `security-boundary` | Sandbox or approval decisions, intention approvals, Git provenance, auth, path or shell construction, secrets, untrusted input reaching a sink, prompt injection into runners. |
| `external-contract` | HTTP routes, session-inspector commands, event protocol, injected skill or prompt text, file formats other code reads. |
| `data-loss` | Deleting, overwriting or truncating user data, logs or history. |
| `user-visible` | Client UI, messages, notifications or any text shown to users. |

### Complexity

How hard the unit's behaviour is to reason about.

| Level | Anchor |
|---|---|
| `low` | Straight-line code, data or text; at most one simple branch; no state. |
| `medium` | Several branches, async calls or local state, but one clear flow. |
| `high` | State machines, ordering or concurrency, parsers or validators, retry or recovery paths, cross-module invariants, or cache/merge logic. |

## Rated dimensions (0–3, or `null` when not applicable)

A score below 3 requires at least one finding in that dimension. A finding's
severity caps the score: `blocker` → 0, `major` → at most 1, `minor` → at most
2, `nit` → no cap. A full score requires evidence. `null` requires a rationale
saying why the dimension does not apply.

### Implementation

| Score | Anchor |
|---|---|
| 3 | Main path, edge cases and error paths checked; no defect found. |
| 2 | A minor defect or unhandled edge case with low, contained impact. |
| 1 | A real defect on a plausible path, or an error that is silently swallowed. |
| 0 | Broken on the main path, loses data, or fails silently in core behaviour. |

### Coverage

Behavioural coverage: would a test fail if this unit's change were reverted
or broken?

| Score | Anchor |
|---|---|
| 3 | Tests assert the changed behaviour, including its key edge or error path. |
| 2 | The main path is asserted; notable edge or error paths are not. |
| 1 | Only indirect or smoke coverage, or tests run the code without asserting the behaviour. |
| 0 | No test exercises the change. |

Use `null` only for units with no executable behaviour (prose docs) and for
test-only units. Skill and prompt text is behaviour; score it. Cite the
covering test lines as evidence, and report in the rationale whether you ran
them.

### Conventions

Repository rules (`AGENTS.md`, repository guides) and the patterns nearby
code already uses.

| Score | Anchor |
|---|---|
| 3 | Follows the documented rules and the surrounding patterns. |
| 2 | A minor deviation from a surrounding pattern. |
| 1 | A clear deviation from a documented rule or established pattern. |
| 0 | Violates a hard rule, such as broad runtime-data reads, an unrequested compatibility path or flag, or non-shadcn/lucide UI. |

Cite the rule (file and line) in the finding. Do not invent rules.

### Simplicity

| Score | Anchor |
|---|---|
| 3 | The smallest shape that meets the requirement. |
| 2 | Some avoidable code or indirection. |
| 1 | An unnecessary abstraction, duplication of existing helpers, or speculative configuration. |
| 0 | Substantially more complex than needed; hard to maintain or change. |

### Spec

Alignment with the PR's stated intent in `spec.summary`. Must be `null` when
no intent is available.

| Score | Anchor |
|---|---|
| 3 | Does what the intent asks, without unrequested behaviour. |
| 2 | A small gap or a small unrequested addition. |
| 1 | Partially implements the intent, or adds notable unrequested behaviour. |
| 0 | Contradicts the intent. |

List behaviour you judged out of scope in `setAside`. List questions only a
person can settle (product intent, policy, trade-offs) in `humanDecisions`.

## Findings

Report only what this PR introduces: `+` lines, or behaviour a changed hunk
makes reachable (set `enabledBy` to that hunk's ID). Do not report pre-existing issues, anything
a linter, compiler or typecheck catches, or style preferences that no rule
documents. `blocker` and `major` findings need a concrete `failureScenario`:
inputs or state, then the wrong outcome. Mark `verified` only when you traced
the code path or ran it; otherwise `plausible`.

## Derived flags

`finalize` computes these; never write them yourself.

| Flag | Red | Amber |
|---|---|---|
| `complexity-coverage-gap` | High complexity, coverage ≤ 1 or `null` | Medium complexity, coverage 0 or `null` |
| `risk-coverage-gap` | High or critical risk, coverage ≤ 1 or `null` | Medium risk, coverage 0 or `null` |
| `zero-<dimension>` | Any rated dimension scores 0 | |
| `low-<dimension>` | | Any rated dimension scores 1 |
| `critical-risk` | | Risk is critical |
| `needs-decision` | | `humanDecisions` is not empty |

A unit is red with any red flag, amber with any amber flag, otherwise green.
The PR takes its worst unit's status.
