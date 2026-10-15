/** Capture native metadata from this product's committed Session and prepared policies. */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { encodeCodexClientMetadata, isCodexWorkspacesMetadata } from '@codexydsh/runtime/llm'
import type { CodexClientMetadata, CodexWorkspacesMetadata } from '@codexydsh/runtime/llm'
import { appendProductEvent, snapshotProductEvents } from '@codexydsh/runtime/session'
import type { Session } from '@codexydsh/runtime/session'

/** Model restrictions chosen by the operator, not assertions that a Node tool is mounted. */
export interface ResponseMetadataModelPolicy {
  readonly nodeReplDisabled?: boolean
  readonly nodeReplAutoReviewRequired?: boolean
}

/** Explicit application facts for an opted-in wire profile; unknown entries remain absent. */
export interface ResponseMetadataConfig {
  readonly installationId?: string
  readonly threadSource?: string
  readonly turnTrigger?: string
  readonly analyticsEnabled?: boolean
  /** Captured model compatibility restrictions; no defaults are inferred from the tool roster. */
  readonly modelPolicy?: ResponseMetadataModelPolicy
}

/** Detach explicit facts before asynchronous request preparation, including their policy object. */
export function captureResponseMetadataConfig(config: ResponseMetadataConfig | undefined): Readonly<ResponseMetadataConfig> | undefined {
  if (config === undefined) return
  return Object.freeze({ ...config,
    ...config.modelPolicy === undefined ? {} : { modelPolicy: Object.freeze({ ...config.modelPolicy }) },
  })
}

/** Policy labels from the same prepared assembly that renders the permission instructions. */
export interface ResponseMetadataPolicy {
  readonly sandboxMode: string
  readonly autoReviewEnabled: boolean
}

function canonicalMetadata(metadata: CodexClientMetadata | undefined): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(metadata?.['x-codex-turn-metadata'] ?? 'null')
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch { /* Foreign metadata is not a product identity or workspace source. */ }
  return undefined
}

/** Capture through the public execution-world seam, or reuse this turn's durable snapshot. */
export async function captureResponseWorkspaces(
  session: Session,
  subprocess: SubprocessRuntime,
  cwd: string,
  signal?: AbortSignal,
): Promise<CodexWorkspacesMetadata | undefined> {
  const events = snapshotProductEvents(session)
  const start = events.findLast(event => event.type === 'turn/start')
  if (start === undefined) return
  const previous = events.findLast(event => event.type === 'request/header'
    && event.data.header.config.codexfulResponses?.clientMetadata !== undefined)
  const canonical = canonicalMetadata(previous?.type === 'request/header'
    ? previous.data.header.config.codexfulResponses?.clientMetadata : undefined)
  if (canonical?.['turn_id'] === `${session.id}:turn:${start.seq}`) {
    return isCodexWorkspacesMetadata(canonical['workspaces']) ? canonical['workspaces'] : undefined
  }
  return probeResponseWorkspaces(subprocess, cwd, signal)
}

async function probeResponseWorkspaces(
  subprocess: SubprocessRuntime, cwd: string, signal?: AbortSignal,
): Promise<CodexWorkspacesMetadata | undefined> {
  try {
    const git = await subprocess.resolveExecutable('git', undefined, signal)
    signal?.throwIfAborted()
    const run = async (directory: string, args: readonly string[]) => {
      signal?.throwIfAborted()
      const handle = subprocess.spawn({ argv: [git, '-C', directory, ...args], cwd: directory,
        env: { GIT_OPTIONAL_LOCKS: '0' }, signal, graceMs: 200,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 * 1024 }, stderr: { maxBytes: 4096 } } })
      const outcome = await handle.done
      signal?.throwIfAborted()
      if (outcome.exitCode !== 0) return undefined
      return handle.collected.stdout?.readFrom(0)
    }
    const root = await run(cwd, ['rev-parse', '--show-toplevel'])
    if (root === undefined || root.lossy) return
    // Git appends one LF; all whitespace belonging to the path must survive.
    const directory = root.text.replace(/\n$/, '')
    if (!isAbsolute(directory)) return
    const status = await run(directory, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'])
    if (status === undefined || status.lossy) return
    const lines = status.text.split('\n')
    const commit = lines.find(line => line.startsWith('# branch.oid '))?.slice('# branch.oid '.length)
    // Unborn repositories and failed Git probes have no commit fact to report.
    if (commit === undefined || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) return
    return Object.freeze({ [directory]: Object.freeze({ latest_git_commit_hash: commit,
      has_changes: lines.some(line => line.length > 0 && !line.startsWith('# ')) }) })
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    // Git is optional workspace metadata; missing or failed probes do not invent facts.
    return undefined
  }
}

interface WorkspaceEnrichment {
  readonly turnId: string
  readonly controller: AbortController
  workspaces: CodexWorkspacesMetadata | undefined
  failure?: { readonly error: unknown }
}

/** Optional Git enrichment never delays a model request; its first result is turn-owned. */
export class ResponseWorkspaceEnrichment {
  private readonly turns = new WeakMap<Session, WorkspaceEnrichment>()
  private readonly pending = new Set<AbortController>()
  private disposed = false

  constructor(private readonly subprocess: SubprocessRuntime) {}

  start(session: Session, cwd: string, signal?: AbortSignal): void {
    signal?.throwIfAborted()
    if (this.disposed) return
    const events = snapshotProductEvents(session)
    const start = events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
    if (start?.type !== 'turn/start') return
    const turnId = `${session.id}:turn:${start.seq}`
    const previous = this.turns.get(session)
    if (previous?.turnId === turnId) return
    previous?.controller.abort()
    const controller = new AbortController()
    const state: WorkspaceEnrichment = { turnId, controller, workspaces: undefined }
    this.turns.set(session, state)
    const fact = events.findLast(event => event.type === 'codexful/workspace-enrichment'
      && event.data.turnStartSeq === start.seq)
    const header = events.findLast(event => event.type === 'request/header')
    const canonical = canonicalMetadata(header?.type === 'request/header'
      ? header.data.header.config.codexfulResponses?.clientMetadata : undefined)
    const retained = canonical?.['turn_id'] === turnId && isCodexWorkspacesMetadata(canonical['workspaces'])
      ? canonical['workspaces'] : undefined
    const ready = fact?.type === 'codexful/workspace-enrichment' && fact.data.phase === 'ready'
    if (retained !== undefined || ready) {
      const workspaces = retained ?? (fact?.type === 'codexful/workspace-enrichment' ? fact.data.workspaces : undefined)
      state.workspaces = workspaces === undefined ? undefined : Object.freeze(Object.fromEntries(
        Object.entries(workspaces).map(([directory, facts]) => [directory, Object.freeze({ ...facts })])))
      return
    }
    const directory = fact?.type === 'codexful/workspace-enrichment' ? fact.data.cwd : cwd
    if (fact === undefined) appendProductEvent(session, 'codexful/workspace-enrichment', {
      turnStartSeq: start.seq, cwd: directory, phase: 'pending',
    })
    this.pending.add(controller)
    const combinedSignal = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal])
    void probeResponseWorkspaces(this.subprocess, directory, combinedSignal).then(workspaces => {
      const active = snapshotProductEvents(session).findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
      if (!combinedSignal.aborted && !this.disposed && active?.type === 'turn/start' && active.seq === start.seq) {
        appendProductEvent(session, 'codexful/workspace-enrichment', {
          turnStartSeq: start.seq, cwd: directory, phase: 'ready',
          ...workspaces === undefined ? {} : { workspaces },
        })
        state.workspaces = workspaces
      }
    }, () => {
      // Failed or cancelled optional enrichment adds no invented Git facts.
    }).catch(error => {
      // A failed required fact commit must surface before these facts enter a request.
      state.failure = { error }
    }).finally(() => { this.pending.delete(controller) })
  }

  read(session: Session): CodexWorkspacesMetadata | undefined {
    if (this.disposed) return
    const state = this.turns.get(session)
    const start = snapshotProductEvents(session).findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
    if (start?.type === 'turn/start' && state?.turnId === `${session.id}:turn:${start.seq}`
      && !state.controller.signal.aborted) {
      if (state.failure !== undefined) throw state.failure.error
      return state.workspaces
    }
    return undefined
  }

  cancel(session: Session): void {
    this.turns.get(session)?.controller.abort()
    this.turns.delete(session)
  }

  dispose(): void {
    this.disposed = true
    for (const controller of this.pending) controller.abort()
    this.pending.clear()
  }
}

/** Build a snapshot before dispatch; request/header owns its subsequent durable commit. */
export function captureResponseMetadata(
  session: Session,
  application: ResponseMetadataConfig | undefined,
  policy: ResponseMetadataPolicy,
  controls: { readonly model: string; readonly reasoningEffort?: string; readonly workspaces?: CodexWorkspacesMetadata },
  mintId: () => string = randomUUID,
): CodexClientMetadata | undefined {
  const events = snapshotProductEvents(session)
  const start = events.findLast(event => event.type === 'turn/start')
  // Manual/non-loop callers may have no committed turn; they remain executable.
  if (start === undefined) return
  const previous = events.findLast(event => event.type === 'request/header'
    && event.data.header.config.codexfulResponses?.clientMetadata !== undefined)
  const metadata = previous?.type === 'request/header'
    ? previous.data.header.config.codexfulResponses?.clientMetadata : undefined
  const canonical = canonicalMetadata(metadata)
  const completedWindows = events.filter(event => event.type === 'compaction/end' && event.data.error === undefined)
  const windowNumber = completedWindows.length
  const lastWindow = completedWindows.at(-1)
  const contextWindowId = lastWindow?.type === 'compaction/end'
    ? `${session.id}:context:${lastWindow.data.compactionId}`
    : metadata?.['thread_id'] === session.id && typeof canonical?.['context_window_id'] === 'string'
      ? canonical['context_window_id'] : mintId()
  const installationId = application?.installationId ?? metadata?.['x-codex-installation-id'] ?? mintId()
  const turnId = `${session.id}:turn:${start.seq}`
  const workspaces = canonical?.['turn_id'] === turnId
    ? isCodexWorkspacesMetadata(canonical['workspaces']) ? canonical['workspaces'] : controls.workspaces
    : controls.workspaces
  const root = session.header.parentSession === undefined
  return encodeCodexClientMetadata({
    installationId, sessionId: session.id, threadId: session.id, turnId,
    contextWindowId, windowNumber, requestKind: 'turn',
    ...root ? { rootTurnId: turnId, agentName: '/root', threadSource: application?.threadSource,
      turnTrigger: application?.turnTrigger } : {},
    sandboxMode: policy.sandboxMode,
    ...policy.sandboxMode === 'danger-full-access' ? { sandbox: 'none' } : {},
    autoReviewEnabled: policy.autoReviewEnabled,
    nodeReplDisabled: application?.modelPolicy?.nodeReplDisabled,
    nodeReplAutoReviewRequired: application?.modelPolicy?.nodeReplAutoReviewRequired,
    turnStartedAtUnixMs: start.time,
    analyticsEnabled: application?.analyticsEnabled,
    workspaces,
    model: controls.model,
    reasoningEffort: controls.reasoningEffort,
  })
}
