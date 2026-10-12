/** Required model facts, released-artifact import, and cross-process writer ownership. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtemp, readFile, rm, appendFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { fork } from 'node:child_process'
import { constants, zstdCompressSync } from 'node:zlib'
import CodexySessionPersistence, { decodeCodexyArtifact, decodeLegacySession, importLegacySession, importLegacySessionDirectory, findLegacySessionArtifacts } from '../src/persistence.ts'
import { appendProductEvent, deriveProductMessages, requestHeaderOf, snapshotProductEvents, buildForkSeed, encodeProductEvents } from '../src/session.ts'

const fixture = fileURLToPath(new URL('./fixtures/released-v5-native.jsonl', import.meta.url))
const id = SessionId('product-storage')
const header = { version: 4, id, createdAt: 1000, isSeeded: false }
describe('Codexy durable artifacts on original DSH', () => {
  let root: string
  const contexts: Context[] = []
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'codexy-persistence-')) })
  afterEach(async () => {
    try { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  async function provider(): Promise<CodexySessionPersistence> {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(CodexySessionPersistence, { root })
    return ctx.sessionPersistence as CodexySessionPersistence
  }
  it('persists required request and completed-output facts through the original Session protocol', async () => {
    const persistence = await provider()
    const session = Session.create(id, undefined, header)
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }), { surfaceOp: 'append' })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    appendProductEvent(session, 'request/header', { reason: 'initial', header: { config: { provider: 'codex', model: 'test', codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'auto' } } } })
    const writer = await persistence.create(header)
    await writer.append(session.snapshotEvents())
    await writer.flush()
    await writer.close()
    const reader = await persistence.open(id, 'read')
    const restored = Session.fromRestore(id, (await reader.read()).events, reader.header, reader.inheritedEventCount, 'detached')
    expect(requestHeaderOf(restored)?.config.codexfulResponses).toEqual({ omitDefaultMaxTokens: true, reasoningSummary: 'auto' })
    expect(() => validateStoredEvents(header, [...restored.snapshotEvents()])).toThrow('unknown to this harness')
    await reader.close()
  })
  it('serves fresh pending sessions before materialization and preserves an empty session on close', async () => {
    const persistence = await provider()
    const writer = await persistence.create(header)
    expect(await persistence.stat(id)).toMatchObject({ header, eventCount: 0 })
    expect(await persistence.list()).toHaveLength(1)
    const reader = await persistence.open(id, 'read')
    expect((await reader.read()).events).toEqual([])
    await writer.close()
    expect((await reader.read()).events).toEqual([])
    expect(decodeCodexyArtifact(await readFile(persistence.pathFor(id))).events).toEqual([])
    await reader.close()
  })
  it('recovers only an incomplete final row before continuing the same dense sequence', async () => {
    const persistence = await provider()
    const writer = await persistence.create(header)
    await writer.append([{ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }])
    await writer.close()
    const path = persistence.pathFor(id)
    const prefix = await readFile(path)
    await appendFile(path, '{"type":"assistant/output-item"')
    const reader = await persistence.open(id, 'read')
    expect((await reader.read()).events).toHaveLength(1)
    await reader.close()
    const successor = await persistence.open(id, 'write')
    await successor.append([{ type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } }])
    await successor.flush()
    await successor.close()
    expect((await readFile(path)).subarray(0, prefix.length)).toEqual(prefix)
    expect(decodeCodexyArtifact(await readFile(path)).events.map(event => event.seq)).toEqual([0, 1])
  })
  it('refuses a concurrent external writer and releases ownership when that process exits', async () => {
    const persistence = await provider()
    const writer = await persistence.create(header)
    await writer.flush()
    await writer.close()
    const child = fork(fileURLToPath(new URL('./fixtures/lease-holder.mjs', import.meta.url)), [persistence.pathFor(id)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const exited = new Promise<void>((resolve, reject) => { child.once('exit', code => code === 0 ? resolve() : reject(new Error(`lease child exited ${code}`))); child.once('error', reject) })
    try {
      await new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error('lease child exited before readiness'))) })
      await expect(persistence.open(id, 'write')).rejects.toThrow('already owned')
      child.send({ release: true })
      await exited
      const successor = await persistence.open(id, 'write')
      await successor.close()
    } finally {
      if (child.exitCode === null) { child.kill(); await exited.catch(() => undefined) }
    }
  })
  it('imports v5 without changing originals, inherited cuts, native roles, or existing seq references', async () => {
    const bytes = await readFile(fixture)
    const source = join(root, 'old-v5.jsonl')
    await writeFile(source, bytes)
    const productRoot = join(root, 'product')
    const target = await importLegacySession(source, productRoot)
    expect(await readFile(source)).toEqual(bytes)
    expect(await importLegacySession(source, productRoot)).toBe(target)
    const archived = await readdir(join(productRoot, '.imports'))
    expect(await readFile(join(productRoot, '.imports', archived[0]!))).toEqual(bytes)
    const decoded = decodeCodexyArtifact(await readFile(target))
    expect(decoded.metadata.inheritedEventCount).toBe(1)
    expect(decoded.events[9]).toMatchObject({ seq: 9, sourceEventSeqs: [7], type: 'user/message' })
    const restored = Session.fromRestore(decoded.metadata.session.id, decoded.events, decoded.metadata.session, decoded.metadata.inheritedEventCount, 'detached')
    const native = requestHeaderOf(restored)
    expect(native?.tools?.[0]).toMatchObject({ kind: 'freeform', format: { type: 'grammar', syntax: 'regex', definition: '.*' } })
    expect(native?.config.codexfulResponses?.strictModelInput).toBe(true)
    expect(deriveProductMessages(restored).filter(message => message.role === 'tool').map(message => message.content[0])).toEqual([{ type: 'text', text: 'test' }, { type: 'text', text: 'still running' }])
    expect(snapshotProductEvents(restored)[12]).toMatchObject({ type: 'subagent/fork-window', seq: 12, data: { cutoffSeq: 9 } })
  })
  it('imports the highest nested committed generation in the shipped Zstandard layout', async () => {
    const directory = join(root, '--project--', 'encoded-session-id')
    await mkdir(directory, { recursive: true })
    const original = await readFile(fixture)
    const selected = join(directory, 'session.v5.jsonl.zstd')
    await writeFile(selected, zstdCompressSync(original, { params: { [constants.ZSTD_c_checksumFlag]: 1 } }))
    await writeFile(join(directory, 'session.v4.jsonl.zstd'), 'immutable predecessor bytes')
    await writeFile(join(directory, 'session.v6.jsonl.zstd.tmp'), 'uncommitted successor')
    expect(await findLegacySessionArtifacts(root)).toEqual([selected])
    const imported = await importLegacySessionDirectory(root, join(root, 'product'))
    expect(imported).toHaveLength(1)
    expect(decodeCodexyArtifact(await readFile(imported[0]!)).events).toHaveLength(14)
    expect(await readFile(join(directory, 'session.v4.jsonl.zstd'), 'utf8')).toBe('immutable predecessor bytes')
  })
  it('balances a fork cut after early native dispatch before the assembled assistant event', async () => {
    const rows: Record<string, unknown>[] = (await readFile(fixture, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const call = { ...rows[8]!, seq: 6 }
    const early = Buffer.from([...rows.slice(0, 7), call].map(row => JSON.stringify(row)).join('\n') + '\n')
    const imported = decodeLegacySession(early, 'early.jsonl')
    const boundary = SessionSeq(imported.events.length - 1)
    const seed = buildForkSeed(imported.events, boundary)
    const inheritedEventCount = SessionLogOffset(imported.events.length)
    const childHeader = { ...imported.metadata.session, id: SessionId('forked-native'), parentSession: imported.metadata.session.id, isSeeded: true }
    const child = Session.fromRestore(childHeader.id, seed, childHeader, inheritedEventCount, 'detached')
    const projected = snapshotProductEvents(child)
    const assistant = projected.find(event => event.seq >= inheritedEventCount && event.type === 'assistant/message')
    expect(assistant).toMatchObject({ type: 'assistant/message', data: { interrupted: true, message: { content: [{ type: 'tool-call', kind: 'freeform' }] } } })
    const repaired = projected.find(event => event.seq >= inheritedEventCount && event.type === 'tool/result')
    expect(repaired).toMatchObject({ type: 'tool/result', sourceEventSeqs: [6], data: { error: { code: 'TOOL_OUTCOME_UNKNOWN' } } })
    const persistence = await provider()
    const writer = await persistence.create(childHeader, { inheritedEventCount })
    await writer.append(encodeProductEvents(projected))
    await writer.close()
    expect(decodeCodexyArtifact(await readFile(persistence.pathFor(childHeader.id))).metadata.inheritedEventCount).toBe(inheritedEventCount)
    expect(seed.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'forked' } } })
  })
  it('validates compressed-frame checksums and retains a recoverable incomplete final frame', async () => {
    const bytes = await readFile(fixture)
    const compressed = zstdCompressSync(bytes, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
    const torn = zstdCompressSync('unfinished suffix\n').subarray(0, 5)
    expect(decodeLegacySession(Buffer.concat([compressed, torn]), 'session.jsonl.zst').originalEventCount).toBe(13)
    const corrupt = Buffer.from(compressed)
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1
    expect(() => decodeLegacySession(corrupt, 'session.jsonl.zst')).toThrow()
  })
  it('rejects invalid native controls, completed checkpoints, and complete invalid UTF-8 rows', async () => {
    const imported = decodeLegacySession(await readFile(fixture), 'native.jsonl')
    const persistence = await provider()
    const writer = await persistence.create(imported.metadata.session, { inheritedEventCount: imported.metadata.inheritedEventCount })
    await writer.append(imported.events)
    await writer.close()
    const bytes = await readFile(persistence.pathFor(imported.metadata.session.id))
    const rows: Record<string, unknown>[] = bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const headerRows = structuredClone(rows)
    const headerData = headerRows[5]!['data'] as Record<string, unknown>
    const nativeHeader = headerData['codexyHeader'] as Record<string, unknown>
    const config = nativeHeader['config'] as Record<string, unknown>
    config['codexfulResponses'] = { strictModelInput: 'yes' }
    expect(() => decodeCodexyArtifact(Buffer.from(headerRows.map(row => JSON.stringify(row)).join('\n') + '\n'))).toThrow('Codexy request controls')
    const checkpointRows = structuredClone(rows)
    const fact = checkpointRows[6]!['data'] as Record<string, unknown>
    const output = fact['data'] as Record<string, unknown>
    output['index'] = -1
    expect(() => decodeCodexyArtifact(Buffer.from(checkpointRows.map(row => JSON.stringify(row)).join('\n') + '\n'))).toThrow('index')
    const invalidUtf8 = Buffer.from(bytes)
    invalidUtf8[invalidUtf8.indexOf(Buffer.from('run this'))] = 0xff
    expect(() => decodeCodexyArtifact(invalidUtf8)).toThrow('encoded data')
  })
  it.each([{ name: 'native-request-header', version: 2 }, { name: 'future-runtime', version: 1 }])('refuses unsupported required runtime feature %j without writing it', async feature => {
    const persistence = await provider()
    const writer = await persistence.create(header)
    await writer.flush()
    const prefix = await readFile(persistence.pathFor(id))
    await expect(writer.append([{ type: 'codexy/fact', seq: SessionSeq(0), time: 1,
      data: { type: 'runtime/feature', data: feature } }])).rejects.toThrow('unsupported runtime/feature')
    expect(await readFile(persistence.pathFor(id))).toEqual(prefix)
    await writer.close()
  })
  it('refuses unfamiliar required facts without overwriting their artifact', async () => {
    const persistence = await provider()
    const writer = await persistence.create(header)
    await writer.flush()
    const prefix = await readFile(persistence.pathFor(id))
    await expect(writer.append([{ type: 'codexy/fact', seq: SessionSeq(0), time: 1, data: { type: 'future/required', data: {} } }])).rejects.toThrow('unknown required Codexy fact')
    expect(await readFile(persistence.pathFor(id))).toEqual(prefix)
    await writer.close()
  })
})
