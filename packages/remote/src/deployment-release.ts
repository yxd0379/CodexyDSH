/** Discover only the integrity-checked product release installed in the local profile. */
import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One release-owned file, addressed relative to its immutable release directory. */
export interface ReleaseFile {
  file: string
  sha256: string
}

/** An independently packed product plugin. */
export interface ReleasePackage extends ReleaseFile {
  name: string
  version: string
  installScript?: ReleaseFile
}

/** Release data shared with the existing product installer. */
export interface DeploymentManifest {
  format: 1
  platform: {
    package: '@deepseek-ai/dsh'
    version: string
    compatibility?: Array<{ version: string; status: 'pending' | 'verified'; surfaces: string[] }>
  }
  packages: ReleasePackage[]
  providerPatches?: Array<ReleaseFile & { name: string }>
  deploymentFiles: ReleaseFile[]
}

/** Fully verified local payload; transport archives only these explicit files. */
export interface DeploymentRelease {
  key: string
  directory: string
  platformVersion: string
  manifest: DeploymentManifest
  files: Array<ReleaseFile & { path: string }>
}

/** Explicit discovery inputs, primarily for alternate Harness homes and tests. */
export interface DeploymentReleaseOptions {
  home?: string
  profile?: string
  modulePath?: string
}

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const digestPattern = /^[a-f0-9]{64}$/u
const deploymentFiles = ['install.mjs', 'profiles/codexy/package.json', 'profiles/codexy-headless/package.json']
const reinstall = 'Rebuild and reinstall the updated Codexy Desktop product before connecting automatically.'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function releaseFile(value: unknown): value is ReleaseFile {
  return record(value) && typeof value.file === 'string' && typeof value.sha256 === 'string' && digestPattern.test(value.sha256)
}

function validManifest(value: unknown): asserts value is DeploymentManifest {
  if (!record(value) || value.format !== 1 || !record(value.platform)
      || value.platform.package !== '@deepseek-ai/dsh' || typeof value.platform.version !== 'string'
      || !versionPattern.test(value.platform.version) || !Array.isArray(value.packages)) {
    throw new Error('Unsupported installed Codexy release manifest')
  }
  const platformVersion = value.platform.version
  const compatibility = value.platform.compatibility
  if (compatibility !== undefined) {
    const seen = new Set<string>()
    if (!Array.isArray(compatibility) || compatibility.length === 0) throw new Error('Invalid release compatibility matrix')
    for (const entry of compatibility) {
      if (!record(entry) || typeof entry.version !== 'string' || !versionPattern.test(entry.version)
          || seen.has(entry.version) || !['pending', 'verified'].includes(String(entry.status))
          || !Array.isArray(entry.surfaces) || entry.surfaces.length === 0
          || entry.surfaces.some(surface => !['web', 'headless', 'desktop'].includes(String(surface)))) {
        throw new Error('Invalid release compatibility matrix')
      }
      seen.add(entry.version)
    }
    if (!compatibility.some(entry => entry.version === platformVersion
        && entry.status === 'verified' && entry.surfaces.includes('web'))) {
      throw new Error('Installed release has no verified Web runtime for automatic deployment')
    }
  }
  const names = new Set<string>()
  const files = new Set<string>()
  for (const item of value.packages) {
    if (!releaseFile(item) || !record(item) || typeof item.name !== 'string'
        || !/^@codexydsh\/[a-z0-9-]+$/u.test(item.name) || typeof item.version !== 'string'
        || !versionPattern.test(item.version) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/u.test(item.file)
        || names.has(item.name) || files.has(item.file)) throw new Error('Invalid or duplicate release package')
    names.add(item.name); files.add(item.file)
    if (item.name === '@codexydsh/processes' && (item.version !== '0.1.0' || !releaseFile(item.installScript)
        || item.installScript.file !== 'scripts/ensure-spawn-helper.mjs')) {
      throw new Error('Invalid release-owned processes repair')
    }
  }
  for (const name of ['@codexydsh/bundle', '@codexydsh/web', '@codexydsh/headless', '@codexydsh/remote']) {
    if (!names.has(name)) throw new Error(`Installed release is missing ${name}`)
  }
  const patches = value.providerPatches ?? []
  if (!Array.isArray(patches) || patches.length > 1) throw new Error('Invalid release provider patches')
  for (const patch of patches) {
    if (!releaseFile(patch) || !record(patch) || patch.name !== '@earendil-works/pi-ai@0.85.1'
        || patch.file !== 'patches/pi-ai-0.85.1.patch') throw new Error('Unsupported release provider patch')
  }
  if (!Array.isArray(value.deploymentFiles)) throw new Error(`Installed release lacks automatic deployment files. ${reinstall}`)
  const tools = new Set<string>()
  for (const item of value.deploymentFiles) {
    if (!releaseFile(item) || !deploymentFiles.includes(item.file) || tools.has(item.file)) {
      throw new Error('Invalid automatic deployment file manifest')
    }
    tools.add(item.file)
  }
  if (deploymentFiles.some(file => !tools.has(file))) throw new Error(`Installed release lacks automatic deployment files. ${reinstall}`)
}

function within(parent: string, child: string): boolean {
  const nested = relative(parent, child)
  return nested !== '' && !isAbsolute(nested) && nested !== '..' && !nested.startsWith(`..${sep}`)
}

function selectedProfile(home: string, options: DeploymentReleaseOptions): string {
  let profile = options.profile
  if (profile === undefined) {
    const nested = relative(join(home, 'profiles'), resolve(options.modulePath ?? fileURLToPath(import.meta.url))).split(sep)
    // Installed plugins are carried by the active profile. Development sources
    // deliberately use the installed Desktop profile, never a working-tree build.
    profile = nested.length >= 3 && nested[1] === 'node_modules' ? nested[0] : 'desktop'
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(profile) || profile === 'node_modules') {
    throw new Error('Invalid local deployment profile name')
  }
  return profile
}

/** Resolve and verify the exact installed product cache, without changing local files.
 * @param options - Optional local home/profile selection; no cache scanning or build fallback.
 * @returns The pinned runtime version and all files permitted in the SSH upload.
 */
export async function discoverDeploymentRelease(options: DeploymentReleaseOptions = {}): Promise<DeploymentRelease> {
  const home = resolve(options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const profile = selectedProfile(home, options)
  const profileDirectory = join(home, 'profiles', profile)
  let profileManifest: unknown
  try { profileManifest = JSON.parse(await readFile(join(profileDirectory, 'package.json'), 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`The installed ${profile} profile is unavailable. ${reinstall}`)
    throw error
  }
  const dependency = record(profileManifest) && record(profileManifest.dependencies) ? profileManifest.dependencies['@codexydsh/remote'] : undefined
  if (typeof dependency !== 'string' || !dependency.startsWith('file:') || dependency.length <= 5) {
    throw new Error(`The installed ${profile} profile has no pinned Codexy release. ${reinstall}`)
  }
  const archivePath = resolve(profileDirectory, dependency.slice(5))
  const cacheRoot = await realpath(join(home, 'products/codexy/releases'))
  const directory = await realpath(dirname(archivePath))
  if (!within(cacheRoot, directory) || dirname(directory) !== cacheRoot || !digestPattern.test(basename(directory))) {
    throw new Error('The installed product dependency is outside its owned release cache')
  }
  const manifestPath = join(directory, 'release.json')
  const manifestBytes = await readFile(manifestPath)
  const manifest: unknown = JSON.parse(manifestBytes.toString('utf8'))
  validManifest(manifest)
  const key = createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
  if (key !== basename(directory)) throw new Error('Installed release manifest does not match its cache key')
  const remote = manifest.packages.find(item => item.name === '@codexydsh/remote')!
  if (basename(archivePath) !== remote.file) throw new Error('Installed Remote package does not match its release manifest')

  const sources: ReleaseFile[] = [{ file: 'release.json', sha256: createHash('sha256').update(manifestBytes).digest('hex') },
    ...manifest.packages, ...(manifest.providerPatches ?? []), ...manifest.deploymentFiles]
  const files: DeploymentRelease['files'] = []
  for (const item of sources) {
    const path = join(directory, item.file)
    let actual: string
    try { actual = await realpath(path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Installed release file is missing: ${item.file}. ${reinstall}`)
      throw error
    }
    if (actual !== path || !within(directory, actual) || !(await stat(actual)).isFile()) {
      throw new Error(`Release file escapes its directory or is not a regular file: ${item.file}`)
    }
    const hash = createHash('sha256').update(await readFile(actual)).digest('hex')
    if (hash !== item.sha256) throw new Error(`Installed release checksum mismatch: ${item.file}`)
    files.push({ file: item.file, path, sha256: hash })
  }
  return { key, directory, platformVersion: manifest.platform.version, manifest, files }
}
