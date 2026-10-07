const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const test = require('node:test')

test('native baseline comments queue durably without opening a browser tab', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'threadex-annotation-'))
  try {
    const document = {
      uri: { scheme: 'threadex-review-baseline', path: '/project/source.ts', query: 'request=request-1' },
      lineCount: 1, lineAt: () => ({ text: 'old code' }), getText: () => 'old code'
    }
    const vscode = {
      Range: class {}, env: { openExternal: () => assert.fail('must not open a tab') },
      window: { setStatusBarMessage() {} }, workspace: { openTextDocument: async () => document },
      CommentThreadCollapsibleState: { Expanded: 1 }
    }
    const sandbox = {
      require: name => name === 'vscode' ? vscode : name === './review-core' ? require('./review-core') : require(name),
      module: { exports: {} }, URLSearchParams, Buffer,
      process: { pid: process.pid, env: { THREADEX_REVIEW_REQUEST_DIR: path.join(directory, 'review-requests') } }
    }
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'extension.js'), 'utf8') + '\nmodule.exports.Controller = ThreadexReviewController', sandbox)
    const instance = Object.create(sandbox.module.exports.Controller.prototype)
    instance.review = {
      mode: 'edit', requestId: 'request-1', sessionId: 'session-1', workspacePath: '/project',
      capabilities: { annotate: true }, files: [{ path: 'source.ts', uri: { path: '/project/source.ts' } }]
    }
    assert.equal(instance.canAnnotate(), true)
    assert.equal(instance.annotationRanges(document).length, 1)
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } }
    await instance.submitAnnotation({ thread: { uri: document.uri, range, comments: [] }, text: ' 中文 reply ' })
    const files = fs.readdirSync(path.join(directory, 'annotations'))
    assert.equal(files.length, 1)
    const payload = JSON.parse(fs.readFileSync(path.join(directory, 'annotations', files[0]), 'utf8'))
    assert.equal(payload.sessionId, 'session-1')
    assert.equal(payload.annotation.annotation, '中文 reply')
    assert.equal(payload.annotation.source.side, 'original')
    assert.equal(payload.annotation.source.path, 'source.ts')
    assert.equal(payload.annotation.source.selection.startLine, 1)
    document.uri.query = 'request=wrong-review'
    await instance.sendAnnotation(document, range, 'Wrong review')
    assert.equal(fs.readdirSync(path.join(directory, 'annotations')).length, 1)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
