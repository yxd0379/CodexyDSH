import { RequestProviders } from '@codexydsh/bridges'
/** Configuration-owned model facts and exact Responses namespace capability. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import LlmRuntime from '@codexydsh/runtime/llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import type { PiAiProviderProfile } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

function adapterOf(providers: Record<string, PiAiProviderProfile>): PiAiAdapter {
  const profiles = resolveProfiles(providers)
  return new PiAiAdapter({ profiles: () => profiles, resolveApiKey: () => Promise.resolve('test-key'), auth: memoryAuth() })
}

describe('pi-ai model metadata', () => {
  it('detaches declared selector, delegation, and tier facts in both metadata reads', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    const tiers = ['standard', 'fast']
    const adapter = adapterOf({ local: {
      api: 'openai-responses', baseURL: 'https://example.test/v1', models: [
        { id: 'custom', showInPicker: false, multiAgentVersion: 'v1', serviceTiers: tiers },
        { id: 'unknown' },
      ],
    } })
    ctx.codexyRequests.registerAdapter(['local'], adapter)
    const listed = await adapter.listModels('local')
    const exact = await adapter.resolveModel('local', 'custom')
    const expected = { showInPicker: false, multiAgentVersion: 'v1', serviceTiers: ['standard', 'fast'] }
    expect(listed[0]).toMatchObject(expected)
    expect(exact).toMatchObject(expected)
    expect((await ctx.codexyRequests.listModels('local'))[0]).toMatchObject(expected)
    expect(await ctx.codexyRequests.resolveModelInfo('local', 'custom')).toMatchObject(expected)
    expect(listed[0]?.serviceTiers).not.toBe(exact.serviceTiers)
    tiers.push('background')
    expect(exact.serviceTiers).toEqual(['standard', 'fast'])
    expect((await adapter.resolveModel('local', 'custom')).serviceTiers).toEqual(['standard', 'fast'])
    const unknown = await adapter.resolveModel('local', 'unknown')
    expect(unknown).not.toHaveProperty('showInPicker')
    expect(unknown).not.toHaveProperty('multiAgentVersion')
    expect(unknown).not.toHaveProperty('serviceTiers')
    await ctx.fiber.dispose()
  })

  it('retains explicit installed-catalog overrides without inferring Codex fields', async () => {
    const adapter = adapterOf({ openai: { modelOverrides: {
      'gpt-4.1': { showInPicker: true, multiAgentVersion: 'disabled', serviceTiers: [] },
    } } })
    const expected = { showInPicker: true, multiAgentVersion: 'disabled', serviceTiers: [] }
    expect((await adapter.listModels('openai')).find(model => model.id === 'gpt-4.1')).toMatchObject(expected)
    expect(await adapter.resolveModel('openai', 'gpt-4.1')).toMatchObject(expected)
    const model = await adapter.resolveModel('openai', 'gpt-5.6-sol')
    expect(model).not.toHaveProperty('showInPicker')
    expect(model).not.toHaveProperty('multiAgentVersion')
    expect(model).not.toHaveProperty('serviceTiers')
  })

  it('keeps prepared model facts with their captured provider configuration', async () => {
    const profilesFor = (lite: 'namespaced' | 'flat', version: 'v1' | 'v2') => resolveProfiles({ local: {
      api: 'openai-responses', baseURL: 'https://example.test/v1', codexResponsesLite: lite,
      models: [{ id: 'gpt-6-sol', reasoningEfforts: { low: 'low' }, multiAgentVersion: version }],
    } })
    let profiles = profilesFor('namespaced', 'v2')
    const adapter = new PiAiAdapter({ profiles: () => profiles,
      resolveApiKey: () => Promise.resolve('test-key'), auth: memoryAuth(),
    })
    const captured = await adapter.prepareCall('local', 'gpt-6-sol')
    profiles = profilesFor('flat', 'v1')
    const current = await adapter.resolveModel('local', 'gpt-6-sol')
    expect(captured.model).toMatchObject({ toolNamespaces: 'native', multiAgentVersion: 'v2' })
    expect(current.multiAgentVersion).toBe('v1')
    expect(current.toolNamespaces).toBeUndefined()
  })

  it('keeps the prepared catalog and other model reasoning on that same configuration', async () => {
    const profilesFor = (next: boolean) => resolveProfiles({ local: {
      api: 'openai-responses', baseURL: 'https://example.test/v1',
      codexResponsesLite: next ? 'flat' : 'namespaced', reasoning: next ? 'high' : 'low',
      models: [
        { id: 'gpt-6-sol', showInPicker: true, multiAgentVersion: next ? 'v1' : 'v2' },
        { id: next ? 'new-model' : 'old-model', showInPicker: true, serviceTiers: [next ? 'new' : 'old'],
          reasoningEfforts: next ? { high: 'high' } : { low: 'low', medium: 'medium' } },
      ],
    } })
    let profiles = profilesFor(false)
    const adapter = new PiAiAdapter({ profiles: () => profiles,
      resolveApiKey: () => Promise.resolve('test-key'), auth: memoryAuth(),
    })
    const prepared = await adapter.prepareCall('local', 'gpt-6-sol')
    profiles = profilesFor(true)
    if (prepared.listModels === undefined || prepared.resolveModel === undefined) {
      throw new Error('pi-ai preparation omitted captured model queries')
    }
    const listed = await prepared.listModels()
    expect(listed.map(model => model.id)).toEqual(['gpt-6-sol', 'old-model'])
    expect(listed[0]?.multiAgentVersion).toBe('v2')
    expect(listed[1]?.serviceTiers).toEqual(['old'])
    expect((await prepared.resolveModel('old-model')).reasoning).toEqual({
      defaultEffort: 'low', efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }],
    })
    await expect(prepared.resolveModel('new-model')).rejects.toHaveProperty('code', 'UNKNOWN_MODEL')
    expect((await adapter.listModels('local')).map(model => model.id)).toEqual(['gpt-6-sol', 'new-model'])
    expect((await adapter.resolveModel('local', 'new-model')).reasoning?.defaultEffort).toBe('high')
  })

  it.each([
    ['openai-responses', 'gpt-6-sol', undefined, true, true, 'native', false],
    ['openai-responses', 'gpt-6-sol', 'flat', true, true, undefined, true],
    ['openai-responses', 'gpt-6-sol', 'namespaced', true, true, 'native', true],
    ['openai-responses', 'qwen3.8', 'flat', true, true, 'native', false],
    ['openai-responses', 'gpt-6-sol', 'flat', false, true, 'native', false],
    ['openai-responses', 'gpt-6-sol', 'flat', true, false, 'native', false],
    ['openai-completions', 'gpt-6-sol', undefined, true, true, undefined, false],
    ['anthropic-messages', 'custom', undefined, false, true, undefined, false],
  ] as const)('reports %s/%s namespace capability with Lite %s, reasoning %s, developer %s',
    async (api, id, lite, reasoning, developer, namespace, liteEnabled) => {
      const adapter = adapterOf({ 'neutral-route': {
        api, baseURL: 'https://example.test/v1',
        ...lite === undefined ? {} : { codexResponsesLite: lite },
        models: [{ id, reasoningEfforts: reasoning ? { low: 'low' } : false,
          ...api === 'openai-responses' ? { compat: { supportsDeveloperRole: developer } } : {},
        }],
      } })
      const resolved = await adapter.resolveModel('neutral-route', id)
      expect(resolved.toolNamespaces).toBe(namespace)
      expect(resolved.codexResponsesLite === true).toBe(liteEnabled)
      expect((await adapter.prepareCall('neutral-route', id)).model).toEqual(resolved)
    })
})
