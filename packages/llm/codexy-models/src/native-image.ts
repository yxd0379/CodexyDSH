/** Product-owned Codex high-detail image preparation over public verbatim assets. */
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { LlmError } from '@codexydsh/runtime/llm'
import type { CodexNativeImageFacts } from '@codexydsh/runtime/llm'
import type { GenerateOptions } from '@codexydsh/runtime/llm'
import { prepareExactNativeImage } from './native-image-wasm.ts'

export interface NativePreparedImage {
  readonly nativeViewImage: true
  readonly data: Uint8Array
  readonly mediaType: ImageMediaType
  readonly bytes: number
  readonly width: number
  readonly height: number
}

const PATCH_SIZE = 32
const MAX_DIMENSION = 2048
const MAX_PATCHES = 2500

/** Pinned Codex utils/image HIGH_DETAIL dimensions, including ceil-rounded patch accounting. */
export function nativeHighDetailDimensions(width: number, height: number): { width: number; height: number } {
  width = Math.max(1, width)
  height = Math.max(1, height)
  const fits = (w: number, h: number) => w <= MAX_DIMENSION && h <= MAX_DIMENSION
    && Math.ceil(w / PATCH_SIZE) * Math.ceil(h / PATCH_SIZE) <= MAX_PATCHES
  if (fits(width, height)) return { width, height }
  const edgeScale = Math.min(MAX_DIMENSION / Math.max(width, height), 1)
  const w = Math.max(1, Math.round(width * edgeScale)), h = Math.max(1, Math.round(height * edgeScale))
  if (fits(w, h)) return { width: w, height: h }
  let scale = Math.sqrt(PATCH_SIZE * PATCH_SIZE * MAX_PATCHES / w / h)
  const columns = w * scale / PATCH_SIZE, rows = h * scale / PATCH_SIZE
  scale *= Math.min(Math.floor(columns) / columns, Math.floor(rows) / rows)
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)) }
}

/** Re-read verified immutable source bytes, never the mutable original filesystem path. */
export async function prepareNativeViewImage(
  attachments: AttachmentStore, facts: CodexNativeImageFacts, signal?: AbortSignal,
): Promise<NativePreparedImage> {
  signal?.throwIfAborted()
  if (facts.file.bytes > attachments.imageLimits.maxImageBytes) throw new LlmError('native view_image source exceeds the deployment byte limit', 'UNSUPPORTED_CONTENT')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of attachments.readFileStream(facts.file, signal)) {
    signal?.throwIfAborted()
    bytes += chunk.byteLength
    if (bytes > facts.file.bytes) throw new LlmError('native view_image source byte length changed', 'UNSUPPORTED_CONTENT')
    chunks.push(Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks)
  const digest = createHash('sha256').update(raw).digest('hex')
  if (bytes !== facts.file.bytes || facts.file.attachmentId !== `sha256:${digest}`) {
    throw new LlmError('native view_image source digest or byte length changed', 'UNSUPPORTED_CONTENT')
  }
  if (facts.version === 2) {
    const mediaType = raw.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : raw[0] === 255 && raw[1] === 216 && raw[2] === 255 ? 'image/jpeg'
        : raw.subarray(0, 4).toString() === 'RIFF' && raw.subarray(8, 12).toString() === 'WEBP' ? 'image/webp'
          : ['GIF87a', 'GIF89a'].includes(raw.subarray(0, 6).toString()) ? 'image/gif' : undefined
    if (mediaType === undefined || mediaType !== facts.mediaType) throw new LlmError('native view_image source format changed', 'UNSUPPORTED_CONTENT')
    const prepared = await prepareExactNativeImage(raw, { maxBytes: attachments.imageLimits.maxImageBytes,
      maxPixels: attachments.imageLimits.maxImagePixels, maxDimension: attachments.imageLimits.maxImageDimension }, signal)
    if (prepared.sourceWidth !== facts.width || prepared.sourceHeight !== facts.height) {
      throw new LlmError('native view_image source dimensions changed', 'UNSUPPORTED_CONTENT')
    }
    return { nativeViewImage: true, data: prepared.data, mediaType: prepared.mediaType, bytes: prepared.data.byteLength,
      width: prepared.width, height: prepared.height }
  }
  if (facts.version !== 1) throw new LlmError('unsupported native image preparation version', 'UNSUPPORTED_CONTENT')
  // Version 1 is immutable recovery policy: retain its original Sharp rules.
  const source = sharp(raw, { failOn: 'error', limitInputPixels: attachments.imageLimits.maxImagePixels, pages: 1 })
  const metadata = await source.metadata()
  const mediaType = ({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' } as const)[metadata.format as 'png' | 'jpeg' | 'webp' | 'gif']
  const height = metadata.pageHeight ?? metadata.height
  if (mediaType === undefined || mediaType !== facts.mediaType || metadata.width !== facts.width || height !== facts.height
    || facts.width > attachments.imageLimits.maxImageDimension || facts.height > attachments.imageLimits.maxImageDimension) {
    throw new LlmError('native view_image source format or dimensions changed', 'UNSUPPORTED_CONTENT')
  }
  const target = nativeHighDetailDimensions(facts.width, facts.height)
  if (mediaType !== 'image/gif' && target.width === facts.width && target.height === facts.height) {
    // Native preserves all valid PNG/JPEG/WebP bytes when no resize is needed.
    // A normalized UI copy is not a substitute for this original source.
    // Decoding is mandatory even when preserving bytes; a header probe alone
    // must not admit a corrupted asset imported through a restored session.
    await source.clone().stats()
    signal?.throwIfAborted()
    return { nativeViewImage: true, data: raw, mediaType, bytes, ...target }
  }
  let prepared = source.resize(target.width, target.height, { fit: 'fill', kernel: 'linear', fastShrinkOnLoad: false })
  if (metadata.exif !== undefined) prepared = prepared.keepExif()
  if (metadata.icc?.subarray(16, 20).equals(Buffer.from('RGB '))) prepared = prepared.keepIccProfile()
  const output = mediaType === 'image/jpeg' ? await prepared.jpeg({ quality: 85, chromaSubsampling: '4:4:4', optimiseCoding: false }).toBuffer()
    : mediaType === 'image/webp' ? await prepared.ensureAlpha().webp({ lossless: true }).toBuffer()
      : await prepared.ensureAlpha().png().toBuffer()
  signal?.throwIfAborted()
  return { nativeViewImage: true, data: output, mediaType: mediaType === 'image/gif' ? 'image/png' : mediaType,
    bytes: output.byteLength, ...target }
}

/** The stock SDK defaults images to auto; the explicit native view tool uses high. */
export function nativeViewImagePayload(payload: Record<string, unknown>, options: GenerateOptions): Record<string, unknown> {
  if (options.codexfulResponses?.wireProfile !== 'codex-0.162.1' || !Array.isArray(payload['input'])) return payload
  const calls = new Map<string, boolean[]>()
  for (const message of options.messages) {
    if (message.role !== 'tool') continue
    calls.set(String(message.toolCallId).split('|')[0]!, message.content
      .filter(block => block.type === 'image' && block.offloaded !== true)
      .map(block => block.type === 'image' && block.codexNativeImage !== undefined))
  }
  return { ...payload, input: payload['input'].map((item: unknown) => {
    if (typeof item !== 'object' || item === null || !('type' in item) || item.type !== 'function_call_output'
      || !('call_id' in item) || !calls.has(String(item.call_id)) || !('output' in item) || !Array.isArray(item.output)) return item
    const images = calls.get(String(item.call_id))!
    let index = 0
    return { ...item, output: item.output.map((part: unknown) => {
      if (typeof part !== 'object' || part === null || !('type' in part) || part.type !== 'input_image') return part
      return images[index++] === true ? { ...part, detail: 'high' } : part
    }) }
  }) }
}
