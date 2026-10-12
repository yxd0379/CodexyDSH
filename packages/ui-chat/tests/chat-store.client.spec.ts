import { describe, expect, it } from 'vitest'
import { createChatStore } from '../src/client/stores.ts'

describe('createChatStore', () => {
  it('folds explicit Codexful Turns independently of changing answer generations', () => {
    const store = createChatStore().create()
    store.actions.setTurnCollapsed(2, true)
    store.actions.setTurnCollapsed(2, true)
    store.actions.setTurnCollapsed(3, true)
    store.actions.setTurnProcessOpen(2, 8, true)
    expect(store.store.getSnapshot().collapsedTurns).toEqual([2, 3])
    store.actions.setTurnCollapsed(2, false)
    expect(store.store.getSnapshot().collapsedTurns).toEqual([3])
    expect(store.store.getSnapshot().turnProcesses).toEqual([{ turn: 2, answerStep: 8 }])
  })
  it('stores only manually expanded Turn-process answers', () => {
    const store = createChatStore().create()
    store.actions.setTurnProcessOpen(2, 3, true)
    expect(store.store.getSnapshot().turnProcesses).toEqual([{ turn: 2, answerStep: 3 }])

    store.actions.setTurnProcessOpen(2, 4, true)
    expect(store.store.getSnapshot().turnProcesses).toEqual([{ turn: 2, answerStep: 4 }])

    store.actions.setTurnProcessOpen(2, 4, false)
    expect(store.store.getSnapshot().turnProcesses).toEqual([])
  })

  it('closes only the requested Turn-process entry', () => {
    const store = createChatStore().create()
    store.actions.setTurnProcessOpen(2, 3, true)
    store.actions.setTurnProcessOpen(3, 4, true)

    store.actions.setTurnProcessOpen(2, 3, false)
    store.actions.setTurnProcessOpen(9, 10, false)

    expect(store.store.getSnapshot().turnProcesses).toEqual([{ turn: 3, answerStep: 4 }])
  })
})
