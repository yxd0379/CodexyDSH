/** Native SSH settings, unified sidebar sources and complete embedded remote documents. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-directory-picker-browse/client'
import { installEmbedded } from './embedded.ts'
import { RemoteWorkspaceController, REMOTE_PANEL } from './controller.ts'
import { RemoteDialogs, RemoteFrames, RemotePanel, RemoteSettingsSection, RemoteWorkspaceSettings, type RemoteInjected } from './views.tsx'
import { zh, type RemoteKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { remoteWorkspace: RemoteKey }
}

/** Required native services; Loader owns the complete Client composition. */
export const inject = ['slots', 'locale', 'layout', 'sessions', 'workspaces', 'uiSession', 'uiWorkspace', 'configForms', 'remote', 'remote.remoteHosts', 'directoryPickerLocations']

/** Register one window's navigation, or bridge the native document when explicitly embedded.
 * @param ctx - Fully composed native Client services.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('remoteWorkspace', { zh }), 'remote: 中文文案')
  if (window.parent !== window && new URLSearchParams(location.search).get('codexydsh-embedded') === '1') {
    installEmbedded(ctx)
    return
  }
  const controller = new RemoteWorkspaceController(ctx)
  const injectView = (): RemoteInjected => ({
    hooks: { remoteView: controller.view, remoteForm: controller.form },
    attach: controller.attach, surface: controller.surface, connect: controller.connect, disconnect: controller.disconnect,
    save: controller.save, remove: controller.remove, rename: controller.rename, setVisible: controller.setVisible,
    closeDialog: controller.closeDialog, authenticate: controller.authenticate, dismissError: controller.dismissError,
    openSettings: controller.openSettings, showDetails: controller.showDetails,
  })
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: REMOTE_PANEL,
    locale: 'remoteWorkspace', inject: injectView }, RemotePanel))
  ctx.slots.inject('shell.overlay', function* () {
    yield ctx.slots.register({ name: 'shell.overlay', id: 'remote-frames', locale: 'remoteWorkspace', inject: injectView }, RemoteFrames)
    yield ctx.slots.register({ name: 'shell.overlay', id: 'remote-dialogs', locale: 'remoteWorkspace', inject: injectView }, RemoteDialogs)
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'ssh-hosts', order: 70,
    label: () => ctx.locale.bind('remoteWorkspace')('title'), locale: 'remoteWorkspace', inject: injectView }, RemoteSettingsSection))
  ctx.slots.inject('settings.workspaces.source', () => ctx.slots.register({ name: 'settings.workspaces.source', id: 'ssh-host-workspaces',
    order: 100, locale: 'remoteWorkspace', inject: injectView }, RemoteWorkspaceSettings))
}
