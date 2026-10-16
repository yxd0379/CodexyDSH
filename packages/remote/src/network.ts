/** Explicit per-host overrides of the remote launch environment. DSH owns proxy routing. */
import type { RemoteHostConfig } from './types.ts'

/** Inherit untouched by default; set both casings so old shell values cannot win. */
export function remoteNetworkEnvironment(target: RemoteHostConfig): Record<string, string> {
  if (target.proxyMode !== 'custom' && target.proxyMode !== 'direct') return {}
  let proxy = ''
  if (target.proxyMode === 'custom') {
    const url = new URL(target.proxyUrl ?? '')
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('远端代理须为 http:// 或 https:// 代理地址')
    }
    proxy = url.href
  }
  const noProxy = target.proxyMode === 'direct' ? '*' : [target.noProxy, 'localhost', '127.0.0.1', '::1', '[::1]'].filter(Boolean).join(',')
  return { http_proxy: proxy, HTTP_PROXY: proxy, https_proxy: proxy, HTTPS_PROXY: proxy,
    all_proxy: proxy, ALL_PROXY: proxy, no_proxy: noProxy, NO_PROXY: noProxy }
}
