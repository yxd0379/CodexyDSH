/** Product RPC assembly owns each policy endpoint and unwinds mounts on failure. */
import { Context } from '@deepseek-ai/cordis'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, onTestFinished } from 'vitest'
import { apply } from '../src/client/index.ts'

function fixture(failAt?: string) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const mounted: TypertRemoteContribution[] = []
  const released: string[] = []
  ctx.provide('remote', {
    async $mount(contribution: TypertRemoteContribution) {
      if (contribution.package === failAt) throw new Error('mount refused')
      mounted.push(contribution)
      return async () => { released.push(contribution.package) }
    },
  })
  return { ctx, mounted, released }
}

describe('product Remote contributions', () => {
  it('selects owned permission and delegation descriptors once and releases in reverse order', async () => {
    const f = fixture()
    const dispose = await apply(f.ctx)
    const endpoints = f.mounted.flatMap(contribution => contribution.descriptors)
    const permission = endpoints.filter(entry => entry.namespace === 'permissionPresets')
    const delegation = endpoints.filter(entry => entry.namespace === 'subagents')
    expect(permission).toHaveLength(1)
    expect(permission[0]?.service).toBe('codexyPermissions')
    expect(delegation).toHaveLength(2)
    expect(delegation.every(entry => entry.service === 'codexySubagents')).toBe(true)
    const sessions = f.mounted.filter(entry => entry.package === '@codexydsh/api-session-controller')
    expect(sessions).toHaveLength(1)
    const models = sessions[0]!.descriptors.find(entry => entry.namespace === 'session' && entry.method === 'modelCatalog')
    if (models === undefined) throw new Error('Session model catalog was not mounted')
    const catalog = { default: { provider: 'native', model: 'primary' }, routableProviders: ['native'], failures: [],
      groups: [{ id: 'native', name: 'Native', models: [{ id: 'primary', name: 'Primary', showInPicker: true,
        multiAgentVersion: 'v2', serviceTiers: ['auto', 'priority'] }] }] }
    expect(models.result.create().parse(catalog)).toEqual(catalog)
    await dispose()
    expect(f.released).toEqual(f.mounted.map(entry => entry.package).reverse())
  })

  it('releases earlier contributions when a later owned namespace fails', async () => {
    const f = fixture('@codexydsh/delegation')
    await expect(apply(f.ctx)).rejects.toThrow('mount refused')
    expect(f.mounted.some(entry => entry.package === '@codexydsh/permissions')).toBe(true)
    expect(f.released).toEqual(f.mounted.map(entry => entry.package).reverse())
  })
})
