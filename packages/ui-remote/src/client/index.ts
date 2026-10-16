/** Remote settings, connection actions, and remote-page identity. */
import type { Context, Plugin } from '@deepseek-ai/cordis'
import type {} from '@codexydsh/remote/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-modules/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { DraftError, draftOperations, type RemoteSettings } from './model.ts'
import { RemoteSettingsPage, RemoteToast, type RemoteNotice, type RemoteSettingsInjected } from './RemoteSettings.tsx'
import { en, zh } from './locales.ts'
import { REMOTE_PANEL, RemoteProjects } from './projects.ts'
import { RemoteProjectsPanel, type RemoteViewInjected } from './RemoteProjects.tsx'
import { installRemoteWorkspaceSources } from './workspace-sources.ts'
import { WorkspaceDirectoryFlow } from './WorkspaceDirectoryFlow.tsx'
import { zh as directoryZh, en as directoryEn } from './directory/locales.ts'
import { RemoteAuthentication } from './RemoteAuthentication.tsx'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Remote SSH configuration and connection identity. */ remote: keyof typeof zh
    'remote-directory-browser': keyof typeof directoryZh
  }
}

/** Settings, connection model, locale, and presentation services. */
export const inject = ['remoteHosts', 'connection', 'modules', 'slots', 'locale', 'configForms', 'codexySettingsSchema', 'layout']

/** Register the Remote settings section and shell-owned feedback.
 * @param ctx - Browser plugin lifetime and declared services.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('remote', { zh, en }))
  ctx.effect(() => ctx.locale.register('remote-directory-browser', { zh: directoryZh, en: directoryEn }))
  const t = ctx.locale.bind('remote')
  const form = ctx.configForms.get<RemoteSettings>('codexy-remote')
  const notice = createSnapshotStore<RemoteNotice | null>(null)
  let sequence = 0
  const announce = (text: string, success: boolean): void => { notice.set({ sequence: ++sequence, text, success }) }
  const operation = async <T>(action: () => Promise<T>, success: keyof typeof zh, accepted: (value: T) => boolean = () => true): Promise<T> => {
    try { const value = await action(); if (accepted(value)) announce(t(success), true); return value }
    catch (error) { announce(t('operationFailed', { message: error instanceof Error ? error.message : String(error) }), false); throw error }
  }
  const projects = new RemoteProjects(ctx.remoteHosts, ctx.modules, ctx.loader.constructor as unknown as Plugin, () => { ctx.layout.selectPanel(REMOTE_PANEL as MainPanelId) }, () => {
    if (ctx.layout.panelInfo.getSnapshot().activePanelId === REMOTE_PANEL) ctx.layout.selectPanel(null)
  }, window.localStorage)
  ctx.inject(['workspaceBrowser', 'uiWorkspace'], scope => {
    installRemoteWorkspaceSources(scope, projects, error => {
      announce(t('operationFailed', { message: error instanceof Error ? error.message : String(error) }), false)
    }, state => t(state))
    scope.slots.inject('sidebar.workspaces.directoryFlow', () => scope.slots.register({
      name: 'sidebar.workspaces.directoryFlow', priority: -1000,
      inject: () => ({ hooks: { locations: form }, t: ctx.locale.bind('remote-directory-browser'),
        listDirectory: (host: string, path?: string, signal?: AbortSignal) => host ? projects.listDirectory(host, path, signal) : scope.uiWorkspace.listDirectory(path, signal),
        createDirectory: (host: string, path: string, name: string) => host ? projects.createDirectory(host, path, name) : scope.uiWorkspace.createDirectory(path, name),
        addRemote: async (host: string, path: string, signal: AbortSignal) => { await projects.createWorkspace(host, path, signal) } }),
    }, WorkspaceDirectoryFlow))
  })
  ctx.effect(() => {
    const reconcile = (): void => { projects.reconcile(ctx.remoteHosts.getSnapshot()) }
    const unsubscribe = ctx.remoteHosts.subscribe(reconcile)
    reconcile()
    return () => { unsubscribe(); projects.dispose() }
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
  const remoteView: RemoteViewInjected['hooks']['remoteView'] = createSnapshotStore(null)
  ctx.effect(() => {
    const refresh = (): void => {
      const state = projects.state.getSnapshot()
      const active = state.runtimes.find(entry => entry.name === state.active)
      remoteView.set(active ? { name: active.name, phase: active.phase, error: active.error } : null)
    }
    refresh()
    return projects.state.subscribe(refresh)
  })
  const remoteViewInjected: RemoteViewInjected = {
    hooks: { remoteView },
    retryRemote: name => { void projects.restart(name).catch(error => {
      announce(t('operationFailed', { message: error instanceof Error ? error.message : String(error) }), false)
    }) },
    mountRemote: container => {
      let mounted: import('./runtime.tsx').RemoteClientRuntime | undefined
      let unmount: (() => void) | undefined
      const refresh = (): void => {
        const state = projects.state.getSnapshot()
        const next = state.runtimes.find(entry => entry.name === state.active && entry.phase === 'ready')?.runtime
        if (next === mounted) return
        unmount?.()
        mounted = next
        unmount = next?.mount(container)
      }
      const stop = projects.state.subscribe(refresh)
      refresh()
      return () => { stop(); unmount?.() }
    },
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: REMOTE_PANEL, locale: 'remote', inject: () => remoteViewInjected,
  }, RemoteProjectsPanel))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'remote', order: 35, label: () => t('title'), locale: 'remote', inject: () => injected,
  }, RemoteSettingsPage))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'remote.notice', inject: () => ({ hooks: { remoteNotice: notice }, dismissRemoteNotice: () => { notice.set(null) } }),
  }, RemoteToast))
}
