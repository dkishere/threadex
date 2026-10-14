## Embedding Descriptions

Use `npm run embed:session-descriptions` to generate or refresh embeddings for
`sessions.description` only. The script hashes each description and skips rows
whose hash and model already match.

The app server now also refreshes `sessions.description` and
`session_description_embedding` automatically after session switches and idle
periods. Use the embed script for backfills or when you need to reprocess
existing descriptions in bulk.
If you need to review the summarizer input itself, set
`SESSION_SUMMARIZER_PROMPT_DUMP_DIR` and inspect the generated prompt text files
locally.
The summarizer prompt includes every user prompt, a topic lead of at most 400
characters from each earlier agent response, and the complete final agent
response. Turns are listed newest-to-oldest. If the prompt would get too large,
it trims each turn proportionally instead of dropping turns outright.
Prompt files use a compact `#n` / `user:` / `agent context:` / `final agent:`
layout.

Summaries and keyword weights are generated in English so search terms stay
stable across sessions and vector/FTS retrieval works more predictably.
The session summarizer only writes two metadata fields: `sessions.description`
and `sessions.keyword_weights`. The description should stay in English and
should mention the work done, any blockers encountered, and the key actions
taken, while keywords should stay specific and lower-case. Its prompt/output
format is intentionally simple: two plain text lines, `description:` and
`keywords:`, to keep the mini model output stable.

Default local provider:

```bash
ollama pull bge-m3
npm run embed:session-descriptions -- --dry-run
npm run embed:session-descriptions
```
