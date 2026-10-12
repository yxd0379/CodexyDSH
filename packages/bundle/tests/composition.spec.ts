import { closeSync, openSync } from 'node:fs'
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

const fixtures: string[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function dumpProfile(bundles: string[], patches: string[]): Promise<EntryOptions[]> {
    const home = await mkdtemp(join(tmpdir(), 'codexy-composition-'))
    fixtures.push(home)
    const profile = join(home, 'profiles', 'codexy')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'codexy-composition-test', private: true,
      dsh: { profile: { bundles } },
    }))
    await writeFile(join(profile, 'cordis.yml'), '[]\n')
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
    const root = fileURLToPath(new URL('../../../', import.meta.url))
    const cli = join(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json'))), 'lib', 'bin.js')
    const output = join(home, 'dump.yml')
    const diagnostics = join(home, 'diagnostics.txt')
    const stdout = openSync(output, 'w')
    const stderr = openSync(diagnostics, 'w')
    try {
      execFileSync(process.execPath, [cli, '--profile', 'codexy',
        ...patches.flatMap(patch => ['--patch', join(root, patch)]), '--dump-config'], {
        cwd: root, env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', stdout, stderr], timeout: 20_000,
      })
    } finally { closeSync(stdout); closeSync(stderr) }
    expect(await readFile(diagnostics, 'utf8')).toBe('')
    return yaml.load(await readFile(output, 'utf8'), { schema: entryListSchema }) as EntryOptions[]
}

describe('Codexy profile composition with the released DSH CLI', () => {
  it('activates independent product rows and disables every replaced platform row without skipped patches', async () => {
    const entries = await dumpProfile(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      ['packages/bundle/cordis.patch.yml', 'packages/web/cordis.patch.yml'])
    const byId = new Map(entries.map(entry => [entry.id, entry]))
    for (const packageName of [
      'agent-loop', 'tools', 'session-persistence-jsonl', 'llm-pi-ai', 'llm-deepseek', 'llm-retry',
      'sandbox', 'subprocess', 'approval', 'permission', 'subagent', 'subagent-spawn-in-process',
      'subagent-fork-in-process', 'tool-bash', 'tool-fs', 'agent-instructions', 'tool-todo',
      'compaction-basic', 'token-meter', 'tool-skill', 'skill-filesystem', 'api-remotes',
      'ui-chat', 'ui-conversation', 'ui-commands', 'ui-input-trigger', 'ui-skill', 'ui-approval',
      'ui-permission', 'ui-deliverables', 'ui-tool', 'ui-trajectory', 'session-controller',
    ]) {
      expect(byId.get(packageName)?.disabled, packageName).toBe(true)
      const product = byId.get(`codexy-${packageName}`)
      expect(product?.name.startsWith('@codexydsh/'), packageName).toBe(true)
      expect(product?.disabled, packageName).not.toBe(true)
    }
    const factories = entries.filter(entry => !entry.disabled && ['@deepseek-ai/dsh-agent-loop', '@codexydsh/runtime'].includes(entry.name))
    expect(factories.map(entry => entry.name)).toEqual(['@codexydsh/runtime'])
    expect(byId.get('codexy-subagent-spawn-in-process')?.config).toEqual({ providerName: 'spawn' })
    expect(byId.get('codexy-subagent-fork-in-process')?.config).toEqual({ providerName: 'fork', codexfulHistory: true })
    expect(byId.get('codexy-token-meter')?.config).toEqual({ preferProviderUsage: true })
    expect(byId.get('codexy-approval')?.config).toEqual(byId.get('approval')?.config)
    expect(byId.get('codexy-remote')?.name).toBe('@codexydsh/remote')
    expect(byId.get('codexy-schedule')?.name).toBe('@codexydsh/schedule')
    expect(byId.get('schedule')?.name).toBe('@deepseek-ai/dsh-schedule')
    expect(byId.get('schedule')?.disabled).not.toBe(true)
    expect(byId.get('codexy-ui-settings')?.name).toBe('@codexydsh/ui-settings')
    expect(byId.get('workflow-ptc')?.disabled).toBe(true)
    expect(byId.get('deepseek-llm-api-extensions')?.disabled).toBe(true)
    expect(byId.get('codexy-deepseek-extensions')?.name).toBe('@codexydsh/deepseek-extensions')
    expect(byId.get('codexy-permission')?.config).toMatchObject({ presets: { 'read-only': { sandbox: 'read-only', approval: 'ask' }, 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' }, 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } } })
  })

  it('replaces both headless plugins while retaining the startup-backed runner configuration', async () => {
    const entries = await dumpProfile(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
      ['packages/bundle/cordis.patch.yml', 'packages/headless/cordis.patch.yml'])
    const byId = new Map(entries.map(entry => [entry.id, entry]))
    for (const id of ['headless-startup', 'headless-runner']) {
      expect(byId.get(id)?.disabled, id).toBe(true)
      expect(byId.get(`codexy-${id}`)?.disabled, id).not.toBe(true)
    }
    expect(byId.get('codexy-schedule')?.name).toBe('@codexydsh/schedule')
    expect(byId.get('codexy-headless-startup')?.name).toBe('@codexydsh/headless/startup')
    expect(byId.get('codexy-headless-runner')?.name).toBe('@codexydsh/headless')
    expect(byId.get('codexy-headless-runner')?.inject).toEqual(['headlessStartup'])
    expect(byId.get('workflow-ptc')?.disabled).toBe(true)
    const productConfig = byId.get('codexy-headless-runner')?.config as Record<string, { source: string }>
    const platformConfig = byId.get('headless-runner')?.config as Record<string, { source: string }>
    for (const key of ['task', 'sessionId', 'json']) {
      expect(productConfig[key]).toEqual(platformConfig[key])
    }
    const factories = entries.filter(entry => !entry.disabled && ['@deepseek-ai/dsh-agent-loop', '@codexydsh/runtime'].includes(entry.name))
    expect(factories.map(entry => entry.name)).toEqual(['@codexydsh/runtime'])
    expect(entries.some(entry => !entry.disabled && entry.name === '@codexydsh/api-session-controller')).toBe(false)
  })

  it('ships every declared product bundle patch and exports its exact file', async () => {
    const packagesRoot = fileURLToPath(new URL('../../', import.meta.url))
    const bundles: string[] = []
    for (const folder of await readdir(packagesRoot, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue
      const packageRoot = join(packagesRoot, folder.name)
      const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
        name: string; files?: string[]; exports?: Record<string, string | object>; dsh?: { bundle?: { patch: string } }
      }
      const patch = manifest.dsh?.bundle?.patch
      if (patch === undefined) continue
      bundles.push(manifest.name)
      await access(join(packageRoot, patch))
      expect(manifest.files, manifest.name).toContain(patch.replace(/^\.\//, ''))
      expect(manifest.exports?.[patch], manifest.name).toBe(patch)
    }
    expect(bundles).toContain('@codexydsh/headless')
  })
})
