/** Native Codex plan updates projected from recorded arguments and tool outcomes. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallBlock } from './tool-call-model.ts'
import type { ToolDetailsModel } from '../components/ToolDetails.tsx'
import { detailRecord } from './detail-model-shared.ts'
import { parsedToolCall, singleResultText } from './raw-tool-call.ts'

/** A complete plan snapshot with a compact progress summary. */
export interface CodexPlanModel {
  /** Ordered plan steps and the confirmation or proposal caption. */
  details: ToolDetailsModel
  /** Completion count and the first named active step. */
  summary: string
  /** Additional active steps retained outside the row's ellipsis. */
  activeExtra: number
}

/**
 * Preserve Codex plan order, duplicate steps, empty text, and the optional explanation.
 * Running lists are labelled as proposed; only the recorded success receipt confirms application.
 * @param block - Preparing, running, or settled Tool call.
 * @param t - Conversation translator.
 * @returns A readable plan, or null for failures and unsupported recorded fields.
 */
export function codexPlanModel(block: ToolCallBlock, t: TranslateNS<'conversation'>): CodexPlanModel | null {
  const call = parsedToolCall(block)
  if (call?.name !== 'update_plan' || !Array.isArray(call.args.plan)) return null
  const explanation = call.args.explanation
  if (explanation !== undefined && typeof explanation !== 'string') return null
  const settled = 'kind' in block
  if (settled && (block.isError || singleResultText(block) !== 'Plan updated')) return null
  const items: ToolDetailsModel['items'][number][] = []
  for (const step of call.args.plan) {
    if (!detailRecord(step) || typeof step.step !== 'string') return null
    const status = step.status
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return null
    items.push({ title: step.step, status: { value: status, label: t(`detail.todo.${status}`) }, fields: [] })
  }
  const active = items.filter(item => item.status?.value === 'in_progress')
  const activeText = active[0]?.title
  const head = t('todo.completed', { done: items.filter(item => item.status?.value === 'completed').length, total: items.length })
  const caption = [t(settled ? 'plan.updated' : 'plan.proposed'), explanation].filter(text => text !== undefined && text !== '').join(' · ')
  return {
    details: { items, caption, empty: t('plan.empty') },
    summary: activeText === undefined || activeText.trim() === '' ? head : `${head} · ${activeText}`,
    activeExtra: activeText === undefined || activeText.trim() === '' ? 0 : active.length - 1,
  }
}
