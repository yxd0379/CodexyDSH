/** Durable model-switch state for Codexful request preparation. */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { SessionSeq } from '../session.ts'

/** The last model-switch instruction and request header accepted by a Session. */
export interface CodexModelSwitchProjection {
  readonly latestSwitchSeq: SessionSeq | null
  readonly latestSwitchModel: string | null
  readonly latestHeaderSeq: SessionSeq | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    codexModelSwitch: CodexModelSwitchProjection
  }
}

const stateSchema = z.object({
  latestSwitchSeq: z.number().int().nonnegative().transform(SessionSeq).nullable(),
  latestSwitchModel: z.string().nullable(),
  latestHeaderSeq: z.number().int().nonnegative().transform(SessionSeq).nullable(),
})

/** Reconstruct the last switch across compaction, restore, and request retries. */
export const codexModelSwitchProjectionDefinition = {
  key: 'codexModelSwitch',
  stateVersion: 1,
  stateSchema,
  init: (): CodexModelSwitchProjection => ({
    latestSwitchSeq: null,
    latestSwitchModel: null,
    latestHeaderSeq: null,
  }),
  apply(state, event) {
    if (event.type === 'request/header') return { ...state, latestHeaderSeq: event.seq }
    const message = event.type === 'developer/message' ? event.data.message
      : event.type === 'user/message' ? event.data : undefined
    if (message?.source.kind !== 'model-selection' || message.source.form !== 'instructions'
      || !('targetModel' in message.source) || typeof message.source.targetModel !== 'string') return state
    return { ...state, latestSwitchSeq: event.seq, latestSwitchModel: message.source.targetModel }
  },
} satisfies ProjectionDefinition<'codexModelSwitch', CodexModelSwitchProjection>
