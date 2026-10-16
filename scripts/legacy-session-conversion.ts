/** Offline conversion only. Never mounted by the application. */
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { decodeCodexyArtifact } from '../packages/runtime/src/persistence-codec.ts'
import { decodeLegacySession } from '../packages/runtime/src/v5-import.ts'
import { interruptedTurnClosers } from '../packages/runtime/src/recovery.ts'

export function convertLegacySession(bytes: Buffer, path: string) {
  const artifact = path.endsWith('.codexy.jsonl') ? decodeCodexyArtifact(bytes) : decodeLegacySession(bytes, path)
  const original = [...artifact.events, ...interruptedTurnClosers(artifact.events)]
  const privateRecords: unknown[] = []
  const native = original.flatMap(raw => {
    const event = structuredClone(raw) as any
    if (event.type === 'codexy/fact' || event.type === 'plugin:codexy/runtime') {
      event.type = event.data.type
      event.data = event.data.data
    }
    if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) || event.type === 'codexy/fact'
      || event.type === 'schedule/change'
      // A released fork accidentally stored the whole conversation as title
      // request diagnostics. Preserve it in the audit export, not native history.
      || event.type === 'session/title-llm-request' && (event.data.messages.length !== 1
        || event.data.messages[0].source?.kind !== 'dsh-session-title-llm')) {
      privateRecords.push(event)
      return []
    }
    // These legacy extensions have no native representation. Leave their
    // source intact and report them rather than silently changing tool roles.
    if (event.type === 'user/message' && event.data.source?.kind === 'codexy-tool-notification') {
      throw new Error(`Tool notification at ${event.seq} needs explicit conversion`)
    }
    if (event.type === 'request/header') delete event.data.codexyHeader
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      delete event.data.requestTimings
      delete event.data.requestSentTime
      if (event.type === 'assistant/attempt') delete event.data.replayState
    }
    if (event.type === 'compaction/summary') delete event.data.clientMetadata
    return [event]
  })
  // The old loop began tools before persisting the assembled assistant message.
  // Native DSH requires that advertisement first. Move only lifecycle markers;
  // message order, tool results, contents and original timestamps stay unchanged.
  const advertised = new Set<string>()
  const pending = new Map<string, any>()
  const selected: any[] = []
  for (const event of native) {
    if (event.type === 'tool/call' && !advertised.has(event.data.callId)) {
      pending.set(event.data.callId, event)
      continue
    }
    selected.push(event)
    if (event.type === 'assistant/message') {
      for (const block of event.data.message.content) {
        if (block.type !== 'tool-call') continue
        advertised.add(block.id)
        const call = pending.get(block.id)
        if (call !== undefined) {
          selected.push(call)
          pending.delete(block.id)
        }
      }
    }
  }
  if (pending.size) throw new Error(`${pending.size} tools have no persisted assistant invocation`)
  const mapping = new Map<number, number>(selected.map((event, index) => [event.seq, index]))
  const inheritedEventCount = SessionLogOffset(selected.filter(event => event.seq < artifact.metadata.inheritedEventCount).length)
  const ref = (seq: number): number => {
    const mapped = mapping.get(seq)
    if (mapped === undefined) throw new Error(`Native history references removed private record ${seq}`)
    return mapped
  }
  const refs = (seqs: number[]) => seqs.map(ref)
  const events = selected.map((event, seq) => {
    event.seq = seq
    if (event.sourceEventSeqs) event.sourceEventSeqs = refs(event.sourceEventSeqs)
    if (event.surfaceOp && event.surfaceOp !== 'append') {
      event.surfaceOp.startSeq = ref(event.surfaceOp.startSeq)
      event.surfaceOp.endSeq = ref(event.surfaceOp.endSeq)
    }
    const data = event.data
    switch (event.type) {
      case 'developer/message':
        if (data.headerSeq !== undefined) data.headerSeq = ref(data.headerSeq)
        break
      case 'command/done':
        // Old /recap completions linked to a private diagnostics record.
        // The displayed completion text is already self-contained.
        if (data.sourceEventSeq !== undefined) {
          if (mapping.has(data.sourceEventSeq)) data.sourceEventSeq = ref(data.sourceEventSeq)
          else delete data.sourceEventSeq
        }
        break
      case 'compaction/summary':
      case 'compaction/prune':
        data.shadowedRange = { start: ref(data.shadowedRange.start), end: ref(data.shadowedRange.end) }
        data.shadowedSeqs = refs(data.shadowedSeqs)
        break
      case 'session/title':
      case 'session/title-llm-request':
        data.messageSeqs = refs(data.messageSeqs)
        break
      case 'image/offload':
        data.targets = data.targets.map((target: any) => ({ ...target, seq: ref(target.seq) }))
        break
    }
    return event as SessionEvent
  })
  const header = artifact.metadata.session
  const session = Session.fromRestore(header.id, events, header, inheritedEventCount, 'detached')
  const before = Session.fromRestore(header.id, original, header, artifact.metadata.inheritedEventCount, 'detached')
  const messages = session.deriveMessages()
  if (JSON.stringify(messages) !== JSON.stringify(before.deriveMessages())) {
    throw new Error('Conversion changed the reconstructed conversation')
  }
  return { header, events, inheritedEventCount, privateRecords, messages }
}
