/** Product metadata shares the upstream paged and live event feed. */
import { describe, expect, it, vi } from 'vitest'
import { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import { productEventSource, isProductSurfaceEvent } from '../src/client/product-events.ts'

function feature(seq: number): SessionEvent<'codexy/fact'> {
  return { type: 'codexy/fact', seq: SessionSeq(seq), time: 123,
    data: { type: 'runtime/feature', data: { name: 'tool-notification', version: 1 } } }
}

describe('product event feed', () => {
  it('preserves subscription identity and projects one live carrier into one logical event', () => {
    const source = new MutableSessionEventSource()
    const projected = productEventSource(source)
    expect(productEventSource(source)).toBe(projected)
    expect(projected.getSnapshot()).toBe(projected.getSnapshot())
    const listener = vi.fn()
    const release = projected.subscribe(listener)
    source.append({ type: 'event', event: feature(3) })
    expect(listener).toHaveBeenCalledOnce()
    const window = projected.getSnapshot()
    expect(window.entries).toEqual([{ type: 'event', event: {
      type: 'runtime/feature', seq: SessionSeq(3), time: 123, data: { name: 'tool-notification', version: 1 },
    } }])
    expect(window.change).toEqual({ kind: 'append', entries: window.entries })
    expect(projected.getSnapshot()).toBe(window)
    release()
    source.append({ type: 'event', event: feature(4) })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('projects older pages while keeping cursor and delta consistent', () => {
    const source = new MutableSessionEventSource()
    source.replace([{ type: 'event', event: feature(3) }], true)
    const projected = productEventSource(source)
    source.prepend([{ type: 'event', event: feature(2) }], false)
    const window = projected.getSnapshot()
    expect(window.hasMore).toBe(false)
    expect(window.entries.map(item => item.event.seq)).toEqual([SessionSeq(2), SessionSeq(3)])
    expect(window.change).toEqual({ kind: 'prepend', entries: window.entries.slice(0, 1) })
    const event = window.entries[0]
    if (event?.type !== 'event') throw new Error('fixture must retain a durable event')
    expect(isProductSurfaceEvent(event.event)).toBe(false)
  })
})
