/** Protect the released Settings mirror from Schemastery dictionary normalization. */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsSchemaService } from '@deepseek-ai/dsh-client-ui-settings/client'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Published settings schema service whose validator accepts frozen mirror values. */
    codexySettingsSchema: SettingsSchemaService
  }
}

/** The published Settings provider owns both validation and the mirror. */
export const inject = ['settingsSchema']

/** Validate detached drafts while preserving the published mirror and ConfigForm writes.
 * @param ctx - Plugin context owning the validator adaptation and consumer dependency.
 */
export function apply(ctx: Context): void {
  const schema = ctx.settingsSchema
  ctx.effect(() => {
    const previous = Object.getOwnPropertyDescriptor(schema, 'validate')
    const validate = schema.validate.bind(schema)
    const detached: SettingsSchemaService['validate'] = (node, draft) => {
      let copy: unknown
      try { copy = structuredClone(draft) }
      catch (error) { return error instanceof Error ? error.message : String(error) }
      return validate(node, copy)
    }
    Object.defineProperty(schema, 'validate', { configurable: true, writable: true, value: detached })
    return () => {
      if (previous === undefined) Reflect.deleteProperty(schema, 'validate')
      else Object.defineProperty(schema, 'validate', previous)
    }
  }, 'codexy-settings: detached validation')
  ctx.provide('codexySettingsSchema', schema)
}
