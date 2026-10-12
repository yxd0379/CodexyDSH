import { requestHeaderOf } from '@codexydsh/runtime/session'
import { appendProductEvent } from '@codexydsh/runtime/session'
/** Source-guided two-phase extraction and consolidation with validated, non-destructive publication. */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { BlockAssembler, createUserMessage } from '@codexydsh/runtime/llm'
import type { GenerateOptions } from '@codexydsh/runtime/llm'
import { MemoryRevision, MemoryRunId } from './service.ts'
import type { MemoryRefreshRequest, MemoryRefreshResult, MemoryRoute, MemoryRunId as RunId } from './service.ts'
import { SessionId } from '@codexydsh/runtime/session'
import type { SessionEvent } from '@codexydsh/runtime/session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-agent'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { Config } from './config.ts'
import { evidenceRows, selectEvidence } from './evidence.ts'
import { consolidationSystem, extractionInput, extractionSystem } from './prompts.ts'
import { boundedText, redactSecrets, revisionOf, tokenBoundedText } from './text.ts'
import { MemoryStore } from './store.ts'

const recordSchema = z.object({
  version: z.enum(['v1', 'v2']), sessionId: z.string().min(1).transform(SessionId), fingerprint: z.string(),
  sourceUpdatedAt: z.number(), generatedAt: z.number(), cwd: z.string(),
  rawMemory: z.string(), rolloutSummary: z.string(), rolloutSlug: z.string(), path: z.string(),
}).strict()
type RecordData = z.infer<typeof recordSchema>
const extractionV1 = z.object({ raw_memory: z.string(), rollout_summary: z.string(), rollout_slug: z.string().nullable().optional() }).strict()
const extractionV2 = z.object({ rollout_summary: z.string(), rollout_slug: z.string() }).strict()
const consolidationSchema = z.object({
  memory_summary: z.string(), memory: z.string(),
  skills: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/), content: z.string() }).strict()),
}).strict()
const stateSchema = z.object({
  revision: z.string(), updatedAt: z.number(), inputDigest: z.string(), selected: z.array(z.string()),
  documentHashes: z.record(z.string(), z.string()).optional(),
  sourceFingerprints: z.record(z.string(), z.string()).optional(),
}).strict()
const revisionSchema = z.object({ revision: z.string(), documents: z.array(z.tuple([z.string(), z.string()])), sourceSessions: z.array(z.string()), createdAt: z.number() }).strict()
const usageSchema = z.record(z.string(), z.object({ count: z.number().int().nonnegative(), lastUsedAt: z.number() }).strict())
const failureSchema = z.object({ retryAt: z.number(), error: z.string() }).strict()

/** One bounded auxiliary request; every dispatch and terminal outcome is durably attributed. */
async function generate(ctx: Context, config: Config, request: MemoryRefreshRequest, runId: RunId,
  phase: 'extract' | 'consolidate', route: MemoryRoute, sourceSessions: readonly SessionId[], system: string, text: string): Promise<string> {
  if (Buffer.byteLength(system) + Buffer.byteLength(text) > config.maxInputBytes) throw new Error(`memory ${phase} input exceeds maxInputBytes`)
  using duration = deadline(request.signal, config.timeoutMs, 'MEMORY_TIMEOUT')
  const messages = [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'codexful-memory', phase } })]
  const options: GenerateOptions = { provider: route.provider, model: route.model, system, messages,
    temperature: 0, maxTokens: config.maxOutputTokens, sessionId: request.session.id, signal: duration.signal }
  appendProductEvent(request.session, 'memory/request', { runId, phase, version: config.version, sourceSessions, route, system, messages, maxTokens: config.maxOutputTokens, temperature: 0 })
  try {
    duration.signal.throwIfAborted()
    const assembler = new BlockAssembler()
    let terminal = false
    for await (const chunk of ctx.codexyRequests.stream(options)) {
      duration.signal.throwIfAborted()
      assembler.push(chunk)
      if (chunk.type === 'finish') terminal = true
    }
    duration.signal.throwIfAborted()
    if (!terminal || assembler.finish.kind !== 'stop') throw new Error(`memory ${phase} request did not finish successfully`)
    const blocks = assembler.blocks()
    if (blocks.some(block => block.type === 'tool-call')) throw new Error('memory generation must not request tools')
    const output = blocks.filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text').map(block => block.text).join('')
    if (Buffer.byteLength(output) > config.maxArtifactBytes) throw new Error('memory output exceeds maxArtifactBytes')
    let noOutput = false
    if (phase === 'extract') {
      const parsed = config.version === 'v1' ? extractionV1.parse(JSON.parse(output)) : extractionV2.parse(JSON.parse(output))
      noOutput = parsed.rollout_summary.trim() === '' && (!('raw_memory' in parsed) || parsed.raw_memory.trim() === '')
    } else consolidationSchema.parse(JSON.parse(output))
    appendProductEvent(request.session, 'memory/result', { runId, phase, sourceSessions, outcome: noOutput ? 'no-output' : 'succeeded', output: redactSecrets(output) })
    return output
  } catch (error) {
    appendProductEvent(request.session, 'memory/result', { runId, phase, sourceSessions, outcome: duration.signal.aborted ? 'cancelled' : 'failed', error: redactSecrets(error instanceof Error ? error.message : String(error)) })
    throw error
  }
}

/** Resolve paired overrides without silently selecting an unrelated model. */
function routeFor(config: Config, request: MemoryRefreshRequest, phase: 'extract' | 'consolidate'): MemoryRoute {
  if (phase === 'consolidate' && config.consolidationProvider !== undefined && config.consolidationModel !== undefined) {
    return { provider: config.consolidationProvider, model: config.consolidationModel }
  }
  if (config.provider !== undefined && config.model !== undefined) return { provider: config.provider, model: config.model }
  const route = request.route ?? requestHeaderOf(request.session)?.config
  if (route === undefined) throw new Error('memory refresh needs a provider/model route; select a model or configure a memory model')
  return { provider: route.provider, model: route.model }
}

/** Load strictly decoded immutable per-Session extraction artifacts. */
async function records(store: MemoryStore): Promise<RecordData[]> {
  const result: RecordData[] = []
  for (const name of await store.internalNames('.state/records')) {
    const text = await store.text('.state/records/' + name)
    if (text !== undefined) result.push(recordSchema.parse(JSON.parse(text)))
  }
  const newest = new Map<SessionId, RecordData>()
  for (const record of result.sort((a, b) => a.generatedAt - b.generatedAt)) newest.set(record.sessionId, record)
  return [...newest.values()]
}

/** Whether source events contain external tool context disallowed by this deployment. */
function polluted(events: readonly SessionEvent[]): boolean {
  return events.some(event => event.type === 'tool/call' && /^(mcp[_:.]|web(?:_|\.)|search(?:_|\.)|fetch(?:_|\.))/.test(event.data.name))
}

/** Select exact current source inputs; stale records leave the active selection without deletion. */
async function selectedRecords(store: MemoryStore, config: Config, all: readonly RecordData[], now: number): Promise<RecordData[]> {
  const rawUsage = await store.text('.state/usage.json')
  const usage = rawUsage === undefined ? {} : usageSchema.parse(JSON.parse(rawUsage))
  return all.filter(record => record.rolloutSummary !== '' || record.rawMemory !== '')
    .filter(record => (usage[record.sessionId]?.lastUsedAt ?? record.generatedAt) >= now - config.maxUnusedDays * 86_400_000)
    .sort((a, b) => (usage[b.sessionId]?.count ?? 0) - (usage[a.sessionId]?.count ?? 0)
      || (usage[b.sessionId]?.lastUsedAt ?? b.generatedAt) - (usage[a.sessionId]?.lastUsedAt ?? a.generatedAt))
    .slice(0, config.maxRawMemories)
}

/** Execute source selection, extraction, and globally serialized consolidation.
 * @param ctx - Injected LLM, persistence, and live-agent services.
 * @param store - Namespace whose mutation lock is already held.
 * @param config - Validated deployment policy.
 * @param request - Human/background owner, route, and cancellation.
 * @returns Committed publication outcome; failures retain prior valid documents.
 */
export async function runPipeline(ctx: Context, store: MemoryStore, config: Config, request: MemoryRefreshRequest): Promise<MemoryRefreshResult> {
  request.signal?.throwIfAborted()
  const now = Date.now()
  const runId = MemoryRunId(randomUUID())
  const existing = await records(store)
  const latest = new Map(existing.map(record => [record.sessionId, record]))
  let extracted = 0
  let skipped = 0
  const candidates = [...await ctx.sessionPersistence.list({ ...request.signal === undefined ? {} : { signal: request.signal } })]
    .filter(item => item.header.id !== request.session.id && item.header.origin !== 'subagent' && item.header.parentSession === undefined)
    .sort((a, b) => b.header.createdAt - a.header.createdAt)
  for (const candidate of candidates) {
    request.signal?.throwIfAborted()
    if (extracted >= config.maxRolloutsPerStartup) break
    if (ctx.agents.get(candidate.header.id)?.status === 'running') { skipped++; continue }
    const handle = await ctx.sessionPersistence.open(candidate.header.id, 'read', { ...request.signal === undefined ? {} : { signal: request.signal } })
    let events
    try { events = (await handle.read(undefined, undefined, { ...request.signal === undefined ? {} : { signal: request.signal } })).events } finally { await handle.close() }
    const rows = evidenceRows(events)
    const lastActivity = rows.at(-1)?.time ?? candidate.header.createdAt
    const finalBoundary = events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
    if (!rows.some(row => row.priority === 0) || finalBoundary?.type === 'turn/start'
      || lastActivity < now - config.maxRolloutAgeDays * 86_400_000
      || !request.force && lastActivity > now - config.minRolloutIdleHours * 3_600_000
      || config.disableOnExternalContext && polluted(events)) { skipped++; continue }
    const fingerprint = revisionOf(String(candidate.header.id) + '\n' + rows.map(row => row.text).join('\n'))
    if (latest.get(candidate.header.id)?.fingerprint === fingerprint) { skipped++; continue }
    const failurePath = `.state/failures/${fingerprint}.json`
    const failure = await store.text(failurePath)
    if (failure !== undefined && failureSchema.parse(JSON.parse(failure)).retryAt > now && !request.force) { skipped++; continue }
    const route = routeFor(config, request, 'extract')
    const system = extractionSystem(config.version)
    const reference = `session:${candidate.header.id}`
    const framing = extractionInput(config.version, reference, candidate.header.cwd ?? '', '')
    const evidence = selectEvidence(rows, config.maxInputBytes - Buffer.byteLength(system) - Buffer.byteLength(framing))
    const text = extractionInput(config.version, reference, candidate.header.cwd ?? '', evidence)
    try {
      const output = await generate(ctx, config, request, runId, 'extract', route, [candidate.header.id], system, text)
      const parsed = config.version === 'v1' ? extractionV1.parse(JSON.parse(output)) : extractionV2.parse(JSON.parse(output))
      request.signal?.throwIfAborted()
      const summary = redactSecrets(parsed.rollout_summary)
      const raw = 'raw_memory' in parsed ? redactSecrets(parsed.raw_memory) : ''
      const slug = (parsed.rollout_slug ?? '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'session'
      const path = `rollout_summaries/${new Date(lastActivity).toISOString().replace(/[:.]/g, '-')}-${revisionOf(candidate.header.id).slice(0, 16)}-${fingerprint.slice(0, 8)}-${slug}.md`
      const record: RecordData = { version: config.version, sessionId: candidate.header.id, fingerprint,
        sourceUpdatedAt: lastActivity, generatedAt: now, cwd: candidate.header.cwd ?? '', rawMemory: raw,
        rolloutSummary: config.version === 'v2' ? boundedText(summary, 9_000).text : summary, rolloutSlug: slug, path }
      await store.create(`.state/records/${fingerprint}.json`, JSON.stringify(record))
      latest.set(record.sessionId, record)
      extracted++
    } catch (error) {
      if (request.signal?.aborted) throw error
      await store.replace(failurePath, JSON.stringify({ retryAt: Date.now() + config.retryBackoffMs, error: redactSecrets(error instanceof Error ? error.message : String(error)) }))
      throw error
    }
  }
  let selected = await selectedRecords(store, config, [...latest.values()], now)
  const notes: { path: string; content: string }[] = []
  for (const name of await store.internalNames('extensions/ad_hoc/notes')) {
    if (name.startsWith('.') || !name.endsWith('.md')) continue
    const path = 'extensions/ad_hoc/notes/' + name
    const content = await store.text(path)
    if (content !== undefined) notes.push({ path, content })
  }
  const previousMemory = await store.text('MEMORY.md')
  const previousSummary = await store.text('memory_summary.md')
  const previousStateText = await store.text('.state/current.json')
  const previousState = previousStateText === undefined ? undefined : stateSchema.parse(JSON.parse(previousStateText))
  const system = consolidationSystem(config.version, store.root)
  let originalDocuments: readonly [string, string][] = []
  if (previousState !== undefined) {
    const original = await store.text(`.state/revisions/${previousState.revision}.json`)
    if (original !== undefined) originalDocuments = revisionSchema.parse(JSON.parse(original)).documents
  }
  const humanEdits = ['MEMORY.md', 'memory_summary.md'].flatMap((path) => {
    const previous = originalDocuments.find(([name]) => name === path)?.[1]
    const current = path === 'MEMORY.md' ? previousMemory : previousSummary
    if (previous === undefined || current === previous) return []
    return [{ path, generated: previous, current: current ?? '', instruction: 'The current document contains human edits. Preserve removals and corrections; do not restore removed claims from old source records.' }]
  })
  const payloadFor = (records: readonly RecordData[]) => ({
    previous: { memory_summary: previousSummary ?? '', memory: previousMemory ?? '' },
    human_edits: humanEdits,
    source_changes: {
      added: records.filter(record => !previousState?.selected.includes(record.sessionId)).map(record => record.sessionId),
      removed: (previousState?.selected ?? []).filter(id => !records.some(record => record.sessionId === id)),
      updated: records.filter(record => previousState?.selected.includes(record.sessionId)
        && previousState.sourceFingerprints?.[record.sessionId] !== record.fingerprint)
        .map(record => ({ session_id: record.sessionId, previous_fingerprint: previousState?.sourceFingerprints?.[record.sessionId] ?? null, fingerprint: record.fingerprint })),
    },
    records, notes,
  })
  if (Buffer.byteLength(system) + Buffer.byteLength(JSON.stringify(payloadFor([]))) > config.maxInputBytes) {
    throw new Error('memory consolidation corrections and existing documents exceed maxInputBytes; retained all prior memory')
  }
  const fitted: RecordData[] = []
  for (const record of selected) {
    if (Buffer.byteLength(system) + Buffer.byteLength(JSON.stringify(payloadFor([...fitted, record]))) <= config.maxInputBytes) fitted.push(record)
    else skipped++
  }
  selected = fitted.sort((a, b) => a.sessionId.localeCompare(b.sessionId, 'en'))
  const inputDigest = revisionOf(JSON.stringify({ system, selected: selected.map(record => [record.sessionId, record.fingerprint]), notes }))
  if (humanEdits.length === 0 && previousState?.inputDigest === inputDigest || selected.length === 0 && notes.length === 0 && previousState === undefined) {
    return { extracted, skipped, consolidated: false, ...previousState === undefined ? {} : { revision: MemoryRevision(previousState.revision) } }
  }
  const payload = payloadFor(selected)
  const text = JSON.stringify(payload)
  const route = routeFor(config, request, 'consolidate')
  const sourceSessions = selected.map(record => record.sessionId)
  const failurePath = `.state/failures/consolidation-${revisionOf(JSON.stringify({ route, system, text }))}.json`
  const failure = await store.text(failurePath)
  if (!request.force && failure !== undefined) {
    const previousFailure = failureSchema.parse(JSON.parse(failure))
    if (previousFailure.retryAt > now) {
      throw new Error(`memory consolidation retry is deferred until ${new Date(previousFailure.retryAt).toISOString()}: ${previousFailure.error}`)
    }
  }
  try {
    const output = await generate(ctx, config, request, runId, 'consolidate', route, sourceSessions, system, text)
    const result = consolidationSchema.parse(JSON.parse(output))
    request.signal?.throwIfAborted()
    const documents = new Map<string, string>([['memory_summary.md', tokenBoundedText(redactSecrets(result.memory_summary), config.summaryTokens)]])
    if (config.version === 'v1') {
      documents.set('MEMORY.md', redactSecrets(result.memory))
      documents.set('raw_memories.md', selected.map(record => `## ${record.sessionId}\n${record.rawMemory}`).join('\n\n'))
    }
    for (const record of selected) documents.set(record.path, `thread_id: ${record.sessionId}\nsource: session:${record.sessionId}\ncwd: ${record.cwd}\nupdated_at: ${new Date(record.sourceUpdatedAt).toISOString()}\n\n${record.rolloutSummary}`)
    if (config.version === 'v1') {
      for (const skill of result.skills) {
        const path = `skills/${skill.name}/SKILL.md`
        if (documents.has(path)) throw new Error('memory consolidation returned duplicate skill names')
        documents.set(path, redactSecrets(skill.content))
      }
    } else if (result.memory !== '' || result.skills.length !== 0) throw new Error('v2 memory consolidation must leave MEMORY.md and skills empty')
    const knownPaths = new Set(selected.map(record => record.path))
    for (const content of documents.values()) {
      if (Buffer.byteLength(content) > config.maxArtifactBytes) throw new Error('memory document exceeds maxArtifactBytes')
      for (const match of content.matchAll(/rollout_summaries\/[a-zA-Z0-9_.-]+\.md/g)) {
        if (!knownPaths.has(match[0])) throw new Error(`memory consolidation invented rollout pointer '${match[0]}'`)
      }
    }
    if (await store.text('MEMORY.md') !== previousMemory || await store.text('memory_summary.md') !== previousSummary) {
      throw new Error('memory documents changed during consolidation; preserved human edits and discarded the generated revision')
    }
    request.signal?.throwIfAborted()
    const revision = revisionOf(JSON.stringify([...documents]))
    if (await store.text(`.state/revisions/${revision}.json`) === undefined) {
      await store.create(`.state/revisions/${revision}.json`, JSON.stringify({ revision, documents: [...documents], sourceSessions, createdAt: now }))
    }
    for (const [path, next] of documents) {
      if (path === 'MEMORY.md' || path === 'memory_summary.md') continue
      const current = await store.text(path)
      const expected = previousState?.documentHashes?.[path]
      if (current !== undefined && current !== next && (expected === undefined || revisionOf(current) !== expected)) {
        throw new Error(`memory document '${path}' was manually edited; consolidation retained the edit`)
      }
    }
    const documentHashes = Object.fromEntries([...documents].map(([path, content]) => [path, revisionOf(content)]))
    const sourceFingerprints = Object.fromEntries(selected.map(record => [record.sessionId, record.fingerprint]))
    documents.set('.state/current.json', JSON.stringify({ revision, updatedAt: now, inputDigest, selected: sourceSessions, documentHashes, sourceFingerprints }))
    // Publication is uncancellable after staging; the journal exposes the prior committed documents until settlement.
    await store.publish(documents, new Map([['MEMORY.md', previousMemory], ['memory_summary.md', previousSummary]]))
    appendProductEvent(request.session, 'memory/updated', { runId, revision, sourceSessions, paths: [...documents.keys()] })
    return { extracted, skipped, consolidated: true, revision }
  } catch (error) {
    if (request.signal?.aborted) throw error
    await store.replace(failurePath, JSON.stringify({ retryAt: Date.now() + config.retryBackoffMs, error: redactSecrets(error instanceof Error ? error.message : String(error)) }))
    throw error
  }
}

/** Persist read usage as one writer-serialized whole ledger.
 * @param store - Local managed store.
 * @param paths - Public documents actually returned to the caller.
 * @param citedSessionIds - Exact rollout identities explicitly cited in a completed answer.
 * @returns Source Session identities credited by those paths.
 */
export async function recordUsage(store: MemoryStore, paths: readonly string[], citedSessionIds: readonly string[] = []): Promise<readonly SessionId[]> {
  const all = await records(store)
  const used = all.filter(record => paths.includes(record.path) || citedSessionIds.includes(record.sessionId)).map(record => record.sessionId)
  if (used.length === 0) return []
  await store.writing(async () => {
    const prior = await store.text('.state/usage.json')
    const usage = prior === undefined ? {} : usageSchema.parse(JSON.parse(prior))
    for (const id of used) usage[id] = { count: (usage[id]?.count ?? 0) + 1, lastUsedAt: Date.now() }
    await store.replace('.state/usage.json', JSON.stringify(usage))
  })
  return used
}
