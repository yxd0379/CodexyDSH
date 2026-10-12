/** Original human questions eligible for the Codexful reading reminder. */
import type { ChatNodeStore, TurnNavigationItem } from '../contract/snapshot.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'

/**
 * Select loaded original questions while excluding steering and generated context.
 * @param items - loaded Turn navigation anchors.
 * @param nodes - the current Chat node reader.
 * @returns Turn anchors backed by visible, original human input.
 */
export function currentQuestionItems(items: readonly TurnNavigationItem[], nodes: ChatNodeStore): readonly TurnNavigationItem[] {
  return items.filter((item) => {
    const node = nodes.get(item.anchorKey) as ChatNode | undefined
    return node?.kind === 'user' && node.visibility === 'visible' && node.data.interruptedTurn === undefined
  })
}
