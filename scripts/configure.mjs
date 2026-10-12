/** Read package paths without side effects; explicitly generate build configs. */
import { readdir, readFile, writeFile, access, mkdir, realpath } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
export async function packagePaths(projectRoot = root) {
  const paths = {}
  for (const directory of await readdir(resolve(projectRoot, 'packages'))) {
    const packageRoot = resolve(projectRoot, 'packages', directory)
    let manifest
    try { manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    for (const [key, declaration] of Object.entries(manifest.exports ?? {})) {
      if (key.includes('*') || key === './package.json' || key.endsWith('.yml')) continue
      const destination = typeof declaration === 'string' ? declaration : declaration.types ?? declaration.default
      const source = destination.startsWith('./src/') ? destination
        : destination.replace(/^\.\/lib\/(?:types\/)?/, './src/').replace(/\.d\.ts$|\.js$/, '.ts')
      let existing = source
      try { await access(resolve(packageRoot, existing)) }
      catch { existing = source.replace(/\.ts$/, '.tsx'); try { await access(resolve(packageRoot, existing)) } catch { continue } }
      paths[manifest.name + (key === '.' ? '' : key.slice(1))] = ['./' + relative(projectRoot, resolve(packageRoot, existing))]
    }
  }
  return paths
}
const paths = await packagePaths()

/** Keep generated compiler files out of the product's root and source tree. */
export async function generateCompilerConfigs(projectRoot = root) {
  const configRoot = resolve(projectRoot, '.build/config')
  const packageNames = await readdir(resolve(projectRoot, 'packages'))
  const sourcePaths = projectRoot === root ? paths : await packagePaths(projectRoot)
  const fromConfig = path => relative(configRoot, resolve(projectRoot, path))
  const options = {
    target: 'ES2024', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    skipLibCheck: true, preserveSymlinks: false, jsx: 'react-jsx', lib: ['ES2024', 'DOM', 'DOM.Iterable'],
    types: ['node', 'react', 'react-dom'], resolveJsonModule: true,
    allowImportingTsExtensions: true, noEmit: true,
    paths: Object.fromEntries(Object.entries(sourcePaths).map(([name, sources]) => [name, sources.map(fromConfig)])),
  }
  await mkdir(configRoot, { recursive: true })
  await writeFile(resolve(configRoot, 'tsconfig.base.json'), JSON.stringify({ compilerOptions: options }, null, 2) + '\n')
  for (const face of ['host', 'client']) {
    const include = face === 'host'
      ? packageNames.flatMap(name => name.startsWith('ui-') ? [`packages/${name}/src/index.ts`] : [`packages/${name}/src/**/*.ts`, `packages/${name}/src/**/*.tsx`]).concat('types/**/*.d.ts')
      : ['packages/*/src/client/**/*.ts', 'packages/*/src/client/**/*.tsx', 'types/**/*.d.ts']
    const exclude = ['**/lib/**', '**/node_modules/**']
    if (face === 'host') exclude.push(fromConfig('packages/*/src/client/**'))
    await writeFile(resolve(configRoot, `tsconfig.${face}.json`), JSON.stringify({ extends: './tsconfig.base.json', include: include.map(fromConfig), exclude }, null, 2) + '\n')
    await writeFile(resolve(configRoot, `tsconfig.declarations.${face}.json`), JSON.stringify({
      extends: `./tsconfig.${face}.json`, exclude: [...exclude, fromConfig('packages/test-support/**'), fromConfig('packages/runtime-testkit/**')], compilerOptions: {
        noEmit: false, declaration: true, emitDeclarationOnly: false, rewriteRelativeImportExtensions: true,
        rootDir: fromConfig('packages'), outDir: `../types-${face}`,
      },
    }, null, 2) + '\n')
  }
  return configRoot
}

const entry = process.argv[1] === undefined ? undefined : await realpath(process.argv[1]).catch(() => undefined)
if (entry === fileURLToPath(import.meta.url)) {
  await generateCompilerConfigs()
}

export { root, paths }
