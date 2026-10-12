/** Published TypertLoader consumes the product's actual built API metadata. */
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'

const require = createRequire(import.meta.url)
const platformRequire = createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
const packages = resolve(dirname(fileURLToPath(import.meta.url)), '../packages')

it('registers and withdraws the shipped memory, usage, and draft invocations through the public loader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codexy-typert-artifact-'))
  let disposeContext: (() => Promise<void>) | undefined
  onTestFinished(async () => {
    await disposeContext?.()
    await rm(root, { recursive: true, force: true })
  })
  const names = ['api-memory', 'api-usage', 'api-prompt']
  await mkdir(join(root, 'node_modules/@codexydsh'), { recursive: true })
  for (const name of names) await symlink(join(packages, name), join(root, 'node_modules/@codexydsh', name), process.platform === 'win32' ? 'junction' : 'dir')
  // Native imports keep the loader, registry, and Cordis on the artifact plane.
  const [{ Context }, { default: Loader }, { default: TypertRegistry }, typertLoader] = await Promise.all([
    import(pathToFileURL(platformRequire.resolve('@deepseek-ai/cordis')).href),
    import(pathToFileURL(platformRequire.resolve('@deepseek-ai/cordis-plugin-loader')).href),
    import(pathToFileURL(platformRequire.resolve('@deepseek-ai/dsh-typert-registry')).href),
    import(pathToFileURL(platformRequire.resolve('@deepseek-ai/dsh-typert-loader')).href),
  ])
  const ctx = new Context()
  disposeContext = () => ctx.fiber.dispose()
  ctx.baseUrl = pathToFileURL(join(root, 'cordis.yml')).href
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(Loader)
  const fiber = ctx.plugin(typertLoader, { packages: names.map(name => '@codexydsh/' + name) })
  await fiber
  for (const name of names) expect(ctx.typert.getPackage('@codexydsh/' + name), name).toMatchObject({ face: 'host' })
  for (const endpoint of ['memory/edit', 'memory/list', 'memory/read', 'memory/refresh', 'memory/search', 'memory/snapshot', 'usage/snapshot', 'draft/optimize']) {
    expect(ctx.typert.local.get(endpoint), endpoint).toBeDefined()
  }
  await fiber.dispose()
  for (const name of names) expect(ctx.typert.getPackage('@codexydsh/' + name), name).toBeUndefined()
  expect(ctx.typert.local.get('memory/read')).toBeUndefined()
  expect(ctx.typert.local.get('usage/snapshot')).toBeUndefined()
  expect(ctx.typert.local.get('draft/optimize')).toBeUndefined()
})
