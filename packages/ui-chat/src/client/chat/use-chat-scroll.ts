/** Composes viewport operations, reading policy, and history navigation for Chat. */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { ChatSnapshot, TurnNavigationItem } from '../contract/snapshot.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { useChatNavigation, type ChatNavigation, type ChatNavigationInput } from './use-chat-navigation.ts'
import { useChatReading, type ChatReadingState } from './use-chat-reading.ts'
import { useChatViewport } from './use-chat-viewport.ts'

/** Committed content and Session operations used to reconcile scroll ownership. */
export interface ChatScrollInput extends ChatNavigationInput {
  readonly chatScroll: ChatViewSlotProps['chatScroll']
  readonly ready: boolean
  readonly order: readonly string[]
  readonly lastKey: string | null
  readonly lastIsUser: boolean
  readonly steeringId: string | null
  readonly submissionId: string | null
  readonly running: boolean
  readonly loadedTurns: ReturnType<ChatSnapshot['navigation']['items']>
  /** Original questions eligible for a pinned reminder; absent outside Codexful. */
  readonly questions?: readonly TurnNavigationItem[]
}

const NO_QUESTIONS: readonly TurnNavigationItem[] = []

interface ChatScrollState extends ChatReadingState {
  readonly listRef: RefObject<HTMLDivElement>
  readonly columnRef: RefObject<HTMLDivElement>
  readonly busyTurn: number | null
  readonly navigateToTurn: ChatNavigation['navigateToTurn']
  readonly loadEarlier: ChatNavigation['loadEarlier']
  readonly returnToBottom: () => void
  readonly pinnedQuestion: TurnNavigationItem | null
}

/**
 * Coordinate scroll policy after Chat content commits.
 * New submitted input supersedes pending reader sampling.
 * @param input - current Chat content, scroll memory, and history operations.
 * @returns element refs, visible reading state, and navigation callbacks.
 */
export function useChatScroll(input: ChatScrollInput): ChatScrollState {
  const {
    ready, order, firstSeq, lastKey, lastIsUser, steeringId, submissionId, running,
    loadedTurns, chatScroll, hasMore, loadingOlder, loadOlder, loadThrough, autoLoadEarlier = false, questions = NO_QUESTIONS,
  } = input
  const { viewport, listRef, columnRef } = useChatViewport()
  const { reading, state } = useChatReading(viewport, chatScroll, loadedTurns.at(-1)?.turn ?? null)
  const navigationInput = useMemo(() => ({
    firstSeq, loadingOlder, hasMore, loadOlder, loadThrough, autoLoadEarlier,
  }), [firstSeq, loadingOlder, hasMore, loadOlder, loadThrough, autoLoadEarlier])
  const { navigation, busyTurn } = useChatNavigation(viewport, reading, navigationInput)
  const [pinnedQuestion, setPinnedQuestion] = useState<TurnNavigationItem | null>(null)
  const content = useRef<{ input: ChatScrollInput; applied: ChatScrollInput | null; opened: boolean }>({
    input, applied: null, opened: false,
  })

  const refreshQuestion = useCallback(() => {
    const next = viewport.readPinnedQuestion(content.current.input.questions ?? NO_QUESTIONS)
    setPinnedQuestion(previous => previous?.turn === next?.turn && previous?.anchorKey === next?.anchorKey
      && previous?.prompt === next?.prompt ? previous : next)
  }, [viewport])

  const processContent = useCallback(() => {
    const current = content.current.input
    const previous = content.current.applied
    const ownInput = (current.lastIsUser && current.lastKey !== previous?.lastKey)
      || (current.steeringId !== null && current.steeringId !== previous?.steeringId
        && current.steeringId !== previous?.submissionId)
      || (current.submissionId !== null && current.submissionId !== previous?.submissionId
        && current.submissionId !== previous?.steeringId)
    if (!ownInput) {
      const scroll = viewport.readPendingReaderScroll()
      if (scroll !== null) reading.onScroll(scroll)
    }
    if (reading.pending && !ownInput) return
    content.current.applied = current
    if (current.ready && !content.current.opened) {
      content.current.opened = true
      navigation.reset()
      reading.restore()
      return
    }
    if (ownInput) {
      navigation.cancel()
      reading.followTail()
      return
    }
    if (navigation.contentCommitted()) {
      navigation.reconcile()
      return
    }
    const tipChanged = previous === null || current.ready !== previous.ready
      || current.firstSeq !== previous.firstSeq || current.lastKey !== previous.lastKey
      || current.order.length !== previous.order.length || current.running !== previous.running
      || current.steeringId !== previous.steeringId || current.submissionId !== previous.submissionId
    if (tipChanged && reading.followingTail) {
      navigation.cancel()
      reading.followTail()
    } else navigation.reconcile()
  }, [viewport, reading, navigation])

  useLayoutEffect(() => {
    const disconnectViewport = viewport.connect({
      scroll: (event) => {
        const readerScroll = viewport.readPendingReaderScroll()
        if (readerScroll !== null) navigation.readerScrolled(readerScroll)
        reading.onScroll(event)
        refreshQuestion()
      },
      scrollEnd: () => {
        reading.onScrollEnd()
        navigation.readerSettled()
        refreshQuestion()
      },
      interact: () => { navigation.cancel() },
      resize: () => {
        const scroll = viewport.readPendingReaderScroll()
        if (scroll !== null) reading.onScroll(scroll)
        if (!navigation.contentCommitted()) reading.onResize()
        navigation.reconcile()
        refreshQuestion()
      },
    })
    const disconnectReading = reading.connect((sample) => {
      navigation.readerSampled(sample)
      processContent()
      refreshQuestion()
    })
    return () => {
      disconnectViewport()
      disconnectReading()
      content.current.opened = false
      content.current.applied = null
    }
  }, [viewport, reading, navigation, processContent, refreshQuestion])

  useLayoutEffect(() => {
    const previous = content.current.input
    content.current.input = {
      ready, order, lastKey, lastIsUser, steeringId, submissionId, running, loadedTurns, questions, chatScroll, ...navigationInput,
    }
    viewport.updateTurns(loadedTurns)
    const layoutChanged = previous.order !== order || previous.ready !== ready
    if (layoutChanged) viewport.invalidate()
    processContent()
    if (layoutChanged) reading.refreshActiveTurn()
    refreshQuestion()
  }, [
    viewport, reading, processContent, navigationInput, ready, order, lastKey, lastIsUser,
    steeringId, submissionId, running, loadedTurns, questions, chatScroll, refreshQuestion,
  ])

  const returnToBottom = useCallback(() => {
    navigation.cancel()
    reading.followTail()
    refreshQuestion()
  }, [navigation, reading, refreshQuestion])

  const navigateToTurn = useCallback<ChatNavigation['navigateToTurn']>((item) => {
    navigation.navigateToTurn(item)
    refreshQuestion()
  }, [navigation, refreshQuestion])

  return {
    listRef, columnRef, ...state, busyTurn, pinnedQuestion,
    navigateToTurn,
    loadEarlier: navigation.loadEarlier,
    returnToBottom,
  }
}
