import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Isolated transport proof, deliberately not connected to the live session DB.
const distro = process.env.THREADEX_WSL_DISTRO || 'Fedora';
const runId = randomUUID();
const cwd = `/tmp/threadex-wsl-mvp-${runId}/work`;
const codex = '/tmp/threadex-wsl-mvp-tools/node_modules/.bin/codex';
const home = `/tmp/threadex-wsl-mvp-${runId}/home`;
function wsl(...args) {
  const result = spawnSync('wsl.exe', ['--distribution', distro, '--exec', ...args], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `WSL command failed: ${args[0]}`);
  return result.stdout.trim();
}
// Use only auth, never import Windows paths, hooks or MCP config into Linux.
wsl(codex, '--version');
const sourceAuth = wsl('wslpath', '-u', process.env.THREADEX_WSL_AUTH_FILE || resolve(homedir(), '.codex/auth.json'));
wsl('mkdir', '-p', '-m', '700', home, cwd);
wsl('install', '-m', '600', sourceAuth, `${home}/auth.json`);
const started = performance.now();
const events = [];
const pending = new Map();
let nextId = 1;
let completed;
let failTurn;
const turnDone = new Promise((resolveTurn, rejectTurn) => {
  completed = resolveTurn;
  failTurn = rejectTurn;
});
// Attach immediately so startup failures cannot cause an unhandled rejection.
turnDone.catch(() => {});
const child = spawn('wsl.exe', ['--distribution', distro, '--cd', cwd, '--exec',
  'env', `CODEX_HOME=${home}`, codex, 'app-server',
  '-c', 'features.memories=false'], {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const fail = (error) => {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
  failTurn(error);
};
child.on('error', fail);
child.stdin.on('error', fail);
child.on('exit', (code) => fail(new Error(`WSL app-server exited: ${code}`)));
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (pending.has(message.id) && !message.method) {
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
    return;
  }
  // MVP never grants unexpected approval or silently answers a user question.
  if (message.id !== undefined && message.method) {
    send({ id: message.id, error: { code: -32601, message: 'Interactive requests unsupported by isolated MVP' } });
    fail(new Error(`Unexpected interactive request: ${message.method}`));
    return;
  }
  events.push(message);
  if (message.method === 'item/completed') {
    const item = message.params.item;
    console.log(JSON.stringify({ event: message.method, item }));
  }
  if (message.method === 'turn/completed') completed(message.params.turn);
});
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolveRequest, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 30_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolveRequest(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    send({ id, method, params });
  });
}
const deadline = setTimeout(() => fail(new Error('MVP exceeded 180 seconds')), 180_000);
let threadId;
try {
  await rpc('initialize', { clientInfo: { name: 'threadex_wsl_mvp', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  send({ method: 'initialized', params: {} });
  console.log(`WSL app-server initialized in ${Math.round(performance.now() - started)} ms`);
  const thread = await rpc('thread/start', {
    cwd, sandbox: 'workspace-write', approvalPolicy: 'never',
    developerInstructions: 'This is a bounded local coding smoke test. Use apply_patch for all code edits. Do not spawn agents. Work only in the supplied cwd.',
    ...(process.env.THREADEX_WSL_MODEL ? { model: process.env.THREADEX_WSL_MODEL } : {}),
  });
  threadId = thread.thread.id;
  await rpc('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'Run uname -s and pwd to verify Linux. Using apply_patch, create sum.mjs exporting sum(a,b) and sum.test.mjs with node:test checks for positive and negative inputs. Run node --test sum.test.mjs. Report the result. Do not install packages or access files outside this working directory.', text_elements: [] }],
  });
  const turn = await turnDone;
  if (turn.status !== 'completed') throw new Error(`Turn ended with ${turn.status}: ${JSON.stringify(turn.error)}`);
  const items = events.filter((event) => event.method === 'item/completed').map((event) => event.params.item);
  if (!items.some((item) => item.type === 'fileChange' && item.status === 'completed')) throw new Error('No successful tracked file change received');
  if (!items.some((item) => item.type === 'commandExecution' && item.exitCode === 0 && item.aggregatedOutput?.includes('Linux'))) throw new Error('Linux environment not confirmed');
  if (!items.some((item) => item.type === 'commandExecution' && item.exitCode === 0 && item.command.includes('node --test') && item.aggregatedOutput?.includes('# fail 0'))) throw new Error('Passing Node tests not confirmed');
  console.log(`PASS: Linux coding turn and structured events returned to Windows in ${Math.round(performance.now() - started)} ms`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  const outputDir = resolve('artifacts/wsl-mvp');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(resolve(outputDir, 'events.json'), JSON.stringify({ distro, cwd, threadId, elapsedMs: performance.now() - started, events }, null, 2));
  // Closing stdio is the app-server shutdown path; interrupt active work first.
  const active = events.findLast((event) => event.method === 'turn/started')?.params.turn.id;
  if (process.exitCode && threadId && active) {
    await rpc('turn/interrupt', { threadId, turnId: active }).catch(() => {});
  }
  child.stdin.end();
  const killTimer = setTimeout(() => child.kill(), 4000);
  killTimer.unref();
  child.once('exit', () => clearTimeout(killTimer));
  wsl('rm', '-f', '--', `${home}/auth.json`);
}
