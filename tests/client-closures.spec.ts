/** The test adapter keeps the published factory and public ESM exports aligned. */
import { describe, expect, it } from 'vitest'
import { unwrapClientFactory } from '../scripts/test-client-closures.ts'

describe('published client factories', () => {
  it('retains the factory body and maps plugin package IDs to public browser entries', async () => {
    const code = `window.__ModuleLoader__.load({ id: 'fixture', factory: (require) => {
      var module = { exports: {} }; var exports = module.exports;
      const session = require('@deepseek-ai/dsh-client-ui-session');
      exports.activate = session.apply; return module.exports;
    } });`
    const result = await unwrapClientFactory(code, 'fixture.js')
    expect(result).toContain('from "@deepseek-ai/dsh-client-ui-session/client"')
    expect(result).toContain('exports.activate = session.apply')
    expect(result).toContain('as activate')
  })
  it('leaves ordinary ESM intact and rejects unresolved dynamic factory dependencies', async () => {
    expect(await unwrapClientFactory('export const value = 1', 'esm.js')).toBeUndefined()
    await expect(unwrapClientFactory(`window.__ModuleLoader__.load({ factory: (require) => {
      var module = { exports: {} }; var exports = module.exports;
      exports.value = require(selectDependency()); return module.exports;
    } });`, 'dynamic.js')).rejects.toThrow('Dynamic factory dependency')
  })
})
