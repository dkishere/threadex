const assert = require('node:assert/strict')
const test = require('node:test')

const {
  applyRejectedBlock,
  createExplainAnchor,
  isReviewMutationAllowed,
  parseReviewFile,
  parseUnifiedDiff,
  renderSafeMermaidFlowchart,
  renderWalkthroughMarkdown,
  reconstructBaseline,
  summarizeReviewBlocks,
  walkthroughRangeLabel,
  walkthroughTargetKey
} = require('./review-core')

test('parses separate source-level review blocks from a Git patch', () => {
  const blocks = parseUnifiedDiff([
    'diff --git a/src/example.ts b/src/example.ts',
    '--- a/src/example.ts',
    '+++ b/src/example.ts',
    '@@ -1,4 +1,5 @@',
    ' const first = 1',
    '-const second = 2',
    '+const second = 20',
    ' const third = 3',
    '+const fourth = 4',
    ' export {}'
  ].join('\n'))

  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].changeKind, 'modification')
  assert.deepEqual(blocks[0].originalLines, ['const second = 2'])
  assert.deepEqual(blocks[0].modifiedLines, ['const second = 20'])
  assert.equal(blocks[1].changeKind, 'addition')
})

test('reverses blocks against current source text', () => {
  const patch = [
    'diff --git a/example.ts b/example.ts',
    '--- a/example.ts',
    '+++ b/example.ts',
    '@@ -1,3 +1,4 @@',
    ' one',
    '-two',
    '+twenty',
    ' three',
    '+four'
  ].join('\n')
  const blocks = parseUnifiedDiff(patch)
  const current = 'one\ntwenty\nthree\nfour\n'

  assert.equal(applyRejectedBlock(current, blocks[0]), 'one\ntwo\nthree\nfour\n')
  assert.equal(reconstructBaseline(current, blocks), 'one\ntwo\nthree\n')
})

test('identifies added and deleted review files', () => {
  assert.equal(parseReviewFile({ path: 'new.ts', patch: 'new file mode 100644\n@@ -0,0 +1 @@\n+new' }).isAdded, true)
  assert.equal(parseReviewFile({ path: 'old.ts', patch: 'deleted file mode 100644\n@@ -1 +0,0 @@\n-old' }).isDeleted, true)
})

test('summarizes additions and deletions across multiple hunks', () => {
  const blocks = parseUnifiedDiff([
    '@@ -1,3 +1,4 @@',
    ' one',
    '-two',
    '+twenty',
    ' three',
    '+four',
    '@@ -10,2 +11 @@',
    '-ten',
    '-eleven',
    '+eleven revised'
  ].join('\n'))

  assert.deepEqual(summarizeReviewBlocks(blocks), { additions: 3, deletions: 3 })
})

test('summarizes whole added and deleted files from parsed review blocks', () => {
  const added = parseReviewFile({
    path: 'new.ts',
    patch: 'new file mode 100644\n@@ -0,0 +1,3 @@\n+one\n+two\n+three'
  })
  const deleted = parseReviewFile({
    path: 'old.ts',
    patch: 'deleted file mode 100644\n@@ -1,2 +0,0 @@\n-one\n-two'
  })

  assert.deepEqual(summarizeReviewBlocks(added.blocks), { additions: 3, deletions: 0 })
  assert.deepEqual(summarizeReviewBlocks(deleted.blocks), { additions: 0, deletions: 2 })
})

test('maps a selected source range to stable explain fingerprints and bounded context', () => {
  const anchor = createExplainAnchor({
    path: 'src/example.ts',
    revision: 'baseline',
    reviewRequestId: 'review-1',
    documentText: 'const first = 1;\nconst second = first + 1;\nexport { second };\n',
    selection: {
      start: { line: 1, character: 0 },
      end: { line: 1, character: 25 }
    }
  })

  assert.equal(anchor.path, 'src/example.ts')
  assert.equal(anchor.revision, 'baseline')
  assert.equal(anchor.reviewRequestId, 'review-1')
  assert.equal(anchor.selectedText, 'const second = first + 1;')
  assert.match(anchor.selectionHash, /^[a-f0-9]{64}$/)
  assert.match(anchor.sourceFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(anchor.context.before, 'const first = 1;')
  assert.equal(anchor.context.after, 'export { second };\n')
})

test('never enables mutation commands for an explain walkthrough', () => {
  assert.equal(isReviewMutationAllowed({ mode: 'explain', capabilities: { mutate: false } }), false)
  assert.equal(isReviewMutationAllowed({ mode: 'edit', capabilities: { mutate: false } }), false)
  assert.equal(isReviewMutationAllowed({ mode: 'edit', capabilities: { mutate: true } }), true)
})

test('labels and keys walkthrough targets by file and visible lines', () => {
  const source = {
    path: 'src/example.ts',
    range: { start: { line: 4, character: 2 }, end: { line: 7, character: 0 } }
  }
  assert.equal(walkthroughRangeLabel(source), 'L5–L7')
  assert.equal(walkthroughTargetKey(source), 'workspace::src/example.ts:4:2:7:0')
  assert.notEqual(
    walkthroughTargetKey(source),
    walkthroughTargetKey({ ...source, revision: 'baseline', reviewRequestId: 'review-1' })
  )
})

test('renders a constrained Mermaid flowchart as a static SVG markdown image', () => {
  const svg = renderSafeMermaidFlowchart([
    'flowchart TD',
    '  A[Read selection] --> B{Still current?}',
    '  B -->|yes| C[Show comment]'
  ].join('\n'))
  assert.match(svg, /^<svg /)
  assert.match(svg, /Read selection/)
  assert.doesNotMatch(svg, /<script/)

  const markdown = renderWalkthroughMarkdown(
    '## How it works\n\n```mermaid\nflowchart LR\nA[Input] --> B[Output]\n```',
    { path: 'src/example.ts', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } } },
    2
  )
  assert.match(markdown, /^\*\*Comment 2\*\*/)
  assert.match(markdown, /src\/example\.ts · L2/)
  assert.match(markdown, /working/)
  assert.match(markdown, /data:image\/svg\+xml;base64,/)
  assert.doesNotMatch(markdown, /```mermaid/)
})
