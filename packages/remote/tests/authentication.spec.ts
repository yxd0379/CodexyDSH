/** Real askpass IPC, typed Host challenges, retries, and cancellation ownership. */
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import RemoteLauncher from '../src/index.ts'
import type { RemoteHostStatus } from '../src/types.ts'
import { sshFixture } from './ssh-fixture.ts'

async function fixture(prompts = ['Password:', 'Verification code:']) {
  const root = await mkdtemp(join(tmpdir(), 'codexy-auth-manager-test-'))
  const server = createServer((_request, response) => { response.writeHead(303); response.end() })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Authentication test server has no port')
  const ssh = await sshFixture({ url: `http://127.0.0.1:${address.port}/?token=fixture` })
  const executable = join(root, 'ssh-auth')
  await writeFile(executable, `#!${process.execPath}\nconst fixture = ${JSON.stringify(ssh.executable)};\nconst prompts = ${JSON.stringify(prompts)};\n` + String.raw`
const { spawn } = require('node:child_process');
let owned;
process.once('SIGTERM', () => { owned?.kill('SIGTERM'); });
function run(command, args, capture) {
  return new Promise((resolve, reject) => {
    const child = owned = spawn(command, args, { stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'inherit', env: process.env });
    let response = '';
    if (capture) child.stdout.on('data', bytes => { response += bytes.toString('utf8'); });
    child.once('error', () => reject(new Error('Authentication fixture command failed')));
    child.once('close', code => { owned = undefined; code === 0 ? resolve(response) : reject(new Error('SSH authentication failed')); });
  });
}
(async () => {
  const args = process.argv.slice(2);
  if (!args.includes('-N')) {
    for (const prompt of prompts) {
      const response = await run(process.env.SSH_ASKPASS, [prompt], true);
      if (!response.trim()) throw new Error('SSH authentication failed');
    }
  }
  await run(fixture, args, false);
})().catch(error => { console.error(error.message); process.exitCode = 255; });
`, { mode: 0o700 })
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    await ssh.close()
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(TypertRegistry).await()
  const fiber = ctx.plugin(RemoteLauncher, {
    ssh: executable, connectTimeoutMs: 10000, startupTimeoutMs: 15000, stopTimeoutMs: 1000, readinessPollMs: 10,
    hosts: { example: { host: 'user@example', deployment: 'existing', profile: 'codexy', directory: '', node: 'node', dsh: 'dsh' } },
  })
  await fiber.await()
  const challenge = async (previous?: string): Promise<NonNullable<RemoteHostStatus['authChallenge']>> => {
    await vi.waitFor(() => {
      const current = ctx.remoteLauncher.list()[0]?.authChallenge
      expect(current).toBeDefined()
      if (previous) expect(current?.id).not.toBe(previous)
    })
    return ctx.remoteLauncher.list()[0]!.authChallenge!
  }
  return { ctx, challenge, fiber }
}

describe.skipIf(process.platform === 'win32')('remote authentication challenges', () => {
  it('follows password and OTP questions, accepts each once, and never projects responses', async () => {
    const f = await fixture()
    const observer = new AbortController()
    const frames = f.ctx.remoteLauncher.follow(observer.signal)[Symbol.asyncIterator]()
    expect((await frames.next()).value?.[0]?.phase).toBe('disconnected')
    const connecting = f.ctx.remoteLauncher.connect('example', new AbortController().signal)
    const failed = connecting.catch(error => { throw error })
    const password = await f.challenge()
    expect((await frames.next()).value?.[0]?.authChallenge).toEqual(password)
    expect(password.prompt).toBe('Password:')
    await expect(f.ctx.remoteLauncher.respondAuthentication('example', 'stale-id', 'discarded')).rejects.toThrow('no longer active')
    const passwordResponse = 'ephemeral-password-123'
    await f.ctx.remoteLauncher.respondAuthentication('example', password.id, passwordResponse)
    const otp = await f.challenge(password.id)
    expect(otp.prompt).toBe('Verification code:')
    await expect(f.ctx.remoteLauncher.respondAuthentication('example', password.id, 'stale-reply')).rejects.toThrow('no longer active')
    await f.ctx.remoteLauncher.respondAuthentication('example', otp.id, '123456')
    expect(await failed).toMatchObject({ phase: 'connected' })
    expect(f.ctx.remoteLauncher.list()[0]).not.toHaveProperty('authChallenge')
    expect(JSON.stringify(f.ctx.remoteLauncher.list())).not.toContain(passwordResponse)
    expect(JSON.stringify(f.fiber.config)).not.toContain(passwordResponse)
    await f.ctx.remoteLauncher.disconnect('example')
    observer.abort()
    await frames.return?.()
    await expect(f.ctx.remoteLauncher.respondAuthentication('example', otp.id, 'late-reply')).rejects.toThrow('no longer active')
  })

  it('cancels a pending question with null and rejects answers from the old attempt', async () => {
    const f = await fixture(['Private key passphrase:'])
    const connecting = f.ctx.remoteLauncher.connect('example', new AbortController().signal).catch(error => error as Error)
    const first = await f.challenge()
    await f.ctx.remoteLauncher.respondAuthentication('example', first.id, null)
    expect((await connecting).message).toContain('cancelled')
    expect(f.ctx.remoteLauncher.list()).toMatchObject([{ phase: 'disconnected' }])
    expect(f.ctx.remoteLauncher.list()[0]).not.toHaveProperty('authChallenge')
    const retry = f.ctx.remoteLauncher.connect('example', new AbortController().signal).catch(error => error as Error)
    const next = await f.challenge(first.id)
    await expect(f.ctx.remoteLauncher.respondAuthentication('example', first.id, 'old-attempt')).rejects.toThrow('no longer active')
    await f.ctx.remoteLauncher.respondAuthentication('example', next.id, null)
    await retry
  })

  it('clears a pending challenge on disconnect and does not accept invalid responses', async () => {
    const f = await fixture(['Password:'])
    const connecting = f.ctx.remoteLauncher.connect('example', new AbortController().signal).catch(error => error as Error)
    const question = await f.challenge()
    await expect(f.ctx.remoteLauncher.respondAuthentication('example', question.id, 'invalid\nresponse')).rejects.toThrow('Invalid SSH authentication response')
    expect(f.ctx.remoteLauncher.list()[0]?.authChallenge?.id).toBe(question.id)
    await f.ctx.remoteLauncher.disconnect('example')
    expect((await connecting).message).toContain('closed')
    expect(f.ctx.remoteLauncher.list()[0]).not.toHaveProperty('authChallenge')
  })
})
