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
import { browserOrigin, REMOTE_PANEL, RemoteProjects } from './projects.ts'
import { RemoteProjectsPanel, RemoteProjectFrames, type RemoteViewport } from './RemoteProjects.tsx'
import { installUnifiedWorkspaces } from './workspaces.ts'
import { embeddedLocation, installEmbeddedProjects } from './embed.tsx'
import { RemoteAuthentication } from './RemoteAuthentication.tsx'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { /** Remote SSH configuration and connection identity. */ remote: keyof typeof zh }
}

/** Settings, connection model, locale, and presentation services. */
export const inject = ['remoteHosts', 'connection', 'slots', 'locale', 'configForms', 'codexySettingsSchema', 'layout']

/** Register the Remote settings section and shell-owned feedback.
 * @param ctx - Browser plugin lifetime and declared services.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('remote', { zh, en }))
  const t = ctx.locale.bind('remote')
  const embedded = embeddedLocation(window.location)
  if (embedded) {
    ctx.inject(['workspaces', 'sessions', 'uiWorkspace'], scope => { installEmbeddedProjects(scope, embedded) })
    return
  }
  const form = ctx.configForms.get<RemoteSettings>('codexy-remote')
  const notice = createSnapshotStore<RemoteNotice | null>(null)
  let sequence = 0
  const announce = (text: string, success: boolean): void => { notice.set({ sequence: ++sequence, text, success }) }
  const operation = async <T>(action: () => Promise<T>, success: keyof typeof zh, accepted: (value: T) => boolean = () => true): Promise<T> => {
    try { const value = await action(); if (accepted(value)) announce(t(success), true); return value }
    catch (error) { announce(t('operationFailed', { message: error instanceof Error ? error.message : String(error) }), false); throw error }
  }
  const projects = new RemoteProjects(ctx.remoteHosts, browserOrigin(new URL(window.location.href)), () => { ctx.layout.selectPanel(REMOTE_PANEL as MainPanelId) }, () => {
    if (ctx.layout.panelInfo.getSnapshot().activePanelId === REMOTE_PANEL) ctx.layout.selectPanel(null)
  }, window.localStorage)
  const viewport = createSnapshotStore<RemoteViewport | null>(null)
  ctx.inject(['workspaces', 'sessions', 'uiWorkspace'], scope => { installUnifiedWorkspaces(scope, projects, form) })
  ctx.effect(() => {
    const receive = (event: MessageEvent): void => { projects.receive(event) }
    const reconcile = (): void => { projects.reconcile(ctx.remoteHosts.getSnapshot()) }
    window.addEventListener('message', receive)
    const unsubscribe = ctx.remoteHosts.subscribe(reconcile)
    reconcile()
    return () => { window.removeEventListener('message', receive); unsubscribe(); projects.dispose() }
  })
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
        await projects.disconnect(name)
        if (!await form.mutate([{ op: 'set', path: ['hosts', name], value: null }], revision)) throw new Error(t('rejected'))
      }, 'removed')
    },
    async connectHost(name) {
      await operation(() => projects.connect(name), 'connectionReady', Boolean)
    },
    async disconnectHost(name) { await operation(() => projects.disconnect(name), 'connectionClosed') },
    openHost(name) { projects.activate(name) },
    retryHosts() { ctx.remoteHosts.retry() },
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'remote.authentication', locale: 'remote',
    inject: () => ({ hooks: { remoteHosts: ctx.remoteHosts },
      respondAuthentication: (name: string, challengeId: string, response: string | null) => ctx.remoteHosts.respondAuthentication(name, challengeId, response) }),
  }, RemoteAuthentication))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: REMOTE_PANEL, inject: () => ({ viewport }) }, RemoteProjectsPanel))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'remote.frames', locale: 'remote',
    inject: () => ({ hooks: { remoteProjects: projects.state, remoteViewport: viewport }, projects, returnLocal: () => { ctx.layout.selectPanel(null) } }),
  }, RemoteProjectFrames))
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
