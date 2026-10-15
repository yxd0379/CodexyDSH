/** Install a packed product into DSH profiles without replacing user patches. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, copyFile, rename, rm, open } from 'node:fs/promises'
import { constants, existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { isMap, parseDocument } from 'yaml'

/** Interpret explicit installer inputs before changing any profile.
 * @param {string[]} args - Installer arguments.
 * @param {{ platform: string, desktopApps: string[] }} environment - Optional discovery context for deterministic non-mutating tests.
 * @returns Artifact directory, DSH home, executable and target profiles.
 */
export function installerOptions(args, environment = { platform: process.platform, desktopApps: ['/Applications/DeepSeek Harness.app', join(homedir(), 'Applications/DeepSeek Harness.app')] }) {
  const directory = dirname(fileURLToPath(import.meta.url))
  const options = { release: existsSync(join(directory, 'release.json')) ? directory : resolve(directory, '../.artifacts'), home: process.env.DSH_HOME ?? join(homedir(), '.dsh'), dsh: 'dsh', desktop: undefined, desktopApp: undefined, standardProfiles: false, plan: false }
  let target
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '--desktop' || argument === '--web' || argument === '--all') {
      if (target !== undefined && target !== argument) throw new Error('--desktop, --web and --all are mutually exclusive')
      target = argument; options.desktop = argument === '--all' ? undefined : argument === '--desktop'
    }
    else if (argument === '--plan') options.plan = true
    else if (['--release', '--home', '--dsh', '--desktop-app', '--managed-profile'].includes(argument)) {
      const value = args[++index]
      if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value`)
      options[argument === '--desktop-app' ? 'desktopApp' : argument.slice(2)] = value
    } else throw new Error(`unknown installer option ${argument}`)
  }
  options.release = resolve(options.release)
  if (options['managed-profile'] !== undefined && (target !== '--web' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(options['managed-profile']) || ['desktop', 'headless', 'codexy-headless'].includes(options['managed-profile']))) throw new Error('--managed-profile requires --web and a Web profile name')
  options.home = resolve(options.home)
  const installedApp = options.desktopApp ?? environment.desktopApps.find(path => existsSync(path))
  const explicitDesktopApp = options.desktopApp !== undefined
  if (options.desktopApp !== undefined) {
    if (target === '--web') throw new Error('--desktop-app and --web are mutually exclusive')
    options.desktop = true
  }
  options.desktopApp = installedApp === undefined ? undefined : resolve(installedApp)
  options.desktop ??= environment.platform === 'darwin' && options.desktopApp !== undefined && existsSync(join(options.home, 'profiles/desktop/package.json'))
  options.standardProfiles = target === '--all' || target === undefined && !explicitDesktopApp
  return options
}
/** Read only the desktop runtime manifest from an ASAR; never extract or edit the application.
 * @param archive - Electron application archive.
 * @returns The installed runtime's exact platform version.
 */
async function desktopRuntimeVersion(archive) {
  const file = await open(archive, 'r')
  try {
    const prefix = Buffer.alloc(16)
    if ((await file.read(prefix, 0, prefix.length, 0)).bytesRead !== prefix.length) throw new Error('truncated desktop ASAR header')
    const headerSize = prefix.readUInt32LE(4), jsonSize = prefix.readUInt32LE(12)
    if (jsonSize < 2 || jsonSize > 16 * 1024 * 1024 || headerSize < jsonSize + 8) throw new Error('invalid desktop ASAR header')
    const header = Buffer.alloc(jsonSize)
    if ((await file.read(header, 0, header.length, 16)).bytesRead !== header.length) throw new Error('truncated desktop ASAR manifest')
    let entry = JSON.parse(header.toString('utf8'))
    for (const part of ['dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json']) entry = entry?.files?.[part]
    if (entry?.unpacked || !Number.isSafeInteger(entry?.size) || entry.size < 2 || entry.size > 1024 * 1024 || !/^\d+$/u.test(entry.offset ?? '')) throw new Error('desktop runtime manifest is missing or invalid')
    const bytes = Buffer.alloc(entry.size), offset = Number(entry.offset)
    if (!Number.isSafeInteger(offset) || (await file.read(bytes, 0, bytes.length, 8 + headerSize + offset)).bytesRead !== bytes.length) throw new Error('truncated desktop runtime manifest')
    const runtime = JSON.parse(bytes.toString('utf8'))
    if (runtime.name !== '@deepseek-ai/dsh' || typeof runtime.version !== 'string') throw new Error('unexpected desktop runtime manifest')
    return runtime.version
  } finally { await file.close() }
}
/** Resolve the application's public installed CLI carrier, not a separately installed newer CLI.
 * @param options - Desktop application selection.
 * @returns Exact runtime version and the application's CLI carrier.
 */
async function desktopRuntime(options) {
  if (options.desktopApp === undefined) throw new Error('DSH Desktop was not found; use --desktop-app "/Applications/DeepSeek Harness.app" to select it')
  const resources = join(options.desktopApp, 'Contents/Resources')
  const version = await desktopRuntimeVersion(join(resources, 'app.asar'))
  const dsh = join(resources, 'runtime/cli/bin/dsh')
  if (!existsSync(dsh)) throw new Error('DSH Desktop has no public CLI carrier; this application build is not supported')
  return { version, dsh }
}
/** Select only exact runtimes with executable validation for the requested product surface.
 * @param platform - Release platform and compatibility matrix.
 * @param version - Runtime version to check.
 * @param surfaces - Requested launch surfaces.
 */
function assertRuntimeSupported(platform, version, surfaces) {
  const compatibility = platform.compatibility ?? [{ version: platform.version, status: 'verified', surfaces: ['web', 'headless'] }]
  const runtime = compatibility.find(entry => entry.version === version)
  if (runtime?.status !== 'verified' || surfaces.some(surface => !runtime.surfaces.includes(surface))) {
    const supported = compatibility.filter(entry => entry.status === 'verified' && surfaces.every(surface => entry.surfaces.includes(surface))).map(entry => entry.version)
    throw new Error(`unsupported DSH ${version} for ${surfaces.join('/')}; ${supported.length === 0 ? 'no verified runtime for this surface' : `install DSH ${supported.join(' or ')}`} before installing these plugins`)
  }
}
/** Ask an installation-owned carrier for its version without launching any profile.
 * @param dsh - DSH command or installed desktop carrier.
 * @param home - Selected DSH home.
 */
function cliVersion(dsh, home) {
  const version = spawnSync(dsh, ['--version'], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home }, timeout: 15000, killSignal: 'SIGKILL' })
  if (version.error !== undefined) throw version.error
  const output = version.stdout.trim().split(/\s+/u)
  const exact = output.length === 1 ? output[0] : output.length === 2 && output[0] === 'dsh' ? output[1] : undefined
  if (version.status !== 0 || exact === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(exact)) throw new Error('cannot read the exact DSH CLI version')
  return exact
}
/** Run only the public profile-install command, with a deadline owned by this installer.
 * CI suppresses interactive prompts and PNPM's background update check; installation
 * deliberately changes release pins, so its lockfile must be allowed to update.
 * @param {string} dsh - Verified public CLI carrier.
 * @param {string} profile - Selected profile name.
 * @param {string} home - Selected DSH home.
 * @param {{ timeoutMs?: number, killGraceMs?: number }} limits - Shorter deadlines for isolated process tests.
 * @returns {Promise<{ status: number | null, error?: Error }>} Exit outcome; output is never treated as proof of success.
 */
export function runProfileInstall(dsh, profile, home, { timeoutMs = 600000, killGraceMs = 5000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(killGraceMs) || killGraceMs <= 0) throw new Error('invalid profile installation deadline')
  const grouped = process.platform !== 'win32'
  const child = spawn(dsh, ['plugin', '--profile', profile, 'install', '--ignore-scripts'], {
    detached: grouped, stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, DSH_HOME: home, CI: 'true', pnpm_config_frozen_lockfile: 'false', PNPM_CONFIG_FROZEN_LOCKFILE: 'false' },
  })
  return new Promise(resolveOutcome => {
    /** @type {Error | undefined} */ let error
    /** @type {number | null} */ let status = null
    /** @type {ReturnType<typeof setTimeout> | undefined} */ let forceTimer
    /** @type {ReturnType<typeof setInterval> | undefined} */ let groupTimer
    let exited = false, stopped = false, finished = false, forced = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(deadline); clearTimeout(forceTimer); clearInterval(groupTimer)
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate)
      resolveOutcome({ status, ...(error === undefined ? {} : { error }) })
    }
    // The detached POSIX group contains only this command and its package-manager
    // children. Never inspect or signal an unrelated native client or profile.
    const groupAlive = () => {
      if (!grouped || child.pid === undefined) return false
      try { process.kill(-child.pid, 0); return true }
      catch (failure) { if (failure.code === 'ESRCH') return false; error ??= failure; return true }
    }
    const signal = value => {
      if (child.pid === undefined) return
      try { if (grouped) process.kill(-child.pid, value); else child.kill(value) }
      catch (failure) { if (failure.code !== 'ESRCH') error ??= failure }
    }
    const stop = reason => {
      if (stopped || finished) return
      stopped = true; error = reason; clearTimeout(deadline)
      signal('SIGTERM')
      // A CLI may exit before an unresponsive PNPM child. Keep ownership until
      // that group disappears, or escalate once, then cancel every timer.
      groupTimer = setInterval(() => { if (exited && !groupAlive()) finish() }, 50)
      forceTimer = setTimeout(() => { forced = true; signal('SIGKILL'); if (exited) finish() }, killGraceMs)
    }
    const interrupt = () => stop(new Error('profile installation interrupted by SIGINT'))
    const terminate = () => stop(new Error('profile installation interrupted by SIGTERM'))
    const deadline = setTimeout(() => stop(new Error(`profile installation timed out after ${timeoutMs}ms`)), timeoutMs)
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate)
    child.once('error', failure => { error = failure; finish() })
    child.once('close', code => { status = code; exited = true; if (!stopped || forced || !groupAlive()) finish() })
  })
}
/** Read a profile manifest, retaining all user-owned fields.
 * @param path - Existing or future manifest.
 * @returns Manifest or undefined when absent.
 */
async function manifestAt(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}
/** Atomically replace a manifest after retaining its complete predecessor.
 * @param path - Target manifest.
 * @param value - Complete next manifest.
 * @returns The saved predecessor path, or undefined on first installation.
 */
async function publishManifest(path, value) {
  return publishText(path, JSON.stringify(value, null, 2) + '\n')
}
/** Atomically replace one profile file while retaining its exact predecessor.
 * @param path - Target profile file.
 * @param value - Complete next file contents.
 * @returns Saved predecessor path, or undefined on first installation.
 */
async function publishText(path, value) {
  let previous
  try { previous = await readFile(path, 'utf8') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const backup = previous === undefined ? undefined : `${path}.codexy-backup-${Date.now()}-${randomUUID()}`
  if (backup !== undefined) await copyFile(path, backup, constants.COPYFILE_EXCL)
  const temporary = `${path}.codexy-next-${randomUUID()}`
  await writeFile(temporary, value, { flag: 'wx' })
  await rename(temporary, path)
  return backup
}
/** Read PNPM's configuration document without discarding user fields or comments.
 * @param path - Profile workspace configuration.
 * @param needsProviderPatch - Whether this release pins the supported Pi SDK patch.
 * @returns Validated editable YAML document.
 */
async function workspaceAt(path, needsProviderPatch) {
  let source
  try { source = await readFile(path, 'utf8') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const document = parseDocument(source ?? 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  if (document.errors.length > 0) throw new Error(`invalid PNPM workspace at ${path}: ${document.errors[0].message}`)
  if (document.contents === null) document.contents = document.createNode({})
  if (!isMap(document.contents)) throw new Error(`PNPM workspace at ${path} must be a YAML mapping`)
  for (const field of ['overrides', 'allowBuilds', ...(needsProviderPatch ? ['patchedDependencies'] : [])]) {
    const value = document.get(field, true)
    if (value !== undefined && !isMap(value)) throw new Error(`${field} in ${path} must be a YAML mapping`)
  }
  return document
}
/** Retain user build approvals when PNPM adds ignored-script placeholders.
 * @param plan - Published profile document with its original script policy.
 * @param needsProviderPatch - Whether to validate the release-owned patch mapping.
 * @returns Completion after any generated policy entries have been removed.
 */
async function retainBuildPolicy(plan, needsProviderPatch) {
  const current = await workspaceAt(plan.workspacePath, needsProviderPatch)
  const policy = plan.workspace.get('allowBuilds', true), observed = current.get('allowBuilds', true)
  if (JSON.stringify(policy?.toJSON()) === JSON.stringify(observed?.toJSON())) return
  if (policy === undefined) current.delete('allowBuilds')
  else current.set('allowBuilds', policy.clone())
  await publishText(plan.workspacePath, current.toString())
}
/** Verify the full release before exposing a plugin to an existing application.
 * @param options - Explicit installer settings.
 * @returns Verified package archives and provider patches.
 */
async function releaseAt(options) {
  const manifest = JSON.parse(await readFile(join(options.release, 'release.json'), 'utf8'))
  if (manifest.format !== 1 || !Array.isArray(manifest.packages) || typeof manifest.platform?.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.platform.version)) throw new Error('unsupported Codexy release or DSH version')
  if (manifest.platform.compatibility !== undefined) {
    const compatibility = manifest.platform.compatibility, seen = new Set()
    if (!Array.isArray(compatibility) || compatibility.length === 0) throw new Error('invalid release compatibility matrix')
    for (const entry of compatibility) {
      if (typeof entry?.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(entry.version) || seen.has(entry.version) || !['pending', 'verified'].includes(entry.status)
        || !Array.isArray(entry.surfaces) || entry.surfaces.length === 0 || entry.surfaces.some(surface => !['web', 'headless', 'desktop'].includes(surface))) throw new Error('invalid release compatibility matrix')
      seen.add(entry.version)
    }
  }
  const overrides = {}
  for (const item of manifest.packages) {
    if (typeof item.name !== 'string' || !/^@codexydsh\/[a-z0-9-]+$/.test(item.name) || typeof item.file !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/.test(item.file)) throw new Error('invalid release package')
    const path = resolve(options.release, item.file)
    const nested = relative(options.release, path)
    if (isAbsolute(nested) || nested.startsWith('..')) throw new Error('release package escapes its directory')
    const hash = createHash('sha256').update(await readFile(path)).digest('hex')
    if (hash !== item.sha256) throw new Error(`release checksum mismatch: ${item.name}`)
    if (Object.hasOwn(overrides, item.name)) throw new Error(`duplicate release package: ${item.name}`)
    overrides[item.name] = `file:${path}`
  }
  for (const name of ['@codexydsh/bundle', '@codexydsh/web', '@codexydsh/headless']) if (!Object.hasOwn(overrides, name)) throw new Error(`release is missing ${name}`)
  const providerPatches = manifest.providerPatches ?? []
  if (!Array.isArray(providerPatches) || providerPatches.length > 1) throw new Error('invalid release provider patches')
  for (const patch of providerPatches) {
    if (patch?.name !== '@earendil-works/pi-ai@0.85.1' || patch.file !== 'patches/pi-ai-0.85.1.patch'
      || typeof patch.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(patch.sha256)) throw new Error('unsupported release provider patch')
    const digest = createHash('sha256').update(await readFile(resolve(options.release, patch.file))).digest('hex')
    if (digest !== patch.sha256) throw new Error(`release provider patch checksum mismatch: ${patch.name}`)
  }
  if (manifest.deploymentFiles !== undefined) {
    const allowed = ['install.mjs', 'profiles/codexy/package.json', 'profiles/codexy-headless/package.json']
    if (!Array.isArray(manifest.deploymentFiles) || manifest.deploymentFiles.length !== allowed.length || new Set(manifest.deploymentFiles.map(item => item.file)).size !== allowed.length) throw new Error('invalid deployment files')
    for (const item of manifest.deploymentFiles) {
      if (!allowed.includes(item.file) || !/^[a-f0-9]{64}$/u.test(item.sha256)) throw new Error('invalid deployment file')
      if (createHash('sha256').update(await readFile(join(options.release, item.file))).digest('hex') !== item.sha256) throw new Error(`deployment checksum mismatch: ${item.file}`)
    }
  }
  return { manifest, overrides, providerPatches }
}
/** Refuse a different user patch for the exact provider version before editing profiles.
 * @param directory - Profile directory used to resolve existing patch paths.
 * @param patch - Verified release provider patch.
 * @param existing - Existing YAML or legacy manifest patch path.
 * @returns Completion after any existing patch has been checked.
 */
async function checkProviderPatch(directory, patch, existing) {
  if (existing === undefined) return
  if (typeof existing !== 'string') throw new Error(`conflicting provider patch in ${directory}: ${patch.name}`)
  let digest
  try { digest = createHash('sha256').update(await readFile(resolve(directory, existing))).digest('hex') }
  catch (error) { throw new Error(`cannot verify existing provider patch in ${directory}: ${patch.name}`, { cause: error }) }
  if (digest !== patch.sha256) throw new Error(`conflicting provider patch in ${directory}: ${patch.name}; existing patch retained`)
}
/** Run the release-owned spawn-helper permission repair after checking installed bytes.
 * @param plan - Installed profile directory and name.
 * @param processes - Verified release package and exact repair digest.
 * @param home - Installation-owned DSH home.
 * @returns Completion of the synchronous repair process.
 */
async function repairProcesses(plan, processes, home) {
  const require = createRequire(join(plan.dir, 'package.json'))
  const path = require.resolve('@codexydsh/processes/package.json')
  const installed = await manifestAt(path)
  if (installed?.name !== processes.name || installed.version !== processes.version) throw new Error(`unexpected processes package in profile ${plan.profile}`)
  const script = join(dirname(path), processes.installScript.file)
  const digest = createHash('sha256').update(await readFile(script)).digest('hex')
  if (digest !== processes.installScript.sha256) throw new Error(`processes repair checksum mismatch in profile ${plan.profile}`)
  const repaired = spawnSync(process.execPath, [script], { cwd: plan.dir, stdio: 'inherit', env: { ...process.env, DSH_HOME: home } })
  if (repaired.error !== undefined || repaired.status !== 0) throw new Error(`processes repair failed in profile ${plan.profile}`, { cause: repaired.error })
}
/** Prepare the standard entry profiles and product aliases, or explicitly narrowed targets.
 * @param options - Validated installer inputs.
 * @returns Planned or completed targets.
 */
export async function installProduct(options) {
  const { manifest: release, overrides: originalOverrides, providerPatches } = await releaseAt(options)
  const processes = release.packages.find(item => item.name === '@codexydsh/processes')
  if (processes !== undefined && processes.version !== '0.1.0') throw new Error('unsupported Codexy processes build version')
  if (processes !== undefined && (processes.installScript?.file !== 'scripts/ensure-spawn-helper.mjs'
    || typeof processes.installScript.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(processes.installScript.sha256))) {
    throw new Error('invalid release-owned processes repair')
  }
  const targets = options['managed-profile'] ? [options['managed-profile']] : options.standardProfiles ? ['web', 'headless', 'codexy', 'codexy-headless', ...(options.desktop ? ['desktop'] : [])] : options.desktop ? ['desktop'] : ['codexy', 'codexy-headless']
  const plans = []
  for (const profile of targets) {
    const dir = join(options.home, 'profiles', profile)
    const path = join(dir, 'package.json')
    const previous = await manifestAt(path)
    if (profile === 'desktop' && previous === undefined) throw new Error('Open DSH Desktop once and fully quit it before installing its product bundles.')
    const headless = profile === 'headless' || profile === 'codexy-headless'
    const templateName = headless ? 'codexy-headless' : 'codexy'
    const template = profile === 'desktop' ? previous : JSON.parse(await readFile(join(options.release, 'profiles', templateName, 'package.json'), 'utf8'))
    if ((profile === 'web' || profile === 'headless') && previous === undefined) template.name = `dsh-profile-${profile}`
    const manifest = structuredClone(previous ?? template)
    const oldBundles = manifest.dsh?.profile?.bundles ?? template.dsh.profile.bundles
    if (!Array.isArray(oldBundles) || oldBundles.some(name => typeof name !== 'string')) throw new Error(`invalid bundles in ${profile}`)
    const defaults = profile === 'desktop' ? [] : template.dsh.profile.bundles.filter(name => !name.startsWith('@codexydsh/'))
    const base = [...new Set([...defaults, ...oldBundles.filter(name => !['@codexydsh/bundle', '@codexydsh/web', '@codexydsh/headless'].includes(name))])]
    manifest.dsh ??= {}; manifest.dsh.profile ??= {}
    manifest.dsh.profile.bundles = [...base, '@codexydsh/bundle', headless ? '@codexydsh/headless' : '@codexydsh/web']
    manifest.dependencies ??= {}
    for (const [name, path] of Object.entries(originalOverrides)) manifest.dependencies[name] = path
    manifest.pnpm ??= {}; manifest.pnpm.overrides = { ...manifest.pnpm.overrides, ...originalOverrides }
    const workspacePath = join(dir, 'pnpm-workspace.yaml')
    const workspace = await workspaceAt(workspacePath, providerPatches.length > 0)
    for (const patch of providerPatches) {
      await checkProviderPatch(dir, patch, workspace.getIn(['patchedDependencies', patch.name]))
      await checkProviderPatch(dir, patch, manifest.pnpm.patchedDependencies?.[patch.name])
    }
    plans.push({ profile, dir, path, manifest, previous, workspacePath, workspace })
  }
  const desktop = options.desktop ? await desktopRuntime(options) : undefined
  const surfaces = options.standardProfiles ? ['web', 'headless', ...(options.desktop ? ['desktop'] : [])] : options.desktop ? ['desktop'] : ['web', 'headless']
  if (desktop !== undefined) assertRuntimeSupported(release.platform, desktop.version, surfaces)
  if (options.plan) return plans.map(({ profile, dir, manifest }) => ({ profile, dir, bundles: manifest.dsh.profile.bundles, ...(desktop === undefined ? {} : { runtime: desktop.version, dsh: desktop.dsh }) }))
  const dsh = desktop?.dsh ?? options.dsh
  const version = cliVersion(dsh, options.home)
  if (desktop !== undefined && version !== desktop.version) throw new Error(`DSH Desktop runtime ${desktop.version} does not match its installed CLI ${version}; application retained unchanged`)
  assertRuntimeSupported(release.platform, version, surfaces)
  const productDir = join(options.home, 'products/codexy')
  await mkdir(productDir, { recursive: true })
  const lockDir = join(productDir, 'install.lock')
  try { await mkdir(lockDir) } catch (error) { if (error.code === 'EEXIST') throw new Error(`Codexy installation lock exists at ${lockDir}; wait for the current installer to finish`); throw error }
  try {
  await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, started: Date.now() }) + '\n')
  const releaseKey = createHash('sha256').update(JSON.stringify(release)).digest('hex')
  const cache = join(productDir, 'releases', releaseKey)
  await mkdir(cache, { recursive: true })
  const overrides = {}
  for (const item of release.packages) {
    const destination = join(cache, item.file)
    try { await copyFile(resolve(options.release, item.file), destination, constants.COPYFILE_EXCL) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    if (createHash('sha256').update(await readFile(destination)).digest('hex') !== item.sha256) throw new Error(`cached release checksum mismatch: ${item.name}`)
    overrides[item.name] = `file:${destination}`
  }
  const cachedPatches = []
  for (const patch of providerPatches) {
    const destination = join(cache, patch.file)
    await mkdir(dirname(destination), { recursive: true })
    try { await copyFile(resolve(options.release, patch.file), destination, constants.COPYFILE_EXCL) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    if (createHash('sha256').update(await readFile(destination)).digest('hex') !== patch.sha256) throw new Error(`cached provider patch checksum mismatch: ${patch.name}`)
    cachedPatches.push({ name: patch.name, path: destination })
  }
  for (const item of release.deploymentFiles ?? []) {
    const destination = join(cache, item.file)
    await mkdir(dirname(destination), { recursive: true })
    try { await copyFile(join(options.release, item.file), destination, constants.COPYFILE_EXCL) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    if (createHash('sha256').update(await readFile(destination)).digest('hex') !== item.sha256) throw new Error(`cached deployment checksum mismatch: ${item.file}`)
  }
  await writeFile(join(cache, 'release.json'), JSON.stringify(release, null, 2) + '\n')
  for (const plan of plans) {
    Object.assign(plan.manifest.dependencies, overrides)
    Object.assign(plan.manifest.pnpm.overrides, overrides)
    for (const [name, archive] of Object.entries(overrides)) plan.workspace.setIn(['overrides', name], archive)
    for (const patch of cachedPatches) plan.workspace.setIn(['patchedDependencies', patch.name], relative(plan.dir, patch.path).replaceAll('\\', '/'))
    plan.workspace.set('strictDepBuilds', false)
    plan.workspace.set('autoInstallPeers', false)
    await mkdir(plan.dir, { recursive: true })
    const backup = await publishManifest(plan.path, plan.manifest)
    const workspaceBackup = await publishText(plan.workspacePath, plan.workspace.toString())
    try { await writeFile(join(plan.dir, 'cordis.patch.yml'), '[]\n', { flag: 'wx' }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    const installed = await runProfileInstall(dsh, plan.profile, options.home)
    await retainBuildPolicy(plan, providerPatches.length > 0)
    if (installed.error !== undefined || installed.status !== 0) throw new Error(`profile ${plan.profile} installation failed${installed.error === undefined ? '' : `: ${installed.error.message}`}${backup === undefined ? '' : `; original manifest saved at ${backup}`}${workspaceBackup === undefined ? '' : `; original PNPM workspace saved at ${workspaceBackup}`}`, { cause: installed.error })
    if (processes !== undefined) await repairProcesses(plan, processes, options.home)
    process.stdout.write(`Installed ${plan.profile}${backup === undefined ? '' : ` (previous manifest: ${backup})`}\n`)
  }
  if (options.standardProfiles && desktop !== undefined) {
    process.stdout.write(`DSH includes its CLI at ${JSON.stringify(dsh)}; it need not already be on PATH.\n`)
    process.stdout.write(`Web: ${JSON.stringify(dsh)} --profile web\nHeadless: ${JSON.stringify(dsh)} --profile headless "task"\nReopen DSH Desktop for the desktop profile.\n`)
  }
  return plans.map(({ profile, dir }) => ({ profile, dir }))
  } finally { await rm(lockDir, { recursive: true, force: true }) }
}
/** Node canonicalizes imported module URLs, including macOS /var -> /private/var.
 * @param {string | undefined} argument - Executed script argument, if present.
 */
function isEntrypoint(argument) {
  if (argument === undefined) return false
  try { return realpathSync(argument) === realpathSync(fileURLToPath(import.meta.url)) }
  catch { return false }
}
if (isEntrypoint(process.argv[1])) {
  try {
    const result = await installProduct(installerOptions(process.argv.slice(2)))
    if (process.argv.includes('--plan')) process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
