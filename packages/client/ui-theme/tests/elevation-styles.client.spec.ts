/**
 * Elevation stylesheet contract, asserted against the CSS text on disk:
 * gradient-shadow-text.css composes the elevation tokens from a rebindable
 * 0.5px hairline stroke plus soft layers, and no package rule pairs an
 * lv/elevation box-shadow with a neutral-border-token border — elevated
 * surfaces draw their neutral stroke inside the elevation shadow (border: 0),
 * never as a layout-consuming border beside it. State-colored borders (for
 * example the warn approval panels) stay real borders and are out of scope.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { packageStylesheets, parseRules } from './stylesheet-scan.ts'

/** Stroke-color indirection components may rebind per surface or state. */
const STROKE_COLOR = '--dsw-elevation-stroke-color'
/** Shadow-token references that mark a rule as an elevated surface. */
const ELEVATED_SHADOW = /--dsw-(?:shadow-lv|elevation-)/
/** Neutral border tokens; the state palette (--dsw-alias-state-*) stays allowed. */
const NEUTRAL_BORDER = /--dsw-alias-border-/

const sheetCss = readFileSync(
  fileURLToPath(new URL('../src/styles/gradient-shadow-text.css', import.meta.url)), 'utf8')
const platformCss = readFileSync(
  fileURLToPath(new URL('../src/styles/design-platform.css', import.meta.url)), 'utf8')

describe('elevation tokens', () => {
  const rules = parseRules(sheetCss)
  const bodyOnly = new Map(rules
    .filter(rule => rule.selectors.length === 1 && rule.selectors[0] === 'body')
    .flatMap(rule => rule.declarations))
  const perElement = new Map(rules
    .filter(rule => rule.selectors.includes('body *'))
    .flatMap(rule => rule.declarations))

  it('defaults the stroke color on body alone, so a surface rebind inherits', () => {
    // Declared per element, `body *` would beat inheritance on every
    // descendant and a surface's rebind could not reach the box that carries
    // the shadow; declared on body alone, the rebind inherits down.
    expect(bodyOnly.get(STROKE_COLOR)).toBe('var(--dsw-alias-border-l4)')
    expect(perElement.has(STROKE_COLOR)).toBe(false)
  })

  it('declares the derived values per element, so a stroke rebind takes effect', () => {
    // A custom property computes with var() already substituted, and
    // descendants inherit that computed value: derived tokens declared only on
    // body would bake in body's stroke color, making every
    // --dsw-elevation-stroke-color rebind a no-op. Per-element declarations
    // re-substitute against the color each element sees (the same contract
    // scrollbar.css states for --dsh-scrollbar-thumb).
    expect(perElement.get('--dsw-elevation-stroke')).toBe(`0 0 0 0.5px var(${STROKE_COLOR})`)
    for (const name of ['--dsw-elevation-panel', '--dsw-elevation-prominent', '--dsw-elevation-soft']) {
      expect(perElement.get(name), name).toMatch(/^var\(--dsw-elevation-stroke\), 0 /)
      expect(bodyOnly.has(name), name).toBe(false)
    }
  })

  it('defines the translucent menu material for both palettes', () => {
    expect(bodyOnly.get('--dsw-mask-blur')).toBe('none')
    expect(bodyOnly.get('--dsw-menu-backdrop-filter')).toBe('blur(40px) saturate(150%)')
    const platformRules = parseRules(platformCss)
    const value = (selector: string, token = '--dsw-menu-surface-fill'): string | undefined => platformRules
      .filter(rule => rule.selectors.includes(selector))
      .flatMap(rule => rule.declarations)
      .findLast(([property]) => property === token)?.[1]
    expect(value('body')).toBe('rgba(248, 249, 250, 0.58)')
    expect(value('body[data-ds-dark-theme]')).toBe('rgba(67, 69, 74, 0.45)')
    expect(value('body', '--dsw-specific-menu')).toBe('var(--dsw-menu-surface-fill)')
    expect(value("html[data-platform='darwin'] body", '--dsw-specific-menu')).toBe('rgba(248, 249, 250, 0.94)')
    expect(value("html[data-platform='darwin'] body[data-ds-dark-theme]", '--dsw-specific-menu')).toBe('rgba(48, 49, 54, 0.94)')
  })
})

/** Elevated or isolated-background menu-fill rules that omit the shared backdrop filter. */
function translucentMenusWithoutBackdrop(css: string): string[] {
  return parseRules(css)
    .filter(rule => rule.declarations.some(([property, value]) =>
      (property === 'background' || property === 'background-color')
      && /^var\(--dsw-(?:specific-menu|menu-surface-fill)\)$/.test(value)))
    .filter(rule => rule.declarations.some(([property, value]) =>
      property === 'box-shadow' && ELEVATED_SHADOW.test(value))
      || rule.selectors.some(selector => /::(?:before|after)$/.test(selector)))
    .filter(rule => !rule.declarations.some(([property, value]) =>
      property === 'backdrop-filter' && value === 'var(--dsw-menu-backdrop-filter)'))
    .map(rule => rule.selectors.join(', '))
}

describe('translucent menu surfaces pair fill and filter', () => {
  it('rejects a menu fill without the shared backdrop filter', () => {
    expect(translucentMenusWithoutBackdrop(
      '.a { background: var(--dsw-specific-menu); box-shadow: var(--dsw-elevation-panel); }',
    )).toEqual(['.a'])
    expect(translucentMenusWithoutBackdrop(
      '.a { background: var(--dsw-specific-menu); box-shadow: var(--dsw-elevation-panel); backdrop-filter: var(--dsw-menu-backdrop-filter); }',
    )).toEqual([])
    expect(translucentMenusWithoutBackdrop(
      '.a::before { background: var(--dsw-specific-menu); }',
    )).toEqual(['.a::before'])
    expect(translucentMenusWithoutBackdrop(
      '.a::before { background: var(--dsw-specific-menu); backdrop-filter: var(--dsw-menu-backdrop-filter); }',
    )).toEqual([])
  })

  it('rejects a backed menu fill without the shared backdrop filter', () => {
    expect(translucentMenusWithoutBackdrop(
      '.a { background: var(--dsw-menu-surface-fill); box-shadow: var(--dsw-elevation-panel); }',
    )).toEqual(['.a'])
    expect(translucentMenusWithoutBackdrop(
      '.a { background: var(--dsw-menu-surface-fill); box-shadow: var(--dsw-elevation-panel); backdrop-filter: var(--dsw-menu-backdrop-filter); }',
    )).toEqual([])
  })

  it('covers every package menu-fill consumer', () => {
    const missing = packageStylesheets().flatMap(file =>
      translucentMenusWithoutBackdrop(readFileSync(file, 'utf8'))
        .map(selectors => `${file} ${selectors}`))
    expect(missing).toEqual([])
  })

  it('keeps backdrop filtering on background layers when descendants use fixed positioning', () => {
    const surfaces = [
      ['packages/client/ui-primitives/src/MenuSurface.module.css', '.surface', '.material'],
      ['packages/client/ui-goal/src/client/GoalBar.module.css', '.bar', '.bar::before'],
      ['packages/client/ui-conversation/src/client/queue/QueueDock.module.css', '.panel', '.panel::before'],
      ['packages/extensions/ui-cordis/src/client/CordisPanel.module.css', '.panel', '.panel::before'],
    ] as const
    const files = packageStylesheets()
    for (const [suffix, container, background] of surfaces) {
      const file = files.find(candidate => candidate.endsWith(suffix))
      expect(file, suffix).toBeDefined()
      const rules = parseRules(readFileSync(file!, 'utf8'))
      const declarations = (selector: string) => new Map(rules
        .filter(rule => rule.selectors.length === 1 && rule.selectors[0] === selector)
        .flatMap(rule => rule.declarations))
      expect(declarations(container).has('backdrop-filter'), container).toBe(false)
      expect(declarations(background).get('background'), background).toBe(container === '.surface' ? 'var(--dsw-menu-surface-fill)' : 'var(--dsw-specific-menu)')
      expect(declarations(background).get('backdrop-filter'), background)
        .toBe('var(--dsw-menu-backdrop-filter)')
    }
  })
})

/**
 * Rules pairing an lv/elevation box-shadow with a neutral-border-token border.
 * @param css - stylesheet text.
 * @returns the offending selectors, in source order.
 */
function neutralBordersBesideElevation(css: string): string[] {
  return parseRules(css)
    .filter(rule => rule.declarations
      .some(([property, value]) => property === 'box-shadow' && ELEVATED_SHADOW.test(value)))
    .filter(rule => rule.declarations.some(([property, value]) =>
      property.startsWith('border') && !property.startsWith('border-radius') && NEUTRAL_BORDER.test(value)))
    .map(rule => rule.selectors.join(', '))
}

describe('elevated surfaces carry no neutral border', () => {
  it('rejects a rule that pairs the shadow with a neutral border', () => {
    expect(neutralBordersBesideElevation(
      '.a { box-shadow: var(--dsw-elevation-panel); border: 0.5px solid var(--dsw-alias-border-l2); }',
    )).toEqual(['.a'])
    expect(neutralBordersBesideElevation(
      '.a { box-shadow: var(--dsw-elevation-panel); border: 0; }',
    )).toEqual([])
  })

  it('never pairs an lv/elevation shadow with a neutral border token under packages/', () => {
    // A 1px border beside the elevation stroke double-draws the outline and
    // shifts layout by the border width; the hairline belongs to the shadow.
    const paired = packageStylesheets().flatMap(file =>
      neutralBordersBesideElevation(readFileSync(file, 'utf8'))
        .map(selectors => `${file} ${selectors}`))
    expect(paired).toEqual([])
  })
})
