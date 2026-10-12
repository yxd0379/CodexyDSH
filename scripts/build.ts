/** Build installable Host modules and DSH closure-factory browser plugins. */
import { readdir, readFile, writeFile, mkdir, cp, access, rm } from 'node:fs/promises'
import { resolve, relative, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { build, type UserConfig, type TsdownPlugin } from 'tsdown'
import { transform } from 'lightningcss'
import { generateCompilerConfigs } from './configure.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const configRoot = await generateCompilerConfigs()
for (const face of ['host', 'client']) {
  await rm(resolve(root, `.build/types-${face}`), { recursive: true, force: true })
  execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(configRoot, `tsconfig.declarations.${face}.json`)], { cwd: root, stdio: 'inherit' })
}
const staticModules = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
])
const cssPrefix = '\0codexy-css:'
const cssPlugin = (name: string): TsdownPlugin => ({
  name: 'codexy-css',
  resolveId(source, importer) {
    if (!/\.css(?:\?inline)?$/.test(source) || importer === undefined) return null
    return cssPrefix + resolve(dirname(importer), source) + '.js'
  },
  async load(id) {
    if (!id.startsWith(cssPrefix)) return null
    const physical = id.slice(cssPrefix.length, -3)
    const inline = physical.endsWith('?inline')
    const filename = inline ? physical.slice(0, -7) : physical
    const module = filename.endsWith('.module.css')
    const result = transform({ filename, code: Buffer.from(await readFile(filename)), minify: true,
      ...(module ? { cssModules: { pattern: '[hash]_[local]' } } : {}),
    })
    const css = result.code.toString()
    if (inline) return `export default ${JSON.stringify(css)};`
    const tag = `${name}/${relative(root, filename)}`
    const classes = Object.fromEntries(Object.entries(result.exports ?? {}).map(([key, value]) => [key, value.name]))
    return `const id=${JSON.stringify(tag)};if(typeof document!=='undefined'&&!document.querySelector('style[data-codexy-css='+JSON.stringify(id)+']')){const style=document.createElement('style');style.dataset.codexyCss=id;style.textContent=${JSON.stringify(css)};document.head.append(style);}export default ${JSON.stringify(classes)};`
  },
})

async function files(directory: string): Promise<string[]> {
  const result: string[] = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name)
    if (item.isDirectory()) result.push(...await files(path))
    else if (/\.(?:ts|tsx)$/.test(item.name) && !item.name.endsWith('.d.ts')) result.push(path)
  }
  return result
}
async function copyAssets(source: string, destination: string): Promise<void> {
  for (const item of await readdir(source, { withFileTypes: true })) {
    const from = resolve(source, item.name), to = resolve(destination, item.name)
    if (item.isDirectory()) await copyAssets(from, to)
    else if (!/\.[cm]?tsx?$/.test(item.name)) { await mkdir(dirname(to), { recursive: true }); await cp(from, to) }
  }
}
for (const directory of await readdir(resolve(root, 'packages'))) {
  for (const face of ['host', 'client']) await copyAssets(resolve(root, 'packages', directory, 'src'), resolve(root, '.build/types-' + face, directory, 'src'))
}
for (const directory of await readdir(resolve(root, 'packages'))) {
  const cwd = resolve(root, 'packages', directory)
  const manifest = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8'))
  if (manifest.private === true) continue
  await rm(resolve(cwd, 'lib'), { recursive: true, force: true })
  const sources = await files(resolve(cwd, 'src'))
  const hostEntries: string[] = []
  for (const source of sources.filter(path => !path.includes('/src/client/'))) {
    const emitted = resolve(root, '.build/types-host', directory, 'src', relative(resolve(cwd, 'src'), source).replace(/\.(ts|tsx)$/, '.js'))
    try { await access(emitted); hostEntries.push(source) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const emittedRoot = resolve(root, '.build/types-host', directory, 'src')
  const entry = Object.fromEntries(hostEntries.map(path => {
    const name = relative(resolve(cwd, 'src'), path).replace(/\.(ts|tsx)$/, '')
    return [name, resolve(emittedRoot, name + '.js')]
  }))
  if (hostEntries.length) await build({ cwd, entry, outDir: 'lib', format: 'esm', clean: false,
    dts: false, sourcemap: true, unbundle: true, platform: 'node',
    external: [/^[^./\0]/], plugins: [cssPlugin(manifest.name)],
    outputOptions: { entryFileNames: '[name].js', chunkFileNames: '[name].js' },
  })
  for (const face of ['host', 'client']) {
    const declarations = resolve(root, `.build/types-${face}`, directory, 'src')
    try { await access(declarations); await cp(declarations, resolve(cwd, 'lib/types'), { recursive: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  // Older runtime exports use lib/*.d.ts while other packages use lib/types.
  for (const declaration of Object.values(manifest.exports ?? {})) {
    if (typeof declaration !== 'object' || declaration === null || !('types' in declaration)) continue
    const destination = String(declaration.types)
    if (!destination.startsWith('./lib/') || destination.startsWith('./lib/types/')) continue
    const source = resolve(cwd, 'lib/types', destination.slice('./lib/'.length))
    try { await access(source); await cp(source, resolve(cwd, destination)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const client = manifest.dsh?.client
  if (client === undefined) continue
  const declared = manifest.exports?.['./client']?.types
  const clientEntry = typeof declared === 'string' ? declared.replace('./lib/types/', './src/').replace(/\.d\.ts$/, '.ts') : './src/client/index.ts'
  const requested = new Set<string>([...staticModules, ...(client.inject ?? []), ...(client.external ?? [])])
  const config: UserConfig = {
    cwd, entry: { client: resolve(root, '.build/types-client', directory, clientEntry.replace(/^\.\/src\//, 'src/').replace(/\.tsx?$/, '.js')) }, outDir: 'lib', format: 'cjs',
    platform: 'browser', clean: false, dts: false, sourcemap: true,
    inputOptions: { platform: 'browser', resolve: { conditionNames: ['browser', 'production', 'import', 'default'] } },
    deps: {
      neverBundle: source => requested.has(source) || [...requested].some(name => source === name + '/client'),
      alwaysBundle: source => !requested.has(source) && ![...requested].some(name => source === name + '/client'),
      onlyBundle: false,
    },
    tsconfig: resolve(configRoot, 'tsconfig.client.json'),
    plugins: [{ name: 'codexy-emitted-client', async resolveId(source) {
      if (!source.startsWith('@codexydsh/')) return null
      const slash = source.indexOf('/', '@codexydsh/'.length)
      const packageName = slash < 0 ? source.slice('@codexydsh/'.length) : source.slice('@codexydsh/'.length, slash)
      const owned = JSON.parse(await readFile(resolve(root, 'packages', packageName, 'package.json'), 'utf8'))
      const leaf = owned.exports?.[slash < 0 ? '.' : '.' + source.slice(slash)]?.types
      if (typeof leaf !== 'string') return null
      return resolve(root, '.build/types-client', packageName, leaf.replace(/^\.\/lib\/(?:types\/)?/, 'src/').replace(/\.d\.ts$/, '.js'))
    } }, cssPlugin(manifest.name)],
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    outputOptions: {
      entryFileNames: 'client.js', chunkFileNames: 'client.[name].js',
      banner: chunk => `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},${chunk.isEntry ? '' : `chunk:${JSON.stringify(chunk.fileName)},`}factory:(require)=>{`,
      intro: 'var module={exports:{}};var exports=module.exports;', footer: 'return module.exports;}});',
    },
  }
  for (const source of sources.filter(path => path.includes('/src/client/'))) {
    const parent = dirname(source)
    for (const item of await readdir(parent)) if (item.endsWith('.css')) {
      const destination = resolve(root, '.build/types-client', directory, relative(cwd, parent), item)
      await mkdir(dirname(destination), { recursive: true })
      await cp(resolve(parent, item), destination)
    }
  }
  await build(config)
  process.stdout.write(`Built ${manifest.name}\n`)
}
