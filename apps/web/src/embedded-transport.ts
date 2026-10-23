/** Resolve the physical Host socket address for an embedded native Web client. */

interface EmbeddedTransport {
  ownsHost: boolean
  streamBaseUrl: string
}

/**
 * Whether the document explicitly requests the embedded application mode.
 * @param url - This document's address, not the parent address.
 * @param framed - Whether the document is inside an iframe.
 * @returns Whether this is an explicitly embedded Remote document.
 */
export function isEmbeddedWeb(url: URL, framed: boolean): boolean {
  return framed && url.searchParams.get('codexydsh-embedded') === '1'
}

/**
 * Build child-owned transport values without inheriting parent RPC objects.
 * @param url - Embedded document URL including its complete public mount path.
 * @param parentStreamBaseUrl - Same-origin parent's optional physical HTTP Host base.
 * @returns The child's socket base, or undefined when its ordinary HTTP document base suffices.
 */
export function embeddedTransport(url: URL, parentStreamBaseUrl: string | undefined): EmbeddedTransport | undefined {
  const prefix = /^(.*\/codexy-remote\/[^/]+\/)/u.exec(url.pathname)?.[1]
  if (prefix === undefined) throw new Error('embedded web: the document is outside a Remote application mount')
  if (parentStreamBaseUrl === undefined) {
    if (url.protocol === 'http:' || url.protocol === 'https:') return undefined
    throw new Error('embedded web: the parent did not provide its HTTP Host address')
  }
  const base = new URL(parentStreamBaseUrl)
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('embedded web: the parent Host address must use HTTP or HTTPS')
  }
  return { ownsHost: true, streamBaseUrl: new URL(prefix, base).href }
}
