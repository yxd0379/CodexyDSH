/**
 * Expand the workspace path aliases that a wildcard would otherwise resolve by
 * probing every package group in turn.
 *
 * `tsconfig.base.json` is the resolution facade for the whole repository. A
 * `@deepseek-ai/dsh-*` wildcard would list one candidate glob per package
 * group. TypeScript and tsx try those candidates in order, so a specifier
 * whose package sits late in the list pays for every earlier miss. Under tsx's
 * ESM hook each miss is an `ERR_MODULE_NOT_FOUND` that Node decorates with a
 * full CommonJS resolution walk, which dominated source-launch boot.
 *
 * This generator writes explicit source aliases into a marked region of
 * `tsconfig.base.json`, leaving every hand-written alias and comment outside
 * that region untouched. `--check` reports drift instead of writing, so a new
 * package that needs an alias fails a gate rather than silently resolving
 * through a fallback that no longer exists.
 *
 * @module scripts/gen-tsconfig-paths
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CONFIG = join(ROOT, 'tsconfig.base.json')
const BEGIN = '      // BEGIN generated package aliases — pnpm run gen-tsconfig-paths'
const END = '      // END generated package aliases'

/** Upstream package-name prefix whose matching directories can be expanded. */
const PREFIX = '@deepseek-ai/dsh-'

/** Owned packages keep their declared names when placed in upstream groups. */
const OWNED_PREFIX = '@codexydsh/'

/** One workspace package the generated region maps. */
interface PackageAlias {
  /** Package or export specifier, e.g. `@codexydsh/runtime/agent`. */
  readonly specifier: string
  /** Repository-relative source file or directory. */
  readonly source: string
}

/**
 * Read a workspace manifest's declared name.
 * @param manifest - absolute path to a `package.json`.
 * @returns The declared name, or undefined when the file is absent or nameless.
 */
function packageName(manifest: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8'))
  } catch (_absentOrUnreadableManifest) {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const name: unknown = (parsed as { name?: unknown }).name
  return typeof name === 'string' ? name : undefined
}

/** One workspace package directory and the name its manifest declares. */
interface WorkspacePackage {
  readonly group: string
  readonly directory: string
  readonly name: string
  readonly exports: Readonly<Record<string, string | Readonly<Record<string, string>>>>
}

/**
 * Walk `packages/<group>/<directory>` once, in a stable order.
 * @returns Upstream and Codexy package directories carrying source.
 */
function workspacePackages(): WorkspacePackage[] {
  const packages = join(ROOT, 'packages')
  const found: WorkspacePackage[] = []
  for (const group of readdirSync(packages).sort()) {
    const groupDir = join(packages, group)
    if (!statSync(groupDir).isDirectory()) continue
    for (const directory of readdirSync(groupDir).sort()) {
      const packageDir = join(groupDir, directory)
      const name = packageName(join(packageDir, 'package.json'))
      if (name === undefined || !name.startsWith(PREFIX) && !name.startsWith(OWNED_PREFIX)) continue
      if (!existsSync(join(packageDir, 'src'))) continue
      const manifest: { exports?: WorkspacePackage['exports'] } = JSON.parse(
        readFileSync(join(packageDir, 'package.json'), 'utf8'),
      )
      found.push({ group, directory, name, exports: manifest.exports ?? {} })
    }
  }
  return found
}

/**
 * Collect upstream package aliases and Codexy's explicitly exported source entries.
 *
 * A wildcard substituted the specifier's suffix into `packages/<group>/<suffix>/src`,
 * so it only ever resolved a package whose declared name is exactly
 * `@deepseek-ai/dsh-<directory>`. Packages named after something other than
 * their directory already carry a hand-written alias and are skipped here.
 * Codexy packages instead derive every subpath from their exports map.
 *
 * @returns Aliases sorted by specifier.
 * @throws When two package directories claim one specifier, which the removed
 * wildcards resolved by group order and an explicit map cannot express.
 */
export function collectPackageAliases(): PackageAlias[] {
  const bySpecifier = new Map<string, PackageAlias & { directory: string }>()
  for (const { group, directory, name, exports } of workspacePackages()) {
    if (name.startsWith(OWNED_PREFIX)) {
      for (const [subpath, target] of Object.entries(exports)) {
        if (subpath === './typert' || subpath === './remote') continue
        const exported = typeof target === 'string' ? target : target.types ?? target.default
        if (exported === undefined) continue
        const source = exported.startsWith('./src/') || exported === './package.json'
          ? exported
          : exported.startsWith('./lib/types/')
            ? exported.replace('./lib/types/', './src/').replace(/\.d\.ts$/, '.ts')
            : exported.startsWith('./lib/')
              ? exported.replace('./lib/', './src/').replace(/\.js$/, '.ts')
              : undefined
        if (source === undefined) continue
        const specifier = subpath === '.' ? name : `${name}/${subpath.slice(2)}`
        bySpecifier.set(specifier, {
          specifier,
          source: `./packages/${group}/${directory}/${source.slice(2)}`,
          directory: `${group}/${directory}`,
        })
      }
      continue
    }
    if (name !== `${PREFIX}${directory}`) continue
    const previous = bySpecifier.get(name)
    if (previous !== undefined) {
      throw new Error(
        `gen-tsconfig-paths: ${name} is claimed by packages/${previous.directory} and packages/${group}/${directory}; `
        + 'an explicit alias cannot express the group-order tiebreak the wildcard used.',
      )
    }
    bySpecifier.set(name, {
      specifier: name,
      source: `./packages/${group}/${directory}/src`,
      directory: `${group}/${directory}`,
    })
  }
  return [...bySpecifier.values()]
    .map(({ specifier, source }) => ({ specifier, source }))
    .sort((left, right) => left.specifier.localeCompare(right.specifier))
}

/**
 * Collect every workspace package the aliases must cover.
 *
 * Unlike {@link collectPackageAliases} this keeps packages whose name does not
 * match their directory. The generator cannot map those — only a hand-written
 * alias can — but they still have to be mapped by something, because deleting
 * the group wildcards removed the fallback that used to catch them.
 *
 * @returns Workspace package names whose root export needs a source alias.
 */
export function collectPackageNames(): string[] {
  return workspacePackages()
    .filter(({ exports, name }) => !name.startsWith(OWNED_PREFIX) || '.' in exports)
    .map(({ name }) => name)
    .sort((left, right) => left.localeCompare(right))
}

/**
 * Read the bare package specifiers a config maps, generated region included.
 * @param text - `tsconfig.base.json` contents.
 * @returns Specifiers mapped without a subpath.
 */
export function mappedSpecifiers(text: string): Set<string> {
  const keys = new Set<string>()
  for (const match of text.matchAll(/^\s*"(@deepseek-ai\/dsh-[^"/]+|@codexydsh\/[^"/]+)":/gm)) {
    const key = match[1]
    if (key !== undefined) keys.add(key)
  }
  return keys
}

/**
 * Report packages that no alias maps.
 *
 * A package missing from `paths` still resolves — through the workspace symlink
 * and the package's own `exports` — but to built `lib/` output rather than to
 * source, which is the artifact-plane leak the explicit aliases exist to avoid.
 * Naming it here turns that into a gate failure instead of a silent difference.
 *
 * @param packages - every workspace package that needs an alias.
 * @param mapped - bare specifiers the config maps.
 * @returns Unmapped package names, in the order given.
 */
export function uncoveredPackages(
  packages: readonly string[],
  mapped: ReadonlySet<string>,
): string[] {
  return packages.filter(name => !mapped.has(name))
}

/**
 * Render the generated region's alias lines.
 * @param aliases - packages to map, in emission order.
 * @param handWritten - specifiers already mapped outside the region; a duplicate key would shadow one silently.
 * @returns The region body, one JSON member per line.
 */
export function renderAliases(aliases: readonly PackageAlias[], handWritten: ReadonlySet<string>): string {
  const lines: string[] = []
  for (const alias of aliases) {
    if (!handWritten.has(alias.specifier)) {
      lines.push(`      ${JSON.stringify(alias.specifier)}: [${JSON.stringify(alias.source)}]`)
    }
  }
  // The region closes `paths`, so the last member carries no trailing comma.
  return lines.join(',\n')
}

/**
 * Replace the generated region of a config's text.
 * @param text - current `tsconfig.base.json` contents.
 * @param body - rendered alias lines.
 * @returns The updated contents.
 * @throws When the markers are missing or out of order.
 */
export function writeRegion(text: string, body: string): string {
  const begin = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (begin < 0 || end < begin) {
    throw new Error(`gen-tsconfig-paths: ${CONFIG} is missing the generated-region markers.`)
  }
  return `${text.slice(0, begin)}${BEGIN}\n${body}\n${END}${text.slice(end + END.length)}`
}

/**
 * Parse the config's `paths` keys, ignoring the generated region.
 * @param text - current `tsconfig.base.json` contents.
 * @returns Specifiers mapped by hand.
 */
function handWrittenSpecifiers(text: string): Set<string> {
  const begin = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  const outside = begin < 0 || end < begin ? text : text.slice(0, begin) + text.slice(end)
  const keys = new Set<string>()
  for (const match of outside.matchAll(/^\s*"(@(?:deepseek-ai|codexydsh)\/[^"]+)":/gm)) {
    const key = match[1]
    if (key !== undefined) keys.add(key)
  }
  return keys
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const check = process.argv.includes('--check')
  const current = readFileSync(CONFIG, 'utf8')
  const next = writeRegion(current, renderAliases(collectPackageAliases(), handWrittenSpecifiers(current)))
  const uncovered = uncoveredPackages(collectPackageNames(), mappedSpecifiers(next))
  if (uncovered.length > 0) {
    console.error(
      'gen-tsconfig-paths: no alias maps '
      + `${uncovered.join(', ')}; add a hand-written entry, because a package named after `
      + 'something other than its directory cannot be generated.',
    )
    process.exitCode = 1
  } else if (current === next) {
    console.log('gen-tsconfig-paths: tsconfig.base.json package aliases are current.')
  } else if (check) {
    console.error('gen-tsconfig-paths: tsconfig.base.json is stale; run `pnpm run gen-tsconfig-paths`.')
    process.exitCode = 1
  } else {
    writeFileSync(CONFIG, next)
    console.log('gen-tsconfig-paths: rewrote tsconfig.base.json package aliases.')
  }
}
