/** Real view_image, public durable assets, session recovery, and stock SDK HTTP encoding. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@codexydsh/filesystem-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as Files from '@codexydsh/files'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@codexydsh/runtime-testkit'
import { createMessage, createSystemMessage, createToolResultMessage, ToolCallId } from '@codexydsh/runtime/llm'
import LlmRuntime from '@codexydsh/runtime/llm'
import { RequestProviders } from '@codexydsh/bridges'
import type { CodexyResponsesConfig, ContentBlock, GenerateOptions, Message } from '@codexydsh/runtime/llm'
import { Session, SessionId, SessionLogOffset, appendProductEvent, deriveProductMessages } from '@codexydsh/runtime/session'
import { decodeCodexyArtifact, encodeArtifactEvents, encodeArtifactHeader } from '../../runtime/src/persistence-codec.ts'
import { assertV5RowContent } from '../../runtime/src/v5-content.ts'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(closeMockServers)
const NATIVE_PNG_SHA256 = 'f4d0330407b363a9ef03d563e5c2ffd24aa76345f997613741f9fc0935354305'
const response = { id: 'resp_image_fixture', status: 'completed', output: [{ type: 'message', id: 'msg_image_fixture',
  role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture response' }] }],
  usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } }
const events = [JSON.stringify({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }),
  JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { ...response.output[0], status: 'in_progress', content: [] } }),
  JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: response.output[0] }),
  JSON.stringify({ type: 'response.completed', response })]
const nativeControls: CodexyResponsesConfig = { omitDefaultMaxTokens: true, reasoningSummary: 'none', wireProfile: 'codex-0.162.1' }
const nativeFixtures = JSON.parse(await readFile(new URL('./fixtures/gcode-native-v2/facts.json', import.meta.url), 'utf8')) as {
  fixtures: Array<{ name: string; source: string; oracle: string; sourceSha256: string; oracleSha256: string; oracleBytes: number }>
}
const callId = ToolCallId('call_native_view_image')
function digest(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex') }
interface WirePart { type: string; detail?: string; image_url?: string; text?: string }
function wireOutput(request: unknown): WirePart[] {
  const body = request as { input: Array<{ type: string; call_id?: string; output?: unknown }> }
  return body.input.find(item => item.type === 'function_call_output' && item.call_id === callId)?.output as WirePart[]
}
function wireFacts(parts: WirePart[]) {
  const image = parts.find(part => part.type === 'input_image')!
  const raw = Buffer.from(image.image_url!.split(',', 2)[1]!, 'base64')
  return { partTypes: parts.map(part => part.type), detail: image.detail,
    mediaPrefix: image.image_url!.split(',', 1)[0], bytes: raw.length, sha256: digest(raw) }
}

async function fixture(baseURL: string, controls: CodexyResponsesConfig | undefined, maxRequestImageBytes?: number, source?: Uint8Array, name = 'code.png') {
  const root = await mkdtemp(join(tmpdir(), 'codex-native-image-wire-'))
  const original = source === undefined ? await readFile(new URL('./fixtures/code-from-image.png', import.meta.url)) : Buffer.from(source)
  await writeFile(join(root, name), original)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, 'home') })
  const profiles = resolveProfiles({ local: { api: 'openai-responses', transport: 'sse', baseURL,
    ...maxRequestImageBytes === undefined ? {} : { maxRequestImageBytes },
    models: [{ id: 'qwen3.8-27b-w8a8', contextWindow: 131_072, maxTokens: 8192, input: ['text', 'image'] }] } })
  ctx.codexyRequests.registerAdapter(['local'], new PiAiAdapter({ profiles: () => profiles,
    resolveApiKey: () => Promise.resolve('fixture-key'), auth: memoryAuth(), resolveAttachments: () => ctx.attachments }))
  await ctx.plugin(Files, { codexTools: true })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('native-image-fixture'), { provider: 'local', model: 'qwen3.8-27b-w8a8' }, { cwd: root })
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('step/start', { turn: 1, step: 1 })
  appendProductEvent(agent.session, 'request/header', { reason: 'initial', header: { config: {
    provider: 'local', model: 'qwen3.8-27b-w8a8', ...controls === undefined ? {} : { codexfulResponses: controls },
  } } })
  const assistant = createMessage({ role: 'assistant', content: [{ type: 'tool-call', id: callId,
    name: 'view_image', arguments: JSON.stringify({ path: name }) }], source: { kind: 'model', provider: 'local', model: 'qwen3.8-27b-w8a8' } })
  agent.session.append('assistant/message', { turn: 1, step: 1, message: assistant as never, stream: [] }, { surfaceOp: 'append' })
  agent.session.append('tool/call', { turn: 1, step: 1, callId, name: 'view_image', arguments: JSON.stringify({ path: name }) })
  const result = await ctx.codexyTools.execute({ name: 'view_image', arguments: { path: name }, agent,
    signal: new AbortController().signal, callId })
  expect(result.isError).toBe(false)
  const message = createToolResultMessage({ callId, content: result.content, isError: false })
  agent.session.append('tool/result', { turn: 1, step: 1, message }, { surfaceOp: 'append' })
  const image = result.content[0]
  if (image?.type !== 'image') throw new Error('Expected actual view_image image result')
  const request = (messages: readonly Message[] = [createSystemMessage('BASE'), assistant, message]): GenerateOptions => ({
    provider: 'local', model: 'qwen3.8-27b-w8a8', messages: [...messages],
    ...controls === undefined ? {} : { codexfulResponses: controls },
  })
  return { ctx, root, original, image, agent, message, request,
    dispose: async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) } }
}

function encoded(session: Session): Buffer {
  return Buffer.from(encodeArtifactHeader({ kind: 'codexy-session', version: 1, session: session.header,
    inheritedEventCount: SessionLogOffset(0) }) + encodeArtifactEvents(session.snapshotEvents()))
}
function restored(bytes: Uint8Array): Session {
  const decoded = decodeCodexyArtifact(bytes)
  expect(Buffer.from(encodeArtifactHeader(decoded.metadata) + encodeArtifactEvents(decoded.events))).toEqual(Buffer.from(bytes))
  return Session.fromRestore(decoded.metadata.session.id, decoded.events, decoded.metadata.session, decoded.metadata.inheritedEventCount, 'detached')
}

/** A new stock attachment/runtime instance has no capture-time memory or source filesystem. */
async function coldRuntime(home: string, baseURL: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(RequestProviders)
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  const profiles = resolveProfiles({ local: { api: 'openai-responses', transport: 'sse', baseURL,
    models: [{ id: 'qwen3.8-27b-w8a8', contextWindow: 131_072, maxTokens: 8192, input: ['text', 'image'] }] } })
  ctx.codexyRequests.registerAdapter(['local'], new PiAiAdapter({ profiles: () => profiles,
    resolveApiKey: () => Promise.resolve('fixture-key'), auth: memoryAuth(), resolveAttachments: () => ctx.attachments }))
  return ctx
}

describe('native view_image wire input', () => {
  it.each(nativeFixtures.fixtures)('sends Native byte-exact $name output through actual view_image/HTTP and deleted-source cold restore', async fact => {
    const source = await readFile(new URL(`./fixtures/gcode-native-v2/${fact.source}`, import.meta.url))
    const oracle = await readFile(new URL(`./fixtures/gcode-native-v2/${fact.oracle}`, import.meta.url))
    expect(digest(source)).toBe(fact.sourceSha256)
    expect(digest(oracle)).toBe(fact.oracleSha256)
    const server = await mockServer([{ events }, { events }])
    const f = await fixture(server.url, nativeControls, undefined, source)
    try {
      expect(f.image.codexNativeImage?.version).toBe(2)
      const original = encoded(f.agent.session)
      expect((await assemble(f.ctx, f.request())).finish).toEqual({ kind: 'stop' })
      await rm(join(f.root, 'code.png'))
      await f.ctx.fiber.dispose()
      const cold = await coldRuntime(join(f.root, 'home'), server.url)
      try { expect((await assemble(cold, f.request(deriveProductMessages(restored(original))))).finish).toEqual({ kind: 'stop' }) }
      finally { await cold.fiber.dispose() }
      for (const request of server.requests) {
        const parts = wireOutput(request), image = parts[0]!
        expect(wireFacts(parts)).toEqual({ partTypes: ['input_image'], detail: 'high', mediaPrefix: 'data:image/png;base64',
          bytes: fact.oracleBytes, sha256: fact.oracleSha256 })
        expect(Buffer.from(image.image_url!.split(',', 2)[1]!, 'base64').equals(oracle)).toBe(true)
      }
    } finally { await f.dispose() }
  })

  it('sends GIF first-frame PNG/high through the actual native tool and stock SDK', async () => {
    const source = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
    const server = await mockServer([{ events }])
    const f = await fixture(server.url, nativeControls, undefined, source, 'code.gif')
    try {
      expect(f.image.codexNativeImage).toMatchObject({ version: 2, mediaType: 'image/gif', width: 1, height: 1 })
      expect((await assemble(f.ctx, f.request())).finish).toEqual({ kind: 'stop' })
      const parts = wireOutput(server.requests[0])
      expect(parts.map(part => part.type)).toEqual(['input_image'])
      expect(parts[0]?.detail).toBe('high')
      expect(parts[0]?.image_url?.split(',', 1)[0]).toBe('data:image/png;base64')
      expect(await sharp(Buffer.from(parts[0]!.image_url!.split(',', 2)[1]!, 'base64')).metadata()).toMatchObject({ format: 'png', width: 1, height: 1 })
    } finally { await f.dispose() }
  })

  it('replays a durable version1 large-image fact with its frozen FIX4 bytes instead of migrating to version2', async () => {
    const source = await readFile(new URL('./fixtures/gcode-native-v2/source-view_plane.png', import.meta.url))
    const server = await mockServer([{ events }])
    const f = await fixture(server.url, nativeControls, undefined, source)
    try {
      const rows = encoded(f.agent.session).toString().trimEnd().split('\n').map(line => JSON.parse(line))
      for (const row of rows) if (row.type === 'tool/result') {
        for (const block of row.data.message.content) if (block.type === 'image') block.codexNativeImage.version = 1
      }
      const original = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      const session = restored(original)
      await rm(join(f.root, 'code.png')); await f.ctx.fiber.dispose()
      const cold = await coldRuntime(join(f.root, 'home'), server.url)
      try { expect((await assemble(cold, f.request(deriveProductMessages(session)))).finish).toEqual({ kind: 'stop' }) }
      finally { await cold.fiber.dispose() }
      expect(wireFacts(wireOutput(server.requests[0]))).toEqual({ partTypes: ['input_image'], detail: 'high', mediaPrefix: 'data:image/png;base64',
        bytes: 100646, sha256: '6cb545d8518340145603594a6687c3e02e9b88fa4d6b856adc44e5c16ae6390c' })
    } finally { await f.dispose() }
  })

  it('sends actual original code-from-image PNG as image-only/high, including after source replacement/deletion and session restore', async () => {
    const server = await mockServer([{ events }, { events }, { events }])
    const f = await fixture(server.url, nativeControls)
    try {
      expect(digest(f.original)).toBe(NATIVE_PNG_SHA256)
      expect(f.image.codexNativeImage).toMatchObject({ version: 2, tool: 'view_image', mediaType: 'image/png', width: 1160, height: 804,
        file: { attachmentId: `sha256:${NATIVE_PNG_SHA256}`, name: 'code.png', bytes: 95041 } })
      // Canonical UI attachment remains the stock normalized copy.
      expect(f.image.attachment).toMatchObject({ mediaType: 'image/webp', bytes: 43006 })
      const saved = encoded(f.agent.session)
      const path = join(f.root, 'original-session.jsonl')
      await writeFile(path, saved)
      for (const mutation of ['unchanged', 'replaced', 'deleted'] as const) {
        if (mutation === 'replaced') await writeFile(join(f.root, 'code.png'), 'source replaced after view_image')
        if (mutation === 'deleted') await rm(join(f.root, 'code.png'))
        const session = restored(await readFile(path))
        const messages = deriveProductMessages(session)
        expect(messages.find(item => item.role === 'tool')?.content).toEqual(f.message.content)
        if (mutation === 'deleted') await f.ctx.fiber.dispose()
        const cold = mutation === 'deleted' ? await coldRuntime(join(f.root, 'home'), server.url) : undefined
        try {
          const result = await assemble(cold ?? f.ctx, f.request(messages))
          expect(result.finish).toEqual({ kind: 'stop' })
          const parts = wireOutput(server.requests.at(-1))
          // Never dump large image payloads when a regression fails.
          console.log('native image wire facts', { source: mutation, cold: cold !== undefined, ...wireFacts(parts) })
          expect(wireFacts(parts)).toEqual({ partTypes: ['input_image'], detail: 'high', mediaPrefix: 'data:image/png;base64',
            bytes: 95041, sha256: NATIVE_PNG_SHA256 })
          expect(await readFile(path)).toEqual(saved)
        } finally { await cold?.fiber.dispose() }
      }
    } finally { await f.dispose() }
  })

  it.each([undefined, { omitDefaultMaxTokens: true, reasoningSummary: 'none' } as CodexyResponsesConfig])(
    'keeps generic/other profile image labels, auto detail, and stock normalization (%s)', async (controls) => {
      const server = await mockServer([{ events }])
      const f = await fixture(server.url, controls)
      try {
        expect(f.image.codexNativeImage).toBeUndefined()
        await assemble(f.ctx, f.request())
        expect(wireFacts(wireOutput(server.requests[0]))).toEqual({ partTypes: ['input_text', 'input_image'], detail: 'auto',
          mediaPrefix: 'data:image/webp;base64', bytes: 43006,
          sha256: 'a0f4812d24a728a4a386227ca60bcf95371d2908fbd037e7771dcc01344baa4a' })
      } finally { await f.dispose() }
    })

  it('restores historical image-only tool content without optional source facts', async () => {
    const server = await mockServer([{ events }])
    const f = await fixture(server.url, nativeControls)
    try {
      const legacy = createToolResultMessage({ callId, content: [{ type: 'image', attachment: f.image.attachment }] })
      const request = f.request()
      request.messages[request.messages.length - 1] = legacy
      await assemble(f.ctx, request)
      const facts = wireFacts(wireOutput(server.requests[0]))
      expect(facts.partTypes).toEqual(['input_text', 'input_image'])
      expect(facts.detail).toBe('auto')
      const bytes = encoded(f.agent.session)
      const rows = bytes.toString().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
      for (const row of rows) {
        if (row['type'] === 'tool/result') (row['data'] as { message: { content: ContentBlock[] } }).message.content = legacy.content
      }
      expect(deriveProductMessages(restored(Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n')))
        .find(message => message.role === 'tool')?.content).toEqual(legacy.content)
    } finally { await f.dispose() }
  })

  it('keeps native and ordinary image occurrences separate even with the same canonical attachment and tool output', async () => {
    const server = await mockServer([{ events }])
    const f = await fixture(server.url, nativeControls)
    try {
      const request = f.request()
      request.messages[request.messages.length - 1] = createToolResultMessage({ callId,
        content: [f.image, { type: 'image', attachment: f.image.attachment }] })
      expect((await assemble(f.ctx, request)).finish).toEqual({ kind: 'stop' })
      const parts = wireOutput(server.requests[0])
      // Stock SDK consolidates text before its images while preserving image order.
      expect(parts.map(part => part.type)).toEqual(['input_text', 'input_image', 'input_image'])
      expect(parts.filter(part => part.type === 'input_image').map(part => ({ detail: part.detail, mime: part.image_url!.split(',', 1)[0] })))
        .toEqual([{ detail: 'high', mime: 'data:image/png;base64' }, { detail: 'auto', mime: 'data:image/webp;base64' }])
    } finally { await f.dispose() }
  })

  it.each(['bytes', 'width', 'height', 'mediaType', 'name'] as const)(
    'rejects conflicting restored facts for a shared raw asset instead of bypassing validation through its cache (%s)', async field => {
      const server = await mockServer([])
      const f = await fixture(server.url, nativeControls)
      try {
        const facts = f.image.codexNativeImage!
        const changed = { ...facts, file: { ...facts.file } }
        if (field === 'bytes') changed.file.bytes += 1
        if (field === 'width') changed.width += 1
        if (field === 'height') changed.height += 1
        if (field === 'mediaType') changed.mediaType = 'image/jpeg'
        if (field === 'name') changed.file.name = 'different-asset-name.png'
        const request = f.request()
        request.messages[request.messages.length - 1] = createToolResultMessage({ callId,
          content: [f.image, { ...f.image, codexNativeImage: changed }] })
        // Both are structurally admitted durable facts; the second source must
        // independently match the immutable asset even after the first cache hit.
        const message = request.messages.at(-1)!
        assertV5RowContent({ type: 'tool/result', data: { message } })
        expect((await assemble(f.ctx, request)).finish.kind).toBe('error')
        expect(server.requests).toHaveLength(0)
      } finally { await f.dispose() }
    })

  it('keeps source facts isolated to tool images and obeys actual request offloading limits', async () => {
    const server = await mockServer([{ events }])
    const f = await fixture(server.url, nativeControls, 1024)
    try {
      expect((await assemble(f.ctx, f.request())).finish).toMatchObject({ kind: 'error', failure: { code: 'IMAGE_OFFLOAD_REQUIRED' } })
      expect(server.requests).toHaveLength(0)
      const request = f.request()
      const last = request.messages.at(-1)!
      request.messages[request.messages.length - 1] = { ...last, content: [{ ...f.image, offloaded: true }] } as Message
      expect((await assemble(f.ctx, request)).finish).toEqual({ kind: 'stop' })
      const output = wireOutput(server.requests[0])
      expect(JSON.stringify(output)).not.toContain('input_image')
    } finally { await f.dispose() }
  })

  it.skipIf(process.platform === 'win32')('keeps public filesystem read permissions before committing any native source asset', async () => {
    const server = await mockServer([])
    const f = await fixture(server.url, nativeControls)
    try {
      const save = vi.spyOn(f.ctx.attachments, 'saveFile')
      await chmod(join(f.root, 'code.png'), 0o000)
      const denied = await f.ctx.codexyTools.execute({ name: 'view_image', arguments: { path: 'code.png' }, agent: f.agent,
        signal: new AbortController().signal, callId: ToolCallId('denied-owned-image') })
      expect(denied.isError).toBe(true)
      expect(denied.content.filter(block => block.type === 'text').map(block => block.text).join('')).toContain('permission denied')
      expect(save).not.toHaveBeenCalled()
      expect(server.requests).toHaveLength(0)
    } finally { await f.dispose() }
  })

  it.each(['media-array', 'id-array', 'zero-width', 'negative-bytes', 'unknown-version', 'unsafe-name'])(
    'rejects malformed optional durable facts (%s) without examining arbitrary tool JSON', async (mutation) => {
      const server = await mockServer([])
      const f = await fixture(server.url, nativeControls)
      try {
        const image = JSON.parse(JSON.stringify(f.image)) as Record<string, unknown>
        const facts = image['codexNativeImage'] as Record<string, unknown>
        const file = facts['file'] as Record<string, unknown>
        if (mutation === 'media-array') facts['mediaType'] = [facts['mediaType']]
        if (mutation === 'id-array') file['attachmentId'] = [file['attachmentId']]
        if (mutation === 'zero-width') facts['width'] = 0
        if (mutation === 'negative-bytes') file['bytes'] = -1
        if (mutation === 'unknown-version') facts['version'] = 3
        if (mutation === 'unsafe-name') file['name'] = '../code.png'
        expect(() => assertV5RowContent({ type: 'tool/result', data: { message: { content: [image], source: {} } } })).toThrow()
        expect(() => assertV5RowContent({ type: 'tool/call', data: { arguments: JSON.stringify(image), kind: 'function',
          arbitraryToolValue: { content: [image] } } })).not.toThrow()
      } finally { await f.dispose() }
    })
})
