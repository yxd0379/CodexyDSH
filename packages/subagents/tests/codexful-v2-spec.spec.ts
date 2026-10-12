import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildSpecs, resolveSpecOptions } from '../src/codexful-v2-spec.ts'
import type { FunctionSpec } from '../src/codexful-v2-spec.ts'
import { TEXT } from '../src/codexful-v2-source-text.ts'
import { SCENARIOS } from './codexful-v2-source-scenarios.ts'

describe('pinned Codex v2 tool specifications', () => {
  for (const scenario of SCENARIOS) {
    it(`preserves source descriptions, fields, and ordering for ${scenario.name}`, () => {
      const fixture = JSON.parse(readFileSync(new URL(
        `./fixtures/codexful-v2-source/${scenario.name}.json`, import.meta.url,
      ), 'utf8')) as { specs: FunctionSpec[] }
      expect(JSON.stringify(buildSpecs(resolveSpecOptions(scenario.input)))).toBe(JSON.stringify(fixture.specs))
    })
  }

  it('keeps every extracted source literal at its recorded hash', () => {
    const manifest = JSON.parse(readFileSync(new URL(
      './fixtures/codexful-v2-source/source-manifest.json', import.meta.url,
    ), 'utf8')) as { literalSha256: Record<keyof typeof TEXT, string> }
    for (const name of Object.keys(TEXT) as (keyof typeof TEXT)[]) {
      expect(createHash('sha256').update(TEXT[name]).digest('hex'), name).toBe(manifest.literalSha256[name])
    }
  })
})
