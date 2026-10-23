/** Request-local HTTP observations for pi-ai protocols with a fetch integration. */

import type { GenerateOptions, LlmRequestTiming } from '@codexydsh/runtime/llm'
import type { FetchFunction } from '@earendil-works/pi-ai'

/**
 * Observe dispatch, response headers, and first nonempty bytes without buffering the body.
 * @param observe - the owning request's transport observer.
 * @returns a fetch implementation retaining global proxy routing and reader cancellation.
 */
export function timedFetch(observe: NonNullable<GenerateOptions['onRequestTiming']>): FetchFunction {
  const mark = (phase: LlmRequestTiming['phase']): void => { observe({ phase, time: Date.now() }) }
  return async (input, init) => {
    mark('http-start')
    const response = await globalThis.fetch(input, init)
    mark('response-headers')
    if (!response.ok || response.body === null) return response
    let observed = false
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        if (!observed && bytes.byteLength > 0) {
          observed = true
          mark('first-byte')
        }
        controller.enqueue(bytes)
      },
    }))
    const measured = new Response(body, response)
    // SDK diagnostics read transport metadata that a constructed Response does not retain.
    Object.defineProperties(measured, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
    })
    mark('response-ready')
    return measured
  }
}
