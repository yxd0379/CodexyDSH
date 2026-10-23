import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultDshHome } from '@deepseek-ai/dsh-home-paths'
import { resolveDesktopPaths, resolveDesktopUserData } from '../src/paths.ts'
import { resolveDesktopAppId } from '../scripts/desktop-release-environment.mjs'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

describe('independent CodexyDSH application data', () => {
  it('keeps default profiles and their locks outside the official DSH home', () => {
    expect(defaultDshHome()).toBe(join(homedir(), '.codexydsh'))
    expect(resolveDesktopPaths(defaultDshHome())).toEqual({
      profile: join(homedir(), '.codexydsh', 'profiles', 'desktop'),
      lock: join(homedir(), '.codexydsh', 'profiles', 'desktop', 'lock'),
    })
  })

  it('uses its own Electron user-data directory while honoring explicit directories', () => {
    const appData = resolve('test-app-data')
    expect(resolveDesktopUserData(appData)).toBe(join(appData, 'CodexyDSH'))
    expect(resolveDesktopUserData(appData, './test-electron-data')).toBe(resolve('test-electron-data'))
  })

  it('supplies an independent application ID with explicit release overrides', () => {
    expect(resolveDesktopAppId({})).toBe('io.codexydsh.desktop')
    expect(resolveDesktopAppId({ DSH_DESKTOP_APP_ID: 'io.example.codexydsh' })).toBe('io.example.codexydsh')
  })

  it('packages a distinct application and updater identity without an official update feed', () => {
    const config = createElectronBuilderConfig({ DSH_DESKTOP_UNSIGNED: '1' }, 'darwin', 'arm64')
    expect(config.appId).toBe('io.codexydsh.desktop')
    expect(config.productName).toBe('CodexyDSH')
    expect(config.extraMetadata.name).toBe('codexydsh-desktop')
    expect(config.protocols).toEqual([{ name: 'CodexyDSH', schemes: ['codexydsh'] }])
    expect(config.publish).toBeNull()
  })
})
