/** Native central image preparation against public immutable attachment assets. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { CodexNativeImageFacts } from '@codexydsh/runtime/llm'
import { nativeHighDetailDimensions, prepareNativeViewImage } from '../src/native-image.ts'

const contexts: Array<{ ctx: Context; home: string }> = []
afterEach(async () => { for (const { ctx, home } of contexts.splice(0)) {
  await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true })
} })
async function fixture(data: Uint8Array, mediaType: ImageMediaType, config: { maxImageBytes?: number; maxImagePixels?: number; maxImageDimension?: number } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'native-image-preparation-'))
  const ctx = new Context(); contexts.push({ ctx, home })
  await ctx.plugin(LocalAttachmentStore, { dshHome: home, ...config })
  const meta = await sharp(data, { pages: 1 }).metadata()
  const facts: CodexNativeImageFacts = { version: 2, tool: 'view_image', mediaType, file: await ctx.attachments.saveFile({ data, name: 'fixture.image' }),
    width: meta.width!, height: meta.pageHeight ?? meta.height! }
  return { ctx, facts, home }
}
async function coldPrepared(f: Awaited<ReturnType<typeof fixture>>) {
  await f.ctx.fiber.dispose()
  const cold = new Context()
  await cold.plugin(LocalAttachmentStore, { dshHome: f.home })
  try { return await prepareNativeViewImage(cold.attachments, JSON.parse(JSON.stringify(f.facts)) as CodexNativeImageFacts) }
  finally { await cold.fiber.dispose() }
}
function digest(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex') }
async function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 231, g: 12, b: 42 } } }).png().toBuffer()
}

describe('pinned high-detail central image preparation', () => {
  it.each([[2048, 2048, 1600, 1600], [4000, 1000, 2048, 512], [2048, 1600, 1792, 1400], [8192, 1, 2048, 1]])(
    'prepares %d x %d under the actual edge/patch budget as %d x %d', async (width, height, outWidth, outHeight) => {
      const f = await fixture(await png(width, height), 'image/png')
      const image = await prepareNativeViewImage(f.ctx.attachments, f.facts)
      expect({ width: image.width, height: image.height }).toEqual({ width: outWidth, height: outHeight })
      const output = await sharp(image.data).metadata()
      expect(output).toMatchObject({ format: 'png', width: outWidth, height: outHeight, hasAlpha: true })
      expect(Math.ceil(image.width / 32) * Math.ceil(image.height / 32)).toBeLessThanOrEqual(2500)
      expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(2048)
      expect(digest((await coldPrepared(f)).data)).toBe(digest(image.data))
    })

  it.each(['image/png', 'image/jpeg', 'image/webp'] as const)('preserves all original bytes for an already-fitting %s', async mediaType => {
    let image = sharp({ create: { width: 47, height: 39, channels: 3, background: '#ed162a' } })
    const source = await (mediaType === 'image/png' ? image.png() : mediaType === 'image/jpeg' ? image.jpeg() : image.webp()).toBuffer()
    const f = await fixture(source, mediaType)
    const prepared = await prepareNativeViewImage(f.ctx.attachments, f.facts)
    expect(Buffer.from(prepared.data)).toEqual(source)
    expect(prepared).toMatchObject({ mediaType, width: 47, height: 39, bytes: source.length })
  })

  it('converts an animated GIF to exactly its first frame PNG', async () => {
    const red = Buffer.alloc(8 * 4 * 3); for (let i = 0; i < red.length; i += 3) red[i] = 255
    const blue = Buffer.alloc(8 * 4 * 3); for (let i = 2; i < blue.length; i += 3) blue[i] = 255
    const gif = await sharp(Buffer.concat([red, blue]), { raw: { width: 8, height: 8, channels: 3, pageHeight: 4 } })
      .gif({ loop: 0, delay: [100, 100] }).toBuffer()
    expect(await sharp(gif, { animated: true }).metadata()).toMatchObject({ format: 'gif', pages: 2, pageHeight: 4 })
    const f = await fixture(gif, 'image/gif')
    const image = await prepareNativeViewImage(f.ctx.attachments, f.facts)
    expect(image).toMatchObject({ mediaType: 'image/png', width: 8, height: 4 })
    const pixels = await sharp(image.data).removeAlpha().raw().toBuffer()
    expect(pixels).toEqual(red)
    expect(digest((await coldPrepared(f)).data)).toBe(digest(image.data))
  })

  it.each(['source-bytes', 'decoded-pixels', 'source-dimensions', 'fact-dimensions', 'fact-mime', 'tampered', 'missing'])(
    'rejects invalid or inadmissible source before request encoding (%s)', async mode => {
      const source = await png(30, 20)
      const f = await fixture(source, 'image/png', mode === 'source-bytes' ? { maxImageBytes: 1 }
        : mode === 'decoded-pixels' ? { maxImagePixels: 100 } : mode === 'source-dimensions' ? { maxImageDimension: 10 } : {})
      const facts = mode === 'fact-dimensions' ? { ...f.facts, width: 31 }
        : mode === 'fact-mime' ? { ...f.facts, mediaType: 'image/jpeg' as const } : f.facts
      if (mode === 'tampered') {
        // The stock provider protects immutable objects as read-only. Change
        // only this owned test asset to exercise its full integrity failure.
        await chmod(f.ctx.attachments.fileHostPath(facts.file)!, 0o600)
        await writeFile(f.ctx.attachments.fileHostPath(facts.file)!, 'tampered owned fixture asset')
      }
      if (mode === 'missing') await rm(f.ctx.attachments.fileHostPath(facts.file)!)
      await expect(prepareNativeViewImage(f.ctx.attachments, facts)).rejects.toThrow()
    })

  it('fully decodes a fitting original before admitting its bytes from imported facts', async () => {
    const original = await readFile(new URL('./fixtures/code-from-image.png', import.meta.url))
    const truncated = original.subarray(0, Math.floor(original.length / 2))
    const f = await fixture(truncated, 'image/png')
    expect(f.facts).toMatchObject({ width: 1160, height: 804 })
    await expect(prepareNativeViewImage(f.ctx.attachments, f.facts)).rejects.toThrow()
  })

  it('uses the pinned patch-grid boundary rather than a guessed 1600px longest edge', () => {
    expect(nativeHighDetailDimensions(2048, 1000)).toEqual({ width: 2048, height: 1000 })
    expect(nativeHighDetailDimensions(1600, 1600)).toEqual({ width: 1600, height: 1600 })
    expect(nativeHighDetailDimensions(1632, 1600).width).toBeLessThan(1632)
  })

  it('retains version1 Sharp preparation and its exact bytes across cold restoration', async () => {
    const source = await readFile(new URL('./fixtures/gcode-native-v2/source-view_plane.png', import.meta.url))
    const f = await fixture(source, 'image/png')
    const legacy = { ...f.facts, version: 1 as const }
    const image = await prepareNativeViewImage(f.ctx.attachments, legacy)
    expect(image).toMatchObject({ mediaType: 'image/png', width: 1600, height: 1600 })
    // Oracle from the frozen FIX4 compiled product: restoring must not migrate it.
    expect(digest(image.data)).toBe('6cb545d8518340145603594a6687c3e02e9b88fa4d6b856adc44e5c16ae6390c')
    expect(image.bytes).toBe(100646)
    f.facts = legacy
    expect(digest((await coldPrepared(f)).data)).toBe(digest(image.data))
  })
})
