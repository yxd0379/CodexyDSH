import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/codex-v1.ts'
import { CODEX_01621_DEFAULT_MODEL_PRESETS, CODEX_PINNED_V1_SPAWN_DESCRIPTION, codexV1SpawnDescription } from '../src/codex-v1-spawn-description.ts'

describe('explicit pinned v1 spawn description', () => {
  it('retains the original default and rejects an unknown wire profile', () => {
    expect(codexV1SpawnDescription()).toBe(CODEX_PINNED_V1_SPAWN_DESCRIPTION)
    expect(Config({}).spawnDescriptionWireProfile).toBeUndefined()
    expect(() => Config({ spawnDescriptionWireProfile: 'unknown' } as never)).toThrow()
  })

  it('renders the independently source-verified 0.162.1 fallback catalog and body', () => {
    const actual = codexV1SpawnDescription('codex-0.162.1')
    expect(createHash('sha256').update(actual).digest('hex'))
      .toBe('5dfbcec2bbf5ba2d61f91aa41dfd93b47c9cffe6c88d1585d8b2358b38bd31e0')
    expect(CODEX_01621_DEFAULT_MODEL_PRESETS.map(model => model.model))
      .toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol'])
    expect(actual.slice(actual.indexOf('\n        Spawn a sub-agent')))
      .toBe(CODEX_PINNED_V1_SPAWN_DESCRIPTION.slice(CODEX_PINNED_V1_SPAWN_DESCRIPTION.indexOf('\n        Spawn a sub-agent')))
    expect(Config({ spawnDescriptionWireProfile: 'codex-0.162.1' }).spawnDescriptionWireProfile)
      .toBe('codex-0.162.1')
  })
})
