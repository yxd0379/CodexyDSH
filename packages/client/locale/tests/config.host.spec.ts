import { expect, it } from 'vitest'
import * as LocaleHost from '../src/index.ts'

it('Host 不再声明或保存界面语言偏好', () => {
  expect(LocaleHost).not.toHaveProperty('Config')
})
