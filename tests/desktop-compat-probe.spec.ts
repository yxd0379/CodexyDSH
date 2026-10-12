/** Probe safety helpers never disclose launch credentials or disturb an occupied listener. */
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { expect, it, onTestFinished } from 'vitest'
import { requireAvailablePort, sanitizedDiagnostic, verifyDesktopHost } from './fixtures/desktop-compat.mjs'

it('removes URL queries and credential fragments from reported diagnostics', () => {
  const result = sanitizedDiagnostic('failed http://127.0.0.1:19387/?authToken=secret authToken=secret cookie=signed authorization=Bearer-secret Authorization: Bearer second-secret apiKey: "third-secret" password=last-secret')
  expect(result).not.toContain('secret')
  expect(result).toContain('http://127.0.0.1:19387/')
  expect(result).not.toContain('authToken=')
})

it('rejects an occupied loopback port without closing the existing listener', async () => {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(() => new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))))
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('missing fixture address')
  await expect(requireAvailablePort(address.port)).rejects.toThrow('is occupied')
  expect(server.listening).toBe(true)
})

it('rejects a persistent product home before starting an application process', async () => {
  await expect(verifyDesktopHost('/does/not/exist.app', process.cwd())).rejects.toThrow('requires an existing temporary DSH home')
})

it('rejects an uninitialized temporary desktop profile before starting an application', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codexy-desktop-probe-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await expect(verifyDesktopHost('/does/not/exist.app', root)).rejects.toMatchObject({ code: 'ENOENT' })
  await mkdir(join(root, 'profiles/desktop'), { recursive: true })
  await writeFile(join(root, 'profiles/desktop/package.json'), '{}')
  await expect(verifyDesktopHost('/does/not/exist.app', root)).rejects.toThrow('cannot resolve the installed desktop executable')
})
