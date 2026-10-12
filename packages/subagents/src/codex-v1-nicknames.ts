/**
 * Pinned Codex v1 nickname allocation and recovery from successful tool results.
 * Names and ordinal formatting follow Codex agent/registry.rs and
 * assets/agent/agent_names.txt at pinned revision 8f195c93.
 * @module @codexydsh/subagents/codex-v1-nicknames
 */

import { randomInt } from 'node:crypto'
import { symbols } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@codexydsh/runtime/session'
import type { SessionEvent } from '@codexydsh/runtime/session'
import type SubagentRuntime from '@codexydsh/delegation'

/** Default nickname candidates copied from the pinned Codex asset. */
export const CODEX_V1_NICKNAMES: readonly string[] = [
  'Euclid', 'Archimedes', 'Ptolemy', 'Hypatia', 'Avicenna', 'Averroes', 'Aquinas',
  'Copernicus', 'Kepler', 'Galileo', 'Bacon', 'Descartes', 'Pascal', 'Fermat',
  'Huygens', 'Leibniz', 'Newton', 'Halley', 'Euler', 'Lagrange', 'Laplace', 'Volta',
  'Gauss', 'Ampere', 'Faraday', 'Darwin', 'Lovelace', 'Boole', 'Pasteur', 'Maxwell',
  'Mendel', 'Curie', 'Planck', 'Tesla', 'Poincare', 'Noether', 'Hilbert', 'Einstein',
  'Raman', 'Bohr', 'Turing', 'Hubble', 'Feynman', 'Franklin', 'McClintock', 'Meitner',
  'Herschel', 'Linnaeus', 'Wegener', 'Chandrasekhar', 'Sagan', 'Goodall', 'Carson',
  'Carver', 'Socrates', 'Plato', 'Aristotle', 'Epicurus', 'Cicero', 'Confucius',
  'Mencius', 'Zeno', 'Locke', 'Hume', 'Kant', 'Hegel', 'Kierkegaard', 'Mill',
  'Nietzsche', 'Peirce', 'James', 'Dewey', 'Russell', 'Popper', 'Sartre', 'Beauvoir',
  'Arendt', 'Rawls', 'Singer', 'Anscombe', 'Parfit', 'Kuhn', 'Boyle', 'Hooke',
  'Harvey', 'Dalton', 'Ohm', 'Helmholtz', 'Gibbs', 'Lorentz', 'Schrodinger',
  'Heisenberg', 'Pauli', 'Dirac', 'Bernoulli', 'Godel', 'Nash', 'Banach',
  'Ramanujan', 'Erdos', 'Jason',
]

/** Logical v1 address availability while a tool result is not yet committed. */
export type CodexV1RosterState = 'open' | 'closed'

/**
 * Render the base name in the pool's current cycle.
 * @param name - base nickname from the candidate asset.
 * @param resetCount - number of exhausted nickname pools, starting at zero.
 * @returns the original name or Codex's English ordinal suffix.
 */
function formatNickname(name: string, resetCount: number): string {
  if (resetCount === 0) return name
  const ordinal = resetCount + 1
  const lastHundred = ordinal % 100
  const suffix = lastHundred >= 11 && lastHundred <= 13 ? 'th'
    : ordinal % 10 === 1 ? 'st' : ordinal % 10 === 2 ? 'nd' : ordinal % 10 === 3 ? 'rd' : 'th'
  return `${name} the ${ordinal}${suffix}`
}

/** Root-shared reservations survive failed creation and child closure. */
export class CodexV1NicknamePool {
  private readonly used = new Set<string>()
  private readonly children = new Map<SessionId, string>()
  private readonly roster = new Map<SessionId, CodexV1RosterState>()
  private resetCount = 0

  /**
   * Reserve a random unused candidate; an exhausted pool starts the next ordinal.
   * Reservations are never released, including when child creation fails.
   * @param names - source-defined candidate list for this spawn's role.
   * @returns the reserved nickname.
   * @throws when the candidate list is empty.
   */
  reserve(names: readonly string[]): string {
    if (names.length === 0) throw new Error('no available agent nicknames')
    let available = names.map(name => formatNickname(name, this.resetCount))
      .filter(name => !this.used.has(name))
    if (available.length === 0) {
      this.used.clear()
      this.resetCount += 1
      available = names.map(name => formatNickname(name, this.resetCount))
    }
    const nickname = available[randomInt(available.length)] as string
    this.used.add(nickname)
    return nickname
  }

  /**
   * Restore or publish a successful child's original nickname without reallocating it.
   * Re-reading a committed result never reserves its nickname a second time.
   * @param childId - durable child Session identity.
   * @param nickname - original nickname from its successful spawn result.
   */
  remember(childId: SessionId, nickname: string): void {
    const existing = this.children.get(childId)
    if (existing !== undefined) {
      if (existing !== nickname) throw new Error(`Conflicting Codex v1 nickname for child ${JSON.stringify(childId)}`)
      return
    }
    this.children.set(childId, nickname)
    this.used.add(nickname)
  }

  /**
   * Read successfully allocated child nicknames.
   * @returns detached successful-child nicknames, including uncommitted results.
   */
  snapshot(): Map<SessionId, string> {
    return new Map(this.children)
  }

  /**
   * Publish a successful address change before its parent tool result is logged.
   * @param childId - child whose address was loaded or closed successfully.
   * @param state - current logical availability.
   */
  mark(childId: SessionId, state: CodexV1RosterState): void {
    this.roster.set(childId, state)
  }

  /**
   * Read successful address changes not necessarily present in parent history.
   * @returns a detached roster overlay for this root.
   */
  rosterSnapshot(): Map<SessionId, CodexV1RosterState> {
    return new Map(this.roster)
  }
}

/**
 * Recover nicknames only from this parent's successful v1 spawn results.
 * Inherited ancestor calls, other namespaces, and errored results are excluded.
 * @param events - durable Session events, including any inherited prefix.
 * @param inheritedEventCount - number of inherited events to exclude.
 * @returns child identities mapped to their originally returned nicknames.
 */
export function codexV1NicknamesFromLog(
  events: readonly SessionEvent[], inheritedEventCount: number,
): Map<SessionId, string> {
  const own = events.slice(inheritedEventCount)
  const namespaced = new Set<string>()
  const calls = new Set<string>()
  const nicknames = new Map<SessionId, string>()
  for (const event of own) {
    const blocks = event.type === 'assistant/message' ? event.data.message.content
      : event.type === 'assistant/output-item' ? [event.data.block] : []
    for (const block of blocks) {
      if (block.type === 'tool-call' && block.namespace === 'multi_agent_v1' && block.name === 'spawn_agent') {
        namespaced.add(block.id)
      }
    }
  }
  for (const event of own) {
    if (event.type === 'tool/call') {
      if (event.data.name === 'multi_agent_v1__spawn_agent'
        || event.data.name === 'spawn_agent' && namespaced.has(event.data.callId)) calls.add(event.data.callId)
      continue
    }
    if (event.type !== 'tool/result' || event.data.message.isError === true
      || !calls.has(event.data.message.toolCallId)) continue
    const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    let result: unknown
    try {
      result = JSON.parse(text)
    } catch (_error: unknown) {
      // An old or malformed durable tool result has no recoverable nickname.
      continue
    }
    if (result === null || typeof result !== 'object' || Array.isArray(result)
      || !('agent_id' in result) || typeof result.agent_id !== 'string'
      || !('nickname' in result) || typeof result.nickname !== 'string') continue
    const id = SessionId(result.agent_id)
    const existing = nicknames.get(id)
    if (existing !== undefined && existing !== result.nickname) {
      throw new Error(`Conflicting Codex v1 nickname results for child ${JSON.stringify(id)}`)
    }
    nicknames.set(id, result.nickname)
  }
  return nicknames
}

/**
 * Fold this parent's successful v1 close and resume results into its closed roster.
 * Ancestor history, other namespaces, malformed calls, and failed results are excluded.
 * @param events - durable parent events, including any inherited prefix.
 * @param inheritedEventCount - inherited events to exclude from ownership.
 * @returns logically closed child identities in the parent's own history.
 */
export function codexV1ClosedAgentsFromLog(events: readonly SessionEvent[], inheritedEventCount: number): Set<SessionId> {
  const own = events.slice(inheritedEventCount)
  const namespaced = new Set<string>()
  const calls = new Map<string, { kind: 'close' | 'resume'; id: SessionId }>()
  const closed = new Set<SessionId>()
  for (const event of own) {
    const blocks = event.type === 'assistant/message' ? event.data.message.content
      : event.type === 'assistant/output-item' ? [event.data.block] : []
    for (const block of blocks) {
      if (block.type === 'tool-call' && block.namespace === 'multi_agent_v1') namespaced.add(block.id)
    }
  }
  for (const event of own) {
    if (event.type === 'tool/call') {
      if (!event.data.name.startsWith('multi_agent_v1__') && !namespaced.has(event.data.callId)) continue
      const kind = event.data.name === 'multi_agent_v1__close_agent' || event.data.name === 'close_agent' ? 'close'
        : event.data.name === 'multi_agent_v1__resume_agent' || event.data.name === 'resume_agent' ? 'resume' : undefined
      if (kind === undefined) continue
      let args: unknown
      try {
        args = JSON.parse(event.data.arguments)
      } catch (_error: unknown) {
        // Malformed durable model arguments have no valid successful address change.
        continue
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) continue
      const id = kind === 'close' ? 'target' in args ? args.target : undefined : 'id' in args ? args.id : undefined
      if (typeof id === 'string') calls.set(event.data.callId, { kind, id: SessionId(id) })
      continue
    }
    if (event.type !== 'tool/result' || event.data.message.isError === true) continue
    const call = calls.get(event.data.message.toolCallId)
    if (call?.kind === 'close') closed.add(call.id)
    else if (call?.kind === 'resume') closed.delete(call.id)
  }
  return closed
}

interface RootPool {
  readonly pool: CodexV1NicknamePool
  readonly dispose: () => void | Promise<void>
}

interface Registry {
  readonly roots: Map<SessionId, RootPool>
  owners: number
}

const registries = new WeakMap<SubagentRuntime, Registry>()

/** Context tracing wraps a service separately for each caller context. */
function registryKey(runtime: SubagentRuntime): SubagentRuntime {
  const original = Reflect.get(runtime, symbols.original) as SubagentRuntime | undefined
  return original ?? runtime
}

/**
 * Share nickname state through the subagent runtime for all tools in one root tree.
 * @param runtime - runtime owning the root and all its child Sessions.
 * @returns an owned registry lease; root disposal removes its pool, and disposing
 *   the last lease removes all root effects and runtime-only reservations.
 */
export function acquireCodexV1NicknameRegistry(runtime: SubagentRuntime): {
  readonly pool: (root: Agent) => CodexV1NicknamePool
  readonly dispose: () => void
} {
  const key = registryKey(runtime)
  let registry = registries.get(key)
  if (registry === undefined) {
    registry = { roots: new Map(), owners: 0 }
    registries.set(key, registry)
  }
  registry.owners += 1
  const owned = registry
  let disposed = false
  return {
    pool(root) {
      if (disposed) throw new Error('nickname registry lease is disposed')
      // V1's depth cap admits spawn only from a top-level root.
      if ((root.session.header.delegationDepth ?? 0) !== 0) throw new Error('a v1 nickname pool requires the root agent')
      let entry = owned.roots.get(root.id)
      if (entry === undefined) {
        const created = new CodexV1NicknamePool()
        const rootId = root.id
        const installed: RootPool = {
          pool: created,
          get dispose() { return disposeRoot },
        }
        const disposeRoot = root.ctx.effect(() => {
          owned.roots.set(rootId, installed)
          return () => {
            if (owned.roots.get(rootId) === installed) owned.roots.delete(rootId)
          }
        }, 'codexV1NicknameRegistry.root()')
        entry = installed
      }
      return entry.pool
    },
    dispose() {
      if (disposed) return
      disposed = true
      owned.owners -= 1
      if (owned.owners === 0) {
        for (const entry of [...owned.roots.values()]) void entry.dispose()
        owned.roots.clear()
        if (registries.get(key) === owned) registries.delete(key)
      }
    },
  }
}

/**
 * Read successful spawn results that have not yet entered the parent's Session log.
 * @param runtime - runtime shared by the v1 root's tool registrations.
 * @param rootId - top-level root Session identity.
 * @returns a detached nickname map; absence means no running v1 allocation.
 */
export function codexV1LiveNicknames(runtime: SubagentRuntime, rootId: SessionId): Map<SessionId, string> {
  return registries.get(registryKey(runtime))?.roots.get(rootId)?.pool.snapshot() ?? new Map<SessionId, string>()
}

/**
 * Read successful v1 address changes before parent tool results are committed.
 * @param runtime - runtime shared by the root's v1 tool registrations.
 * @param rootId - top-level root Session identity.
 * @returns a detached open/closed overlay; absence means no live root registry.
 */
export function codexV1LiveRoster(runtime: SubagentRuntime, rootId: SessionId): Map<SessionId, CodexV1RosterState> {
  return registries.get(registryKey(runtime))?.roots.get(rootId)?.pool.rosterSnapshot() ?? new Map<SessionId, CodexV1RosterState>()
}
