---
name: threadex-author
description: Trace Git commits or file changes back to Threadex tasks and turns using Threadex-author trailers and saved session evidence. Use when asked which agent task changed a file, why a commit was made, or to recover its originating conversation.
---

# Trace Threadex authorship

Use read-only Git history and the Threadex session inspector to connect a commit
to its originating tasks, turns, and recorded file changes.

## Find the commit and task links

Work in the requested Git repository. If only a file is given, start with a
bounded history such as `git --literal-pathspecs log -n 20 --follow -- path/to/file`.
For a supplied revision, resolve it safely with
`git rev-parse --verify --end-of-options 'REV^{commit}'`, then use the resulting
hash in subsequent commands. Inspect its message with
`git show -s --format=%B HASH` and changed paths with
`git diff-tree --root --no-commit-id --name-status -r --no-renames HASH`.
Merge commits may require comparison with the relevant parent.

Current trailers look like:

```text
Threadex-author: threadex://default/tx_example#1/2/3
```

The commit format is `threadex://{workspace}/{codexId|threadexId}#1/2/3`.
The fragment contains sorted, deduplicated positive turn numbers for one session.
Decode each percent-encoded component separately and preserve workspace case. `tx_` targets
are Threadex session IDs; other targets are native Codex thread IDs. Existing
`local_` DB IDs are retained: the equivalent `tx_` alias resolves the same row.
Session-wide links omit the fragment. Numbers are persisted UUID aliases, not
current transcript row offsets; deletion or late imports do not renumber them.
A commit can link multiple turns, grouped into one trailer per workspace/session.

Prefer the existing provenance CLI when the Threadex checkout is available.
Find the checkout from this built-in skill's resolved source path: the skill
lives at `<checkout>/skills/threadex-author/SKILL.md`. Run from the target Git
repository, substituting the actual checkout path:

```sh
node --import /absolute/threadex/node_modules/tsx/dist/loader.mjs /absolute/threadex/scripts/git-provenance.ts inspect HASH path/to/file
```

The file argument is optional and relative to the command's working directory.
The CLI reads only numbered `Threadex-author:` links. Its file filter checks that the path
changed in that commit; returned records are still commit-wide task candidates.
Even `precision: "commit-files-to-task-links"` does not prove per-task file ownership.
If the CLI is unavailable, inspect current trailers directly and report any
unsupported format you cannot resolve rather than inventing a mapping.

## Inspect the referenced turn

Use the sibling [session-inspector skill](../session-inspector/SKILL.md) for its
read-only tool/API contract. Prefer `get_session` or
`POST /api/session-inspector/session` at `RUNNER_SERVER_URL` (default
`http://127.0.0.1:8787`). First resolve the numbers through
`GET /api/sessions/resolve-reference?workspaceId=default&target=tx_example&turnNumbers=1%2F2%2F3`.
The response contains `session` and `turns: [{turnId, turnNumber}]`. A 404 means
at least one requested turn is unavailable; do not substitute its current row
position. Then inspect each returned UUID. For example:

```json
{"workspaceId":"default","sessionId":"tx_example","turnId":"<resolved UUID>","view":"turn_summary","turnLimit":1,"maxTextChars":12000}
```

For native Codex IDs replace `sessionId` with `threadId`. Preserve workspace
scope and use the returned stored session ID for further calls. Without a turn
ID, paginate bounded results using `turnLimit` / `turnOffset` and `turnPage`.
`q` searches prompt/answer text, so it is not a reliable file-path filter.

Compare the requested path against each returned turn's `fileChanges`, including
both `path` and `movePath` for renames. Resolve relative paths against the saved
session CWD before comparing with repository paths; normalize real filesystem
paths when symlinks such as macOS `/tmp` and `/private/tmp` differ. Use the prompt
and conclusion to explain intent; use `view: "full", includeLiveItems: true`
for detailed evidence only when needed. Do not assume a missing turn is a
completed turn or silently substitute another turn.

The DB also accumulates path-only `session_turn.changed_files`; the inspector's
file-change views summarize saved live items and are not a direct projection of
that column. Do not claim to have checked the column from those views, or open
runtime databases/log directories as an automatic fallback.

## Report the evidence and its limits

Return the commit hash, clickable canonical task/turn link, matching file paths,
and a brief explanation supported by the saved turn. Distinguish a trailer-only
candidate from a turn whose file-change evidence matches. This is file/turn
provenance, not line authorship or proof that all of a turn's edits landed in
that commit. A turn may span multiple commits; partial staging, reverted edits,
and concurrent edits can broaden associations. Amend/rebase may retain old links.

No trailer means unknown provenance, not proof that Threadex was uninvolved.
An unavailable server, missing session, or absent file evidence leaves that
part unresolved; retain the Git evidence and say what could not be verified.
Compact URLs do not record the original machine hostname. External OS handling
of `threadex://` is not required for API lookup and may not be registered.

Do not install hooks, consume the pending provenance index, amend commits,
prompt another session, or start a task merely to answer a provenance question.
