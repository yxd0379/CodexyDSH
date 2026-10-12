import { Fragment, memo, useCallback, useEffect, useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { PendingSubmission } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MessageImageSource } from '@codexydsh/ui-conversation/client'
import { fileExtension, FileTypeIcon, fileSizeText, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, JsonBlock, projectUserText, StateDot } from '@codexydsh/ui-primitives'
import type {
  AssistantActionOwnerProps, ChatNodeOwnerProps, ChatNodeViewProps, ChatViewSlotProps, PerformanceUsageInjected,
  PresentationInjected, TurnCopyInjected,
} from '../contract/slots.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import type { ModelRetryNode, TurnErrorNode, UserMessageNode } from '../contract/snapshot.ts'
import { CompactionItem } from './CompactionItem.tsx'
import { ContextInjectionRow } from './ContextInjectionRow.tsx'
import { MessageIconActions } from './MessageIconActions.tsx'
import { TurnCopyMenu } from './TurnCopyMenu.tsx'
import { CodexfulTurnControls, CodexfulTurnTime } from './TurnProcessNodeView.tsx'
import { TurnUsagePanel } from './TurnUsagePanel.tsx'
import { useTurnTailActions } from './TurnTailNodeView.tsx'
import { useSearchableHidden } from './searchable-hidden.ts'
import css from './MessageItem.module.css'

type UserImage = Extract<UserMessageNode['content'][number], { type: 'image' }>
type UserFile = Extract<UserMessageNode['content'][number], { type: 'file' }>
type PresentedAttachment =
  | { readonly type: 'image'; readonly image: MessageImageSource }
  | { readonly type: 'file'; readonly file: UserFile['attachment'] }

function contentParts(content: readonly unknown[]): {
  text: string
  attachments: PresentedAttachment[]
  rest: unknown[]
} {
  const texts: string[] = []
  const attachments: PresentedAttachment[] = []
  const rest: unknown[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string; attachment?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else if (b.type === 'image' && b.attachment !== undefined) {
      attachments.push({ type: 'image', image: { attachment: (b as UserImage).attachment } })
    }
    else if (b.type === 'file' && b.attachment !== undefined) {
      attachments.push({ type: 'file', file: (b as UserFile).attachment })
    }
    else rest.push(block)
  }
  return { text: texts.join(''), attachments, rest }
}

function retrySeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1_000))
}

interface RetryCountdown {
  deadline: number
  seconds: number
}

function failureMessage(
  message: string,
  code: unknown,
  t: ChatViewSlotProps['t'],
): string {
  return code === 'AUTH' ? t('message.failure.auth') : message
}

function ModelRetryItem({ node, active, t }: {
  node: ModelRetryNode
  active: boolean
  t: ChatViewSlotProps['t']
}) {
  // Anchor the host-scheduled delay to this browser's first render of the
  // retry node. Host event time and Date.now() may belong to different clocks.
  const deadline = useMemo(() => Date.now() + node.delayMs, [node.delayMs, node.seq])
  const scheduledSeconds = retrySeconds(node.delayMs)
  const maximum = node.mode === 'normal' ? node.maxRetries : '∞'
  const [countdown, setCountdown] = useState<RetryCountdown>(() => ({
    deadline,
    seconds: retrySeconds(deadline - Date.now()),
  }))
  const remainingSeconds = countdown.deadline === deadline
    ? countdown.seconds
    : retrySeconds(deadline - Date.now())

  useEffect(() => {
    if (!active) return
    const updateCountdown = (): number => {
      const next = retrySeconds(deadline - Date.now())
      setCountdown(current => (
        current.deadline === deadline && current.seconds === next
          ? current
          : { deadline, seconds: next }
      ))
      return next
    }
    if (updateCountdown() === 1) return
    const timer = window.setInterval(() => {
      if (updateCountdown() === 1) window.clearInterval(timer)
    }, 250)
    return () => { window.clearInterval(timer) }
  }, [active, deadline])

  const label = active
    ? t('message.retry.active')
    : node.retryState === 'cancelled'
      ? t('message.retry.cancelled')
      : node.retryState === 'started'
        ? t('message.retry.started')
        : t('message.retry.scheduled')
  const seconds = active ? remainingSeconds : scheduledSeconds

  return (
    <details className={css.retryRow} data-active={active || undefined}>
      <summary className={css.retrySummary}>
        <span className={css.retryText} role="status">
          {t('message.retry.status', { label, retry: node.retry, maximum, seconds })}
        </span>
      </summary>
      <div className={css.retryDetails}>
        <div>
          <span className={css.retryDetailLabel}>{t('message.retry.delay')}</span>
          {t('duration.milliseconds', { milliseconds: Math.round(node.delayMs) })}
        </div>
        <div>
          <span className={css.retryDetailLabel}>{t('message.retry.failure')}</span>
          {failureMessage(node.failure.message, node.failure.code, t)}
        </div>
      </div>
    </details>
  )
}

/** Persistent, turn-positioned feedback for a terminal failure. */
function TurnErrorItem({ node, t }: {
  node: TurnErrorNode
  t: ChatViewSlotProps['t']
}) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="error" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.turnErrorTitle}>{t('message.turnError')}</span>
        <span className={css.turnErrorMessage}>{failureMessage(node.message, node.code, t)}</span>
      </div>
      {node.code !== undefined && <code className={css.turnErrorCode}>{node.code}</code>}
    </div>
  )
}

/** Persistent, turn-positioned notice for a turn ended at the output-token cap. */
function TurnMaxTokensItem({ t }: {
  t: ChatViewSlotProps['t']
}) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="warning" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.maxTokensTitle}>{t('message.maxTokens')}</span>
        <span className={css.turnErrorMessage}>{t('message.maxTokens.hint')}</span>
      </div>
    </div>
  )
}

/** Human-message presentation shared by user, steering and local submission rows. */
function UserStyleBubble({
  content, renderMessageImages, actions, pending = false, echo = false, referenceLabels = [], skillNames = [],
  previewAttachments, references, t,
}: {
  content: readonly unknown[]
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  /** Optional IconActions (or similar) below the bubble; receives the joined text. */
  actions?: (text: string) => ReactNode
  /** Whether this is the Host-authoritative pre-admission steering projection. */
  pending?: boolean
  /** Whether this is a local submission echo (invisible marker; the echo renders exactly like its durable replacement). */
  echo?: boolean
  /** Exact session mention labels associated by the adjacent recall node. */
  referenceLabels?: readonly string[]
  /** Skill names the step's `skill-invocation` injections loaded for this message. */
  skillNames?: readonly string[]
  /** Local submission-echo attachments replacing the content-derived attachment sequence. */
  previewAttachments?: readonly PresentedAttachment[]
  references?: Pick<ChatNodeOwnerProps, 'openFile' | 'openSkill'>
  t: ChatViewSlotProps['t']
}): ReactNode {
  const { text, attachments: contentAttachments, rest } = contentParts(content)
  const attachments = previewAttachments ?? contentAttachments
  const compactImages = attachments.length > 1
  const truncated = (total: number): string => t('json.truncated', { total })
  const showBubble = text !== '' || rest.length > 0
  const long = text.length > 1_200 || text.split('\n').length > 12
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const reveal = useCallback(() => { setExpanded(true) }, [])
  const bodyRef = useSearchableHidden(long && !expanded, reveal)
  const preview = useMemo(() => {
    if (!long) return ''
    return `${Array.from(text.split('\n').slice(0, 8).join('\n')).slice(0, 700).join('').trimEnd()}…`
  }, [long, text])
  return (
    <div
      className={css.userRow}
      data-short-message={text.length <= 80 && !text.includes('\n') && attachments.length === 0 && rest.length === 0 || undefined}
      data-pending-steering={pending || undefined}
      data-submission-echo={echo || undefined}
    >
      {pending && <span className={css.pendingSteeringLabel}>{t('message.pendingSteering')}</span>}
      <div className={css.userStack}>
        {attachments.length > 0 && (
          <div className={css.attachmentRow} data-message-attachments>
            {attachments.map((attachment, index) => attachment.type === 'image'
              ? (
                <Fragment key={`image:${index}`}>
                  {renderMessageImages({
                    images: [attachment.image],
                    align: 'end',
                    compact: compactImages,
                  })}
                </Fragment>
              )
              : (
                <span key={`file:${index}`} className={css.fileCard} title={attachment.file.name}>
                  <FileTypeIcon path={attachment.file.name} className={css.fileIcon} />
                  <span className={css.fileContent}>
                    <span className={css.fileName}>{attachment.file.name}</span>
                    <span className={css.fileMeta}>
                      {[fileExtension(attachment.file.name).toUpperCase().slice(0, 8), fileSizeText(attachment.file.bytes)]
                        .filter(Boolean).join(' ')}
                    </span>
                  </span>
                </span>
              ))}
          </div>
        )}
        {showBubble && <div className={css.bubble} data-long-message={long || undefined}>
          {long && <button type="button" className={css.messageExpand} aria-expanded={expanded} aria-controls={bodyId}
            onClick={(event) => { event.currentTarget.focus(); setExpanded(!expanded) }}>
            {expanded ? <IconChevronUpOutlineRegular /> : <IconChevronDownOutlineRegular />}
            {t(expanded ? 'message.showLess' : 'message.showMore')}
          </button>}
          {long && !expanded && <div className={css.messagePreview}>
            {projectUserText(preview, referenceLabels, skillNames, 'skill', references)}
          </div>}
          <div ref={bodyRef} id={bodyId} data-message-full>
            {projectUserText(text, referenceLabels, skillNames, 'skill', references)}
          </div>
          {rest.map((block, i) => <JsonBlock key={i} label={t('message.extraBlock')} payload={block} truncatedLabel={truncated} />)}
        </div>}
        {referenceLabels.length > 0 && (
          <div className={css.referenceSummary}>
            {t('message.referenceSummary', { labels: referenceLabels.join(t('message.referenceSeparator')) })}
          </div>
        )}
      </div>
      {actions?.(text)}
    </div>
  )
}

/**
 * Render one Host-authoritative pending steering item with the same visual
 * language as its eventual durable transcript node.
 * @param props - Pending message content and conversation translator.
 * @returns the pending steering bubble.
 */
export function PendingSteeringBubble({ content, renderMessageImages, t }: {
  content: readonly unknown[]
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  t: ChatViewSlotProps['t']
}): ReactNode {
  return (
    <UserStyleBubble
      content={content}
      renderMessageImages={renderMessageImages}
      pending
      t={t}
      actions={text => (
        <MessageIconActions
          text={text}
          clock="start"
          className={css.actions}
          t={t}
        />
      )}
    />
  )
}

/**
 * Render one local transcript or steering submission echo with the same
 * visual language and surface marker as the Host occurrence that replaces
 * it: draft text plus object-URL previews, visible from the submit click
 * until the durable `user/message` or steering occurrence renders.
 * @param props - the session snapshot's pending submission and render seats.
 * @returns the echoed user bubble.
 */
export function PendingSubmissionBubble({ submission, renderMessageImages, t }: {
  submission: PendingSubmission
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  t: ChatViewSlotProps['t']
}): ReactNode {
  const content = useMemo(
    () => (submission.text === '' ? [] : [{ type: 'text', text: submission.text }]),
    [submission.text],
  )
  const previewAttachments = useMemo<readonly PresentedAttachment[]>(
    () => submission.attachments.map(attachment => attachment.type === 'image'
      ? {
        type: 'image',
        image: {
          preview: {
            url: attachment.value.previewUrl,
            ...(attachment.value.name === undefined ? {} : { name: attachment.value.name }),
            ...(attachment.value.width === undefined ? {} : { width: attachment.value.width }),
            ...(attachment.value.height === undefined ? {} : { height: attachment.value.height }),
          },
        },
      }
      : { type: 'file', file: attachment.value }),
    [submission.attachments],
  )
  return (
    <UserStyleBubble
      content={content}
      previewAttachments={previewAttachments}
      renderMessageImages={renderMessageImages}
      pending={submission.placement === 'steering'}
      echo
      t={t}
      actions={text => (
        <MessageIconActions
          text={text}
          time={submission.time}
          clock="start"
          className={css.actions}
          t={t}
        />
      )}
    />
  )
}

/** Codexful Turn-actions seat forwarded by the entry that declares the child slot. */
type TurnActionsSeat = (owner: AssistantActionOwnerProps) => ReactNode

/** User, admitted-steering, and source-linked interruption Chat renderer body. */
function HumanMessageView({
  node, renderMessageImages, openFile, openSkill, usePresentation, useChat, useTurnData, usePerformanceUsage,
  readTurnEvents, turnProcess, forkAt, turnActions, t,
}: ChatNodeViewProps<'user' | 'steering'>
  & InjectFace<PresentationInjected>
  & InjectFace<TurnCopyInjected>
  & InjectFace<PerformanceUsageInjected>
  & { turnActions?: TurnActionsSeat | undefined }): ReactNode {
  const data = node.data
  const codexful = usePresentation(policy => policy.codexful)
  const detailed = usePerformanceUsage(mode => mode) === 'detailed'
  const nodes = useChat(current => current.nodes)
  const turn = node.location.kind === 'turn' || node.location.kind === 'step' ? node.location.turn : undefined
  const openingMessage = useChat(snapshot => turn === undefined ? undefined : snapshot.locations.getTurn(turn.turn)
    .find((key) => {
      const candidate = snapshot.nodes.get(key) as ChatNode | undefined
      return (candidate?.kind === 'user' || candidate?.kind === 'steering') && candidate.data.interruptedTurn === undefined
    }))
  // Codexful keeps every Turn action on the opening question row: the branch
  // point and per-message controls of the finalized answer travel here instead
  // of a second row under the answer.
  const tail = useTurnData('turn-tail')
  const tailActions = useTurnTailActions(tail, useChat)
  const turnActionsVisible = codexful && tail !== undefined && tail.closing !== null
  const branchSeq = turnActionsVisible ? tailActions.seq : undefined
  const assistantActions = turnActionsVisible && tailActions.messageId !== undefined
    ? turnActions?.({ messageId: tailActions.messageId }) ?? null
    : null
  if (codexful && data.interruptedTurn !== undefined) return null
  return (
    <UserStyleBubble
      content={data.content}
      references={{ openFile, openSkill }}
      renderMessageImages={renderMessageImages}
      {...data.referenceLabels === undefined ? {} : { referenceLabels: data.referenceLabels }}
      {...data.skillNames === undefined ? {} : { skillNames: data.skillNames }}
      t={t}
      actions={text => (
        <MessageIconActions
          text={text}
          time={codexful ? undefined : data.time}
          clock="start"
          className={css.actions}
          alwaysVisible={codexful === true}
          onBranch={branchSeq === undefined ? undefined : () => { forkAt(branchSeq) }}
          branchUnavailable={tailActions.branchUnavailable}
          extraActions={assistantActions}
          usageAction={turnActionsVisible && detailed && tailActions.tokenUsage !== undefined
            ? <TurnUsagePanel usage={tailActions.tokenUsage} t={t} />
            : null}
          leadingActions={codexful && openingMessage === node.key && turn !== undefined
            ? <>
              {turnProcess !== undefined && <CodexfulTurnControls turn={turn} process={turnProcess} t={t} />}
              <CodexfulTurnTime turn={turn} fallbackStart={node.kind === 'user' ? data.time : undefined} t={t} />
            </> : null}
          copyAction={codexful && turn !== undefined
            ? <TurnCopyMenu turn={turn.turn} question={text} endSeq={turn.end?.seq} snapshot={{ nodes }}
              readTurnEvents={readTurnEvents} t={t} /> : undefined}
          t={t}
        />
      )}
    />
  )
}

/** User-message renderer: the entry that declares the Codexful Turn-actions seat. */
export const UserMessageNodeView = memo(function UserMessageNodeView(
  props: ChatNodeViewProps<'user'>
    & InjectFace<PresentationInjected>
    & InjectFace<TurnCopyInjected>
    & InjectFace<PerformanceUsageInjected>
    & PropsRenderSlots<'conversation.chat.turn-actions'>,
) {
  return <HumanMessageView
    {...props}
    turnActions={owner => props.renderSlot('conversation.chat.turn-actions', owner)}
  />
})

/** Admitted-steering renderer: the same human row without the Turn-actions seat. */
export const SteeringMessageNodeView = memo(function SteeringMessageNodeView(
  props: ChatNodeViewProps<'steering'>
    & InjectFace<PresentationInjected>
    & InjectFace<TurnCopyInjected>
    & InjectFace<PerformanceUsageInjected>,
) {
  return <HumanMessageView {...props} />
})

/** Injected-context and developer-message keyed Chat renderer. */
export const ContextMessageNodeView = memo(function ContextMessageNodeView({ node, t }: ChatNodeViewProps<'context' | 'developer'>) {
  const data = node.data
  return (
    <ContextInjectionRow
      content={data.content}
      source={data.source}
      producer={data.producer}
      form={data.form}
      {...node.kind === 'developer' ? { messageRole: 'developer' } : {}}
      t={t}
    />
  )
})

/** Automatic compaction keyed Chat renderer. */
export const CompactionNodeView = memo(function CompactionNodeView({ node, t }: ChatNodeViewProps<'compaction'>) {
  return <CompactionItem node={node.data} t={t} />
})

/** Correlated retry-chain keyed Chat renderer. */
export const RetryNodeView = memo(function RetryNodeView({ node, t }: ChatNodeViewProps<'model-retry'>) {
  const data = node.data
  return <ModelRetryItem node={data.current} active={data.current.retryState === 'scheduled'} t={t} />
})

/** Terminal turn-error keyed Chat renderer. */
export const TurnErrorNodeView = memo(function TurnErrorNodeView({ node, t }: ChatNodeViewProps<'turn-error'>) {
  return <TurnErrorItem node={node.data} t={t} />
})

/** Max-tokens turn-end notice keyed Chat renderer. */
export const TurnMaxTokensNodeView = memo(function TurnMaxTokensNodeView({ t }: ChatNodeViewProps<'turn-max-tokens'>) {
  return <TurnMaxTokensItem t={t} />
})

/** Explicit unknown-surface keyed Chat renderer. */
export const UnknownNodeView = memo(function UnknownNodeView({ node, t }: ChatNodeViewProps<'unknown'>) {
  const data = node.data
  return (
    <div className={css.contextRow}>
      <JsonBlock
        label={t('message.unknownSurface', { type: data.type })}
        payload={data.data}
        truncatedLabel={total => t('json.truncated', { total })}
      />
    </div>
  )
})
