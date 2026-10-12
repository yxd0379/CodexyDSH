/** Independently mounted Codexful memory namespace and Settings browser. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import memoryRemote from '@codexydsh/api-memory/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@codexydsh/ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { MemorySettings } from './MemorySettings.tsx'
import { MemoryToast } from './MemoryAction.tsx'
import type { MemoryActionInjected, MemoryNotice, MemoryToastInjected } from './MemoryAction.tsx'
import { MemoryViewController } from './model.ts'
import type { MemoryRemote } from './model.ts'
import { en, NS, zh } from './locales.ts'
import type { MemoryKey } from './locales.ts'
import { resolveStatusPollMs } from '../config.ts'
import type { MemoryUiConfig } from '../config.ts'

export type { MemoryActionInjected, MemoryActionProps, MemoryNotice, MemoryToastInjected, MemoryToastProps } from './MemoryAction.tsx'
export type { MemoryKey } from './locales.ts'
export type { MemoryRemote, MemoryView, MemoryViewError } from './model.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { /** Human memory browser copy. */ memory: MemoryKey }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** A memory operation retaining its exact Client Session until the Host responds. */
    memoryBrowser: unknown
  }
}

/** Retain the addressed Session and wait for its history before every Agent-bound RPC. */
function leasedMemory(memory: MemoryRemote, sessions: ISessions): MemoryRemote {
  const using = <Value>(sessionId: SessionId, signal: AbortSignal | undefined, call: () => Promise<Value>): Promise<Value> =>
    sessions.using(sessionId, { source: 'memoryBrowser', ...(signal === undefined ? {} : { signal }) }, async (reference) => {
      signal?.throwIfAborted()
      const state = reference.binding.session.getSnapshot()
      if (state.openState !== 'open') throw state.openError ?? new Error(`Memory Session "${sessionId}" is not open`)
      return call()
    })
  return {
    snapshot: (id, signal) => using(id, signal, () => memory.snapshot(id, signal)),
    list: (id, request, signal) => using(id, signal, () => memory.list(id, request, signal)),
    read: (id, request, signal) => using(id, signal, () => memory.read(id, request, signal)),
    search: (id, request, signal) => using(id, signal, () => memory.search(id, request, signal)),
    edit: (id, request, signal) => using(id, signal, () => memory.edit(id, request, signal)),
    refresh: (id, signal) => using(id, signal, () => memory.refresh(id, signal)),
  }
}

/** Required browser services; this plugin mounts its own optional memory namespace. */
export const inject = ['remote', 'sessions', 'slots', 'locale', 'configForms']

/** Mount the memory Remote contribution and register effect-owned browser surfaces.
 * @param ctx - Client root carrying the Remote carrier and typed Slot registry.
 * @returns Namespace disposer; Cordis removes all accompanying effects on unload.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-memory: dictionaries')
  const unmount = await ctx.remote.$mount(memoryRemote)
  const surfaces = new Map<SessionId, MemoryViewController>()
  const configuration = ctx.configForms.get<MemoryUiConfig>('codexy-ui-memory')
  const notice = createSnapshotStore<MemoryNotice | null>(null)
  let sequence = 0
  ctx.effect(() => () => { for (const surface of surfaces.values()) surface.dispose(); surfaces.clear() }, 'ui-memory: Session views')
  ctx.effect(() => configuration.subscribe(() => {
    for (const surface of surfaces.values()) surface.restartStatusPolling()
  }), 'ui-memory: status interval')
  ctx.inject(['remote.memory'], (scope) => {
    const memory = leasedMemory(scope.remote.memory, scope.sessions)
    const surfaceFor = (sessionId: SessionId): MemoryViewController => {
      const previous = surfaces.get(sessionId)
      if (previous !== undefined) return previous
      const surface = new MemoryViewController(memory, sessionId, (outcome) => { notice.set({ sequence: ++sequence, outcome }) },
        () => resolveStatusPollMs(configuration.getSnapshot().value))
      surfaces.set(sessionId, surface)
      return surface
    }
    const operations = (sessionId: SessionId): MemoryActionInjected => {
      const surface = surfaceFor(sessionId)
      return {
        hooks: { memoryView: surface.state }, openMemory: () => { surface.open() }, closeMemory: () => { surface.close() },
        reloadMemory: () => surface.load(), setMemoryQuery: (query) => { surface.setQuery(query) },
        searchMemory: cursor => surface.search(cursor), listMemory: (path, cursor) => surface.list(path, cursor),
        readMemory: path => surface.read(path), editMemory: () => { surface.beginEdit() },
        setMemoryDraft: (content) => { surface.setDraft(content) }, discardMemory: () => { surface.discard() },
        saveMemory: () => surface.save(), refreshMemory: () => surface.refresh(), observeMemory: () => surface.observe(),
      }
    }
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section', id: 'memory', locale: NS, order: 25,
      label: () => scope.locale.bind(NS)('title'), inject: () => ({ memoryFor: operations }),
    }, MemorySettings))
    scope.slots.inject('shell.overlay', () => scope.slots.register({
      name: 'shell.overlay', id: 'memory.notice', locale: NS,
      inject: (): MemoryToastInjected => ({ hooks: { memoryNotice: notice }, dismissMemoryNotice: () => { notice.set(null) } }),
    }, MemoryToast))
  })
  return unmount
}
