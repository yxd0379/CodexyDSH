import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { remoteRuntimeFileIncluded } from './build-remote-server.ts'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

describe('Linux ARM64 Remote server materialization', () => {
  it('omits other-platform PTY files and the nested server archive', () => {
    const root = '/build/deployed'
    expect(remoteRuntimeFileIncluded(root + '/node_modules/node-pty/prebuilds/darwin-arm64', root)).toBe(false)
    expect(remoteRuntimeFileIncluded(root + '/node_modules/node-pty/prebuilds/linux-arm64', root)).toBe(true)
    expect(remoteRuntimeFileIncluded(root + '/node_modules/node-pty/build/Release', root)).toBe(false)
    expect(remoteRuntimeFileIncluded(root + '/node_modules/@codexydsh/remote/server', root)).toBe(false)
    expect(remoteRuntimeFileIncluded(root + '/node_modules/@codexydsh/remote/lib/index.js', root)).toBe(true)
  })

  it('accepts actual ARM64 ELF addons rather than trusting an architecture folder name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codexydsh-remote-materialize-'))
    directories.push(root)
    const path = join(root, 'addon.node')
    const elf = Buffer.alloc(24)
    elf.set([0x7f, 0x45, 0x4c, 0x46])
    elf.writeUInt16LE(183, 18)
    await writeFile(path, elf)
    expect(remoteRuntimeFileIncluded(path, root)).toBe(true)
    elf.writeUInt16LE(62, 18)
    await writeFile(path, elf)
    expect(remoteRuntimeFileIncluded(path, root)).toBe(false)
    await writeFile(path, Buffer.alloc(24, 0xcf))
    expect(remoteRuntimeFileIncluded(path, root)).toBe(false)
  })
})
