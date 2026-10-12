/** Direct human shell command presentation; execution never requires a model turn. */
import { useMemo } from 'react'
import { TerminalBlock, type TerminalBlockLabels } from '@codexydsh/ui-primitives'
import type { CommandRowProps } from '../contract/slots.ts'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { GenericCommandCard } from './GenericCommandCard.tsx'
import css from './ShellCommandCard.module.css'

type ShellCommandCardProps = CommandRowProps & PropsLocale<'chat'>

/**
 * Show the human command and its recorded result without the model-facing XML wrapper.
 * @param props - command lifecycle and locale supplied by the command slot.
 * @returns a compact terminal with copyable output and complete output disclosure.
 */
export function ShellCommandCard({ node, t }: ShellCommandCardProps) {
  const text = node.outcome?.text
  const command = node.args?.trimStart() ?? ''
  const result = useMemo(() => {
    if (text === undefined || !text.startsWith(`<user_shell_command>\n<command>\n${command}\n</command>`)) return undefined
    const match =
      /\n<result>\nExit code: (-?\d+)\nDuration: ([\d.]+) seconds\nOutput:\n([\s\S]*)\n<\/result>\n<\/user_shell_command>$/.exec(text)
    return match === null ? undefined : { exitCode: Number(match[1]), duration: match[2] ?? '', output: match[3] ?? '' }
  }, [text, command])
  const labels = useMemo<TerminalBlockLabels>(() => ({
    signal: signal => t('command.shell.signal', { signal }),
    exitCode: code => t('command.shell.exitCode', { code }),
    noExitCode: t('command.shell.noExitCode'),
    running: t('command.running'), failed: t('command.failed'), done: t('command.done'),
    copy: t('copy'), copied: t('copied'), noOutput: t('command.shell.noOutput'),
    collapseAria: t('command.shell.collapse'), collapse: t('command.shell.collapse'),
    expandAria: count => t('command.shell.expand', { count }),
    expand: count => t('command.shell.expand', { count }),
  }), [t])
  if (node.outcome !== null && result === undefined) return <GenericCommandCard node={node} t={t} />
  return <div className={css.root} data-user-shell-command>
    <div className={css.caption}>{t('command.shell.title')}
      {result !== undefined && <span>{t('command.shell.duration', { seconds: result.duration })}</span>}
    </div>
    <TerminalBlock command={command} output={result?.output} exitCode={result?.exitCode} running={node.outcome === null}
      labels={labels} maxLines={8} runStateDot={false} />
  </div>
}
