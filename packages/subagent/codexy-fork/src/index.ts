import { productSnapshot } from '@codexydsh/bridges/session-reads'
/**
 * The in-process FORK subagent backend: registers a {@link SubagentProvider} on
 * `ctx.codexySubagents` that runs each child as a child {@link Agent} SEEDED with a prefix of the
 * parent's session log — so the child inherits the parent's conversation context instead of
 * starting fresh. The default seed ends at the last `turn/end`; Codexful's
 * opt-in seed includes the current turn and balances its open tail.
 * @module @codexydsh/delegation-fork-in-process
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionEvent } from '@codexydsh/runtime/session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@codexydsh/runtime'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
} from '@codexydsh/delegation'
import { startInProcessRun } from '@codexydsh/delegation-driver'
import { codexfulForkSeed, scrubCodexfulForkHistory } from './codexful-context.ts'

export const name = 'subagent-fork-in-process'
// `tools` is deliberately NOT injected — same rationale as subagent-spawn-in-process: the
// per-run structured runtime gates its capture-tool registration on `tools`
// itself, so this backend's apply timing (and the delegation tool's position
// in the model-visible tool list) is unchanged by structured output.
export const inject = ['agentLoop', 'codexySubagents']

/** Config: the registry name to register the provider under. */
export interface Config {
  /** Provider name on `ctx.codexySubagents` (default `fork`). */
  providerName: string
  /** Inherit and filter the current model context for Codexful children. */
  codexfulHistory?: boolean
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('fork'),
  codexfulHistory: z.boolean().default(false),
})

/**
 * The balanced completed-turn prefix of `parent`'s log: every event up to and including the
 * last `turn/end`. The in-flight turn is excluded; before any completed turn the child starts
 * fresh. Because live sequence numbers equal array indexes, the result remains a valid seed
 * beginning at sequence zero.
 * @param parent - the agent whose session log to slice.
 * @returns the seed events, contiguous from seq 0; empty when no turn has completed.
 */
function completedTurnPrefix(parent: Agent): SessionEvent[] {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const events = productSnapshot(parent.session)
  const lastEnd = events.findLast(e => e.type === 'turn/end')
  if (lastEnd === undefined) return []
  // seq === array index (the append contract), so slice up to and including it.
  return events.slice(0, lastEnd.seq + 1)
}

/**
 * The fork provider. Supports `depthLimit` and `outputSchema` (via the shared
 * in-process structured runtime), `agentOptions` (merged over the parent
 * route), and `toolFilter`/`persona` (scoped restrict() and a scoped shadowing
 * persona section).
 */
class ForkInProcessProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities
  // Context contract: a forked child IS seeded with the parent's completed-turn prefix.
  readonly inheritsParentContext = true

  constructor(readonly name: string, private readonly codexfulHistory: boolean) {
    this.capabilities = {
      agentOptions: true,
      outputSchema: true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
      ...codexfulHistory ? { forkTurns: true } : {},
    }
  }

  start(request: ResolvedSubagentStartRequest) {
    if (this.codexfulHistory) {
      const captured = codexfulForkSeed(request.parent, request.forkTurns)
      return startInProcessRun(request, captured ?? {})
    }
    const seed = completedTurnPrefix(request.parent)
    return startInProcessRun(request, {
      // Only pass a seed when there's a completed turn to inherit; an empty seed
      // is equivalent to a fresh child, so omit it to keep the session unseeded.
      ...seed.length > 0 ? { seed } : {},
    })
  }

  prepareContinuable(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec> {
    if (this.codexfulHistory) {
      return Promise.resolve(codexfulForkSeed(request.parent, request.forkTurns) ?? {})
    }
    // The fork prefix is captured ONCE, at creation: it becomes part of the
    // child's own durable transcript, so a later cold resume replays that
    // prefix instead of re-forking the parent's newer history.
    const seed = completedTurnPrefix(request.parent)
    return Promise.resolve(seed.length > 0 ? { seed } : {})
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.codexySubagents.registerProvider(new ForkInProcessProvider(config.providerName, config.codexfulHistory === true))
  if (config.codexfulHistory !== true) return
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.parentSession === undefined) return
    agent.ctx.effect(() => ctx.agentLoop.enablePreparedHistoryProjection(agent, (turn, step) => {
      // oxlint-disable-next-line typescript/no-deprecated -- The descriptor is logged before the first child request.
      const own = productSnapshot(agent.session, agent.session.inheritedEventCount)
      const descriptor = own.find(event => event.type === 'subagent/descriptor'
        && event.data.provider === config.providerName)
      if (descriptor !== undefined) scrubCodexfulForkHistory(agent.session, turn, step, descriptor.seq,
        ctx.codexySubagents.forkCutoffOf(agent.session.id))
    }), 'codexful.forkHistory')
  })
}
