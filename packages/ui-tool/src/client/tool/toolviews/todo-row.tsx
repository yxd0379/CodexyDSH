import { useMemo } from 'react'
import { IconChecklistOutlineRegular } from '@codexydsh/ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { registerTodoHistory, type TodoHistory } from '../models/todo-history.ts'
import { todoDiffModel } from '../models/todo-diff-model.ts'
import { codexPlanModel } from '../models/codex-plan-model.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'
import { planSummary, type PlanItemLike } from './plan-summary.ts'

type TodoHistoryInjected = { hooks: { todoHistory: HostObservable<TodoHistory | undefined> } }
type TodoRowProps = ToolCallViewProps & PropsLocale<'conversation'> & InjectFace<TodoHistoryInjected>
type CodexPlanRowProps = ToolCallViewProps & PropsLocale<'conversation'>

function isItem(value: unknown): value is PlanItemLike {
  return typeof value === 'object' && value !== null
}

/**
 * The row's summary split at the ellipsis boundary: `text` truncates, `extra`
 * is the parallel-active count that must not, so a narrow row never clips the
 * one part that says several tasks are running.
 */
interface RowSummary {
  text: string
  extra: number
}

function summarize(argsRaw: string | null, t: TodoRowProps['t']): RowSummary | null {
  if (argsRaw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    // Mid-stream truncation or malformed model JSON: fall back to the generic summary.
    return null
  }
  // Valid JSON with invalid todo fields (null root, non-array todos, null items —
  // a rejected tool/call retains such args verbatim): same generic fallback.
  if (typeof parsed !== 'object' || parsed === null) return null
  const todos = (parsed as { todos?: unknown }).todos
  if (!Array.isArray(todos) || !todos.every(isItem)) return null
  const { done, total, activeContent, activeExtra } = planSummary(todos)
  const head = t('todo.completed', { done, total })
  return {
    text: activeContent === null ? head : `${head} · ${activeContent}`,
    extra: activeExtra,
  }
}

/** Summarizes a plan update without presenting a cancelled call as completed. */
export function TodoRow({ toolName, block, inspect, useDisclosure, useTodoHistory, useSession, t }: TodoRowProps) {
  const baseline = useTodoHistory(snapshot => snapshot?.get(block.callId))
  const hasMore = useSession(snapshot => snapshot.hasMore)
  const diff = useMemo(() => todoDiffModel(block, baseline, hasMore, t), [block, baseline, hasMore, t])
  const model = toolRowModel(toolName, block)
  const summary = summarize(model.bodyRaw, t) ?? { text: model.summary, extra: 0 }
  return (
    <ToolRow
      useDisclosure={useDisclosure}
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={<IconChecklistOutlineRegular />}
      title={t(model.titleKey)}
      summary={summary.text}
      summarySuffix={[diff?.summary, summary.extra > 0 ? `+${summary.extra}` : null]
        .filter((part): part is string => part !== null && part !== undefined).join(' · ') || null}
      bodyRaw={model.bodyRaw}
      output={model.output}
      details={diff?.details}
      errorSummary={model.errorSummary}
      state={model.state}
      inspect={inspect}
    />
  )
}

/**
 * Render the native Codex replacement plan and retain rejected arguments as raw input.
 * @param props - Frozen call phase, disclosure, inspection callback, and locale.
 * @returns A localized progress row with expandable plan steps.
 */
export function CodexPlanRow({ toolName, block, inspect, useDisclosure, t }: CodexPlanRowProps) {
  const model = toolRowModel(toolName, block)
  const plan = codexPlanModel(block, t)
  return <ToolRow useDisclosure={useDisclosure} t={t} variant={model.variant} toolName={toolName}
    icon={<IconChecklistOutlineRegular />} title={t(model.titleKey)}
    summary={plan?.summary ?? model.summary}
    summarySuffix={plan !== null && plan.activeExtra > 0 ? `+${plan.activeExtra}` : null}
    bodyRaw={model.bodyRaw} output={model.output} details={plan?.details}
    errorSummary={model.errorSummary} state={model.state} inspect={inspect} />
}

/** Registers the DSH todo and native Codex plan conversation rows. */
export const todoToolview = {
  name: 'todo-toolview',
  inject: ['slots', 'uiConversation'],
  apply(ctx: Context): void {
    registerTodoHistory(ctx)
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register({
        name: 'tool.call.toolview', key: 'todo_write', locale: NS,
        inject: (sessionId): TodoHistoryInjected => ({
          hooks: { todoHistory: ctx.uiConversation.binding(sessionId).target('tool-todo-history') },
        }),
      }, TodoRow))
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register({ name: 'tool.call.toolview', key: 'update_plan', locale: NS }, CodexPlanRow))
  },
}
