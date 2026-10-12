/** POSIX remote startup program, executed by the configured Node through OpenSSH. */

/**
 * Detached dsh startup and reusable, owner-only discovery records. The remote
 * runtime receives only its own environment; local model credentials never enter SSH argv.
 */
export const remoteBootstrap = String.raw`
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';

const request = JSON.parse(process.argv[1]);
const { target, timeoutMs, maxOutputBytes, readinessPollMs, probeTimeoutMs } = request;
const key = createHash('sha256').update(JSON.stringify(target)).digest('hex');
const root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'remote-hosts', key);
await mkdir(root, { recursive: true, mode: 0o700 });
const statePath = join(root, 'launch.json');
const logPath = join(root, 'output.log');
const lockPath = join(root, 'launch.lock');
const deadline = Date.now() + timeoutMs;
const lifetime = new AbortController();
for (const signal of ['SIGTERM', 'SIGHUP']) process.once(signal, () => lifetime.abort(new Error('Remote startup cancelled')));

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function launchUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.pathname !== '/' || !url.searchParams.get('token') || url.username || url.password) {
    throw new Error('Remote dsh did not announce an authenticated loopback URL');
  }
  return url.href;
}
async function stored() {
  let text;
  try { text = await readFile(statePath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const value = JSON.parse(text);
  if (value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || (value.url !== null && typeof value.url !== 'string')) {
    throw new Error('Invalid remote launch record: ' + statePath);
  }
  if (value.url !== null) launchUrl(value.url);
  return value;
}
async function save(value) {
  const path = join(root, randomUUID() + '.json');
  try {
    await writeFile(path, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(path, statePath);
  } finally {
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
async function authorized(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { signal: lifetime.signal, timeout: Math.max(1, Math.min(probeTimeoutMs, deadline - Date.now())) }, response => {
      response.resume();
      resolve(response.statusCode === 303);
    });
    req.on('timeout', () => req.destroy(new Error('Remote readiness probe timed out')));
    req.on('error', error => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') resolve(false);
      else reject(error);
    });
  });
}
async function output() {
  const file = await open(logPath, 'r');
  try {
    const size = (await file.stat()).size;
    const bytes = Buffer.alloc(Math.min(size, maxOutputBytes));
    const result = await file.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    return bytes.subarray(0, result.bytesRead).toString('utf8');
  } finally { await file.close(); }
}

let lock;
while (lock === undefined) {
  lifetime.signal.throwIfAborted();
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (Date.now() >= deadline) throw new Error('Another remote launch is still in progress: ' + lockPath);
    await delay(readinessPollMs, undefined, { signal: lifetime.signal });
  }
}
try {
  let state = await stored();
  if (state?.url && alive(state.pid) && await authorized(state.url)) {
    console.log('DSH_REMOTE_READY ' + JSON.stringify({ url: state.url }));
  } else {
    if (state === undefined || !alive(state.pid)) {
      const log = await open(logPath, 'w', 0o600);
      let child;
      try {
        child = spawn(target.dsh, ['--profile', target.profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
          cwd: target.directory || homedir(), detached: true,
          stdio: ['ignore', log.fd, log.fd], env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
        });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        state = { version: 1, pid: child.pid, url: null };
        child.unref();
        await save(state);
      } finally { await log.close(); }
    }
    for (;;) {
      lifetime.signal.throwIfAborted();
      const text = await output();
      const match = /^dsh web: (http:\/\/127\.0\.0\.1:[0-9]+\/\?token=[^\s]+)/m.exec(text);
      if (match && await authorized(launchUrl(match[1]))) {
        state.url = launchUrl(match[1]);
        await save(state);
        console.log('DSH_REMOTE_READY ' + JSON.stringify({ url: state.url }));
        break;
      }
      if (!alive(state.pid)) throw new Error('Remote dsh exited during startup\n' + text.replace(/([?&]token=)[^\s&)]+/g, '$1[redacted]'));
      if (Date.now() >= deadline) throw new Error('Remote dsh readiness timed out\n' + text.replace(/([?&]token=)[^\s&)]+/g, '$1[redacted]'));
      await delay(readinessPollMs, undefined, { signal: lifetime.signal });
    }
  }
} finally {
  await lock.close();
  await unlink(lockPath);
}
`
