/** The real packaged native codec ABI: detached output ownership and cleanup on every terminal arm. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const limits = { maxBytes: 20 * 1024 * 1024, maxPixels: 64_000_000, maxDimension: 8192 }
function digest(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex') }
beforeEach(() => vi.resetModules())
afterEach(() => vi.restoreAllMocks())

interface NativeExports {
  memory: WebAssembly.Memory
  allocate_input(length: number): number
  prepare_image(pointer: number, length: number, maxBytes: number, maxPixels: number, maxDimension: number): number
  release_input(pointer: number, length: number): void
  release_result(pointer: number): void
}
function instrument(controller?: AbortController, abortAt?: 'allocated' | 'prepared') {
  const real = WebAssembly.instantiate.bind(WebAssembly)
  const events: string[] = []
  let memory: WebAssembly.Memory | undefined
  vi.spyOn(WebAssembly, 'instantiate').mockImplementation(async (module: WebAssembly.Module, imports?: WebAssembly.Imports) => {
    const instance = await real(module, imports), api = instance.exports as unknown as NativeExports
    memory = api.memory
    return { exports: { memory: api.memory,
      allocate_input(length: number) { const pointer = api.allocate_input(length); events.push('allocate-input');
        if (abortAt === 'allocated') controller!.abort('owned fixture abort'); return pointer },
      prepare_image(...args: [number, number, number, number, number]) { const pointer = api.prepare_image(...args); events.push('prepare-image');
        if (abortAt === 'prepared') controller!.abort('owned fixture abort'); return pointer },
      release_result(pointer: number) { events.push('release-result'); api.release_result(pointer) },
      release_input(pointer: number, length: number) { events.push('release-input'); api.release_input(pointer, length) },
    } } as unknown as WebAssembly.Instance
  })
  return { events, memory: () => memory }
}

describe('native image WASM ownership', () => {
  it('uses one real module continuously without later allocations changing returned image bytes or growing a leak', async () => {
    const watched = instrument()
    const { prepareExactNativeImage } = await import('../src/native-image-wasm.ts')
    const source = await readFile(new URL('./fixtures/gcode-native-v2/source-view_plane.png', import.meta.url))
    const small = await readFile(new URL('./fixtures/code-from-image.png', import.meta.url))
    const first = await prepareExactNativeImage(source, limits)
    expect(digest(first.data)).toBe('7ee0f174f967908b1f77ce88487169fcc8837f971a9093ce189d789ab1fff340')
    expect(first.data.buffer).not.toBe(watched.memory()!.buffer)
    const capacity = watched.memory()!.buffer.byteLength
    for (let i = 0; i < 4; i++) {
      const next = await prepareExactNativeImage(i % 2 === 0 ? small : source, limits)
      expect(next.data.buffer).not.toBe(watched.memory()!.buffer)
      expect(digest(first.data)).toBe('7ee0f174f967908b1f77ce88487169fcc8837f971a9093ce189d789ab1fff340')
    }
    expect(watched.events.filter(item => item === 'release-result')).toHaveLength(5)
    expect(watched.events.filter(item => item === 'release-input')).toHaveLength(5)
    expect(watched.memory()!.buffer.byteLength).toBe(capacity)
    expect(WebAssembly.instantiate).toHaveBeenCalledTimes(1)
  })

  it('releases result and input after a real codec decode failure', async () => {
    const watched = instrument()
    const { prepareExactNativeImage } = await import('../src/native-image-wasm.ts')
    await expect(prepareExactNativeImage(Uint8Array.of(1, 2, 3, 4), limits)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(watched.events).toEqual(['allocate-input', 'prepare-image', 'release-result', 'release-input'])
  })

  it.each(['allocated', 'prepared'] as const)('releases every owned allocation on abort after %s', async abortAt => {
    const controller = new AbortController(), watched = instrument(controller, abortAt)
    const source = await readFile(new URL('./fixtures/code-from-image.png', import.meta.url))
    const { prepareExactNativeImage } = await import('../src/native-image-wasm.ts')
    await expect(prepareExactNativeImage(source, limits, controller.signal)).rejects.toBe('owned fixture abort')
    expect(watched.events).toEqual(abortAt === 'allocated' ? ['allocate-input', 'release-input']
      : ['allocate-input', 'prepare-image', 'release-result', 'release-input'])
  })

  it('fails closed on an invalid packaged module before allocating input', async () => {
    vi.spyOn(WebAssembly, 'compile').mockRejectedValue(new WebAssembly.CompileError('owned invalid codec fixture'))
    const instantiate = vi.spyOn(WebAssembly, 'instantiate')
    const { prepareExactNativeImage } = await import('../src/native-image-wasm.ts')
    await expect(prepareExactNativeImage(Uint8Array.of(1, 2, 3), limits)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT',
      message: 'native image codec unavailable: owned invalid codec fixture' })
    expect(instantiate).not.toHaveBeenCalled()
  })
})
