import { afterEach, describe, expect, it, vi } from 'vitest'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildNativeImageCodec } from '../scripts/build-native-image-codec.mjs'

const temporary: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codexy-codec-build-test-'))
  temporary.push(root)
  await cp(new URL('../packages/models/native-image-codec/', import.meta.url), join(root, 'packages/models/native-image-codec'), { recursive: true })
  const prebuilt = join(root, '.build/native-image-codec/prebuilt')
  await mkdir(prebuilt, { recursive: true })
  for (const file of ['native-image-codec.wasm', 'native-image-codec.build.json']) {
    await cp(new URL(`../packages/models/lib/${file}`, import.meta.url), join(prebuilt, file))
  }
  vi.stubEnv('CODEXY_NATIVE_IMAGE_PREBUILT', prebuilt)
  return { root, prebuilt }
}
describe('portable native image build artifact', () => {
  it.each(['explicit', 'cache'])('copies a verified %s codec without invoking a Rust compiler', async mode => {
    const { root, prebuilt } = await fixture()
    if (mode === 'cache') vi.stubEnv('CODEXY_NATIVE_IMAGE_PREBUILT', undefined)
    vi.stubEnv('CODEXY_NATIVE_IMAGE_RUSTC', '/nonexistent/rustc')
    const result = await buildNativeImageCodec(root)
    expect(result.target).toBe('wasm32-unknown-unknown')
    expect(await readFile(join(root, 'packages/models/lib/native-image-codec.wasm')))
      .toEqual(await readFile(join(prebuilt, 'native-image-codec.wasm')))
  })
  it.each(['artifact', 'source'])('rejects changed %s before copying', async kind => {
    const { root, prebuilt } = await fixture()
    const path = kind === 'artifact' ? join(prebuilt, 'native-image-codec.wasm') : join(root, 'packages/models/native-image-codec/src/lib.rs')
    await writeFile(path, 'changed test input')
    await expect(buildNativeImageCodec(root)).rejects.toThrow('does not match')
  })
})
