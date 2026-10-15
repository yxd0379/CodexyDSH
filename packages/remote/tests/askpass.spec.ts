/** Passwords, key passphrases, OTP retries, and cancellation use only the local askpass pipe. */
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createSshAuthentication, type SshAuthentication } from '../src/askpass.ts'
import { launchRemote, type TransportOptions } from '../src/transport.ts'
import { sshFixture } from './ssh-fixture.ts'

function invoke(auth: SshAuthentication, prompt: string) {
  const child = spawn(auth.env.SSH_ASKPASS!, [prompt], { env: { ...process.env, ...auth.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => { resolve({ code, stdout, stderr }) })
  })
  onTestFinished(() => { child.kill('SIGKILL') })
  return done
}

const limits: Omit<TransportOptions, 'ssh'> = { connectTimeoutMs: 5000, startupTimeoutMs: 5000, stopTimeoutMs: 500,
  maxOutputBytes: 65_536, serverAliveSeconds: 10, serverAliveCount: 3, readinessPollMs: 10 }

describe.skipIf(process.platform === 'win32')('OpenSSH askpass authentication', () => {
  it('handles passwords, key passphrases, and repeated OTP challenges without storing responses', async () => {
    const answers = ['password-private-1', 'key-passphrase-private-2', 'incorrect-otp-3', 'correct-otp-4']
    const prompts = ['remote password:', 'Enter passphrase for key:', 'Verification code:', 'Verification code:']
    const callback = vi.fn(async (_prompt: string, _signal: AbortSignal) => answers[callback.mock.calls.length - 1]!)
    const auth = await createSshAuthentication(callback, new AbortController().signal)
    onTestFinished(() => auth.close())
    const root = dirname(auth.env.SSH_ASKPASS!)
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(auth.env.CODEXY_SSH_AUTH_SOCKET!)).mode & 0o777).toBe(0o600)
    for (const [index, prompt] of prompts.entries()) {
      expect(await invoke(auth, prompt)).toEqual({ code: 0, stdout: `${answers[index]}\n`, stderr: '' })
      expect(callback.mock.calls[index]?.[0]).toBe(prompt)
    }
    const files = await Promise.all((await readdir(root)).filter(file => file !== 'prompt.sock').map(file => readFile(join(root, file), 'utf8')))
    for (const answer of answers) {
      expect(JSON.stringify(auth.env)).not.toContain(answer)
      expect(files.join('\n')).not.toContain(answer)
    }
    expect(auth.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(await readFile(auth.env.SSH_ASKPASS!, 'utf8')).toContain('ELECTRON_RUN_AS_NODE=1 exec')
    await auth.close()
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects unauthorized local socket requests and bounded invalid responses silently', async () => {
    const callback = vi.fn(async () => 'invalid\nresponse')
    const auth = await createSshAuthentication(callback, new AbortController().signal)
    onTestFinished(() => auth.close())
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(auth.env.CODEXY_SSH_AUTH_SOCKET!)
      socket.once('error', reject)
      socket.once('connect', () => { socket.write(JSON.stringify({ challenge: 'wrong', prompt: 'password:' }) + '\n') })
      socket.once('close', () => { resolve() })
    })
    expect(callback).not.toHaveBeenCalled()
    expect(await invoke(auth, 'password:')).toEqual({ code: 1, stdout: '', stderr: '' })
    expect(await invoke(auth, 'x'.repeat(4097))).toEqual({ code: 1, stdout: '', stderr: '' })
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('cancels active prompts, ends the helper, and removes the socket and owned scripts', async () => {
    const controller = new AbortController()
    let promptSignal: AbortSignal | undefined
    const auth = await createSshAuthentication(async (_prompt, signal) => {
      promptSignal = signal
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
      })
    }, controller.signal)
    onTestFinished(() => auth.close())
    const result = invoke(auth, 'One-time password:')
    await vi.waitFor(() => { expect(promptSignal).toBeDefined() })
    controller.abort(new Error('cancel authentication'))
    await auth.close()
    expect(promptSignal?.aborted).toBe(true)
    expect(await result).toEqual({ code: 1, stdout: '', stderr: '' })
    await expect(stat(auth.env.CODEXY_SSH_AUTH_SOCKET!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('enables interactive OpenSSH only for an owned authentication helper and preserves host verification', async () => {
    const auth = await createSshAuthentication(async () => 'not-requested', new AbortController().signal)
    onTestFinished(() => auth.close())
    const ssh = await sshFixture({ url: 'http://127.0.0.1:12345/?token=remote-token' })
    onTestFinished(() => ssh.close())
    const target = { host: 'example', deployment: 'existing' as const, profile: 'codexy', directory: '', node: 'node', dsh: 'dsh' }
    await launchRemote(target, { ...limits, ssh: ssh.executable, auth: auth.env }, new AbortController().signal)
    await launchRemote(target, { ...limits, ssh: ssh.executable }, new AbortController().signal)
    const calls = await ssh.calls()
    expect(calls[0]).toContain('BatchMode=no')
    expect(calls[1]).toContain('BatchMode=yes')
    for (const args of calls) {
      expect(args).toContain('StrictHostKeyChecking=yes')
      expect(args).toContain('ForwardAgent=no')
      expect(args.join(' ')).not.toContain('not-requested')
      expect(args.join(' ')).not.toContain(auth.env.CODEXY_SSH_AUTH_CHALLENGE)
    }
  })

  it('passes the broker only to SSH and answers simulated password and OTP retries through askpass', async () => {
    const prompts = ['Password:', 'Verification code:', 'Verification code:']
    const responses = ['private-password', '123456', '654321']
    const callback = vi.fn(async (_prompt: string) => responses[callback.mock.calls.length - 1]!)
    const auth = await createSshAuthentication(callback, new AbortController().signal)
    onTestFinished(() => auth.close())
    const root = await mkdtemp(join(tmpdir(), 'codexy-askpass-ssh-test-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const executable = join(root, 'ssh')
    const hashes = responses.map(response => createHash('sha256').update(response).digest('hex'))
    await writeFile(executable, `#!${process.execPath}\n` + String.raw`
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const digest = value => createHash('sha256').update(value).digest('hex');
const prompts = ${JSON.stringify(prompts)};
const hashes = ${JSON.stringify(hashes)};
if (!process.argv.includes('BatchMode=no') || process.env.SSH_ASKPASS_REQUIRE !== 'force') process.exit(2);
if (Object.values(process.env).some(value => hashes.includes(digest(value)))) process.exit(3);
for (const [index, prompt] of prompts.entries()) {
  const result = spawnSync(process.env.SSH_ASKPASS, [prompt], { env: process.env, encoding: 'utf8' });
  if (result.status !== 0 || result.stderr || digest(result.stdout.trimEnd()) !== hashes[index]) process.exit(4);
}
process.stdout.write('DSH_REMOTE_READY ' + JSON.stringify({ url: 'http://127.0.0.1:12345/?token=remote-token' }) + '\n');
`, { mode: 0o700 })
    const target = { host: 'example', deployment: 'existing' as const, profile: 'codexy', directory: '', node: 'node', dsh: 'dsh' }
    await expect(launchRemote(target, { ...limits, ssh: executable, auth: auth.env }, new AbortController().signal)).resolves.toBeInstanceOf(URL)
    expect(callback.mock.calls.map(([prompt]) => prompt)).toEqual(prompts)
    const script = await readFile(executable, 'utf8')
    for (const response of responses) expect(script).not.toContain(response)
  })
})
