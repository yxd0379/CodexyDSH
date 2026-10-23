/** Version 2 codec: product-owned pinned native image processing, with no host imports. */
import { readFile } from 'node:fs/promises'
import { LlmError } from '@codexydsh/runtime/llm'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

export interface NativeCodecLimits { readonly maxBytes: number; readonly maxPixels: number; readonly maxDimension: number }
export interface NativeCodecImage {
  readonly data: Uint8Array
  readonly mediaType: ImageMediaType
  readonly sourceWidth: number
  readonly sourceHeight: number
  readonly width: number
  readonly height: number
}
interface NativeCodecExports {
  memory: WebAssembly.Memory
  allocate_input(length: number): number
  prepare_image(pointer: number, length: number, maxBytes: number, maxPixels: number, maxDimension: number): number
  release_input(pointer: number, length: number): void
  release_result(pointer: number): void
}
let codec: Promise<NativeCodecExports> | undefined
async function loadCodec(): Promise<NativeCodecExports> {
  const packageJson = import.meta.resolve('@codexydsh/models/package.json')
  const data = await readFile(new URL('./lib/native-image-codec.wasm', packageJson))
  const module = await WebAssembly.compile(data)
  if (WebAssembly.Module.imports(module).length !== 0) throw new Error('native image codec requires unsupported host imports')
  const instance = await WebAssembly.instantiate(module, {})
  if (!(instance.exports['memory'] instanceof WebAssembly.Memory)
    || ['allocate_input', 'prepare_image', 'release_input', 'release_result'].some(name => typeof instance.exports[name] !== 'function')) {
    throw new Error('native image codec ABI is unavailable')
  }
  return instance.exports as unknown as NativeCodecExports
}

/** Synchronous ABI work cannot interleave; every returned buffer owns copied bytes. */
export async function prepareExactNativeImage(raw: Uint8Array, limits: NativeCodecLimits, signal?: AbortSignal): Promise<NativeCodecImage> {
  signal?.throwIfAborted()
  for (const value of [raw.byteLength, limits.maxBytes, limits.maxPixels, limits.maxDimension]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffff_ffff) {
      throw new LlmError('native image input or deployment limits exceed the supported codec range', 'UNSUPPORTED_CONTENT')
    }
  }
  let api: NativeCodecExports
  try { api = await (codec ??= loadCodec()) }
  catch (error) {
    // An absent or invalid packaged codec must never select another encoder.
    throw new LlmError(`native image codec unavailable: ${error instanceof Error ? error.message : String(error)}`, 'UNSUPPORTED_CONTENT')
  }
  signal?.throwIfAborted()
  let input: number | undefined
  let descriptor: number | undefined
  try {
    input = api.allocate_input(raw.byteLength) >>> 0
    new Uint8Array(api.memory.buffer, input, raw.byteLength).set(raw)
    signal?.throwIfAborted()
    descriptor = api.prepare_image(input, raw.byteLength, limits.maxBytes, limits.maxPixels, limits.maxDimension) >>> 0
    // prepare_image may grow memory, so acquire both views after it returns.
    const values = new DataView(api.memory.buffer, descriptor, 32)
    const pointer = values.getUint32(0, true), length = values.getUint32(4, true), mime = values.getUint32(8, true)
    const sourceWidth = values.getUint32(12, true), sourceHeight = values.getUint32(16, true)
    const width = values.getUint32(20, true), height = values.getUint32(24, true), error = values.getUint32(28, true)
    const data = new Uint8Array(api.memory.buffer, pointer, length).slice()
    if (error !== 0) throw new LlmError(new TextDecoder().decode(data), 'UNSUPPORTED_CONTENT')
    const mediaType = ({ 1: 'image/png', 2: 'image/jpeg', 3: 'image/webp' } as const)[mime as 1 | 2 | 3]
    if (mediaType === undefined || length === 0 || [sourceWidth, sourceHeight, width, height].some(value => value === 0)) {
      throw new LlmError('native image codec returned invalid image facts', 'UNSUPPORTED_CONTENT')
    }
    signal?.throwIfAborted()
    return { data, mediaType, sourceWidth, sourceHeight, width, height }
  } finally {
    try { if (descriptor !== undefined) api.release_result(descriptor) }
    finally { if (input !== undefined) api.release_input(input, raw.byteLength) }
  }
}
