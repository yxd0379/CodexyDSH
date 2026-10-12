/** Publish the installation's unchanged browser Session layer without its Host controller. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import type { WebBootGraph, WebBootEntry } from '@deepseek-ai/dsh-client-modules'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { z } from 'zod'

const provider = '@deepseek-ai/dsh-api-session-controller'
const metadata = z.object({ name: z.literal(provider), version: z.literal(getDshRuntimeVersion()),
  dsh: z.object({ client: z.object({ platform: z.literal('web'),
    inject: z.array(z.string()).optional(), external: z.array(z.string()).optional(),
    immediately: z.boolean().optional(),
  }) }),
})

/** The public Host owns graph composition, authenticated routing, and index injections. */
export const inject = ['clientModules', 'webServer']

/** Add the unchanged published Session factory to both initial and live browser graphs.
 * @param ctx - Product Host context with the released Web services.
 */
export function apply(ctx: Context): void {
  const require = createRequire(import.meta.url)
  const manifest = metadata.parse(JSON.parse(readFileSync(require.resolve(provider + '/package.json'), 'utf8')))
  const bytes = readFileSync(require.resolve(provider + '/client'))
  const rev = createHash('sha256').update(bytes).digest('hex')
  const url = `codexy-platform/session-client.${rev}.js`
  const entry: WebBootEntry = { id: provider, rev, url, ...manifest.dsh.client }
  const graphs = new WeakMap<WebBootGraph, WebBootGraph>()
  const extend = (base: WebBootGraph): WebBootGraph => {
    if (base.entries.some(row => row.id === provider)) return base
    const cached = graphs.get(base)
    if (cached !== undefined) return cached
    const entries = [...base.entries]
    const after = Math.max(-1, ...entries.map((row, index) => entry.inject?.includes(row.id) ? index : -1)) + 1
    entries.splice(after, 0, entry)
    const graph: WebBootGraph = { rev: createHash('sha256').update(base.rev + ':' + rev).digest('hex'), entries,
      batches: [...base.batches, { phase: 'application', url, rev, entries: [provider] }] }
    graphs.set(base, graph)
    return graph
  }
  const modules = ctx.clientModules
  ctx.effect(() => {
    const previous = Object.getOwnPropertyDescriptor(modules, 'graph')
    const graph = modules.graph.bind(modules)
    Object.defineProperty(modules, 'graph', { configurable: true, writable: true, value: () => extend(graph()) })
    return () => {
      if (previous === undefined) Reflect.deleteProperty(modules, 'graph')
      else Object.defineProperty(modules, 'graph', previous)
    }
  }, 'codexy-browser-session: public graph contribution')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/' + url, handler(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return }
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' })
    response.end(request.method === 'HEAD' ? undefined : bytes)
  } }), 'codexy-browser-session: published artifact route')
  ctx.on('webserver/index-inject', (table) => {
    const row = table.findIndex(item => item.kind === 'global' && item.name === '__DSH_BOOT__')
    if (row < 0) throw new Error('codexy-browser-session: public boot graph injection is missing')
    table[row] = { kind: 'global', name: '__DSH_BOOT__', value: modules.graph() }
  })
}
