/** Remote settings, connection actions, and remote-page identity. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@codexydsh/remote/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { DraftError, draftOperations, type RemoteSettings } from './model.ts'
import { RemoteSettingsPage, RemoteToast, RemoteIdentity, type RemoteNotice, type RemoteSettingsInjected } from './RemoteSettings.tsx'
import { en, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { /** Remote SSH configuration and connection identity. */ remote: keyof typeof zh }
}

/** Settings, connection model, locale, and presentation services. */
export const inject = ['remoteHosts', 'connection', 'slots', 'locale', 'configForms', 'codexySettingsSchema']

/** Register the Remote settings section and shell-owned feedback.
 * @param ctx - Browser plugin lifetime and declared services.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('remote', { zh, en }))
  const t = ctx.locale.bind('remote')
  const form = ctx.configForms.get<RemoteSettings>('codexy-remote')
  const notice = createSnapshotStore<RemoteNotice | null>(null)
  let sequence = 0
  const announce = (text: string, success: boolean): void => { notice.set({ sequence: ++sequence, text, success }) }
  const operation = async <T>(action: () => Promise<T>, success: keyof typeof zh): Promise<T> => {
    try { const value = await action(); announce(t(success), true); return value }
    catch (error) { announce(t('operationFailed', { message: error instanceof Error ? error.message : String(error) }), false); throw error }
  }
  const injected: RemoteSettingsInjected = {
    hooks: { remoteSettings: form, remoteHosts: ctx.remoteHosts },
    async saveHost(draft) {
      let edits
      try {
        edits = draftOperations(draft)
        if (draft.originalName === undefined && form.getSnapshot().value?.hosts[draft.name]) throw new DraftError('duplicate')
      } catch (error) {
        if (error instanceof DraftError) { error.message = t(error.key); throw error }
        throw error
      }
      await operation(async () => { if (!await form.mutate(edits, draft.revision)) throw new Error(t('rejected')) }, 'saved')
    },
    async removeHost(name, revision) {
      await operation(async () => {
        await ctx.remoteHosts.disconnect(name)
        if (!await form.mutate([{ op: 'set', path: ['hosts', name], value: null }], revision)) throw new Error(t('rejected'))
      }, 'removed')
    },
    async connectHost(name) {
      const page = window.open('about:blank', '_blank')
      if (page) { page.opener = null; page.document.title = t('connecting'); page.document.body.textContent = t('connecting') }
      try {
        const connected = await operation(async () => {
          const result = await ctx.remoteHosts.connect(name, new AbortController().signal)
          if (result.url === null) throw new Error(t('noUrl'))
          return result.url
        }, 'connectionReady')
        if (page && !page.closed) page.location.replace(connected)
      } catch (error) { page?.close(); throw error }
    },
    async disconnectHost(name) { await operation(() => ctx.remoteHosts.disconnect(name), 'connectionClosed') },
    openHost(url) { window.open(url, '_blank', 'noopener') },
    retryHosts() { ctx.remoteHosts.retry() },
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'remote', order: 35, label: () => t('title'), locale: 'remote', inject: () => injected,
  }, RemoteSettingsPage))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'remote.notice', inject: () => ({ hooks: { remoteNotice: notice }, dismissRemoteNotice: () => { notice.set(null) } }),
  }, RemoteToast))
  const host = new URLSearchParams(window.location.hash.slice(1)).get('codexy-remote')
  const connection = ctx.get('connection') as ConnectionHandle
  if (host) ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'remote.identity', locale: 'remote', inject: () => ({ host, hooks: { remoteConnection: connection.state } }),
  }, RemoteIdentity))
}
