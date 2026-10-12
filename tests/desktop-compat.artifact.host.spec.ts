/** Optional real macOS desktop Host check against packed installation in a temporary home. */
import { expect, it } from 'vitest'
import { verifyDesktopHost } from './fixtures/desktop-compat.mjs'

const app = process.env.CODEXY_PACKED_DESKTOP_APP
const home = process.env.CODEXY_PACKED_DESKTOP_HOME

it.skipIf(app === undefined || home === undefined)('boots the installed desktop Host, serves product UI modules and shuts down over IPC', async () => {
  const result = await verifyDesktopHost(app!, home!)
  expect(result).toMatchObject({ desktop: true, html: true, quitInspection: true, shutdownComplete: true })
  expect(result.productModules).toBeGreaterThanOrEqual(15)
  expect(result.browserAssets).toBeGreaterThan(0)
}, 75000)
