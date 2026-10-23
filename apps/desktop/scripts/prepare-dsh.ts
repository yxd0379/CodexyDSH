/** Materialize the current workspace production closure before packaging Desktop resources. */

import { resolveMacOSSignatureCacheDirectory } from './macos-signature-cache-directory.mjs'
import { packagingStep } from './packaging-step.mjs'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { parseDesktopRelease, type DesktopRelease } from '../src/release.ts'
import {
  DESKTOP_HOST_PACKAGE,
  DESKTOP_HOST_RUNTIME_FILES,
} from '../src/core-package-set.ts'
import { smokePrimaryRuntime } from './prepare-primary-runtime.ts'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { prepareRuntimeManifests } from './prepare-runtime-manifests.ts'
import { writeDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import {
  resolveDesktopAppId,
  resolveMacOSSigningEnvironment,
} from './desktop-release-environment.mjs'
import {
  signMacOSRuntime,
} from './macos-runtime.ts'
import { desktopTargetPlatform, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { desktopRuntimeFileExclusion } from './runtime-file-policy.ts'
import { selectOfficeEngine } from '../../../scripts/libreoffice-packages.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const BUILD_PATHS = resolveDesktopTargetBuildPaths()
const DSH_OUTPUT_ROOT = BUILD_PATHS.dsh
const RUNTIME_ROOT = BUILD_PATHS.runtime
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')
const NODE = join(BUILD_PATHS.electron, process.platform === 'win32' ? 'electron.exe' : 'Electron.app/Contents/MacOS/Electron')

function manifestVersion(path: string, subject: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error(`desktop runtime: ${subject} has no version`)
  return manifest.version
}

function desktopRelease(): DesktopRelease {
  const version = manifestVersion(join(APP_ROOT, 'package.json'), 'desktop package')
  const dshVersion = manifestVersion(resolve(APP_ROOT, '..', '..', 'package.json'), 'root dsh package')
  if (version !== dshVersion) {
    throw new Error(`desktop runtime: Electron ${version} must bind the same version of @deepseek-ai/dsh, found ${dshVersion}`)
  }
  const runtime = JSON.parse(readFileSync(join(RUNTIME_ROOT, 'versions.json'), 'utf8')) as Record<string, unknown>
  return parseDesktopRelease({
    schemaVersion: 1,
    version,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: runtime.node,
    pnpmVersion: runtime.pnpm,
  })
}

function deployWorkspaceRuntime(destination: string): Promise<void> {
  // pnpm distinguishes local source identities from registry package names when approving scripts.
  const sources = {
    '@deepseek-ai/dsh-subprocess-local': 'packages/subprocess/subprocess-local',
    '@codexydsh/processes': 'packages/subprocess/codexy-processes',
  }
  const approvals = Object.fromEntries(Object.entries(sources).map(([name, directory]) => [
    `${name}@${pathToFileURL(resolve(REPOSITORY_ROOT, directory)).href}`, true,
  ]))
  const pnpmfile = resolve(destination, '..', 'workspace-build-approvals.cjs')
  writeFileSync(pnpmfile, `module.exports = { hooks: { updateConfig(config) { return { ...config, allowBuilds: { ...config.allowBuilds, ...${JSON.stringify(approvals)} } } } } }\n`)
  return new Promise((resolvePromise, reject) => {
    const pnpm = process.env.npm_execpath
    if (pnpm === undefined || pnpm === '') {
      reject(new Error('desktop runtime: invoke preparation through a pnpm package command'))
      return
    }
    const child = spawn(NODE, [
      pnpm, '--filter', DESKTOP_HOST_PACKAGE, 'deploy', '--prod',
      '--config.node-linker=hoisted',
      '--config.enable-global-virtual-store=false',
      '--pnpmfile', pnpmfile,
      destination,
    ], {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop runtime: pnpm exited with ${String(code ?? signal)}`))
    })
  })
}

/**
 * Copy a deployed Host closure into the resource layout consumed by Desktop.
 * @param source - Isolated pnpm deployment rooted at the private Host package.
 * @param output - Build-owned runtime resource directory.
 * @param target - Runtime platform and architecture.
 * @param officeEngine - Office engine selected for the target.
 */
export function materializeDesktopWorkspaceRuntime(
  source: string, output: string, target: { platform: NodeJS.Platform; arch: string }, officeEngine: string,
): void {
  const modules = join(source, 'node_modules')
  cpSync(modules, join(output, 'node_modules'), {
    recursive: true, dereference: true,
    filter: path => desktopRuntimeFileExclusion(relative(modules, path), target, officeEngine) === undefined,
  })
  // deploy's selected package is its root; Desktop addresses its Host beside the CLI in node_modules.
  const host = join(output, 'node_modules', DESKTOP_HOST_PACKAGE)
  mkdirSync(host, { recursive: true })
  cpSync(join(source, 'package.json'), join(host, 'package.json'))
  for (const file of DESKTOP_HOST_RUNTIME_FILES) {
    mkdirSync(resolve(host, file, '..'), { recursive: true })
    cpSync(join(source, file), join(host, file))
  }
}

function sharedWorkspacePackages(modules: string): string[] {
  const workspace = yaml.load(readFileSync(join(REPOSITORY_ROOT, 'pnpm-workspace.yaml'), 'utf8')) as { packages: string[] }
  return globSync(workspace.packages.map(pattern => `${pattern}/package.json`), { cwd: REPOSITORY_ROOT })
    .map(path => (JSON.parse(readFileSync(join(REPOSITORY_ROOT, path), 'utf8')) as { name: string }).name)
    .filter(name => existsSync(join(modules, name, 'package.json')))
    .sort()
}

async function main(): Promise<void> {
  const buildRoot = mkdtempSync(join(tmpdir(), 'codexydsh-desktop-runtime-'))
  try {
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:reset', async () => {
      rmSync(DSH_OUTPUT_ROOT, { recursive: true, force: true })
    })
    const release = desktopRelease()
    const deployed = join(buildRoot, 'deployed')
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:deploy-workspace', () => deployWorkspaceRuntime(deployed))
    const targetName = resolveDesktopBuildTarget()
    const target = { platform: process.platform, arch: desktopTargetPlatform(targetName).arch }
    const modules = join(deployed, 'node_modules')
    const officeManifest = JSON.parse(readFileSync(join(modules, '@deepseek-ai/libreoffice-kit/package.json'), 'utf8'))
    const officeEngine = selectOfficeEngine(officeManifest, target)
    mkdirSync(DSH_OUTPUT_ROOT, { recursive: true })
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:materialize-modules', async () => {
      materializeDesktopWorkspaceRuntime(deployed, DSH_OUTPUT_ROOT, target, officeEngine)
    })
    const sharedNames = sharedWorkspacePackages(join(DSH_OUTPUT_ROOT, 'node_modules'))
    writeFileSync(join(DSH_OUTPUT_ROOT, 'package.json'), `${JSON.stringify({
      name: '@deepseek-ai/dsh-desktop-runtime', private: true, version: release.version, type: 'module',
      dependencies: Object.fromEntries(sharedNames.map(name => [name, manifestVersion(join(DSH_OUTPUT_ROOT, 'node_modules', name, 'package.json'), name)])),
    }, undefined, 2)}\n`)
    for (const file of DESKTOP_HOST_RUNTIME_FILES) {
      if (!existsSync(join(DSH_OUTPUT_ROOT, 'node_modules', DESKTOP_HOST_PACKAGE, file))) {
        throw new Error(`desktop runtime: missing private Host file ${file}`)
      }
    }
    if (!existsSync(join(DSH_OUTPUT_ROOT, 'node_modules', '@deepseek-ai', `libreoffice-kit-${officeEngine}`, 'prebuilds.json'))) {
      throw new Error(`desktop runtime: missing required LibreOffice engine ${officeEngine}`)
    }
    if (process.platform === 'darwin' && process.env.DSH_DESKTOP_UNSIGNED !== '1') {
      const cacheDirectory = resolveMacOSSignatureCacheDirectory(process.env, BUILD_PATHS.root)
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'sign:dsh-native', () => signMacOSRuntime(DSH_OUTPUT_ROOT, resolveDesktopAppId(process.env), resolveMacOSSigningEnvironment(process.env), target.arch, cacheDirectory))
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'sign:primary-native', () => signMacOSRuntime(join(RUNTIME_ROOT, 'primary-runtime'), resolveDesktopAppId(process.env), resolveMacOSSigningEnvironment(process.env), target.arch, cacheDirectory, 'primary'))
    }
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:manifests', () => prepareRuntimeManifests(DSH_OUTPUT_ROOT))
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:primary-smoke', async () => smokePrimaryRuntime(join(RUNTIME_ROOT, 'primary-runtime')))
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:write-descriptor', async () => writeDesktopRuntime(DSH_OUTPUT_ROOT, release, sharedNames, target))
    const descriptor = await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:verify-before-smoke', () => verifyDesktopRuntime(DSH_OUTPUT_ROOT, release.version, target))
    if (!process.argv.includes('--defer-runtime-smoke')) {
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:smoke', () => smokePreparedRuntime(DSH_OUTPUT_ROOT, NODE, RUNTIME_ROOT, descriptor))
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:verify-after-smoke', () => verifyDesktopRuntime(DSH_OUTPUT_ROOT, release.version, target))
    }
  } catch (error) {
    rmSync(DSH_OUTPUT_ROOT, { recursive: true, force: true })
    throw error
  } finally {
    let cleaned = false
    const cleanup = (): void => {
      rmSync(buildRoot, { recursive: true, force: true })
      cleaned = true
    }
    try { await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:cleanup', async () => cleanup()) }
    finally { if (!cleaned) cleanup() }
  }
}

if (import.meta.main) await main()
