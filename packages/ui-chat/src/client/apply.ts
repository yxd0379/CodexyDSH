/** Register the Chat Conversation target, renderers, stats, and details surface. */
import type { Context } from '@deepseek-ai/cordis'
import draftRemote from '@codexydsh/api-prompt/remote'
import { loadHistoryPage } from './history-page.ts'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { GroupKey } from '@codexydsh/ui-conversation/client'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-browser/client'
import type {} from '@codexydsh/ui-input-trigger/client'
// The `file` entry of `SidebarRightResourceParamsMap`, which types `{ params: { line } }` below.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
// Type-only service and declaration merges used by the apply world.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@codexydsh/ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {
  ChatNodeInjected, ChatScrollPosition, ChatViewInjected,
  TurnTailOwnerProps,
} from './contract/slots.ts'
import type { ChatSnapshot } from './contract/snapshot.ts'
import { EMPTY_CHAT_SNAPSHOT } from './contract/snapshot.ts'
import { ApprovalCommand } from './chat/ApprovalCommand.tsx'
import { ChatView } from './chat/ChatView.tsx'
import { PromptOptimizeButton } from './chat/PromptOptimizeButton.tsx'
import { registerChatNodeRenderers } from './chat/register-node-renderers.ts'
import { RunningDock } from './chat/RunningDock.tsx'
import { StatsPills } from './chat/StatsPills.tsx'
import { registerConversationNodes } from './conversation-nodes/register.ts'
import { en, NS, zh } from './locale.ts'
import { TranscriptViewRow, type TranscriptViewRowInjected } from './settings/TranscriptViewRow.tsx'
import { createChatStore } from './stores.ts'
import { TranscriptViewPolicy } from './transcript-view.ts'
import { derivePresentationPolicy } from './presentation-policy.ts'
import { CHAT_SETTINGS_NAMESPACE, DEFAULT_HISTORY_PAGE_MESSAGES, DEFAULT_LINK_OPENING, type ChatSettings } from '../chat-settings.ts'
import { LinkOpeningRow, type LinkOpeningRowInjected } from './settings/LinkOpeningRow.tsx'
import { PerformanceUsageRow, type PerformanceUsageRowInjected } from './settings/PerformanceUsageRow.tsx'
import { PerformanceUsagePolicy } from './performance-usage.ts'
import { ReasoningRecapRow, type ReasoningRecapInjected } from './settings/ReasoningRecapRow.tsx'
import { useTurnDataValue } from './chat/use-turn-data.ts'
import { bindDisclosure } from './chat/use-disclosure.ts'

const CHAT_NODE_INJECT: ChatNodeInjected = {
  hooks: {
    turnData: (_standard, { turnData }) => function useTurnData(key) {
      return useTurnDataValue(turnData, key)
    },
    disclosure: (_standard, { disclosureReset }) => bindDisclosure(disclosureReset),
  },
}

/** Services required by the Chat target and its presentation registrations. */
export const inject = [
  'slots', 'sessions', 'uiWorkspace', 'uiSession', 'uiConversation', 'locale',
  'configForms', 'remote', 'remote.session', 'sidebarRight',
]

/**
 * Mount all Chat-owned contributions.
 * @param ctx - Client root context.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(draftRemote)
  const chatSources = new WeakMap<SessionBinding, ObservableSnapshot<ChatSnapshot>>()
  const chatSource = (binding: SessionBinding): ObservableSnapshot<ChatSnapshot> => {
    let source = chatSources.get(binding)
    if (source === undefined) {
      const target = ctx.uiConversation.binding(binding).target('chat')
      source = {
        getSnapshot: () => target.getSnapshot() ?? EMPTY_CHAT_SNAPSHOT,
        subscribe: listener => target.subscribe(listener),
      }
      chatSources.set(binding, source)
    }
    return source
  }
  registerConversationNodes(ctx)
  ctx.uiSession.provide({
    hooks: ['chat'],
    resolve: binding => ({ hooks: { chat: chatSource(binding) } }),
  })

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-chat: dictionaries')
  const t = ctx.locale.bind(NS)
  const chatStore = createChatStore()
  const chatScrollPositions = new Map<SessionId, ChatScrollPosition>()
  const chatSettings = ctx.configForms.get<ChatSettings>(CHAT_SETTINGS_NAMESPACE)
  const linkOpening = createSnapshotStore(chatSettings.getSnapshot().value?.linkOpening ?? DEFAULT_LINK_OPENING)
  ctx.effect(() => chatSettings.subscribe(() => {
    const accepted = chatSettings.getSnapshot().value?.linkOpening
    if (accepted !== undefined) linkOpening.set(accepted)
  }))
  ctx.inject(['sidebarRightTabs'], (scope) => {
    const tabs = scope.sidebarRightTabs
    const browserAvailable: ObservableSnapshot<boolean> = {
      getSnapshot: () => tabs.get('browser') !== undefined,
      subscribe: listener => tabs.subscribe(listener),
    }
    scope.slots.inject('settings.general.item', () => scope.slots.register({
      name: 'settings.general.item',
      id: 'link-opening',
      order: 14,
      locale: NS,
      inject: (): LinkOpeningRowInjected => ({
        hooks: { linkOpening, browserAvailable },
        setLinkOpening: (destination) => {
          linkOpening.set(destination)
          void chatSettings.set('linkOpening', destination).catch((_error: unknown) => {
            // The local choice remains usable when persistence is unavailable.
          })
        },
      }),
    }, LinkOpeningRow))
  })
  const transcriptView = new TranscriptViewPolicy(chatSettings)
  const codexful = createSnapshotStore(chatSettings.getSnapshot().value?.codexful === true)
  const reasoningRecap = createSnapshotStore(chatSettings.getSnapshot().value?.reasoningRecap !== false)
  ctx.effect(() => chatSettings.subscribe(() => {
    codexful.set(chatSettings.getSnapshot().value?.codexful === true)
    reasoningRecap.set(chatSettings.getSnapshot().value?.reasoningRecap !== false)
  }))
  const presentation = derivePresentationPolicy(transcriptView.mode, codexful, reasoningRecap)
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item', id: 'reasoning-recap', order: 12.5, locale: NS,
    inject: (): ReasoningRecapInjected => ({
      hooks: { reasoningRecap },
      setReasoningRecap: (enabled) => {
        void chatSettings.set('reasoningRecap', enabled)
      },
    }),
  }, ReasoningRecapRow))
  const performancePolicy = new PerformanceUsagePolicy(chatSettings)
  ctx.effect(() => () => { transcriptView.dispose(); performancePolicy.dispose() })
  const performanceUsage = performancePolicy.mode
  registerChatNodeRenderers(ctx, performanceUsage, presentation)

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'performance-usage',
    order: 13,
    locale: NS,
    inject: (): PerformanceUsageRowInjected => ({
      hooks: { performanceUsage },
      setPerformanceUsage: (mode) => { performancePolicy.setMode(mode) },
    }),
  }, PerformanceUsageRow))

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'transcript-view',
    order: 12,
    locale: NS,
    inject: (): TranscriptViewRowInjected => ({
      hooks: { transcriptView: transcriptView.mode },
      setTranscriptView: (mode) => { transcriptView.setMode(mode) },
    }),
  }, TranscriptViewRow))

  ctx.slots.inject('conversation.view', () => {
    const disposeView = ctx.slots.register({
      name: 'conversation.view',
      id: 'chat',
      order: 0,
      label: () => t('view.chat'),
      locale: NS,
      children: {
        'conversation.chat.node': { kind: 'keyed', scope: 'session', inject: CHAT_NODE_INJECT },
        'conversation.message.images': { kind: 'single', scope: 'session' },
      },
      store: chatStore,
      inject: (sessionId: SessionId): ChatViewInjected => {
        const binding = ctx.sessions.binding(sessionId)
        if (binding === undefined) throw new Error(`ui-chat: unknown session "${sessionId}"`)
        const session = binding.session
        const chat = chatSource(binding)
        const conversation = ctx.uiConversation.binding(binding)
        return {
          hooks: { presentation },
          keyedHooks: {
            chatNode: key => chat.getSnapshot().nodes.source(key),
            chatNodeProcess: key => chat.getSnapshot().nodes.processSource(key),
            chatGroup: key => conversation.snapshot.getSnapshot().views.grouped('chat')?.groupSource(key as GroupKey),
          },
          fileMentions: (owner: TurnTailOwnerProps) => ctx.get('chatFileMentions')?.forClosing(owner, sessionId),
          // Files open in the right Sidebar, not in a desktop application: the
          // content stays in the product, beside the conversation that produced
          // it. A relative path, or an absolute one inside the session's
          // workspace, is addressed under this session's scope,
          // `dsh-resource://file/session/<id>/<path>`; an absolute path
          // elsewhere keeps its absolute spelling in the same Session's address.
          // Which tab type claims the
          // address is the Sidebar's decision, not this call site's.
          // A line travels as a navigation parameter, not as part of the
          // address: the file is one piece of content whether it is opened at
          // its top or at line 400, so the same tab is revealed and told where
          // to land.
          openFile: async (path, options) => {
            const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
            const url = fileAddressFor(sessionId, cwd, path)
            if (options?.line === undefined) ctx.sidebarRight.openResource(url)
            else ctx.sidebarRight.openResource(url, { params: { line: options.line } })
            await Promise.resolve()
          },
          openSkill: (name) => {
            const scope = ctx.sessions.scope(sessionId)
            if (scope === undefined) return
            ctx.get('inputTriggers')?.sessionOf(scope).openReference('skill', { ref: `/${name}` })
          },
          openExternalLink: (url) => {
            if (linkOpening.getSnapshot() === 'sidebar' && ctx.get('sidebarRightTabs')?.get('browser') !== undefined) {
              ctx.sidebarRight.openTab('browser', { params: { url } })
            } else {
              window.open(url, '_blank', 'noopener,noreferrer')
            }
          },
          loadOlder: () => {
            const minimum = chatSettings.getSnapshot().value?.historyPageMessages ?? DEFAULT_HISTORY_PAGE_MESSAGES
            void loadHistoryPage(binding, minimum)
          },
          loadThrough: seq => session.loadThrough(seq),
          loadImage: Object.assign(
            (attachment: ImageAttachmentRef) => ctx.uiConversation.imageUrl(sessionId, attachment),
            { peek: (attachment: ImageAttachmentRef) => ctx.uiConversation.peekImageUrl(sessionId, attachment) },
          ),
          chatScroll: {
            save: (position) => {
              if (position === null) chatScrollPositions.delete(sessionId)
              else chatScrollPositions.set(sessionId, position)
            },
            read: () => chatScrollPositions.get(sessionId) ?? null,
          },
          forkAt: (seq) => {
            ctx.sessions.fork({ sessionId, atSeq: seq, increaseTitle: true })
              .then((childId) => { ctx.uiWorkspace.openSession(childId) })
              .catch(() => {
                // Fork or child-title failure leaves the source view unchanged.
              })
          },
        }
      },
    }, ChatView)
    return disposeView
  })

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'run-status', order: -100, locale: NS,
    inject: sessionId => ({ hooks: { presentation, runningChat: ctx.uiConversation.binding(sessionId).target('chat') } }),
  }, RunningDock))

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: 'optimize-prompt', order: 0, locale: NS,
    inject: (sessionId) => {
      const scope = ctx.sessions.scope(sessionId)
      return {
        optimize: (text: string, signal: AbortSignal) => {
          const session = ctx.sessions.binding(sessionId)?.session
          if (session === undefined) return Promise.resolve({ ok: false as const, reason: undefined })
          return ctx.remote.draft.optimize(sessionId, text, signal).then(
            result => result.ok
              ? { ok: true as const, text: result.value.text }
              : { ok: false as const, reason: result.error.message },
            (error: unknown) => ({
              ok: false as const,
              reason: error instanceof Error ? error.message : undefined,
            }),
          )
        },
        reportError: (text: string) => {
          if (scope === undefined) return
          scope.get('conversation')?.input.for(scope).notify('error', text)
        },
      }
    },
  }, PromptOptimizeButton))

  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register({
      name: 'conversation.composer.dock', id: 'stats', order: 0, locale: NS,
      inject: () => ({ hooks: { performanceUsage, presentation } }),
    }, StatsPills))

  ctx.slots.inject('conversation.approval.detail', () =>
    ctx.slots.register({ name: 'conversation.approval.detail' }, ApprovalCommand))

}
