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
const { target, networkEnv = {}, timeoutMs, maxOutputBytes, readinessPollMs, probeTimeoutMs } = request;
const network = createHash('sha256').update(JSON.stringify(networkEnv)).digest('hex');
const inheritedNetwork = createHash('sha256').update('{}').digest('hex');
// One Host per profile, independent of SSH alias or the installed release path.
const key = createHash('sha256').update(target.profile).digest('hex');
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
  try {
    lock = await open(lockPath, 'wx', 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
  }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = JSON.parse(await readFile(lockPath, 'utf8'));
    if (Number.isSafeInteger(owner.pid) && !alive(owner.pid)) {
      await rename(lockPath, lockPath + '.interrupted-' + randomUUID());
      continue;
    }
    if (Date.now() >= deadline) throw new Error('Another remote launch is still in progress: ' + lockPath);
    await delay(readinessPollMs, undefined, { signal: lifetime.signal });
  }
}
try {
  let state = await stored();
  if (state?.dsh && (state.dsh !== target.dsh || (state.network ?? inheritedNetwork) !== network) && alive(state.pid)) {
    console.error('DSH_REMOTE_PROGRESS 服务端版本或网络配置已变更，检查空闲后重启');
    const argv = (await readFile('/proc/' + state.pid + '/cmdline', 'utf8')).split('\0');
    const executable = state.dsh.replace(/\/launch-dsh$/, '/bin/dsh');
    if ((!argv.includes(state.dsh) && !argv.includes(executable)) || !argv.includes(target.profile)) throw new Error('Remote process identity changed; reconnect after stopping the old Host');
    if (state.url) {
      const auth = await fetch(state.url, { redirect: 'manual', signal: lifetime.signal });
      await auth.body?.cancel();
      const cookie = auth.headers.get('set-cookie')?.split(';')[0];
      if (!cookie) throw new Error('Cannot check running remote tasks before updating');
      const url = new URL('/api/session/list', state.url);
      const response = await fetch(url, { method: 'POST', signal: lifetime.signal,
        headers: { cookie, origin: url.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'remote-update', method: 'session/list', payload: { args: { _request: {} } } }),
      });
      const result = await response.json();
      if (!result.result?.ok || !Array.isArray(result.result.value?.items)) throw new Error('Cannot check running remote tasks before updating');
      if (result.result.value.items.some(item => item.running)) throw new Error('远端任务仍在运行，请完成后再连接以应用服务端或网络配置更新。');
    }
    process.kill(state.pid, 'SIGTERM');
    while (alive(state.pid)) {
      if (Date.now() >= deadline) throw new Error('Previous remote Host is still stopping');
      await delay(readinessPollMs, undefined, { signal: lifetime.signal });
    }
    state = undefined;
  }
  if (state?.url && alive(state.pid) && await authorized(state.url)) {
    console.error('DSH_REMOTE_PROGRESS 复用运行中的远端 DSH（PID ' + state.pid + '）');
    console.log('DSH_REMOTE_READY ' + JSON.stringify({ url: state.url }));
  } else {
    if (state === undefined || !alive(state.pid)) {
      const log = await open(logPath, 'w', 0o600);
      let child;
      try {
        const args = ['--profile', target.profile, '--no-open', '--host', '127.0.0.1', '--port', '0'];
        console.error('DSH_REMOTE_PROGRESS 启动命令：' + [target.dsh, ...args].map(value => JSON.stringify(value)).join(' '));
        child = spawn(target.dsh, args, {
          cwd: target.directory || homedir(), detached: true,
          stdio: ['ignore', log.fd, log.fd], env: { ...process.env, ...networkEnv, NODE_OPTIONS: '', NODE_PATH: '' },
        });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        state = { version: 1, pid: child.pid, url: null, dsh: target.dsh, network };
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
