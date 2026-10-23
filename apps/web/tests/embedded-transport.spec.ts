/** Embedded Remote sockets retain the public mount and use the owning HTTP Host. */
import { describe, expect, it } from 'vitest'
import { embeddedTransport, isEmbeddedWeb } from '../src/embedded-transport.ts'

describe('embedded Web boot', () => {
  it('requires both the explicit query flag and a framed document', () => {
    const url = new URL('https://local.test/codexy-remote/ascend/?codexydsh-embedded=1')
    expect(isEmbeddedWeb(url, true)).toBe(true)
    expect(isEmbeddedWeb(url, false)).toBe(false)
    expect(isEmbeddedWeb(new URL('https://local.test/codexy-remote/ascend/'), true)).toBe(false)
  })

  it('uses the Desktop physical HTTP authority and the child mount for sockets', () => {
    const url = new URL('dsh-app://app/codexy-remote/ascend/?codexydsh-embedded=1&token=private')
    expect(embeddedTransport(url, 'http://127.0.0.1:39001/')).toEqual({
      ownsHost: true, streamBaseUrl: 'http://127.0.0.1:39001/codexy-remote/ascend/',
    })
    expect(embeddedTransport(url, 'http://127.0.0.1:39001/another-mount/')).toEqual({
      ownsHost: true, streamBaseUrl: 'http://127.0.0.1:39001/codexy-remote/ascend/',
    })
  })

  it('leaves ordinary HTTP documents on their own base and preserves a public subpath', () => {
    const url = new URL('https://local.test/product/codexy-remote/host-id/')
    expect(embeddedTransport(url, undefined)).toBeUndefined()
    expect(embeddedTransport(url, 'https://local.test/product/')).toEqual({
      ownsHost: true, streamBaseUrl: 'https://local.test/product/codexy-remote/host-id/',
    })
  })

  it('rejects a custom-scheme child without an HTTP Host or a Remote mount', () => {
    expect(() => embeddedTransport(new URL('dsh-app://app/codexy-remote/ascend/'), undefined)).toThrow('HTTP Host address')
    expect(() => embeddedTransport(new URL('dsh-app://app/codexy-remote/ascend/'), 'dsh-app://app/')).toThrow('HTTP or HTTPS')
    expect(() => embeddedTransport(new URL('https://local.test/'), undefined)).toThrow('Remote application mount')
  })
})
