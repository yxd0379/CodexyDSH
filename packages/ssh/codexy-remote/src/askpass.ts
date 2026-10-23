/** Per-connection OpenSSH prompts carried over a private local socket. */
import { randomBytes } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Request one password, passphrase, or keyboard-interactive response. */
export type SshAuthenticationPrompt = (prompt: string, signal: AbortSignal) => Promise<string>

/** Environment for SSH children and the joined lifetime of their local prompt broker. */
export interface SshAuthentication {
  env: Record<string, string>
  close(): Promise<void>
}

const maxTextBytes = 4096
const maxFrameBytes = 16_384
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

// SSH launches this program with the prompt in argv. Authentication responses
// travel only from the private socket to its stdout pipe, never through files.
const helper = String.raw`
import { createConnection } from 'node:net';
const fail = () => { process.exitCode = 1; socket.destroy(); };
const socket = createConnection(process.env.CODEXY_SSH_AUTH_SOCKET);
let bytes = Buffer.alloc(0);
process.stdout.on('error', fail);
socket.on('error', fail);
socket.once('connect', () => {
  const prompt = process.argv[2] ?? '';
  if (Buffer.byteLength(prompt) > 4096) { fail(); return; }
  socket.write(JSON.stringify({ challenge: process.env.CODEXY_SSH_AUTH_CHALLENGE, prompt }) + '\n');
});
socket.on('data', chunk => {
  bytes = Buffer.concat([bytes, chunk]);
  if (bytes.length > 16384) { fail(); return; }
  const end = bytes.indexOf(10);
  if (end < 0) return;
  try {
    const value = JSON.parse(bytes.subarray(0, end).toString('utf8'));
    if (typeof value.response !== 'string' || Buffer.byteLength(value.response) > 4096 || /[\0\r\n]/u.test(value.response)) { fail(); return; }
    process.stdout.write(value.response + '\n');
    socket.end();
  } catch { fail(); }
});
socket.once('end', () => { if (!bytes.includes(10)) process.exitCode = 1; });
`

/** Create an OpenSSH askpass broker without retaining authentication responses.
 * @param callback - In-memory UI exchange for each OpenSSH prompt, including retries.
 * @param signal - Connection cancellation; active prompts and sockets close together.
 * @returns SSH-only helper environment and idempotent cleanup.
 */
export async function createSshAuthentication(callback: SshAuthenticationPrompt, signal: AbortSignal): Promise<SshAuthentication> {
  signal.throwIfAborted()
  if (process.platform === 'win32') throw new Error('SSH authentication prompts currently require Linux or macOS')
  const root = await mkdtemp(join(tmpdir(), 'codexy-ssh-auth-'))
  const socketPath = join(root, 'prompt.sock')
  const executable = join(root, 'askpass')
  const module = join(root, 'askpass.mjs')
  const challenge = randomBytes(32).toString('hex')
  const lifetime = new AbortController()
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    const promptLifetime = new AbortController()
    socket.once('close', () => { sockets.delete(socket); promptLifetime.abort(new Error('SSH authentication prompt closed')) })
    socket.on('error', () => { socket.destroy() })
    let bytes = Buffer.alloc(0)
    let requested = false
    socket.on('data', chunk => {
      if (requested) { socket.destroy(); return }
      bytes = Buffer.concat([bytes, chunk])
      if (bytes.length > maxFrameBytes) { socket.destroy(); return }
      const end = bytes.indexOf(10)
      if (end < 0) return
      requested = true
      let request: unknown
      try { request = JSON.parse(bytes.subarray(0, end).toString('utf8')) }
      catch { socket.destroy(); return }
      bytes = Buffer.alloc(0)
      if (request === null || typeof request !== 'object' || !('challenge' in request) || request.challenge !== challenge
        || !('prompt' in request) || typeof request.prompt !== 'string' || Buffer.byteLength(request.prompt) > maxTextBytes) {
        socket.destroy(); return
      }
      const prompt = request.prompt
      const promptSignal = AbortSignal.any([lifetime.signal, promptLifetime.signal])
      void Promise.resolve().then(() => {
        promptSignal.throwIfAborted()
        return callback(prompt, promptSignal)
      }).then(response => {
        promptSignal.throwIfAborted()
        if (typeof response !== 'string' || Buffer.byteLength(response) > maxTextBytes || /[\0\r\n]/u.test(response)) throw new Error('Invalid SSH authentication response')
        socket.end(JSON.stringify({ response }) + '\n')
      }).catch(() => { socket.destroy() })
    })
  })
  let closing: Promise<void> | undefined
  const aborted = (): void => { void close() }
  const close = (): Promise<void> => closing ??= (async () => {
    signal.removeEventListener('abort', aborted)
    lifetime.abort(new Error('SSH authentication closed'))
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    await rm(root, { recursive: true, force: true })
  })()
  try {
    await writeFile(module, helper, { mode: 0o600 })
    // The assignment affects only the helper, including Electron's Node carrier.
    await writeFile(executable, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(module)} "$@"\n`, { mode: 0o700 })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => { server.removeListener('error', reject); resolve() })
    })
    await chmod(socketPath, 0o600)
    signal.addEventListener('abort', aborted, { once: true })
    signal.throwIfAborted()
    return { env: { SSH_ASKPASS: executable, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || 'codexy-ssh',
      CODEXY_SSH_AUTH_SOCKET: socketPath, CODEXY_SSH_AUTH_CHALLENGE: challenge }, close }
  } catch (error) { await close(); throw error }
}
