/** Browser MCP configuration and Session-local command picker. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { CommandUiContract, SelectOption } from '@codexydsh/ui-commands/client'
import { TYPERT_REMOTE } from '@codexydsh/mcp/remote'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { McpSettings, McpToast, type McpNotice, type McpSettingsInjected } from './McpSettings.tsx'
import { DraftError, draftOperations, type CatalogSettings } from './model.ts'
import { en, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { /** MCP settings and connection picker. */ mcp: keyof typeof zh }
}
declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { /** A pending MCP catalog read. */ mcpCatalog: true }
}

/** Services owning settings, Session retention, commands, and presentation. */
export const inject = ['remote', 'sessions', 'slots', 'locale', 'configForms', 'commandUi', 'codexySettingsSchema']

/** Register MCP settings and decorate the bare /mcp command.
 * @param ctx - Browser plugin context.
 * @returns Disposal of the generated Remote namespace contribution.
 */
export async function apply(ctx: Context): Promise<() => void> {
  ctx.effect(() => ctx.locale.register('mcp', { zh, en }))
  const t = ctx.locale.bind('mcp')
  const notice = createSnapshotStore<McpNotice | null>(null)
  let sequence = 0
  const notify = (text: string, success: boolean): void => { notice.set({ sequence: ++sequence, text, success }) }
  const form = ctx.configForms.get<CatalogSettings>('codexy-mcp')
  const write: McpSettingsInjected = {
    hooks: { mcpSettings: form },
    async saveMcp(draft) {
      let operations
      try { operations = draftOperations(draft) }
      catch (error) {
        /* v8 ignore else -- draftOperations reports admitted invalid fields as DraftError. */
        if (error instanceof DraftError) throw new Error(t(error.key))
        /* v8 ignore next -- draftOperations reports admitted invalid fields as DraftError. */
        throw error
      }
      const servers = form.getSnapshot().value?.servers ?? {}
      if (draft.originalName === undefined && Object.hasOwn(servers, draft.serverName) && servers[draft.serverName] !== null) {
        throw new Error(t('duplicate'))
      }
      try {
        if (!await form.mutate(operations, draft.revision)) throw new Error(t('rejected'))
        notify(t('saved'), true)
      } catch (error) { notify(t('failed', { message: error instanceof Error ? error.message : String(error) }), false); throw error }
    },
    async deleteMcp(name, revision) {
      try {
        if (!await form.mutate([{ op: 'set', path: ['servers', name], value: null }], revision)) throw new Error(t('rejected'))
        notify(t('removed'), true)
      } catch (error) { notify(t('failed', { message: error instanceof Error ? error.message : String(error) }), false); throw error }
    },
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'mcp', order: 30, label: () => t('title'), locale: 'mcp', inject: () => write,
  }, McpSettings))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'mcp.notice', inject: () => ({ hooks: { mcpNotice: notice }, dismissMcpNotice: () => { notice.set(null) } }),
  }, McpToast))
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE)
  ctx.inject(['remote.mcp', 'remote.commands'], (scope) => {
    const command = scope.get('commandUi') as CommandUiContract
    scope.effect(() => command.decorate({
      name: 'mcp', available: session => scope.sessions.subagentAddress(session.sessionId) === undefined,
      ui: {
        kind: 'popupSelect',
        options: async (session, signal): Promise<SelectOption[]> => {
          const result = await scope.sessions.using(session.sessionId, { source: 'mcpCatalog', signal }, async (reference) => {
            const state = reference.binding.session.getSnapshot()
            if (state.openState !== 'open') throw state.openError ?? new Error(t('missingSession'))
            signal.throwIfAborted()
            return scope.remote.mcp.catalog(session.sessionId, signal)
          })
          if (!result.ok) throw result.error
          if (!result.value.length) throw new Error(t('noServers'))
          return result.value.map(server => ({
            id: `${server.enabled ? 'off' : 'on'} ${server.serverName}`,
            label: `${t(server.enabled ? 'disconnect' : 'connect')} ${server.serverName}`,
            badge: t(server.phase === 'failed' ? 'connectionFailed' : server.phase),
            detail: `${server.transport} · ${t('tools', { count: String(server.toolCount) })}`,
          }))
        },
        onSelect: async (option, session) => {
          const signal = new AbortController().signal
          const result = await scope.sessions.using(session.sessionId, { source: 'mcpCatalog', signal }, async (reference) => {
            const state = reference.binding.session.getSnapshot()
            if (state.openState !== 'open') throw state.openError ?? new Error(t('missingSession'))
            signal.throwIfAborted()
            return scope.remote.commands.execute(session.sessionId, `/mcp ${option.id}`, [], signal)
          })
          if (!result.ok) throw result.error
          if (!result.value) throw new Error(t('missingSession'))
          if (result.value.result.kind === 'error') throw new Error(result.value.result.text)
        },
      },
    }))
  })
  // oxlint-disable-next-line typescript/no-misused-promises -- Cordis awaits asynchronous effect disposal.
  return unmount
}
