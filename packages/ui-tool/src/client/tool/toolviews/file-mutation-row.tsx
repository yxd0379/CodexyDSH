import type { Context } from '@deepseek-ai/cordis'
import { IconEditOutlineRegular } from '@codexydsh/ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { diffCardModel } from '../models/diff-card-model.ts'
import { toolRowModel, toolTitleKey } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { PreparingToolRow } from '../components/PreparingToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

type FileMutationRowProps = ToolCallViewProps & PropsLocale<'conversation'>
const FILE_MUTATION_ICON = <IconEditOutlineRegular size={14} />

/**
 * Lets users expand an applied file diff and open the reported path.
 */
export function FileMutationRow(props: FileMutationRowProps) {
  return props.phase === 'preparing'
    ? <PreparingFileMutationRow {...props} />
    : <StartedFileMutationRow {...props} />
}

function PreparingFileMutationRow({ toolName, useDisclosure, useToolCallArgumentsPartial, t }: Extract<FileMutationRowProps, { phase: 'preparing' }>) {
  const raw = useToolCallArgumentsPartial()
  return <PreparingToolRow toolName={toolName} useDisclosure={useDisclosure} icon={FILE_MUTATION_ICON}
    title={t(toolTitleKey(toolName))} t={t}
    summary={t('tool.preparing.content', { kilobytes: Math.ceil(raw.length / 1024) })} />
}

function StartedFileMutationRow({ toolName, block, cwd, home, openFile, inspect, useDisclosure, t }: Exclude<FileMutationRowProps, { phase: 'preparing' }>) {
  const model = toolRowModel(toolName, block, cwd, home)
  const diff = diffCardModel(block)
  const patch = toolName === 'apply_patch'
  const paths = patch ? diff?.card.diffs.map(hunk => hunk.path) : undefined
  return (
    <ToolRow
      useDisclosure={useDisclosure}
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={FILE_MUTATION_ICON}
      title={t(patch && diff !== null ? 'activity.edited' : model.titleKey)}
      activityPreview={patch && diff !== null ? 'diff' : undefined}
      summary={paths?.join(', ') ?? model.summary}
      bodyRaw={patch ? model.bodyRaw : null}
      output={model.output}
      errorSummary={model.errorSummary}
      diff={diff}
      state={model.state}
      filePath={paths?.length === 1 ? paths[0] : model.filePath}
      onOpenFile={openFile}
      inspect={inspect}
    />
  )
}

/** Registers file edits, writes, and Codex patch conversation rows. */
export const fileMutationToolview = {
  name: 'file-mutation-toolview',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', function* () {
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'edit', locale: NS }, FileMutationRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'write', locale: NS }, FileMutationRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'apply_patch', locale: NS }, FileMutationRow)
    })
  },
}
