const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const vscode = require('vscode')

const {
  applyRejectedBlock,
  blockLabel,
  createExplainAnchor,
  isReviewMutationAllowed,
  parseReviewFile,
  renderWalkthroughMarkdown,
  reconstructBaseline,
  summarizeReviewBlocks,
  walkthroughFingerprint,
  walkthroughRangeLabel,
  walkthroughTargetKey
} = require('./review-core')

const BASELINE_SCHEME = 'threadex-review-baseline'
const EMPTY_SCHEME = 'threadex-review-empty'
const REQUEST_SCAN_INTERVAL_MS = 1000
const MAX_REQUEST_AGE_MS = 10 * 60 * 1000

let activeController = null

function activate(context) {
  activeController = new ThreadexReviewController(context)
  context.subscriptions.push(activeController)
}

function deactivate() {
  activeController?.dispose()
  activeController = null
}

class ThreadexReviewController {
  constructor(context) {
    this.context = context
    this.review = null
    this.processedRequestIds = new Set()
    this.latestLoadedRequestMtime = 0
    this.requestScanPromise = null
    this.requestScanQueued = false
    this.requestWatcher = null
    this.requestTimer = null
    this.resultScanPromise = null
    this.resultScanQueued = false
    this.resultWatcher = null
    this.processedResultIds = new Set()
    this.commentGroups = new Map()
    this.explainAnchors = []
    this.treeProvider = new ReviewTreeProvider(this)
    this.codeLensProvider = new ReviewCodeLensProvider(this)
    this.treeView = vscode.window.createTreeView('threadexReview.filesView', {
      treeDataProvider: this.treeProvider,
      showCollapseAll: true
    })
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95)
    this.statusBarItem.command = 'threadexReview.focus'
    this.commentController = vscode.comments.createCommentController('threadexAnnotations', 'Threadex Annotations')
    this.commentController.commentingRangeProvider = {
      provideCommentingRanges: (document) => this.annotationRanges(document)
    }
    this.addedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right
    })
    this.modifiedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.modifiedLineBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.modifiedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right
    })
    this.deletedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right
    })
    this.walkthroughDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.infoForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right
    })

    context.subscriptions.push(
      this.treeView,
      this.statusBarItem,
      this.commentController,
      this.addedDecoration,
      this.modifiedDecoration,
      this.deletedDecoration,
      this.walkthroughDecoration,
      vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, {
        provideTextDocumentContent: (uri) => this.virtualDocumentText(uri, 'baseline')
      }),
      vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, {
        provideTextDocumentContent: (uri) => this.virtualDocumentText(uri, 'empty')
      }),
      vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: BASELINE_SCHEME }], this.codeLensProvider),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshDecorations()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.queueRequestScan()),
      vscode.commands.registerCommand('threadexReview.focus', () => this.focusReview()),
      vscode.commands.registerCommand('threadexReview.explainSelection', () => this.explainSelection()),
      vscode.commands.registerCommand('threadexReview.explainFile', () => this.explainFile()),
      vscode.commands.registerCommand('threadexReview.addAnnotation', () => this.addAnnotation()),
      vscode.commands.registerCommand('threadexReview.submitAnnotation', (thread) => this.submitAnnotation(thread)),
      vscode.commands.registerCommand('threadexReview.revealExplanation', (item) => this.revealExplanation(item)),
      vscode.commands.registerCommand('threadexReview.openFile', (item) => this.openFile(item)),
      vscode.commands.registerCommand('threadexReview.openBlock', (item) => this.openBlock(item)),
      vscode.commands.registerCommand('threadexReview.openDiff', (item) => this.openDiff(item)),
      vscode.commands.registerCommand('threadexReview.acceptBlock', (item) => this.acceptBlock(item)),
      vscode.commands.registerCommand('threadexReview.rejectBlock', (item) => this.rejectBlock(item)),
      vscode.commands.registerCommand('threadexReview.acceptFile', (item) => this.acceptFile(item)),
      vscode.commands.registerCommand('threadexReview.rejectFile', (item) => this.rejectFile(item)),
      vscode.commands.registerCommand('threadexReview.complete', () => this.completeReview())
    )

    this.startRequestBridge()
    void this.syncContext()
  }

  dispose() {
    this.requestWatcher?.close()
    this.requestWatcher = null
    this.resultWatcher?.close()
    this.resultWatcher = null
    if (this.requestTimer) clearInterval(this.requestTimer)
    this.requestTimer = null
    this.disposeCommentThreads()
    this.clearDecorations()
  }

  startRequestBridge() {
    const requestDirectory = process.env.THREADEX_REVIEW_REQUEST_DIR
    const resultDirectory = process.env.THREADEX_WALKTHROUGH_RESULT_DIR
    if (!requestDirectory && !resultDirectory) return
    try {
      if (requestDirectory) {
        fs.mkdirSync(requestDirectory, { recursive: true })
        this.requestWatcher = fs.watch(requestDirectory, { persistent: false }, () => this.queueRequestScan())
      }
      if (resultDirectory) {
        fs.mkdirSync(resultDirectory, { recursive: true })
        this.resultWatcher = fs.watch(resultDirectory, { persistent: false }, () => this.queueResultScan())
      }
      this.requestTimer = setInterval(() => {
        this.queueRequestScan()
        this.queueResultScan()
      }, REQUEST_SCAN_INTERVAL_MS)
      this.requestTimer.unref?.()
      this.queueRequestScan()
      this.queueResultScan()
    } catch (error) {
      console.error('Threadex Review: could not start request bridge', error)
    }
  }

  queueRequestScan() {
    if (this.requestScanPromise) {
      this.requestScanQueued = true
      return
    }
    this.requestScanPromise = this.scanRequests()
      .catch((error) => console.error('Threadex Review: request scan failed', error))
      .finally(() => {
        this.requestScanPromise = null
        if (this.requestScanQueued) {
          this.requestScanQueued = false
          this.queueRequestScan()
        }
      })
  }

  queueResultScan() {
    if (this.resultScanPromise) {
      this.resultScanQueued = true
      return
    }
    this.resultScanPromise = this.scanResults()
      .catch((error) => console.error('Threadex Walkthrough: result scan failed', error))
      .finally(() => {
        this.resultScanPromise = null
        if (this.resultScanQueued) {
          this.resultScanQueued = false
          this.queueResultScan()
        }
      })
  }

  async scanRequests() {
    const requestDirectory = process.env.THREADEX_REVIEW_REQUEST_DIR
    if (!requestDirectory || !activeWorkspacePath()) return

    const candidates = fs.readdirSync(requestDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => {
        const requestPath = path.join(requestDirectory, entry.name)
        return { requestPath, mtimeMs: fs.statSync(requestPath).mtimeMs }
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs)

    for (const candidate of candidates) {
      if ((Date.now() - candidate.mtimeMs) > MAX_REQUEST_AGE_MS) break
      if (candidate.mtimeMs <= this.latestLoadedRequestMtime) continue
      let request
      try {
        request = JSON.parse(fs.readFileSync(candidate.requestPath, 'utf8'))
      } catch {
        continue
      }
      const requestId = typeof request?.requestId === 'string' ? request.requestId : ''
      if (!requestId || this.processedRequestIds.has(requestId)) continue
      if (!isWorkspaceAvailable(request.workspacePath)) continue
      const expiresAt = Date.parse(String(request.expiresAt ?? ''))
      if (Number.isFinite(expiresAt) && expiresAt < Date.now()) continue
      this.processedRequestIds.add(requestId)
      this.latestLoadedRequestMtime = candidate.mtimeMs
      await this.loadRequest(request)
      break
    }
  }

  async scanResults() {
    const resultDirectory = process.env.THREADEX_WALKTHROUGH_RESULT_DIR
    if (!resultDirectory || !this.canExplain()) return
    if (!isWorkspaceAvailable(this.review.workspacePath)) return
    const candidates = fs.readdirSync(resultDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => {
        const resultPath = path.join(resultDirectory, entry.name)
        return { resultPath, mtimeMs: fs.statSync(resultPath).mtimeMs }
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs)

    for (const candidate of candidates) {
      if ((Date.now() - candidate.mtimeMs) > MAX_REQUEST_AGE_MS) break
      let result
      try {
        result = JSON.parse(fs.readFileSync(candidate.resultPath, 'utf8'))
      } catch {
        continue
      }
      const actionId = typeof result?.actionId === 'string' ? result.actionId : ''
      if (!actionId || this.processedResultIds.has(actionId)) continue
      if (!samePath(result.workspacePath, this.review.workspacePath) || result.sessionId !== this.review.sessionId) continue
      const resultCreatedAt = Date.parse(String(result.createdAt ?? ''))
      if (!Number.isFinite(resultCreatedAt) || resultCreatedAt < this.review.createdAt) continue
      const expiresAt = Date.parse(String(result.expiresAt ?? ''))
      if (Number.isFinite(expiresAt) && expiresAt < Date.now()) continue
      this.processedResultIds.add(actionId)
      await this.applyWalkthroughResult(result)
      break
    }
  }

  async loadRequest(request) {
    const workspacePath = canonicalPath(request.workspacePath)
    if (!workspacePath || !isWorkspaceAvailable(workspacePath)) return
    const mode = request?.mode === 'explain' ? 'explain' : request?.mode === 'annotate' ? 'annotate' : 'edit'
    const capabilities = request?.capabilities && typeof request.capabilities === 'object'
      ? request.capabilities
      : mode === 'explain'
        ? { explain: true, mutate: false, accept: false, reject: false }
        : { explain: false, mutate: true, accept: true, reject: true }
    const files = []

    for (const candidate of mode === 'edit' && Array.isArray(request.files) ? request.files : []) {
      const parsed = parseReviewFile(candidate)
      if (!parsed.path || parsed.blocks.length === 0) continue
      const absolutePath = path.resolve(workspacePath, parsed.path)
      if (!isInside(workspacePath, absolutePath)) continue
      const uri = vscode.Uri.file(absolutePath)
      const exists = fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()
      const currentText = exists ? fs.readFileSync(absolutePath, 'utf8') : ''
      files.push({
        ...parsed,
        uri,
        exists,
        currentText,
        baselineText: typeof candidate.baselineText === 'string'
          ? candidate.baselineText.replace(/\r\n/g, '\n')
          : reconstructBaseline(currentText, parsed.blocks)
      })
    }

    this.disposeCommentThreads()
    this.review = {
      requestId: request.requestId,
      title: String(request.title || `Turn ${request.turnId || ''}`).trim(),
      turnId: String(request.turnId || ''),
      sessionId: String(request.sessionId || ''),
      createdAt: Number.isFinite(Date.parse(String(request.createdAt ?? ''))) ? Date.parse(String(request.createdAt)) : Date.now(),
      workspacePath,
      mode,
      capabilities,
      returnUrl: typeof request.returnUrl === 'string' ? request.returnUrl : '',
      files
    }
    this.treeProvider.refresh()
    this.codeLensProvider.refresh()
    this.refreshDecorations()
    this.updateStatusBar()
    await this.syncContext()

    if (mode === 'explain') {
      await this.focusReview()
      void vscode.window.showInformationMessage('Threadex Walkthrough is ready. Select code, then run “Threadex: Explain Selection”.')
      return
    }

    if (mode === 'annotate') {
      void vscode.window.showInformationMessage('Threadex annotations are ready. Select code or use the comment icon beside a line.')
      return
    }

    if (files.length === 0) {
      void vscode.window.showInformationMessage('Threadex Review: this turn has no text blocks to review.')
      return
    }

    await this.focusReview()
    await this.openDiff({ kind: 'file', path: files[0].path })
  }

  isEditable() {
    return isReviewMutationAllowed(this.review)
  }

  canExplain() {
    return Boolean(this.review && this.review.capabilities?.explain === true && this.review.sessionId)
  }

  canAnnotate() {
    return Boolean(this.review?.capabilities?.annotate === true && this.review.sessionId && this.review.returnUrl)
  }

  annotationRanges(document) {
    if (!this.canAnnotate() || document.uri.scheme !== 'file' || !isInside(this.review.workspacePath, document.uri.fsPath)) return []
    const endLine = Math.max(0, document.lineCount - 1)
    return [new vscode.Range(0, 0, endLine, document.lineAt(endLine).text.length)]
  }

  async addAnnotation() {
    const editor = vscode.window.activeTextEditor
    if (!editor || !this.canAnnotate() || editor.document.uri.scheme !== 'file' || !isInside(this.review.workspacePath, editor.document.uri.fsPath)) {
      void vscode.window.showWarningMessage('Threadex: open this project from the source session before adding an annotation.')
      return
    }
    const range = editor.selection.isEmpty
      ? editor.document.lineAt(editor.selection.active.line).range
      : new vscode.Range(editor.selection.start, editor.selection.end)
    const reply = await vscode.window.showInputBox({
      title: 'Reply to Threadex',
      prompt: 'Comment on the selected source range',
      placeHolder: 'What should Codex change or consider?'
    })
    if (reply === undefined || !reply.trim()) return
    await this.sendAnnotation(editor.document, range, reply.trim())
  }

  async submitAnnotation(thread) {
    if (!thread?.uri || !thread.range) return this.addAnnotation()
    const document = await vscode.workspace.openTextDocument(thread.uri)
    const draft = [...(thread.comments ?? [])].reverse().find((comment) => comment?.body)
    const body = typeof draft?.body === 'string' ? draft.body : draft?.body?.value
    if (!body?.trim()) {
      void vscode.window.showWarningMessage('Threadex: write a reply before sending the annotation.')
      return
    }
    await this.sendAnnotation(document, thread.range, body.trim())
    thread.canReply = true
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded
  }

  async sendAnnotation(document, range, reply) {
    if (!this.canAnnotate()) return
    const relativePath = path.relative(this.review.workspacePath, document.uri.fsPath).split(path.sep).join('/')
    if (!relativePath || relativePath.startsWith('../')) return
    const selectedText = document.getText(range).trim() || document.lineAt(range.start.line).text
    const payload = {
      version: 1,
      sessionId: this.review.sessionId,
      annotation: {
        text: selectedText.slice(0, 12_000),
        annotation: reply.slice(0, 4_000),
        source: {
          type: 'file',
          path: relativePath,
          selection: {
            startLine: range.start.line + 1,
            startColumn: range.start.character + 1,
            endLine: range.end.line + 1,
            endColumn: range.end.character + 1
          },
          side: document.uri.scheme === BASELINE_SCHEME ? 'original' : 'modified',
          sessionUrl: `codex://session/${this.review.sessionId}`
        }
      }
    }
    const target = new URL(this.review.returnUrl)
    target.searchParams.set('sessionId', this.review.sessionId)
    target.hash = `threadex-annotation=${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
    await vscode.env.openExternal(vscode.Uri.parse(target.toString()))
    vscode.window.setStatusBarMessage('Threadex: annotation returned to the source session.', 5_000)
  }

  resolveExplainSource(editor) {
    const workspacePath = this.review?.workspacePath
    if (!editor || !workspacePath) return null
    const uri = editor.document.uri
    if (uri.scheme === 'file' && isInside(workspacePath, uri.fsPath)) {
      return {
        path: path.relative(workspacePath, uri.fsPath).split(path.sep).join('/'),
        revision: 'workspace',
        reviewRequestId: undefined
      }
    }
    if (uri.scheme !== BASELINE_SCHEME || this.review?.mode !== 'edit') return null
    const requestId = new URLSearchParams(uri.query).get('request')
    if (!requestId || requestId !== this.review.requestId) return null
    const file = this.getFiles().find((candidate) => candidate.uri.path === uri.path)
    if (!file) return null
    return { path: file.path, revision: 'baseline', reviewRequestId: requestId }
  }

  async explainSelection() {
    if (!this.canExplain()) {
      void vscode.window.showWarningMessage('Threadex: open Code Walkthrough from the active Threadex session before requesting an explanation.')
      return
    }
    const editor = vscode.window.activeTextEditor
    const workspacePath = this.review.workspacePath
    const explainSource = this.resolveExplainSource(editor)
    if (!editor || !workspacePath || !explainSource) {
      void vscode.window.showWarningMessage('Threadex: select source code in the active workspace or this Threadex diff first.')
      return
    }
    if (editor.selection.isEmpty) {
      void vscode.window.showWarningMessage('Threadex: select the code you want explained first.')
      return
    }
    const anchor = createExplainAnchor({
      ...explainSource,
      documentText: editor.document.getText(),
      selection: editor.selection
    })
    if (!anchor || !anchor.selectedText.trim()) {
      void vscode.window.showWarningMessage('Threadex: the selection is no longer valid. Select it again.')
      return
    }
    if (anchor.selectedText.length > 12_000 || anchor.range.end.line - anchor.range.start.line > 300) {
      void vscode.window.showWarningMessage('Threadex: select at most 12,000 characters and 300 lines.')
      return
    }
    const question = await vscode.window.showInputBox({
      title: 'Threadex: Explain Selection',
      prompt: 'Optional question for this explanation',
      placeHolder: 'For example: Why does this cache invalidate here?'
    })
    if (question === undefined) return
    if (question.length > 1200) {
      void vscode.window.showWarningMessage('Threadex: the optional question must be at most 1,200 characters.')
      return
    }
    const actionDirectory = process.env.THREADEX_WALKTHROUGH_ACTION_DIR
    if (!actionDirectory) {
      void vscode.window.showErrorMessage('Threadex: walkthrough bridge is unavailable in this Web VS Code server.')
      return
    }
    const now = Date.now()
    const actionId = randomUUID()
    const action = {
      version: 1,
      kind: 'explainSelection',
      actionId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
      workspacePath,
      sessionId: this.review.sessionId,
      question: question.trim() || undefined,
      source: anchor
    }
    try {
      atomicWriteJson(path.join(actionDirectory, `${now}-${actionId}.json`), action)
      vscode.window.setStatusBarMessage('Threadex: preparing your code walkthrough…', 6_000)
      void vscode.window.showInformationMessage('Threadex: explaining the selected code…')
    } catch (error) {
      void vscode.window.showErrorMessage(`Threadex: could not submit the walkthrough request. ${errorMessage(error)}`)
    }
  }

  async explainFile() {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      void vscode.window.showWarningMessage('Threadex: open a source file first.')
      return
    }
    const document = editor.document
    if (document.getText().length > 12_000 || document.lineCount > 300) {
      void vscode.window.showWarningMessage('Threadex: this file is too large to explain at once. Select a smaller code region instead.')
      return
    }
    const lastLine = Math.max(0, document.lineCount - 1)
    editor.selection = new vscode.Selection(0, 0, lastLine, document.lineAt(lastLine).text.length)
    await this.explainSelection()
  }

  walkthroughTargetUri(source, workspacePath) {
    if (source?.revision === 'baseline') {
      if (this.review?.mode !== 'edit' || source.reviewRequestId !== this.review.requestId) return null
      const file = this.getFiles().find((candidate) => candidate.path === source.path)
      if (!file) return null
      return vscode.Uri.from({
        scheme: BASELINE_SCHEME,
        path: file.uri.path,
        query: `request=${encodeURIComponent(this.review.requestId)}`
      })
    }
    const absolutePath = path.resolve(workspacePath, source.path)
    return isInside(workspacePath, absolutePath) ? vscode.Uri.file(absolutePath) : null
  }

  async applyWalkthroughResult(result) {
    const status = result?.status
    if (status === 'stale') {
      void vscode.window.showWarningMessage(`Threadex: ${String(result.error || 'The file changed. Select the code again.')}`)
      return
    }
    if (status !== 'success' || typeof result.explanation !== 'string' || !result.explanation.trim()) {
      void vscode.window.showErrorMessage(`Threadex: ${String(result?.error || 'The walkthrough could not be completed.')}`)
      return
    }
    const workspacePath = this.review?.workspacePath
    const source = result.source
    if (!workspacePath || !source || typeof source.path !== 'string' || !source.range || !isInside(workspacePath, path.resolve(workspacePath, source.path))) {
      void vscode.window.showWarningMessage('Threadex: the explanation result has an invalid source target.')
      return
    }
    const targetUri = this.walkthroughTargetUri(source, workspacePath)
    if (!targetUri) {
      void vscode.window.showWarningMessage('Threadex: this diff revision is no longer active. Reopen the review and select it again.')
      return
    }
    let document
    try {
      document = await vscode.workspace.openTextDocument(targetUri)
    } catch {
      void vscode.window.showWarningMessage('Threadex: the selected file is no longer available. Select the code again.')
      return
    }
    const anchor = createExplainAnchor({ path: source.path, documentText: document.getText(), selection: source.range })
    if (!anchor || anchor.sourceFingerprint !== source.sourceFingerprint || anchor.selectionHash !== source.selectionHash) {
      void vscode.window.showWarningMessage('Threadex: the file changed before the explanation arrived. Select the code again.')
      return
    }
    const range = new vscode.Range(anchor.range.start.line, anchor.range.start.character, anchor.range.end.line, anchor.range.end.character)
    const targetKey = walkthroughTargetKey(source)
    if (!targetKey) {
      void vscode.window.showWarningMessage('Threadex: the explanation result has an invalid comment anchor.')
      return
    }
    const existingGroup = this.commentGroups.get(targetKey)
    const commentNumber = (existingGroup?.comments.length ?? 0) + 1
    const body = new vscode.MarkdownString(renderWalkthroughMarkdown(result.explanation, source, commentNumber))
    body.isTrusted = false
    body.supportHtml = false
    const comment = {
      body,
      mode: vscode.CommentMode.Preview,
      author: { name: 'Threadex' }
    }
    let group = existingGroup
    if (group) {
      group.comments.push(comment)
      group.actionIds.push(result.actionId)
      group.latestActionId = result.actionId
      group.thread.comments = [...group.comments]
    } else {
      const thread = this.commentController.createCommentThread(document.uri, range, [comment])
      thread.canReply = this.canAnnotate()
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded
      group = {
        key: targetKey,
        path: source.path,
        rangeLabel: walkthroughRangeLabel(source),
        revision: source.revision === 'baseline' ? 'baseline' : 'working',
        uri: document.uri,
        range,
        comments: [comment],
        actionIds: [result.actionId],
        latestActionId: result.actionId,
        thread
      }
      this.commentGroups.set(targetKey, group)
      this.explainAnchors.push(group)
    }
    group.thread.label = `${group.path} · ${group.rangeLabel} · ${group.revision} · ${group.comments.length} comment${group.comments.length === 1 ? '' : 's'}`
    group.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded
    this.treeProvider.refresh()
    this.codeLensProvider.refresh()
    this.refreshDecorations()
    this.updateStatusBar()
    const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document.uri.toString() === document.uri.toString())
      ?? await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true })
    const commentPosition = new vscode.Range(range.end, range.end)
    editor.revealRange(commentPosition, vscode.TextEditorRevealType.InCenter)
    vscode.window.setStatusBarMessage('Threadex: walkthrough added as an inline comment.', 5_000)
  }

  async revealExplanation(item) {
    const anchor = this.explainAnchors.find((candidate) => candidate.key === item?.targetKey || candidate.actionIds.includes(item?.actionId))
    if (!anchor) return
    const document = await vscode.workspace.openTextDocument(anchor.uri)
    const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document.uri.toString() === document.uri.toString())
      ?? await vscode.window.showTextDocument(document, { preview: false })
    editor.selection = new vscode.Selection(anchor.range.end, anchor.range.end)
    const commentPosition = new vscode.Range(anchor.range.end, anchor.range.end)
    editor.revealRange(commentPosition, vscode.TextEditorRevealType.InCenter)
    anchor.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded
  }

  async focusReview() {
    await vscode.commands.executeCommand('workbench.view.explorer')
    try {
      await vscode.commands.executeCommand('threadexReview.filesView.focus')
    } catch {}
  }

  getFiles() {
    return this.review?.files ?? []
  }

  getExplanationGroups() {
    return [...this.commentGroups.values()]
  }

  resolveFile(item) {
    const requestedPath = typeof item === 'string' ? item : item?.path
    if (!requestedPath) return null
    return this.getFiles().find((file) => file.path === requestedPath) ?? null
  }

  resolveBlock(item) {
    const file = this.resolveFile(item)
    if (!file || !item?.blockId) return null
    const block = file.blocks.find((candidate) => candidate.id === item.blockId) ?? null
    return block ? { file, block } : null
  }

  virtualDocumentText(uri, kind) {
    if (kind === 'empty') return ''
    const file = this.getFiles().find((candidate) => candidate.uri.path === uri.path)
    return file?.baselineText ?? ''
  }

  async openFile(item) {
    const file = this.resolveFile(item)
    if (!file) return
    return this.openDiff({ kind: 'file', path: file.path })
  }

  async openBlock(item, options = {}) {
    const resolved = this.resolveBlock(item)
    if (!resolved) return
    const { file, block } = resolved
    if (!file.exists) return this.openDiff({ kind: 'file', path: file.path })

    const document = await vscode.workspace.openTextDocument(file.uri)
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: Boolean(options.preserveFocus)
    })
    const line = Math.max(0, Math.min(block.modifiedStart, Math.max(0, document.lineCount - 1)))
    const range = new vscode.Range(line, 0, line, document.lineAt(line).text.length)
    editor.selection = new vscode.Selection(range.start, range.start)
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter)
    this.refreshDecorations()
  }

  async openDiff(item) {
    const file = this.resolveFile(item) ?? this.resolveBlock(item)?.file
    if (!file || !this.review) return
    const query = `request=${encodeURIComponent(this.review.requestId)}`
    const baselineUri = vscode.Uri.from({ scheme: BASELINE_SCHEME, path: file.uri.path, query })
    const currentUri = file.exists
      ? file.uri
      : vscode.Uri.from({ scheme: EMPTY_SCHEME, path: file.uri.path, query })
    await vscode.commands.executeCommand(
      'vscode.diff',
      baselineUri,
      currentUri,
      `${file.path} — ${this.review.title}`,
      { preview: false }
    )
  }

  acceptBlock(item) {
    if (!this.isEditable()) {
      void vscode.window.showWarningMessage('Threadex: Code Walkthrough is read-only. Accept and Reject are unavailable.')
      return
    }
    const resolved = this.resolveBlock(item)
    if (!resolved) return
    resolved.block.status = 'accepted'
    this.refreshReviewUi()
  }

  async rejectBlock(item) {
    if (!this.isEditable()) {
      void vscode.window.showWarningMessage('Threadex: Code Walkthrough is read-only. Reject cannot modify files.')
      return
    }
    const resolved = this.resolveBlock(item)
    if (!resolved || resolved.block.status !== 'pending') return
    const { file, block } = resolved
    const currentText = await this.readCurrentText(file)
    const nextText = applyRejectedBlock(currentText, block)
    await this.writeCurrentText(file, nextText, file.isAdded && nextText.length === 0)
    const delta = block.originalLines.length - block.modifiedLines.length
    block.status = 'rejected'
    file.currentText = nextText
    for (const candidate of file.blocks) {
      if (candidate !== block && candidate.status === 'pending' && candidate.modifiedStart > block.modifiedStart) {
        candidate.modifiedStart += delta
      }
    }
    this.refreshReviewUi()
  }

  acceptFile(item) {
    if (!this.isEditable()) {
      void vscode.window.showWarningMessage('Threadex: Code Walkthrough is read-only. Accept and Reject are unavailable.')
      return
    }
    const file = this.resolveFile(item)
    if (!file) return
    for (const block of file.blocks) {
      if (block.status === 'pending') block.status = 'accepted'
    }
    this.refreshReviewUi()
  }

  async rejectFile(item) {
    if (!this.isEditable()) {
      void vscode.window.showWarningMessage('Threadex: Code Walkthrough is read-only. Reject cannot modify files.')
      return
    }
    const file = this.resolveFile(item)
    if (!file) return
    await this.writeCurrentText(file, file.baselineText, file.isAdded)
    file.currentText = file.baselineText
    for (const block of file.blocks) {
      if (block.status === 'pending') block.status = 'rejected'
    }
    this.refreshReviewUi()
  }

  async readCurrentText(file) {
    try {
      const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === file.uri.toString())
      if (document) return document.getText()
      return Buffer.from(await vscode.workspace.fs.readFile(file.uri)).toString('utf8')
    } catch {
      return ''
    }
  }

  async writeCurrentText(file, text, deleteFile) {
    if (deleteFile) {
      try {
        await vscode.workspace.fs.delete(file.uri, { useTrash: false })
      } catch {}
      file.exists = false
      return
    }

    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file.uri.fsPath)))
    const openDocument = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === file.uri.toString())
    if (openDocument) {
      const lastLine = Math.max(0, openDocument.lineCount - 1)
      const range = new vscode.Range(0, 0, lastLine, openDocument.lineAt(lastLine).text.length)
      const edit = new vscode.WorkspaceEdit()
      edit.replace(openDocument.uri, range, text)
      if (await vscode.workspace.applyEdit(edit)) await openDocument.save()
    } else {
      await vscode.workspace.fs.writeFile(file.uri, Buffer.from(text, 'utf8'))
    }
    file.exists = true
  }

  completeReview() {
    this.review = null
    this.disposeCommentThreads()
    this.treeProvider.refresh()
    this.codeLensProvider.refresh()
    this.clearDecorations()
    this.updateStatusBar()
    void this.syncContext()
  }

  refreshReviewUi() {
    this.treeProvider.refresh()
    this.codeLensProvider.refresh()
    this.refreshDecorations()
    this.updateStatusBar()
  }

  pendingCount() {
    return this.getFiles().reduce(
      (count, file) => count + file.blocks.filter((block) => block.status === 'pending').length,
      0
    )
  }

  updateStatusBar() {
    if (!this.review) {
      this.statusBarItem.hide()
      return
    }
    const pending = this.pendingCount()
    const commentCount = this.getExplanationGroups().reduce((count, group) => count + group.comments.length, 0)
    this.statusBarItem.command = this.canAnnotate() ? 'threadexReview.addAnnotation' : 'threadexReview.focus'
    this.statusBarItem.text = this.review.mode === 'annotate'
      ? '$(comment-add) Threadex: Add annotation'
      : this.review.mode === 'explain'
      ? commentCount > 0
        ? `$(comment-discussion) Threadex Walkthrough: ${commentCount} comment${commentCount === 1 ? '' : 's'} in ${this.commentGroups.size} block${this.commentGroups.size === 1 ? '' : 's'}`
        : '$(comment-discussion) Threadex Walkthrough: select code to explain'
      : pending > 0 ? `$(git-pull-request) Threadex Review: ${pending}` : '$(pass-filled) Threadex Review complete'
    this.statusBarItem.tooltip = this.review.title
    this.statusBarItem.show()
  }

  async syncContext() {
    await vscode.commands.executeCommand('setContext', 'threadexReview.hasSession', Boolean(this.review))
    await vscode.commands.executeCommand('setContext', 'threadexReview.isEditable', this.isEditable())
    await vscode.commands.executeCommand('setContext', 'threadexReview.canExplain', this.canExplain())
    await vscode.commands.executeCommand('setContext', 'threadexReview.canAnnotate', this.canAnnotate())
  }

  disposeCommentThreads() {
    for (const group of this.commentGroups.values()) group.thread.dispose()
    this.commentGroups.clear()
    this.explainAnchors = []
  }

  clearDecorations() {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.addedDecoration, [])
      editor.setDecorations(this.modifiedDecoration, [])
      editor.setDecorations(this.deletedDecoration, [])
      editor.setDecorations(this.walkthroughDecoration, [])
    }
  }

  refreshDecorations() {
    for (const editor of vscode.window.visibleTextEditors) {
      const walkthroughAnchors = this.explainAnchors.filter((anchor) => anchor.uri.toString() === editor.document.uri.toString())
      editor.setDecorations(this.walkthroughDecoration, walkthroughAnchors.map((anchor) => ({
        range: anchor.range,
        hoverMessage: new vscode.MarkdownString(`**${anchor.path} · ${anchor.rangeLabel}**\n\n${anchor.comments.length} walkthrough comment${anchor.comments.length === 1 ? '' : 's'}. Open the inline block or CodeLens to read them.`),
        renderOptions: {
          after: {
            contentText: `  💬 Threadex · ${anchor.comments.length}`,
            color: new vscode.ThemeColor('editorCodeLens.foreground')
          }
        }
      })))
      const file = this.getFiles().find((candidate) => candidate.uri.toString() === editor.document.uri.toString())
      if (!file || !this.isEditable()) {
        editor.setDecorations(this.addedDecoration, [])
        editor.setDecorations(this.modifiedDecoration, [])
        editor.setDecorations(this.deletedDecoration, [])
        continue
      }
      const additions = []
      const modifications = []
      const deletions = []
      for (const block of file.blocks) {
        if (block.status !== 'pending') continue
        const line = Math.max(0, Math.min(block.modifiedStart, Math.max(0, editor.document.lineCount - 1)))
        const endLine = Math.max(line, Math.min(
          line + Math.max(1, block.modifiedLines.length) - 1,
          Math.max(0, editor.document.lineCount - 1)
        ))
        const range = new vscode.Range(line, 0, endLine, editor.document.lineAt(endLine).text.length)
        const option = {
          range,
          hoverMessage: new vscode.MarkdownString(`**${blockLabel(block)}**\n\nOpen the CodeLens or Threadex Review tree to accept, reject, or inspect the diff.`)
        }
        if (block.changeKind === 'addition') additions.push(option)
        else if (block.changeKind === 'modification') modifications.push(option)
        else {
          deletions.push({
            ...option,
            renderOptions: {
              after: {
                contentText: `  ⟵ ${block.originalLines.length} deleted line${block.originalLines.length === 1 ? '' : 's'}`,
                color: new vscode.ThemeColor('errorForeground')
              }
            }
          })
        }
      }
      editor.setDecorations(this.addedDecoration, additions)
      editor.setDecorations(this.modifiedDecoration, modifications)
      editor.setDecorations(this.deletedDecoration, deletions)
    }
  }
}

class ReviewTreeProvider {
  constructor(controller) {
    this.controller = controller
    this.emitter = new vscode.EventEmitter()
    this.onDidChangeTreeData = this.emitter.event
  }

  refresh() {
    this.emitter.fire(undefined)
  }

  getChildren(element) {
    if (!element) {
      if (this.controller.review?.mode === 'annotate') return [{ kind: 'annotation' }]
      const walkthrough = this.controller.getExplanationGroups().length > 0 ? [{ kind: 'walkthrough' }] : []
      if (this.controller.review?.mode === 'explain') return walkthrough
      const files = this.controller.getFiles().map((file) => ({ kind: 'file', path: file.path }))
      return [...walkthrough, ...files]
    }
    if (element.kind === 'walkthrough') {
      return this.controller.getExplanationGroups().map((group) => ({ kind: 'explanation', targetKey: group.key }))
    }
    return []
  }

  getTreeItem(element) {
    if (element.kind === 'annotation') {
      const item = new vscode.TreeItem('Add annotation to source session', vscode.TreeItemCollapsibleState.None)
      item.contextValue = 'threadexAnnotation'
      item.description = 'Select code or use the line comment icon'
      item.tooltip = 'Send a source annotation and reply back to the Threadex session that opened this project.'
      item.iconPath = new vscode.ThemeIcon('comment-add')
      item.command = { command: 'threadexReview.addAnnotation', title: 'Add annotation' }
      return item
    }
    if (element.kind === 'walkthrough') {
      const groups = this.controller.getExplanationGroups()
      const commentCount = groups.reduce((count, group) => count + group.comments.length, 0)
      const item = new vscode.TreeItem('Code Walkthrough', groups.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None)
      item.contextValue = 'threadexWalkthrough'
      item.description = groups.length > 0
        ? `${groups.length} block${groups.length === 1 ? '' : 's'} · ${commentCount} comment${commentCount === 1 ? '' : 's'}`
        : 'Select code, then Explain Selection'
      item.iconPath = new vscode.ThemeIcon('comment-discussion')
      if (groups.length === 0) item.command = { command: 'threadexReview.explainSelection', title: 'Explain Selection' }
      return item
    }
    if (element.kind === 'explanation') {
      const group = this.controller.getExplanationGroups().find((candidate) => candidate.key === element.targetKey)
      const item = new vscode.TreeItem(
        group ? `${path.basename(group.path)} · ${group.rangeLabel} · ${group.revision}` : 'Walkthrough comment',
        vscode.TreeItemCollapsibleState.None
      )
      item.contextValue = 'threadexWalkthroughComment'
      item.description = group ? `${group.comments.length} comment${group.comments.length === 1 ? '' : 's'}` : ''
      item.tooltip = group ? `${group.path} · ${group.rangeLabel} · ${group.revision}` : undefined
      item.iconPath = new vscode.ThemeIcon('comment-discussion')
      item.command = { command: 'threadexReview.revealExplanation', title: 'Reveal inline comments', arguments: [element] }
      return item
    }
    if (element.kind === 'file') {
      const file = this.controller.resolveFile(element)
      const summary = summarizeReviewBlocks(file?.blocks)
      const item = new vscode.TreeItem(file?.path ?? element.path, vscode.TreeItemCollapsibleState.None)
      item.contextValue = 'threadexReviewFile'
      item.resourceUri = file?.uri
      item.description = `+${summary.additions} −${summary.deletions}`
      item.tooltip = `${file?.path ?? element.path}\n+${summary.additions} additions · −${summary.deletions} deletions\nOpen language-aware diff`
      item.command = { command: 'threadexReview.openDiff', title: 'Open Language-aware Diff', arguments: [element] }
      return item
    }
    const resolved = this.controller.resolveBlock(element)
    const item = new vscode.TreeItem(resolved ? blockLabel(resolved.block) : 'Review block')
    item.contextValue = 'threadexReviewBlock'
    item.description = resolved?.block.status
    item.iconPath = new vscode.ThemeIcon(
      resolved?.block.status === 'accepted' ? 'pass-filled' : resolved?.block.status === 'rejected' ? 'discard' : 'diff-modified'
    )
    item.command = { command: 'threadexReview.openBlock', title: 'Open review block', arguments: [element] }
    return item
  }
}

class ReviewCodeLensProvider {
  constructor(controller) {
    this.controller = controller
    this.emitter = new vscode.EventEmitter()
    this.onDidChangeCodeLenses = this.emitter.event
  }

  refresh() {
    this.emitter.fire()
  }

  provideCodeLenses(document) {
    const walkthroughLenses = this.controller.explainAnchors
      .filter((anchor) => anchor.uri.toString() === document.uri.toString())
      .map((anchor) => new vscode.CodeLens(anchor.range, {
        title: `$(comment-discussion) ${anchor.comments.length} Threadex comment${anchor.comments.length === 1 ? '' : 's'} · ${anchor.rangeLabel}`,
        command: 'threadexReview.revealExplanation',
        arguments: [{ targetKey: anchor.key }]
      }))
    if (!this.controller.isEditable()) return walkthroughLenses
    const file = this.controller.getFiles().find((candidate) => candidate.uri.toString() === document.uri.toString())
    if (!file) return walkthroughLenses
    const lenses = []
    for (const block of file.blocks) {
      if (block.status !== 'pending') continue
      const line = Math.max(0, Math.min(block.modifiedStart, Math.max(0, document.lineCount - 1)))
      const range = new vscode.Range(line, 0, line, 0)
      const argument = { kind: 'block', path: file.path, blockId: block.id }
      lenses.push(
        new vscode.CodeLens(range, { title: '$(diff) Review diff', command: 'threadexReview.openDiff', arguments: [argument] }),
        new vscode.CodeLens(range, { title: '$(check) Accept', command: 'threadexReview.acceptBlock', arguments: [argument] }),
        new vscode.CodeLens(range, { title: '$(discard) Reject', command: 'threadexReview.rejectBlock', arguments: [argument] })
      )
    }
    return [...walkthroughLenses, ...lenses]
  }
}

function activeWorkspacePath() {
  const folder = vscode.workspace.workspaceFolders?.find((candidate) => candidate.uri.scheme === 'file')
  return folder?.uri.fsPath ? canonicalPath(folder.uri.fsPath) : null
}

function isWorkspaceAvailable(workspacePath) {
  const requestedPath = canonicalPath(workspacePath)
  if (!requestedPath) return false
  return Boolean(vscode.workspace.workspaceFolders?.some((folder) => {
    if (folder.uri.scheme !== 'file') return false
    const openPath = canonicalPath(folder.uri.fsPath)
    return Boolean(openPath && isInside(openPath, requestedPath))
  }))
}

function canonicalPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const resolved = path.resolve(value)
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function samePath(left, right) {
  const leftPath = canonicalPath(left)
  const rightPath = canonicalPath(right)
  return Boolean(leftPath && rightPath && leftPath === rightPath)
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function atomicWriteJson(destination, value) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value), 'utf8')
  fs.renameSync(temporary, destination)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

module.exports = { activate, deactivate }
