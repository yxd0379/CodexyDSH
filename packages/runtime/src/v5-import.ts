/** Non-destructive import of released fork artifacts into the product container. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, zstdDecompressSync } from 'node:zlib'
import { mkdir, open, readFile, readdir, link, unlink } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { KNOWN_SESSION_EVENT_TYPES, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage, ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { releasedV4SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { isSessionFormatJsonObject, sessionFormatCount, parseSessionFormatLogFilename } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatMigrationContext } from '@deepseek-ai/dsh-session-format'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { CODEXY_ARTIFACT_VERSION, decodeCodexyArtifact, PRODUCT_EVENT_TYPES, validateCodexyEvents } from './persistence-codec.ts'
import type { CodexyArtifactHeader } from './persistence-codec.ts'
import { platformHeader } from './session.ts'
import type { EpochHeader, SessionEventMap } from './session.ts'
import { publishArtifact } from './persistence.ts'
import { scanZstdFrames } from './zstd-frames.ts'
import { restoreReleasedV5Artifact } from './v5-validation.ts'
import { assertV5RowContent, notificationMessage, record, toolKind, text } from './v5-content.ts'

/** One translated artifact, retaining event sequence identities and the exact inherited cut. */
export interface ImportedArtifact { metadata: CodexyArtifactHeader; events: SessionEvent[]; originalEventCount: number }
function errno(error: unknown, code: string): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === code }
function plaintext(bytes: Buffer, path: string): Buffer {
  if (!path.endsWith('.zst') && !path.endsWith('.zstd')) return bytes
  const scanned = scanZstdFrames(bytes)
  const buffers = scanned.frames.map(frame => zstdDecompressSync(bytes.subarray(frame.start, frame.end)))
  if (scanned.tornStart !== undefined) buffers.push(zstdDecompressSync(bytes.subarray(scanned.tornStart), { finishFlush: constants.ZSTD_e_flush }))
  return Buffer.concat(buffers)
}
function notificationCarrier(event: SessionFormatEvent, events: readonly SessionFormatEvent[], activeTurn: number | undefined): SessionEvent<'user/message'> {
  const data = record(event.data, 'tool notification')
  const message = notificationMessage(data)
  const source = record(message['source'], 'tool notification source')
  const call = typeof data['callSeq'] === 'number' ? events[data['callSeq']] : undefined
  const callData = call?.type === 'tool/call' ? record(call.data, 'originating tool call') : undefined
  if (activeTurn === undefined || data['turn'] !== activeTurn || call === undefined || call.seq >= event.seq || callData === undefined
    || callData['callId'] !== message['toolCallId'] || toolKind(callData['kind']) !== toolKind(source['toolKind'])
    || source['toolKind'] === 'freeform' && source['name'] !== callData['name']) throw new TypeError(`invalid tool notification relationship at seq ${event.seq}`)
  const cited = event['sourceEventSeqs']
  if (!Array.isArray(cited) || cited.length !== 1 || cited[0] !== call.seq) throw new TypeError(`tool notification must cite its originating call at seq ${event.seq}`)
  const content = message['content']
  if (!Array.isArray(content)) throw new TypeError('tool notification content must be an array')
  const notification: SessionEventMap['tool/notification'] = { ...data,
    turn: sessionFormatCount(data['turn'], 'notification turn'), callSeq: SessionSeq(sessionFormatCount(data['callSeq'], 'notification callSeq')),
    message: { ...message, id: MessageId(text(message['id'], 'notification id')), role: 'tool',
      toolCallId: ToolCallId(text(message['toolCallId'], 'notification call id')), content: content as ContentBlock[],
      isError: message['isError'] === true, source: { ...source, kind: 'tool', callId: ToolCallId(text(source['callId'], 'notification source call id')),
        ...source['toolKind'] === undefined ? {} : { toolKind: toolKind(source['toolKind']) },
        ...source['name'] === undefined ? {} : { name: text(source['name'], 'notification source name') } } },
    ...data['historyTruncationTokenLimit'] === undefined ? {} : { historyTruncationTokenLimit: sessionFormatCount(data['historyTruncationTokenLimit'], 'notification history limit') },
    ...typeof data['originalText'] === 'string' ? { originalText: data['originalText'] } : {},
  }
  const carrier: UserMessage = { id: notification.message.id, role: 'user', content: notification.message.content,
    source: { kind: 'codexy-tool-notification', notification } }
  return { type: 'user/message', seq: SessionSeq(event.seq), time: event.time, data: carrier,
    surfaceOp: 'append', sourceEventSeqs: [SessionSeq(call.seq)] }
}
/** Decode released v4/v5 JSONL or concatenated Zstandard bytes without mutating the source. */
export function decodeLegacySession(bytes: Buffer, sourcePath: string): ImportedArtifact {
  const jsonl = plaintext(bytes, sourcePath)
  const boundary = jsonl.lastIndexOf(10)
  if (boundary < 0) throw new TypeError('legacy Session header is incomplete')
  const rows = jsonl.subarray(0, boundary).toString('utf8').split('\n')
  const physical: unknown = JSON.parse(rows.shift()!)
  if (!isSessionFormatJsonObject(physical) || physical['version'] !== 4 && physical['version'] !== 5) throw new TypeError('only released v4/v5 Session artifacts can be imported')
  const version = physical['version']
  const decoder = releasedV4SessionFormatCodec.createDecoder({ ...physical, version: 4 }, 'strict')
  const original: SessionFormatEvent[] = []
  const context: SessionFormatMigrationContext = { emitEvent: event => original.push(event), emitRun: run => original.push(...run.expand()) }
  for (const line of rows) {
    const row: unknown = JSON.parse(line)
    if (version === 5) assertV5RowContent(row)
    decoder.decodeRow(row, context)
  }
  const inheritedEventCount = SessionLogOffset(decoder.finish(context))
  if (version === 5) restoreReleasedV5Artifact({ header: { ...decoder.header, version: 5 }, events: original, inheritedEventCount }, new Set([...KNOWN_SESSION_EVENT_TYPES, ...PRODUCT_EVENT_TYPES]))
  const header = snapshotJsonValue({ ...decoder.header, version: 4, id: SessionId(decoder.header.id) }) as SessionHeader
  let activeTurn: number | undefined
  const events = original.map((event): SessionEvent => {
    if (event.type === 'turn/start') { const data = record(event.data, 'turn start'); activeTurn = typeof data['turn'] === 'number' ? data['turn'] : undefined }
    if (event.type === 'turn/end') activeTurn = undefined
    if (event.type === 'tool/notification') return notificationCarrier(event, original, activeTurn)
    if (event.type === 'request/header') {
      const data = record(event.data, 'request header data')
      const nativeValue = record(data['header'], 'request header')
      const config = record(nativeValue['config'], 'request config')
      const native: EpochHeader = { ...nativeValue, config: { ...config,
        provider: text(config['provider'], 'request provider'), model: text(config['model'], 'request model') } } as EpochHeader
      const reason = data['reason']
      if (reason !== 'initial' && reason !== 'resume' && reason !== 'change' && reason !== 'series') throw new TypeError('invalid legacy request header reason')
      return { ...event, type: 'request/header', seq: SessionSeq(event.seq), data: { ...data, reason, header: platformHeader(native), codexyHeader: native } } as SessionEvent<'request/header'>
    }
    if ((event.type !== 'schedule/change' && KNOWN_SESSION_EVENT_TYPES.has(event.type)) || (event['ignorable'] === true && !PRODUCT_EVENT_TYPES.has(event.type))) return { ...event, seq: SessionSeq(event.seq) } as SessionEvent
    if (!PRODUCT_EVENT_TYPES.has(event.type)) throw new TypeError(`unknown required legacy fact ${event.type} at seq ${event.seq}`)
    return { type: 'codexy/fact', seq: SessionSeq(event.seq), time: event.time, data: { type: event.type, data: event.data as JsonValue } }
  })
  const importedFrom = { path: resolve(sourcePath), sha256: createHash('sha256').update(bytes).digest('hex'), version }
  events.push({ type: 'codexy/fact', seq: SessionSeq(events.length), time: events.at(-1)?.time ?? header.createdAt,
    data: { type: 'runtime/import', data: { ...importedFrom, originalEventCount: original.length } } })
  const metadata: CodexyArtifactHeader = { kind: 'codexy-session', version: CODEXY_ARTIFACT_VERSION, session: header, inheritedEventCount, importedFrom }
  validateCodexyEvents(metadata, events)
  return { metadata, events, originalEventCount: original.length }
}
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
async function preserveOriginal(root: string, sourcePath: string, bytes: Buffer, digest: string): Promise<string> {
  const archive = join(root, '.imports')
  await mkdir(archive, { recursive: true, mode: 0o700 })
  const path = join(archive, `${digest}.${basename(sourcePath)}`)
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    try { await link(temporary, path); await syncDirectory(archive) } catch (error: unknown) {
      if (!errno(error, 'EEXIST')) throw error
      if (!(await readFile(path)).equals(bytes)) throw new TypeError('preserved original bytes differ from their content hash')
    }
  } finally { await unlink(temporary) }
  return path
}
/** Import one source into a new product artifact; an identical repeated import returns its existing path. */
export async function importLegacySession(sourcePath: string, productRoot: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const bytes = await readFile(sourcePath)
  const imported = decodeLegacySession(bytes, sourcePath)
  const root = resolve(productRoot)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const digest = imported.metadata.importedFrom!.sha256
  await preserveOriginal(root, sourcePath, bytes, digest)
  signal?.throwIfAborted()
  const target = join(root, `${encodeURIComponent(imported.metadata.session.id)}.codexy.jsonl`)
  try { await publishArtifact(target, imported.metadata, imported.events) } catch (error: unknown) {
    if (!errno(error, 'EEXIST')) throw error
    const existing = decodeCodexyArtifact(await readFile(target))
    if (existing.metadata.importedFrom?.sha256 !== digest) throw new TypeError(`product Session ${imported.metadata.session.id} already exists with different source data`)
  }
  return target
}
/** Select the highest committed generation per Session directory; preserve all predecessors. */
export async function findLegacySessionArtifacts(sourceRoot: string, signal?: AbortSignal): Promise<readonly string[]> {
  const selected: string[] = []
  async function visit(directory: string): Promise<void> {
    signal?.throwIfAborted()
    const entries = await readdir(directory, { withFileTypes: true })
    const files = entries.filter(entry => entry.isFile() && !entry.name.endsWith('.codexy.jsonl'))
    const generations = files.flatMap(entry => {
      const raw = entry.name.replace(/\.(?:zstd|zst)$/, '')
      const version = parseSessionFormatLogFilename(raw)
      return version === undefined ? [] : [{ version, path: join(directory, entry.name) }]
    }).sort((a, b) => b.version - a.version)
    const latest = generations[0]
    if (latest !== undefined) {
      if (generations[1]?.version === latest.version) throw new TypeError(`ambiguous legacy Session encoding in ${directory}`)
      selected.push(latest.path)
      return
    }
    for (const entry of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (/\.jsonl(?:\.zstd|\.zst)?$/.test(entry.name)) selected.push(join(directory, entry.name))
    }
    for (const entry of entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
      await visit(join(directory, entry.name))
    }
  }
  await visit(resolve(sourceRoot))
  return selected
}
/** Import selected legacy generations without replacing or deleting any original artifact. */
export async function importLegacySessionDirectory(sourceRoot: string, productRoot: string, signal?: AbortSignal): Promise<readonly string[]> {
  const artifacts = await findLegacySessionArtifacts(sourceRoot, signal)
  const imported: string[] = []
  for (const source of artifacts) { signal?.throwIfAborted(); imported.push(await importLegacySession(source, productRoot, signal)) }
  return imported
}
