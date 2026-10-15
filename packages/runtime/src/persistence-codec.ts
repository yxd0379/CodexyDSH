/** Product artifact codec over the unmodified DSH v4 Session implementation. */
import { Session, SessionId, SessionLogOffset, KNOWN_SESSION_EVENT_TYPES, adoptSessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { projectProductEvent } from './events.ts'
import { assertV5RowContent } from './v5-content.ts'
import { restoreReleasedV5Artifact } from './v5-validation.ts'
import type { SessionFormatEvent, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'

/** Current product container; the embedded logical Session remains upstream v4. */
export const CODEXY_ARTIFACT_VERSION = 1
/** Product facts understood independently of currently mounted plugins. */
export const PRODUCT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'assistant/output-item', 'llm/request-timing', 'request/feature', 'request/header',
  'tool/notification', 'approval/review', 'approval/reviewer', 'code-mode/completed',
  'code-mode/dispatch', 'codexful/multi-agent-version', 'codexful/workspace-enrichment', 'memory/context', 'memory/edited',
  'memory/request', 'memory/result', 'memory/updated', 'memory/used', 'recap/request',
  'recap/result', 'subagent/codex-v1-identity', 'subagent/fork-window', 'runtime/import',
  'runtime/feature', 'schedule/change', 'codexy/goal-state', 'codexy/goal-request',
  'compaction/request', 'compaction/request-result', 'compaction/preparation-error',
])
/** Product artifact metadata stored in the first physical line. */
export interface CodexyArtifactHeader {
  readonly kind: 'codexy-session'
  readonly version: typeof CODEXY_ARTIFACT_VERSION
  readonly session: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly importedFrom?: { readonly path: string; readonly sha256: string; readonly version: number }
}
/** One parsed artifact and the byte boundary of its complete physical prefix. */
export interface DecodedCodexyArtifact {
  readonly metadata: CodexyArtifactHeader
  readonly events: SessionEvent[]
  readonly validBytes: number
  readonly tornBytes: number
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
/** Validate container metadata and the upstream logical header before reading events. */
export function decodeArtifactHeader(value: unknown): CodexyArtifactHeader {
  if (!isRecord(value) || value['kind'] !== 'codexy-session' || value['version'] !== CODEXY_ARTIFACT_VERSION) {
    throw new TypeError('unsupported Codexy Session container')
  }
  const session = value['session']
  const inherited = value['inheritedEventCount']
  if (!isRecord(session) || typeof session['id'] !== 'string' || session['version'] !== 4
    || typeof session['createdAt'] !== 'number' || typeof session['isSeeded'] !== 'boolean'
    || typeof inherited !== 'number' || !Number.isSafeInteger(inherited) || inherited < 0) {
    throw new TypeError('invalid Codexy Session metadata')
  }
  const detached = snapshotJsonValue(value)
  if (detached === undefined) throw new TypeError('Codexy metadata must contain lossless JSON')
  const rawImported = value['importedFrom']
  let importedFrom: CodexyArtifactHeader['importedFrom']
  if (rawImported !== undefined) {
    if (!isRecord(rawImported) || typeof rawImported['path'] !== 'string' || typeof rawImported['sha256'] !== 'string'
      || !/^[a-f0-9]{64}$/.test(rawImported['sha256']) || typeof rawImported['version'] !== 'number' || !Number.isSafeInteger(rawImported['version'])) throw new TypeError('invalid imported Session metadata')
    importedFrom = { path: rawImported['path'], sha256: rawImported['sha256'], version: rawImported['version'] }
  }
  const metadata: CodexyArtifactHeader = { ...detached, kind: 'codexy-session', version: CODEXY_ARTIFACT_VERSION,
    session: { ...session, version: 4, id: SessionId(session['id']), createdAt: session['createdAt'], isSeeded: session['isSeeded'] },
    inheritedEventCount: SessionLogOffset(inherited), ...importedFrom === undefined ? {} : { importedFrom } }

  // Session validates its complete header; an inherited cut is checked after the body is available.
  Session.fromRestore(SessionId(session['id']), [], metadata.session, SessionLogOffset(0), 'detached')
  return metadata
}
/** Reject unknown required facts, then validate dense envelopes and surface references through DSH. */
export function validateCodexyBatch(events: readonly SessionEvent[]): void {
  for (const event of events) {
    const type: string = event.type
    assertV5RowContent(projectProductEvent(event))
    if (type === 'codexy/fact') {
      const fact = projectProductEvent(event)
      assertV5RowContent(fact)
      if (!PRODUCT_EVENT_TYPES.has(fact.type) && !KNOWN_SESSION_EVENT_TYPES.has(fact.type)) {
        throw new TypeError(`unknown required Codexy fact ${fact.type} at seq ${event.seq}`)
      }
    } else if (!KNOWN_SESSION_EVENT_TYPES.has(type) && event.ignorable !== true) {
      throw new TypeError(`unknown required Session event ${type} at seq ${event.seq}`)
    }
    adoptSessionEvent(event)
  }
}
/** Validate a restored artifact, including historical surface references and the inherited cut. */
export function validateCodexyEvents(metadata: CodexyArtifactHeader, events: SessionEvent[]): SessionEvent[] {
  validateCodexyBatch(events)
  Session.fromRestore(metadata.session.id, events, metadata.session, metadata.inheritedEventCount, 'detached')
  const header: unknown = { ...metadata.session, version: 5, delegationDepth: metadata.session.delegationDepth ?? 0 }
  const logical = events.map(event => {
    const projected = projectProductEvent(event)
    const detached: unknown = snapshotJsonValue({ ...event, type: projected.type, data: projected.data })
    return detached as SessionFormatEvent
  })
  restoreReleasedV5Artifact({ header: header as SessionFormatHeader, events: logical, inheritedEventCount: metadata.inheritedEventCount },
    new Set([...KNOWN_SESSION_EVENT_TYPES, ...PRODUCT_EVENT_TYPES]))

  return events
}
/** Parse complete UTF-8 JSONL rows; an unterminated suffix is retained for write-owner repair. */
export function decodeCodexyArtifact(bytes: Uint8Array): DecodedCodexyArtifact {
  const data = Buffer.from(bytes)
  const lastNewline = data.lastIndexOf(10)
  if (lastNewline < 0) throw new TypeError('Codexy Session metadata is incomplete')
  const complete = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, lastNewline + 1))
  const rows = complete.slice(0, -1).split('\n')
  const first = rows.shift()
  if (first === undefined) throw new TypeError('Codexy Session metadata is missing')
  const headerValue: unknown = JSON.parse(first)
  const metadata = decodeArtifactHeader(headerValue)
  const events = rows.map((row, index) => {
    if (row.length === 0) throw new TypeError(`empty Codexy Session row ${index + 1}`)
    const value: unknown = JSON.parse(row)
    if (!isRecord(value) || value['seq'] !== index || typeof value['type'] !== 'string') {
      throw new TypeError(`invalid Codexy Session envelope at row ${index + 1}`)
    }
    return value as SessionEvent
  })
  validateCodexyEvents(metadata, events)
  return { metadata, events, validBytes: lastNewline + 1, tornBytes: data.length - lastNewline - 1 }
}
/** Encode one immutable product metadata line. */
export function encodeArtifactHeader(metadata: CodexyArtifactHeader): string {
  decodeArtifactHeader(metadata)
  return `${JSON.stringify(metadata)}\n`
}
/** Encode a detached contiguous event batch; each event occupies one complete physical row. */
export function encodeArtifactEvents(events: readonly SessionEvent[]): string {
  const detached = snapshotJsonValue(events)
  if (detached === undefined) throw new TypeError('Codexy Session events must contain lossless JSON')
  return detached.map(event => `${JSON.stringify(event)}\n`).join('')
}
