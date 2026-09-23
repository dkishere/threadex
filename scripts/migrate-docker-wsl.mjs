import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';

const root = 'B:/threadex';
const dir = `${root}/outputs/docker-wsl-migration-20260921`;
mkdirSync(dir, { recursive: true });
const names = ['threadex-pg-migration', 'gnm-retrieval-pilot-20260921'];
const source = ['--context', 'desktop-linux'];
const wsl = ['-d', 'Ubuntu-24.04', '-u', 'root', '--', 'docker'];
const volumeName = name => `${name}-wsl-final`;
function run(exe, args) {
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${exe} ${args.slice(0, 5).join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const old = (...args) => run('docker', [...source, ...args]);
const dest = (...args) => run('wsl', [...wsl, ...args]);
function background(script, label) {
  const log = openSync(`${dir}/${label}.log`, 'a');
  const p = spawn(process.execPath, [script], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
  p.unref(); return p.pid;
}
async function transfer(aExe, aArgs, bExe, bArgs) {
  const a = spawn(aExe, aArgs, { windowsHide: true, stdio: ['ignore','pipe','inherit'] });
  const b = spawn(bExe, bArgs, { windowsHide: true, stdio: ['pipe','inherit','inherit'] });
  const ac = once(a, 'close'), bc = once(b, 'close');
  let pipeError;
  try { await pipeline(a.stdout, b.stdin); } catch(e) { pipeError = e; }
  const aCode = (await ac)[0], bCode = (await bc)[0];
  if (aCode !== 0 || bCode !== 0) throw new Error(`Transfer failed: source=${aCode} destination=${bCode}; ${pipeError || ''}`);
  // GNU tar may finish after the archive terminator before padding is consumed.
  // Both commands must succeed; volume contents are independently hashed below.
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let stopped = false;
let migrated = false;
try {
  const specs = JSON.parse(old('inspect', ...names));
  writeFileSync(`${dir}/container-specs.json`, JSON.stringify(specs, null, 2));
  for (const s of specs) {
    console.log('Transferring image', s.Name);
    let imageExists = false;
    try { dest('image', 'inspect', s.Image); imageExists = true; } catch {}
    if (!imageExists) await transfer('docker', [...source, 'image', 'save', s.Image], 'wsl', [...wsl, 'image', 'load']);
    dest('image', 'inspect', s.Image);
    for (const m of s.Mounts.filter(m => m.Type === 'volume')) {
      let exists = false;
      try { dest('volume', 'inspect', volumeName(m.Name)); exists = true; } catch {}
      if(exists) throw new Error(`Destination must be fresh: ${volumeName(m.Name)}`);
      dest('volume', 'create', volumeName(m.Name));
    }
  }
  if (process.argv.includes('--prepare-only')) { console.log('PREPARED'); process.exit(0); }
  console.log('Stopping Threadex supervisor and API before final data sync');
  // Exact PIDs verified before launch; no recursive process-tree kill (runner survives).
  const pids = JSON.parse(run('powershell.exe', ['-NoProfile', '-Command', '$api = (Get-NetTCPConnection -LocalPort 5173 -State Listen).OwningProcess; $child = Get-CimInstance Win32_Process -Filter "ProcessId = $api"; $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($child.ParentProcessId)"; $supervisor = Get-CimInstance Win32_Process -Filter "ProcessId = $($parent.ParentProcessId)"; if ($child.CommandLine -notmatch "src[\\\\/]server[\\\\/]index.ts" -or $supervisor.CommandLine -notmatch "serve(?:-wsl)?\\.mjs") { throw "Unexpected Threadex process tree" }; @($supervisor.ProcessId,$parent.ProcessId,$child.ProcessId) | ConvertTo-Json -Compress']));
  for (const pid of pids) { try { process.kill(pid); } catch (e) { if(e.code !== 'ESRCH') throw e; } }
  stopped = true;
  await sleep(3000);
  try { await fetch('http://127.0.0.1:5173/api/health', {signal: AbortSignal.timeout(2000)}); throw new Error('Threadex still listening'); }
  catch(e) { if(e.message === 'Threadex still listening') throw e; }
  console.log('Stopping source containers cleanly');
  old('stop', '--time', '120', ...names);
  for (const s of specs) {
    for (const m of s.Mounts.filter(m => m.Type === 'volume')) {
      console.log('Copying stopped volume', m.Name);
      await transfer('docker', [...source, 'run', '--rm', '--network', 'none', '--entrypoint', 'tar', '-v', `${m.Name}:/source:ro`, s.Image, '-C', '/source', '-cpf', '-', '.'],
        'wsl', [...wsl, 'run', '--rm', '-i', '--network', 'none', '--entrypoint', 'tar', '-v', `${volumeName(m.Name)}:/target`, s.Image, '-C', '/target', '-xpf', '-']);
      const check = 'cd /check && find . -type f -exec sha256sum {} + | sort | sha256sum';
      const before = old('run', '--rm', '--network', 'none', '--entrypoint', 'sh', '-v', `${m.Name}:/check:ro`, s.Image, '-c', check);
      const after = dest('run', '--rm', '--network', 'none', '--entrypoint', 'sh', '-v', `${volumeName(m.Name)}:/check:ro`, s.Image, '-c', check);
      if(before !== after) throw new Error(`Volume checksum mismatch: ${m.Name}`);
      console.log('Verified volume SHA256', m.Name, after);
    }
    const args = ['create', '--name', s.Name.slice(1), '--restart', s.HostConfig.RestartPolicy.Name, '--shm-size', String(s.HostConfig.ShmSize)];
    if(s.HostConfig.Memory) args.push('--memory', String(s.HostConfig.Memory));
    if(s.HostConfig.NanoCpus) args.push('--cpus', String(s.HostConfig.NanoCpus/1e9));
    for(const [k,v] of Object.entries(s.Config.Labels || {})) args.push('--label', `${k}=${v}`);
    for(const e of s.Config.Env || []) args.push('-e', e);
    for(const [port, bindings] of Object.entries(s.HostConfig.PortBindings || {})) for(const b of bindings) args.push('-p', `${b.HostIp || '127.0.0.1'}:${b.HostPort}:${port}`);
    for(const m of s.Mounts) {
      const src = m.Type === 'volume' ? volumeName(m.Name) : m.Source.replace(/^([A-Za-z]):[\\/]/, (_,d) => `/mnt/${d.toLowerCase()}/`).replaceAll('\\','/');
      args.push('-v', `${src}:${m.Destination}${m.RW ? '' : ':ro'}`);
    }
    args.push(s.Image, ...(s.Config.Cmd || []));
    dest(...args);
  }
  console.log('Stopping Docker Desktop to release backend memory');
  run('docker', ['desktop', 'stop', '--timeout', '120']);
  dest('start', ...names);
  for(let i=0; i<60; i++) {
    try { dest('exec', names[0], 'pg_isready', '-U', 'threadex', '-d', 'threadex'); break; }
    catch(e) { if(i===59) throw e; await sleep(1000); }
  }
  process.env.SESSION_DOCKER_WSL_DISTRO = 'Ubuntu-24.04';
  process.env.SESSION_PG_VOLUME = volumeName('threadex-pg-data');
  dest('ps');
  run(process.execPath, [`${root}/scripts/pg-dev.mjs`, 'start']);
  migrated = true;
  console.log('Starting Threadex', background(`${root}/scripts/serve-wsl.mjs`, 'threadex'));
  for(let i=0;i<90;i++) {
    try { const r=await fetch('http://127.0.0.1:5173/api/health'); if(r.ok) { console.log('COMPLETE', await r.text()); process.exit(0); } } catch {}
    await sleep(1000);
  }
  throw new Error('Threadex health timeout');
} catch(e) {
  console.error('MIGRATION FAILED', e);
  if(stopped && !migrated) {
    try {
      for(const n of names) { try { dest('stop', n); } catch {} }
      run('docker', ['context', 'use', 'desktop-linux']);
      run('docker', ['desktop', 'start']);
      old('start', ...names);
      delete process.env.SESSION_DOCKER_WSL_DISTRO;
      delete process.env.SESSION_PG_VOLUME;
      background(`${root}/scripts/serve.mjs`, 'rollback-threadex');
      console.log('Rolled back to original volumes and restarted Threadex');
    } catch(r) { console.error('ROLLBACK FAILED', r); }
  }
  process.exitCode=1;
}
