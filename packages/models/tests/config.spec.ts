import { describe, expect, it } from 'vitest'
import { assertServiceable, Config, resolveProfiles, type Options, type PiAiModelProfile } from '../src/config.ts'

/** Validate one hand-declared route, with the caller's fields layered onto it. */
const routeWith = (profile: Record<string, unknown>): (() => unknown) =>
  () => ({ providers: Config({
    providers: {
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{ id: 'm' }],
        ...profile,
      },
    },
  }).providers.get() })

/** Validate that route with the caller's fields on its single model entry. */
const configWith = (model: Record<string, unknown>): (() => unknown) =>
  routeWith({ models: [{ id: 'm', ...model }] })

describe('backend web search access policy', () => {
  it.each([undefined, true, false])('keeps the optional boolean distinct through schema and resolution (%s)', (externalAccess) => {
    const source = { api: 'openai-responses', baseURL: 'https://example.test/v1', transport: 'sse' as const,
      backendHostedTools: ['web_search' as const], models: [{ id: 'm' }],
      ...externalAccess === undefined ? {} : { backendWebSearchExternalAccess: externalAccess } }
    expect(Config({ providers: { local: source } }).providers.get()['local']?.backendWebSearchExternalAccess).toBe(externalAccess)
    expect(resolveProfiles({ local: source }).get('local')?.backendWebSearchExternalAccess).toBe(externalAccess)
  })

  it.each([0, 'true', {}])('rejects a nonboolean policy at both public configuration boundaries (%j)', (value) => {
    const source = { api: 'openai-responses', baseURL: 'https://example.test/v1', models: [{ id: 'm' }] }
    Object.assign(source, { backendWebSearchExternalAccess: value })
    expect(routeWith(source)).toThrow()
    expect(() => resolveProfiles({ local: source })).toThrow('backendWebSearchExternalAccess must be a boolean')
  })
})

describe('reasoning schema boundary', () => {
  it('retains explicit catalog policy without assigning omitted fields', () => {
    const profiles: NonNullable<Options['providers']> = { 'acme-gateway': {
      api: 'openai-responses', baseURL: 'https://acme.test', models: [
        { id: 'hidden', showInPicker: false, multiAgentVersion: 'disabled', serviceTiers: [] },
        { id: 'unknown' },
      ],
    } }
    expect(Config({ providers: profiles }).providers.get()).toMatchObject(profiles)
    const metadata = resolveProfiles(profiles).get('acme-gateway')?.modelMetadata
    expect(metadata?.get('hidden')).toEqual({ showInPicker: false, multiAgentVersion: 'disabled', serviceTiers: [] })
    expect(metadata?.get('unknown')).toEqual({})
  })

  it.each([
    { showInPicker: 'false' }, { multiAgentVersion: 'v3' },
    { serviceTiers: 'fast' }, { serviceTiers: [1] },
  ])('rejects invalid model catalog policy %j at configuration parsing', (fields) => {
    expect(configWith(fields)).toThrow()
  })

  it.each([
    { showInPicker: 'false' }, { multiAgentVersion: 'v3' },
    { serviceTiers: 'fast' }, { serviceTiers: [1] }, { serviceTiers: new Array<string>(1) },
  ])('rejects invalid catalog policy %j during direct profile resolution', (fields) => {
    const model: PiAiModelProfile = { id: 'm' }
    Object.assign(model, fields)
    expect(() => resolveProfiles({ local: {
      api: 'openai-responses', baseURL: 'https://example.test/v1', models: [model],
    } })).toThrow('invalid selector, delegation, or service-tier metadata')
  })
  it('accepts an empty provider section and propagates unexpected catalog failures', () => {
    expect(() => { assertServiceable({}) }).not.toThrow()
    const failure = new TypeError('model metadata lookup failed')
    expect(() => resolveProfiles({ openrouter: { models: [{
      id: '111',
      get name(): string { throw failure },
    }], api: 'openai-completions' } }, 'deferred')).toThrow(failure)
  })

  it('rejects a level pi-ai does not know at the write that produced it', () => {
    expect(configWith({ reasoningEfforts: { ultra: 'x' } })).toThrow(/"off"/)
    expect(configWith({ reasoningEfforts: { high: 42 } })).toThrow()
  })

  it('keeps false distinguishable from an absent declaration', () => {
    type Materialized = { providers: Record<string, { models?: { reasoningEfforts?: unknown }[] }> }
    const withFalse = configWith({ reasoningEfforts: false })() as Materialized
    expect(withFalse.providers['acme-gateway']?.models?.[0]?.reasoningEfforts).toBe(false)
    const absent = configWith({})() as Materialized
    expect(absent.providers['acme-gateway']?.models?.[0]?.reasoningEfforts).toBeUndefined()
  })

  it('rejects a thinking format outside the offered set', () => {
    expect(configWith({ compat: { thinkingFormat: 'quantum' } })).toThrow(/expected/)
  })

  it('accepts Baseten template arguments and completion controls', () => {
    expect(configWith({
      compat: {
        supportsFinishReason: false,
        thinkingFormat: 'baseten',
        chatTemplateArgs: { enable_thinking: { $var: 'thinking.enabled' } },
        supportsThinkingTokenBudget: true,
      },
    })).not.toThrow()
  })
})

describe('modality schema boundary', () => {
  it('rejects a modality pi-ai does not know, at either level', () => {
    expect(configWith({ input: ['audio'] })).toThrow(/expected/)
    expect(routeWith({ defaultInput: ['text', 'audio'] })).toThrow(/expected/)
  })

  it('refuses a route whose models could accept nothing', () => {
    // The pair the settings seam runs: the schema accepts the empty list as
    // well-typed, and the namespace validator is what refuses it. Asserting
    // only the schema would report this route as writable.
    expect(routeWith({ defaultInput: [] })).not.toThrow()
    expect(() => { assertServiceable(routeWith({ defaultInput: [] })() as Options) })
      .toThrow(/defaultInput must name at least one modality/)
  })

  type Materialized = {
    providers: Record<string, { defaultInput?: unknown; models?: { input?: unknown }[] }>
  }

  it('materializes an absent entry list as empty and an absent route list as text', () => {
    // The empty-list inheritance rule exists because of exactly this: an entry
    // that declares nothing reaches resolution as `[]`, not as `undefined`.
    const absent = configWith({})() as Materialized
    expect(absent.providers['acme-gateway']?.models?.[0]?.input).toEqual([])
    expect(absent.providers['acme-gateway']?.defaultInput).toEqual(['text'])
  })
})

describe('request image policy bounds', () => {
  it.each([
    ['requestImagePixelBudget', 0, /requestImagePixelBudget must be a positive safe integer/],
    ['requestImagePixelBudget', Number.MAX_SAFE_INTEGER + 1, /requestImagePixelBudget must be a positive safe integer/],
    ['requestImageMaxBytes', 0, /requestImageMaxBytes must be a positive safe integer/],
    ['requestImageMaxBytes', 1.5, /requestImageMaxBytes must be a positive safe integer/],
  ] as const)('rejects %s=%s at service resolution', (field, value, message) => {
    const programmatic = {
      providers: {
        'acme-gateway': {
          api: 'openai-completions',
          baseURL: 'https://acme.test',
          models: [{ id: 'm' }],
          [field]: value,
        },
      },
    } as Options
    expect(() => {
      assertServiceable(programmatic)
    }).toThrow(message)
  })
})
