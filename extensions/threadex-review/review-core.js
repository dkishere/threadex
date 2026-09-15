const { createHash } = require('node:crypto')

function parseUnifiedDiff(patch) {
  const blocks = []
  const lines = String(patch ?? '').replace(/\r\n/g, '\n').split('\n')
  let oldLine = 0
  let newLine = 0
  let pending = null

  const flush = () => {
    if (!pending || (pending.originalLines.length === 0 && pending.modifiedLines.length === 0)) {
      pending = null
      return
    }
    const changeKind = pending.originalLines.length === 0
      ? 'addition'
      : pending.modifiedLines.length === 0
        ? 'deletion'
        : 'modification'
    const identity = [
      pending.originalStart,
      pending.modifiedStart,
      pending.originalLines.join('\n'),
      pending.modifiedLines.join('\n')
    ].join('\0')
    blocks.push({
      ...pending,
      id: createHash('sha1').update(identity).digest('hex').slice(0, 16),
      changeKind,
      status: 'pending'
    })
    pending = null
  }

  for (let index = 0; index < lines.length; index += 1) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index])
    if (!hunk) continue
    flush()
    oldLine = Math.max(0, Number(hunk[1]) - 1)
    newLine = Math.max(0, Number(hunk[3]) - 1)

    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.startsWith('@@ ') || line.startsWith('diff --git ')) {
        index -= 1
        break
      }
      if (line.startsWith('\\ No newline at end of file')) continue
      const marker = line[0]
      if (marker === ' ') {
        flush()
        oldLine += 1
        newLine += 1
        continue
      }
      if (marker !== '+' && marker !== '-') continue
      if (!pending) {
        pending = {
          originalStart: oldLine,
          modifiedStart: newLine,
          originalLines: [],
          modifiedLines: []
        }
      }
      if (marker === '-') {
        pending.originalLines.push(line.slice(1))
        oldLine += 1
      } else {
        pending.modifiedLines.push(line.slice(1))
        newLine += 1
      }
    }
    flush()
  }

  return blocks
}

function parseReviewFile(candidate) {
  const patch = String(candidate?.patch ?? '')
  const blocks = parseUnifiedDiff(patch)
  return {
    path: String(candidate?.path ?? ''),
    patch,
    blocks,
    isAdded: /(?:^|\n)new file mode \d+/.test(patch) || /(?:^|\n)--- \/dev\/null/.test(patch),
    isDeleted: /(?:^|\n)deleted file mode \d+/.test(patch) || /(?:^|\n)\+\+\+ \/dev\/null/.test(patch)
  }
}

function summarizeReviewBlocks(blocks) {
  const summary = { additions: 0, deletions: 0 }
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const originalCount = Array.isArray(block?.originalLines) ? block.originalLines.length : 0
    const modifiedCount = Array.isArray(block?.modifiedLines) ? block.modifiedLines.length : 0
    if (block?.changeKind === 'addition') {
      summary.additions += modifiedCount
    } else if (block?.changeKind === 'deletion') {
      summary.deletions += originalCount
    } else {
      summary.additions += modifiedCount
      summary.deletions += originalCount
    }
  }
  return summary
}

function splitText(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n')
  const trailingNewline = normalized.endsWith('\n')
  if (normalized === '') return { lines: [], trailingNewline: false }
  const lines = normalized.split('\n')
  if (trailingNewline) lines.pop()
  return { lines, trailingNewline }
}

function applyRejectedBlock(text, block) {
  const current = splitText(text)
  const start = Math.max(0, Math.min(block.modifiedStart, current.lines.length))
  current.lines.splice(start, block.modifiedLines.length, ...block.originalLines)
  const result = current.lines.join('\n')
  return current.trailingNewline && result ? `${result}\n` : result
}

function reconstructBaseline(text, blocks) {
  return [...blocks]
    .sort((left, right) => right.modifiedStart - left.modifiedStart)
    .reduce((current, block) => applyRejectedBlock(current, block), String(text ?? ''))
}

function blockLabel(block) {
  if (block.changeKind === 'addition') {
    const start = block.modifiedStart + 1
    const end = block.modifiedStart + block.modifiedLines.length
    return start === end ? `Added line ${start}` : `Added lines ${start}-${end}`
  }
  if (block.changeKind === 'deletion') {
    const count = block.originalLines.length
    return `Deleted ${count} line${count === 1 ? '' : 's'} near line ${block.modifiedStart + 1}`
  }
  const oldCount = block.originalLines.length
  const newCount = block.modifiedLines.length
  return `Replaced ${oldCount} line${oldCount === 1 ? '' : 's'} with ${newCount}`
}

function walkthroughFingerprint(value) {
  return createHash('sha256').update(String(value ?? '').replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

function createExplainAnchor(input) {
  const documentText = String(input?.documentText ?? '').replace(/\r\n/g, '\n')
  const selection = input?.selection
  const range = selection && typeof selection === 'object'
    ? {
        start: { line: selection.start?.line, character: selection.start?.character },
        end: { line: selection.end?.line, character: selection.end?.character }
      }
    : null
  const offsets = range ? rangeOffsets(documentText, range) : null
  if (!offsets || offsets.start >= offsets.end) return null
  const selectedText = documentText.slice(offsets.start, offsets.end)
  return {
    path: String(input?.path ?? ''),
    revision: input?.revision === 'baseline' ? 'baseline' : 'workspace',
    reviewRequestId: typeof input?.reviewRequestId === 'string' ? input.reviewRequestId : undefined,
    range,
    selectedText,
    selectionHash: walkthroughFingerprint(selectedText),
    sourceFingerprint: walkthroughFingerprint(documentText),
    context: selectionContext(documentText, range)
  }
}

function isReviewMutationAllowed(review) {
  return Boolean(review && review.mode === 'edit' && review.capabilities?.mutate !== false)
}

function walkthroughTargetKey(source) {
  const range = source?.range
  if (!source?.path || !range?.start || !range?.end) return ''
  return [
    source.revision === 'baseline' ? 'baseline' : 'workspace',
    source.revision === 'baseline' ? String(source.reviewRequestId ?? '') : '',
    source.path,
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character
  ].join(':')
}

function walkthroughRangeLabel(source) {
  const range = source?.range
  if (!range?.start || !range?.end) return 'unknown lines'
  const start = range.start.line + 1
  const exclusiveEnd = range.end.character === 0 && range.end.line > range.start.line
  const end = Math.max(start, range.end.line + 1 - (exclusiveEnd ? 1 : 0))
  return start === end ? `L${start}` : `L${start}–L${end}`
}

function renderWalkthroughMarkdown(explanation, source, commentNumber = 1) {
  const revision = source?.revision === 'baseline' ? 'baseline' : 'working'
  const location = `${String(source?.path ?? 'source')} · ${walkthroughRangeLabel(source)} · ${revision}`
  const markdown = String(explanation ?? '').replace(/```mermaid\s*\n([\s\S]*?)```/gi, (fence, diagram) => {
    const svg = renderSafeMermaidFlowchart(diagram)
    if (!svg) return fence
    return `![Walkthrough flow chart](data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')})`
  })
  return `**Comment ${commentNumber}** · \`${location}\`\n\n${markdown}`
}

function renderSafeMermaidFlowchart(source) {
  const lines = String(source ?? '').replace(/\r\n/g, '\n').split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('%%'))
  if (lines.length === 0) return null
  const header = /^(?:flowchart|graph)\s+(TD|TB|LR)$/i.exec(lines[0])
  if (!header) return null
  const direction = header[1].toUpperCase() === 'LR' ? 'LR' : 'TD'
  const nodes = new Map()
  const edges = []
  for (const line of lines.slice(1, 25)) {
    const edge = /^(.+?)\s*(-->|-\.->)\s*(?:\|([^|]{1,80})\|\s*)?(.+)$/.exec(line)
    if (!edge) continue
    const from = parseMermaidNode(edge[1])
    const to = parseMermaidNode(edge[4])
    if (!from || !to) continue
    if (!nodes.has(from.id) && nodes.size < 12) nodes.set(from.id, from)
    if (!nodes.has(to.id) && nodes.size < 12) nodes.set(to.id, to)
    if (!nodes.has(from.id) || !nodes.has(to.id)) continue
    edges.push({ from: from.id, to: to.id, label: cleanDiagramText(edge[3] ?? '', 24), dashed: edge[2] === '-.->' })
  }
  if (nodes.size < 2 || edges.length === 0) return null
  const ordered = [...nodes.values()]
  const horizontal = direction === 'LR'
  const nodeWidth = 184
  const nodeHeight = 58
  const gap = 70
  const padding = 38
  const width = horizontal ? padding * 2 + ordered.length * nodeWidth + (ordered.length - 1) * gap : 560
  const height = horizontal ? 170 : padding * 2 + ordered.length * nodeHeight + (ordered.length - 1) * gap
  const positioned = new Map(ordered.map((node, index) => [node.id, {
    ...node,
    x: horizontal ? padding + index * (nodeWidth + gap) : (width - nodeWidth) / 2,
    y: horizontal ? (height - nodeHeight) / 2 : padding + index * (nodeHeight + gap)
  }]))
  const edgeSvg = edges.map((edge) => {
    const from = positioned.get(edge.from)
    const to = positioned.get(edge.to)
    if (!from || !to) return ''
    const x1 = horizontal ? from.x + nodeWidth : from.x + nodeWidth / 2
    const y1 = horizontal ? from.y + nodeHeight / 2 : from.y + nodeHeight
    const x2 = horizontal ? to.x : to.x + nodeWidth / 2
    const y2 = horizontal ? to.y + nodeHeight / 2 : to.y
    const labelX = (x1 + x2) / 2
    const labelY = (y1 + y2) / 2 - 7
    return `<path d="M ${x1} ${y1} L ${x2} ${y2}" fill="none" stroke="#64748b" stroke-width="2"${edge.dashed ? ' stroke-dasharray="6 5"' : ''} marker-end="url(#arrow)"/>${edge.label ? `<text x="${labelX}" y="${labelY}" text-anchor="middle" font-size="12" fill="#475569">${escapeXml(edge.label)}</text>` : ''}`
  }).join('')
  const nodeSvg = ordered.map((node) => {
    const positionedNode = positioned.get(node.id)
    const centerX = positionedNode.x + nodeWidth / 2
    const centerY = positionedNode.y + nodeHeight / 2 + 5
    const shape = node.decision
      ? `<polygon points="${centerX},${positionedNode.y} ${positionedNode.x + nodeWidth},${centerY - 5} ${centerX},${positionedNode.y + nodeHeight} ${positionedNode.x},${centerY - 5}" fill="#334155" stroke="#94a3b8" stroke-width="2"/>`
      : `<rect x="${positionedNode.x}" y="${positionedNode.y}" width="${nodeWidth}" height="${nodeHeight}" rx="10" fill="#334155" stroke="#94a3b8" stroke-width="2"/>`
    return `${shape}<text x="${centerX}" y="${centerY}" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="13" fill="#f8fafc">${escapeXml(cleanDiagramText(node.label, 42))}</text>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Walkthrough flow chart"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#64748b"/></marker></defs><rect width="100%" height="100%" rx="12" fill="#f8fafc"/>${edgeSvg}${nodeSvg}</svg>`
}

function parseMermaidNode(value) {
  const match = /^([A-Za-z][A-Za-z0-9_-]*)(?:\[([^\]]*)\]|\{([^}]*)\}|\(([^)]*)\))?$/.exec(String(value ?? '').trim())
  if (!match) return null
  const rawLabel = match[2] ?? match[3] ?? match[4] ?? match[1]
  return { id: match[1], label: cleanDiagramText(rawLabel, 80), decision: match[3] !== undefined }
}

function cleanDiagramText(value, maximum) {
  return String(value ?? '').replace(/^['"]|['"]$/g, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, maximum)
}

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function rangeOffsets(source, range) {
  const validPosition = (position) => Number.isInteger(position?.line) && Number.isInteger(position?.character) && position.line >= 0 && position.character >= 0
  if (!validPosition(range.start) || !validPosition(range.end)) return null
  if (range.start.line > range.end.line || (range.start.line === range.end.line && range.start.character > range.end.character)) return null
  const lines = source.split('\n')
  if (range.start.line >= lines.length || range.end.line >= lines.length) return null
  if (range.start.character > lines[range.start.line].length || range.end.character > lines[range.end.line].length) return null
  const starts = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  return {
    start: starts[range.start.line] + range.start.character,
    end: starts[range.end.line] + range.end.character
  }
}

function selectionContext(source, range) {
  const lines = source.split('\n')
  return {
    before: limitContext(lines.slice(Math.max(0, range.start.line - 12), range.start.line).join('\n')),
    after: limitContext(lines.slice(range.end.line + 1, Math.min(lines.length, range.end.line + 13)).join('\n'))
  }
}

function limitContext(value) {
  return value.length <= 6000 ? value : `${value.slice(0, 5960)}\n…[context truncated]`
}

module.exports = {
  applyRejectedBlock,
  blockLabel,
  createExplainAnchor,
  isReviewMutationAllowed,
  parseReviewFile,
  parseUnifiedDiff,
  renderSafeMermaidFlowchart,
  renderWalkthroughMarkdown,
  reconstructBaseline,
  splitText,
  summarizeReviewBlocks,
  walkthroughFingerprint,
  walkthroughRangeLabel,
  walkthroughTargetKey
}
