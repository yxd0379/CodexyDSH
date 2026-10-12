/** Codexful command and exploration rows with complete recorded output. */
import { Fragment, memo, useId, useMemo } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconInspectOutlineRegular,
  IconCheckOutlineRegular, IconCopyOutlineRegular, TerminalBlock, TextShimmer, useCodeHighlighter, useCopyFeedback,
} from '@codexydsh/ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { CONVERSATION_NS as NS } from '../../locale.ts'
import { codexShellModel } from '../models/codex-shell-model.ts'
import { terminalBlockLabels } from '../models/terminal-card-model.ts'
import { GenericToolCard } from './GenericToolCard.tsx'
import { registerShellHistory, type ShellHistory } from '../models/shell-history.ts'
import css from './codex-shell-row.module.css'

type ShellHistoryInjected = { hooks: { shellHistory: HostObservable<ShellHistory | undefined> } }
type CodexShellRowProps = ToolCallViewProps & PropsLocale<'conversation'> & InjectFace<ShellHistoryInjected>

/**
 * Render inspection actions as a compact tree and other commands as a run row.
 * @param props - frozen call, disclosure hook, navigation, and locale.
 * @returns expandable command/output with accessible execution status.
 */
export const CodexShellRow = memo(function CodexShellRow(props: CodexShellRowProps) {
  if (props.phase === 'preparing') return <div className={css.preparing} role="status">
    <TextShimmer active>{props.t('codexShell.preparing')}</TextShimmer>
  </div>
  return <StartedCodexShellRow {...props} />
})

function StartedCodexShellRow(props: Exclude<CodexShellRowProps, { phase: 'preparing' }>) {
  const { toolName, block, useDisclosure, t, inspect } = props
  const activity = props.useShellHistory(history => history?.get(block.callId))
  const model = useMemo(() => codexShellModel(toolName, block), [toolName, block])
  const commandCopy = useCopyFeedback(activity?.command || model?.command || '')
  const { expanded, toggle } = useDisclosure()
  const bodyId = useId()
  const labels = useMemo(() => terminalBlockLabels(t), [t])
  if (model === null) return <GenericToolCard {...props} />
  const running = model.state === 'running'
  const state = !model.poll && activity?.latest.exitCode !== undefined ? activity.latest.state : model.state
  const command = model.poll ? activity?.command || t('codexShell.process', { id: model.requestedProcessId ?? '?' }) : model.command
  const explored = model.entries.length > 0
  const stateLabel = t(state === 'error' ? 'bash.failed' : state === 'stopped' ? 'bash.stopped'
    : running ? 'bash.running' : (activity?.latest ?? model).processId !== undefined ? 'codexShell.processRunning' : 'terminal.done')
  const title = t(explored ? running ? 'codexShell.exploring' : 'codexShell.explored'
    : model.poll ? model.command === '' ? running ? 'codexShell.waiting' : 'codexShell.waited' : 'codexShell.sent'
      : running ? 'codexShell.running' : 'codexShell.ran')
  const cappedOutput = (model.output?.trimEnd().split('\n').length ?? 0) > 8
  const output = <TerminalBlock command={model.command} output={model.output} exitCode={model.exitCode}
    running={running} labels={{ ...labels, expand: hidden => t('codexShell.moreOutput', { count: hidden }), expandAria: () => t('codexShell.details') }} maxLines={8} variant="output"
    onOpenDetails={inspect}
    className={css.output} footer={<>
      {model.duration !== undefined && <span>{t('codexShell.duration', { seconds: model.duration })}</span>}
      {command !== '' && <button type="button" className={css.copyCommand} onClick={commandCopy.onCopy}>
        {commandCopy.copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
        {t(commandCopy.copied ? 'copied' : 'codexShell.copyCommand')}
      </button>}
      {inspect !== undefined && !cappedOutput && <button type="button" className={css.inspect} onClick={inspect}>
        <IconInspectOutlineRegular />{t('codexShell.details')}
      </button>}
    </>} />
  return <div className={css.root} data-codex-shell data-state={state} data-open={expanded || undefined}>
    <button type="button" className={css.summary} aria-expanded={expanded} aria-controls={bodyId} onClick={toggle}>
      <span className={css.chevron} aria-hidden>{expanded ? <IconChevronDownOutlineRegular /> : <IconChevronRightOutlineRegular />}</span>
      <TextShimmer className={css.title} active={running}>{title}</TextShimmer>
      {explored
        ? <span className={css.explorationSummary}>{t('codexShell.actionCount', { count: model.entries.length })}</span>
        : <CommandText command={command} expanded={expanded} />}
      <span className={css.status} role="status">
        <span className={css.accessibleStatus}>{stateLabel}</span>
      </span>
    </button>
    {explored && expanded && <ul className={css.tree} id={bodyId}>
      {model.entries.map((entry, index) => <li key={index} className={css.entry}>
        <span className={css.branch} aria-hidden>{index === model.entries.length - 1 ? '└' : '├'}</span>
        <span className={css.verb}>{t(`codexShell.${entry.kind}`)}</span>
        <code className={css.detail} title={entry.detail}>{entry.detail}</code>
      </li>)}
    </ul>}
    {expanded && <div className={css.body} id={explored ? undefined : bodyId}>
      {explored && <div className={css.rawCommand}><CommandText command={command} expanded /></div>}
      {model.poll && model.command !== '' && <pre className={css.rawCommand}>{model.command}</pre>}
      {output}
    </div>}
  </div>
}

function CommandText({ command, expanded }: { command: string; expanded: boolean }) {
  const highlight = useCodeHighlighter('shellscript')
  const source = command.split('\n').slice(0, 8).join('\n').slice(0, 1600)
  const lines = useMemo(() => highlight(source), [highlight, source])
  const visible = expanded ? source : command.split('\n')[0] ?? command
  return <code className={css.command} data-command-source>
    {lines === undefined ? visible : (expanded ? lines : lines.slice(0, 1)).map((line, index) => <Fragment key={index}>
      {index > 0 && '\n'}{line.map((token, tokenIndex) => <span key={tokenIndex} style={token.style}>{token.text}</span>)}
    </Fragment>)}
    {source.length < command.length || !expanded && command.includes('\n') ? ' …' : ''}
  </code>
}

/** Keyed Codex shell registrations; disposing the plugin removes both views. */
export const codexShellToolview = {
  name: 'codex-shell-toolview',
  inject: ['slots', 'uiConversation'],
  apply(ctx: Context): void {
    registerShellHistory(ctx)
    const inject = (sessionId: Parameters<Context['uiConversation']['binding']>[0]): ShellHistoryInjected => ({
      hooks: { shellHistory: ctx.uiConversation.binding(sessionId).target('tool-shell-history') },
    })
    ctx.slots.inject('tool.call.toolview', function* () {
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'exec_command', locale: NS, inject }, CodexShellRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'write_stdin', locale: NS, inject }, CodexShellRow)
    })
  },
}
