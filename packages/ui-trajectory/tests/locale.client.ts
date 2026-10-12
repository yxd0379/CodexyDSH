import { commonEn } from '@codexydsh/test-support/client'
import { commonZh } from '@codexydsh/test-support/client'
import { en, zh, type TrajectoryTranslate } from '../src/client/locales.ts'

function translator(dictionary: Record<string, string>): TrajectoryTranslate {
  return (key, params = {}) => {
    const template = dictionary[key] ?? key
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const value = params[name]
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : ''
    })
  }
}

/** English trajectory translator for component and pure-layout tests. */
export const t = translator({ ...commonEn, ...en })

/** Chinese trajectory translator for real-view fixtures that open in Chinese. */
export const tZh = translator({ ...commonZh, ...zh })
