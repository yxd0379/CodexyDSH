import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { LocaleRuntime } from '../src/client/index.ts'

it('插件文案优先使用中文，原始字符串和只有默认文案的外部 manifest 保持可读', () => {
  const locale = new LocaleRuntime(new Context())
  expect(locale.resolveText('原始文案 {name}')).toBe('原始文案 {name}')
  expect(locale.resolveText({ zh: '工具', en: 'Tools', ja: 'ツール' })).toBe('工具')
  expect(locale.resolveText({ zh: '', en: 'Tools' })).toBe('')
  expect(locale.resolveText({ en: 'External plugin' })).toBe('External plugin')
})
