/** Rename command feedback; interactive naming uses the shared user-question composer. */
import type { ChatViewSlotProps, CommandRowOwnerProps } from '../contract/slots.ts'
import { GenericCommandCard } from './GenericCommandCard.tsx'

interface RenameCommandCardProps extends CommandRowOwnerProps {
  t: ChatViewSlotProps['t']
}

/**
 * Display command progress or settlement while the shared question panel collects the title.
 * @param props - recorded command state and localized feedback.
 * @returns the regular command row without a second input form.
 */
export function RenameCommandCard({ node, t }: RenameCommandCardProps) {
  return <GenericCommandCard node={node} t={t} runningSummary={t('message.rename.running')} />
}
