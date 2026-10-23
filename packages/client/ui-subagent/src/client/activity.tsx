/** Durable child discovery displayed as a compact, navigable Chat activity. */
import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import { IconAgentPresetOutlineRegular, StateDot, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SubagentCatalogInjected } from './SubagentHeaderLineage.tsx'
import { NS } from './locales.ts'
import css from './activity.module.css'

interface SubagentActivityData {
  readonly childSessionId: SubagentAddress['childSessionId']
  readonly mode: SubagentAddress['mode']
  readonly label: string
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** A recorded direct-child discovery with navigation to its own Session. */
    'subagent-activity': SubagentActivityData
  }
}

/** One stable Chat row per child recorded in its parent's catalog. */
export const subagentActivityDefinition: ConversationNodeDefinition<SubagentActivityData> = {
  kind: 'subagent-activity',
  target: 'chat',
  match: event => event.type === 'subagent/catalog' && event.data.mode !== 'external'
    ? { id: event.data.childId, role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'subagent/catalog' || match.event.data.mode === 'external') {
      throw new Error('subagent activity requires a local catalog entry')
    }
    return {
      childSessionId: match.event.data.childId,
      mode: match.event.data.mode,
      label: match.event.data.label ?? match.event.data.childId,
    }
  },
  update: context => context.state,
  buildViewNode: (context) => context.state === undefined || context.start === undefined ? null : {
    key: context.key,
    id: context.id,
    kind: 'subagent-activity',
    target: 'chat',
    anchorSeq: context.start.event.seq,
    location: context.start.location,
    visibility: 'visible',
    groupTree: 'process',
    data: context.state,
  },
}

type SubagentActivityProps = Pick<PropsRuntime<'conversation.chat.node', 'subagent-activity'>,
  'node' | 'sessionId' | 'useSessions' | 'useSessionStatus'>
  & Pick<SubagentCatalogInjected, 'openChild'> & PropsLocale<typeof NS>

/**
 * Render discovery with the child's current observed state and exact navigation address.
 * @param props - Chat node, Session selectors, navigation callback, and localized labels.
 * @returns the compact child activity row.
 */
export function SubagentActivity({ node, sessionId, useSessions, useSessionStatus, openChild, t }: SubagentActivityProps) {
  const { childSessionId, mode, label } = node.data
  const summary = useSessions(state => state.byId[childSessionId])
  const observedRunning = useSessionStatus(state => state.get(childSessionId)?.running)
  const running = observedRunning ?? summary?.running
  const timing = useSessions(state => state.projectionsBySession[childSessionId]?.values.subagentTiming
    ?? state.byId[childSessionId]?.projectionValues?.subagentTiming)
  const completed = running === false && timing?.active === undefined && timing?.lastTurnCompleted === true
  const state = running === true ? 'ongoing' : completed ? 'done' : 'idle'
  const status = running === true ? t('activity.running') : completed ? t('activity.completed')
    : running === false ? t('activity.inactive') : t('activity.unknown')
  return (
    <button type="button" className={css.row} data-subagent-activity={childSessionId}
      aria-label={t('activity.open', { label, status })}
      onClick={() => { openChild({ parentSessionId: sessionId, childSessionId, mode }) }}>
      <IconAgentPresetOutlineRegular size={14} />
      <TextShimmer active={running === true} className={css.label}>{label}</TextShimmer>
      <StateDot state={state} />
      <span className={css.status}>{status}</span>
    </button>
  )
}

/**
 * Register discovery and navigation without parsing model-facing tool return text.
 * @param ctx - Client context owning the Conversation and slot registrations.
 * @param actions - current navigation actions shared with the child catalog.
 */
export function registerSubagentActivity(ctx: Context, actions: () => Pick<SubagentCatalogInjected, 'openChild'>): void {
  ctx.uiConversation.events.register(subagentActivityDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'subagent-activity', locale: NS, inject: actions,
  }, SubagentActivity))
}
