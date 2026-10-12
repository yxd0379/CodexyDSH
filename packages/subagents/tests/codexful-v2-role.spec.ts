import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { renderCodexfulV2Role } from '../src/codexful-v2-role.ts'

describe('Codexful v2 model-owned role text', () => {
  // Digests come from the pinned Codex role bases and Rust composition, including trailing newlines.
  it.each([
    [undefined, false, 'af60719c7b64906bd05733aec72a96726712fe25d382a7bc9e05a6733cfd67dc'],
    [undefined, true, 'af4940bc6da67fab366fdbdb98c9979b37d10d05e703aaf3784a0a3f2cf6264f'],
    ['gpt-6-astra', false, '47091490938505958b0c22ff42db6fd79b272a2af6923166f4c2cc53c4fe0df4'],
    ['gpt-6-sol', true, 'ed146aef547fe4dad4e977ee39f5ba39522c80a1689db8e99144573663ac9880'],
    ['gpt-6-luna', false, '47091490938505958b0c22ff42db6fd79b272a2af6923166f4c2cc53c4fe0df4'],
    ['gpt-5.6-sol', false, 'af60719c7b64906bd05733aec72a96726712fe25d382a7bc9e05a6733cfd67dc'],
    ['gpt-6-sol-custom', true, 'af4940bc6da67fab366fdbdb98c9979b37d10d05e703aaf3784a0a3f2cf6264f'],
  ] as const)('renders the pinned role for model %s, child %s', (model, child, expected) => {
    const text = renderCodexfulV2Role({ model, child, maxConcurrency: 4 })
    expect(createHash('sha256').update(text).digest('hex')).toBe(expected)
  })

  it('omits disabled wait and model-override guidance while rendering the current concurrency', () => {
    const text = renderCodexfulV2Role({
      child: false, maxConcurrency: 7, waitAgentEnabled: false, exposeModelOverrides: false,
    })
    expect(createHash('sha256').update(text).digest('hex'))
      .toBe('d3f946374da1ceb13255a57b8d2cd26fc72241d75a47b23bb379450d44dda4f3')
  })

  it('filters the model-owned base before appending shared instructions and catalog markers', () => {
    const text = renderCodexfulV2Role({
      model: 'gpt-6-astra', child: false, maxConcurrency: 4,
      transformBase(base) {
        expect(base).not.toContain('<multi_agent_role>')
        expect(base).not.toContain('available concurrency slots')
        return base.replace('At the start of your turn, you are the active agent.\n', '')
      },
    })
    expect(text).not.toContain('At the start of your turn')
    expect(text).toContain('There are 4 available concurrency slots')
    expect(text.endsWith('</multi_agent_role>')).toBe(true)
  })
})
