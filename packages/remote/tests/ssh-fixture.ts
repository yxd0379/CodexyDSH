/** Owned local replacement for the external OpenSSH executable. */
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'

/** Allocate a private SSH fixture which executes the real bootstrap or returns a supplied external server.
 * @param options - Remote environment and optional ready server URL.
 * @returns fixture executable, owned files, and joined cleanup.
 */
export async function sshFixture(options: {
  env?: Record<string, string>
  url?: string
  responses?: { output?: string; error?: string; code?: number; input?: boolean; pending?: boolean }[]
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codexy-remote-test-')))
  const executable = join(root, 'ssh')
  await writeFile(join(root, 'config.json'), JSON.stringify(options))
  await writeFile(executable, `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');
const root = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(args) + '\n');
const destination = args[args.indexOf('--') + 1];
if (destination === 'unreachable') { console.error('SSH refused http://127.0.0.1:1/?token=private-token'); process.exit(255); }
if (destination === 'pending') {
  fs.writeFileSync(path.join(root, 'pending'), String(process.pid));
  setInterval(() => {}, 1000);
} else if (args.includes('-N')) {
  const forward = args[args.indexOf('-L') + 1];
  const match = /^(.*):127\.0\.0\.1:([0-9]+)$/.exec(forward);
  if (!match || args.some((value, index) => value === 'ClearAllForwardings=yes' && index < args.indexOf('-L'))) process.exit(2);
  const sockets = new Set();
  const server = net.createServer(socket => {
    const remote = net.connect(Number(match[2]), '127.0.0.1');
    for (const stream of [socket, remote]) {
      sockets.add(stream);
      stream.on('error', () => { socket.destroy(); remote.destroy(); });
      stream.once('close', () => sockets.delete(stream));
    }
    socket.pipe(remote).pipe(socket);
  });
  server.listen(match[1], () => fs.writeFileSync(path.join(root, 'forward'), String(process.pid)));
  process.once('SIGTERM', () => { for (const socket of sockets) socket.destroy(); server.close(); });
} else if (config.responses) {
  const indexPath = path.join(root, 'response-index');
  const index = fs.existsSync(indexPath) ? Number(fs.readFileSync(indexPath, 'utf8')) : 0;
  fs.writeFileSync(indexPath, String(index + 1));
  const response = config.responses[index];
  if (!response) { console.error('Unexpected SSH fixture command'); process.exit(2); }
  const finish = () => {
    if (response.output) process.stdout.write(response.output);
    if (response.error) process.stderr.write(response.error);
    if (response.pending) {
      fs.writeFileSync(path.join(root, 'pending'), String(process.pid));
      setInterval(() => {}, 1000);
    } else process.exitCode = response.code ?? 0;
  };
  if (response.input) {
    const upload = fs.createWriteStream(path.join(root, 'upload-' + index + '.tar.gz'));
    process.stdin.pipe(upload);
    upload.once('finish', finish);
  } else finish();
} else if (config.url) {
  console.log('DSH_REMOTE_READY ' + JSON.stringify({ url: config.url }));
} else {
  const child = spawn('/bin/sh', ['-c', args.at(-1)], { stdio: 'inherit', env: { ...process.env, ...config.env } });
  process.once('SIGTERM', () => child.kill('SIGTERM'));
  child.once('close', code => { process.exitCode = code ?? 1; });
}
`, { mode: 0o700 })
  return {
    root, executable,
    async calls(): Promise<string[][]> {
      return (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    },
    async close(): Promise<void> { await rm(root, { recursive: true, force: true }) },
  }
}

/** Observe that an allocated forwarding endpoint refuses new connections.
 * @param port - formerly listening local port.
 * @returns after the operating system refuses a connection.
 */
export async function refusesConnections(port: number): Promise<boolean> {
  const { createConnection } = await import('node:net')
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    socket.once('error', () => { resolve(true) })
    socket.once('connect', () => { socket.destroy(); resolve(false) })
  })
}

/** Allocate a private directory with a Node-compatible fake dsh that exposes launch authentication.
 * @returns remote environment, executable, and cleanup observing the server's exit.
 */
export async function fakeRemoteDsh() {
  // Node's cwd and CommonJS __dirname are canonical, including macOS's /var alias.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codexy-remote-runtime-')))
  const executable = join(root, 'dsh')
  const observer = createServer()
  await new Promise<void>((resolve, reject) => {
    observer.once('error', reject)
    observer.listen(0, '127.0.0.1', () => { observer.removeListener('error', reject); resolve() })
  })
  const address = observer.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture observer has no TCP address')
  const exited = Promise.withResolvers<undefined>()
  let connected: Socket | undefined
  observer.once('connection', (socket) => { socket.once('close', () => { exited.resolve(undefined) }); connected = socket })
  await writeFile(executable, `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const http = require('node:http');
const socket = require('node:net').connect(Number(process.env.DSH_REMOTE_OBSERVER), '127.0.0.1');
fs.writeFileSync(path.join(root, 'argv.json'), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(path.join(root, 'cwd.txt'), process.cwd());
const server = http.createServer((req, res) => {
  if (req.url === '/?token=remote-secret') { res.writeHead(303, { Location: './' }); res.end(); }
  else { res.writeHead(200); res.end('remote files and sessions'); }
});
server.listen(0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=remote-secret'));
socket.once('data', () => { server.close(() => { socket.end(); }); });
`, { mode: 0o700 })
  return {
    root, executable, env: { DSH_HOME: join(root, '.dsh'), DSH_REMOTE_OBSERVER: String(address.port) },
    async close(): Promise<void> {
      if (connected) { connected.write('stop'); await exited.promise }
      await new Promise<void>((resolve) => { observer.close(() => { resolve() }) })
      await rm(root, { recursive: true, force: true })
    },
  }
}
