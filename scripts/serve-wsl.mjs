import { spawn } from 'node:child_process';
import net from 'node:net';

process.env.SESSION_DOCKER_WSL_DISTRO = 'Ubuntu-24.04';
process.env.SESSION_PG_VOLUME = 'threadex-pg-data-wsl-final';
// systemd services alone do not keep a WSL instance alive.
const keepAlive = spawn('wsl.exe', ['-d', 'Ubuntu-24.04', '-u', 'root', '--', 'sleep', 'infinity'], { windowsHide: true, stdio: 'ignore' });
keepAlive.on('error', error => { console.error('WSL keepalive failed', error); process.exit(1); });
process.on('exit', () => keepAlive.kill());
// WSL localhost forwarding may become ready after PostgreSQL itself.
let ready = false;
for(let attempt = 0; attempt < 90; attempt++) {
  ready = await new Promise(resolve => {
    const socket = net.connect({host: '127.0.0.1', port: 55432});
    const finish = result => { socket.destroy(); resolve(result); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
  if(ready) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if(!ready) throw new Error('WSL PostgreSQL localhost forwarding did not become ready');
await import('./serve.mjs');
