/** Public-service fixtures only: no model requests, disk writes, or file cleanup. */
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FileSystem, FsTargetKey, FsVersion } from '@codexydsh/filesystem'
import type { FsTarget, FsInfo, FsPathInfo, FsDirEntry, FsWriteOutcome, FsEditOutcome } from '@codexydsh/filesystem'
import { LlmAdapter, ToolCallId, MessageId } from '@codexydsh/runtime/llm'
import type { GenerateOptions, StreamChunk, LlmResolvedModelInfo } from '@codexydsh/runtime/llm'
import { Session, SessionId, SessionLogOffset } from '@codexydsh/runtime/session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@codexydsh/runtime-testkit'
import { encodeArtifactHeader, encodeArtifactEvents, decodeCodexyArtifact } from '../../runtime/src/persistence-codec.ts'
import * as Files from '../src/index.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

/** Explicit fixture backends exercise the real product/public service calls without touching user files. */
class FixtureFs extends FileSystem {
  readonly files = new Map<string, Uint8Array>([['image.png', PNG]])
  reads = 0
  lastSignal?: AbortSignal
  override watch(): never { throw new Error('No watcher in fixture') }
  override async resolve(path: string): Promise<FsTarget> { return { targetKey: FsTargetKey(path), displayPath: `/fixture/${path}` } }
  override processPath(target: FsTarget): string { return target.displayPath }
  override fileUrl(target: FsTarget): string { return `file://${target.displayPath}` }
  override contains(parent: FsTarget, child: FsTarget): boolean { return child.displayPath.startsWith(parent.displayPath) }
  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    const data = this.files.get(target.targetKey)
    return data === undefined ? undefined : { type: 'file', size: data.length, version: FsVersion('fixture-1') }
  }
  override async lstat(path: string): Promise<FsPathInfo | undefined> { return this.stat(await this.resolve(path)) }
  override async readBytes(target: FsTarget, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted()
    this.reads += 1
    this.lastSignal = signal
    return new Uint8Array(this.files.get(target.targetKey) ?? [])
  }
  override async readByteRange(target: FsTarget, range: { offset: number; length: number }): Promise<Uint8Array> {
    return (await this.readBytes(target)).subarray(range.offset, range.offset + range.length)
  }
  override async readText(target: FsTarget): Promise<string> { return new TextDecoder().decode(await this.readBytes(target)) }
  override async streamText(target: FsTarget): Promise<AsyncIterable<string>> {
    const text = await this.readText(target)
    return (async function* () { yield text })()
  }
  override async listDir(): Promise<FsDirEntry[]> { return [] }
  override async writeText(): Promise<FsWriteOutcome> { throw new Error('No writes in fixture') }
  override async editText(): Promise<FsEditOutcome> { throw new Error('No edits in fixture') }
}

class FixtureAttachments extends AttachmentStore {
  readonly imageLimits = { maxImageBytes: 1024, maxImagesPerMessage: 1, maxMessageImageBytes: 1024,
    maxImagePixels: 100, maxImageDimension: 2000, mediaTypes: ['image/png'] as const }
  readonly objects = new Map<string, Uint8Array>()
  override async validateImage(input: SaveImageAttachment): Promise<void> {
    if (input.mediaType !== 'image/png' || !Buffer.from(input.data).equals(PNG)) throw new Error('Fixture requires its valid PNG')
  }
  override async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    await this.validateImage(input)
    const attachmentId = AttachmentId(`sha256:${createHash('sha256').update(input.data).digest('hex')}`)
    this.objects.set(attachmentId, new Uint8Array(input.data))
    return { attachmentId, mediaType: 'image/png', bytes: input.data.length, width: 1, height: 1,
      ...input.name === undefined ? {} : { name: input.name } }
  }
  override async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    signal?.throwIfAborted()
    const data = this.objects.get(ref.attachmentId)
    if (data === undefined) throw new Error('Missing fixture attachment')
    return { ref, data: new Uint8Array(data) }
  }
}

class FixtureCatalog extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, inputModalities: model === 'vision' ? ['text', 'image'] : ['text'] }
  }
  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { throw new Error('No model requests in fixture') }
}

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function setup(options: { attachments?: boolean; questions?: boolean; codexTools?: boolean; applyPatchOnly?: boolean } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(FixtureFs)
  if (options.attachments !== false) await ctx.plugin(FixtureAttachments)
  if (options.questions !== false) await ctx.plugin(UserQuestionService)
  ctx.codexyRequests.registerAdapter(['fixture'], new FixtureCatalog())
  await ctx.plugin(Files, { codexTools: options.codexTools ?? true,
    ...options.applyPatchOnly ? { applyPatch: true, applyPatchOnly: true } : {} })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId(`fixture-agent-${contexts.length}`), { provider: 'fixture', model: 'vision' })
  return { ctx, agent, harness, fs: ctx.codexyFs as FixtureFs, attachments: ctx.get('attachments') as FixtureAttachments | undefined }
}

function plan(agent: Agent, active: boolean): void {
  // A committed public plan event, carried losslessly by the owned Session envelope.
  agent.session.append('codexy/fact', { type: 'plan/mode', data: { active } })
}
function execute(ctx: Context, agent: Agent, name: string, args: unknown, signal = new AbortController().signal) {
  return ctx.codexyTools.execute({ name, arguments: args, agent, signal, callId: ToolCallId('fixture-call') })
}
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}
const questions = [{ id: 'choice', header: 'Choice', question: 'Which implementation?', options: [
  { label: 'Small (Recommended)', description: 'Keep the interface small.' },
  { label: 'Large', description: 'Add more configuration.' },
] }]
/** Frozen public 0.162.1 declaration, not values copied from a user session. */
const requestUserInputParameters = {
  type: 'object', additionalProperties: false, required: ['questions'], properties: {
    questions: { type: 'array', description: 'Questions to show the user. Prefer 1 and do not exceed 3', items: {
      type: 'object', additionalProperties: false, required: ['id', 'header', 'question', 'options'], properties: {
        id: { type: 'string', description: 'Stable identifier for mapping answers (snake_case).' },
        header: { type: 'string', description: 'Short header label shown in the UI (12 or fewer chars).' },
        question: { type: 'string', description: 'Single-sentence prompt shown to the user.' },
        options: { type: 'array', description: 'Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". Do not include an "Other" option in this list; the client will add a free-form "Other" option automatically.', items: {
          type: 'object', additionalProperties: false, required: ['label', 'description'], properties: {
            label: { type: 'string', description: 'User-facing label (1-5 words).' },
            description: { type: 'string', description: 'One short sentence explaining impact/tradeoff if selected.' },
          },
        } },
      },
    } },
  },
}

describe('opt-in native tool capabilities', () => {
  it('preserves the default catalog and registers neither native alias without real backends', async () => {
    const ordinary = await setup({ codexTools: false })
    expect(ordinary.ctx.codexyTools.schemas().map(schema => schema.name).sort()).toEqual(['edit', 'read', 'read_image', 'write'])
    const absent = await setup({ attachments: false, questions: false, applyPatchOnly: true })
    expect(absent.ctx.codexyTools.schemas().map(schema => schema.name)).toEqual(['apply_patch'])
  })

  it('owns service-dependent registrations and does not resurrect the omitted DSH file tools', async () => {
    const { ctx } = await setup({ attachments: false, questions: false, applyPatchOnly: true })
    const imageFiber = await ctx.plugin(FixtureAttachments)
    const questionFiber = await ctx.plugin(UserQuestionService)
    expect(ctx.codexyTools.schemas().map(schema => schema.name).sort()).toEqual(['apply_patch', 'request_user_input', 'view_image'])
    await imageFiber.dispose()
    await questionFiber.dispose()
    expect(ctx.codexyTools.schemas().map(schema => schema.name)).toEqual(['apply_patch'])
  })

  it('declares the exact pinned path-only view interface, not unsupported detail or environment knobs', async () => {
    const { ctx } = await setup()
    expect(ctx.codexyTools.schemas().find(schema => schema.name === 'view_image')).toEqual({ name: 'view_image',
      description: 'View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.',
      parameters: { type: 'object', additionalProperties: false,
        properties: { path: { type: 'string', description: 'Local filesystem path to an image file.' } }, required: ['path'] } })
  })
})

describe('view_image actual backend execution', () => {
  it('commits before rendering, emits only the image, and preserves the older read_image envelope', async () => {
    const { ctx, agent, fs, attachments } = await setup()
    const signal = new AbortController().signal
    const result = await execute(ctx, agent, 'view_image', { path: 'image.png' }, signal)
    expect(result.isError).toBe(false)
    expect(result.content).toHaveLength(1)
    const image = result.content[0]
    if (image?.type !== 'image' || attachments === undefined) throw new Error('Expected saved image')
    expect(Buffer.from((await attachments.readImage(image.attachment)).data)).toEqual(PNG)
    expect(fs.lastSignal).toBe(signal)
    const older = await execute(ctx, agent, 'read_image', { file_path: 'image.png' })
    expect(older.content.map(block => block.type)).toEqual(['text', 'image'])
    expect(text(older)).toContain('<path>/fixture/image.png</path>')

    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('assistant/message', { turn: 1, step: 1, message: { id: MessageId('fixture-assistant'), role: 'assistant',
      source: { kind: 'model', provider: 'fixture', model: 'vision' },
      content: [{ type: 'tool-call', id: ToolCallId('fixture-call'), name: 'view_image', arguments: '{"path":"image.png"}' }] },
      stream: [] },
    { surfaceOp: 'append' })
    agent.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('fixture-call'), name: 'view_image', arguments: '{"path":"image.png"}' })
    agent.session.append('tool/result', { turn: 1, step: 1, message: {
      id: MessageId('fixture-image-result'), role: 'tool', toolCallId: ToolCallId('fixture-call'), isError: false,
      source: { kind: 'tool', callId: ToolCallId('fixture-call'), toolKind: 'function', name: 'view_image' }, content: result.content,
    } }, { surfaceOp: 'append' })
    const bytes = encodeArtifactHeader({ kind: 'codexy-session', version: 1, session: agent.session.header,
      inheritedEventCount: SessionLogOffset(0) }) + encodeArtifactEvents(agent.session.snapshotEvents())
    const decoded = decodeCodexyArtifact(Buffer.from(bytes))
    const restored = Session.fromRestore(agent.session.id, decoded.events, decoded.metadata.session,
      decoded.metadata.inheritedEventCount, 'detached')
    const last = restored.deriveMessages().at(-1)?.content[0]
    if (last?.type !== 'image') throw new Error('Expected restored image reference')
    expect(Buffer.from((await attachments.readImage(last.attachment)).data)).toEqual(PNG)
    expect(encodeArtifactHeader(decoded.metadata) + encodeArtifactEvents(decoded.events)).toBe(bytes)
  })

  it('refuses a text model before filesystem reads or attachment saves', async () => {
    const { ctx, fs, attachments, harness } = await setup()
    const agent = await harness.create(SessionId('fixture-text-agent'), { provider: 'fixture', model: 'text' })
    const result = await execute(ctx, agent, 'view_image', { path: 'image.png' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('does not declare image input')
    expect(fs.reads).toBe(0)
    expect(attachments?.objects.size).toBe(0)
  })

  it('validates exact native arguments before reading and reports a genuinely missing file', async () => {
    const { ctx, agent, fs } = await setup()
    for (const args of [{ file_path: 'image.png' }, { path: 'image.png', detail: 'original' }]) {
      expect((await execute(ctx, agent, 'view_image', args)).isError).toBe(true)
    }
    expect(fs.reads).toBe(0)
    const missing = await execute(ctx, agent, 'view_image', { path: 'missing.png' })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('not found')
  })
})

describe('request_user_input actual public answer service', () => {
  it('passes the live root, cancellation and call identity to the scoped answerer and projects real answers', async () => {
    const { ctx, agent } = await setup()
    plan(agent, true)
    const signal = new AbortController().signal
    ctx.on('user-questions/request', async function (request) {
      expect(request.agent).toBe(agent)
      expect(request.signal).toBe(signal)
      expect(request.wait).toEqual({ callId: 'fixture-call' })
      expect(request.questions).toEqual(questions)
      return { answers: [{ id: 'choice', selected: ['Small (Recommended)'], custom: 'Use the existing service.' }] }
    })
    const result = await execute(ctx, agent, 'request_user_input', { questions }, signal)
    expect(result.isError).toBe(false)
    expect(JSON.parse(text(result))).toEqual({ answers: { choice: { answers: ['Small (Recommended)', 'Use the existing service.'] } } })
  })

  it('honors the latest committed mode instead of silently enabling Plan mode', async () => {
    const { ctx, agent } = await setup()
    let requests = 0
    ctx.on('user-questions/request', async () => { requests += 1; return { answers: [] } })
    for (const active of [undefined, true, false]) {
      if (active !== undefined) plan(agent, active)
      if (active === true) continue
      const result = await execute(ctx, agent, 'request_user_input', { questions })
      expect(result.isError).toBe(true)
      expect(text(result)).toBe('Error: request_user_input is unavailable in Default mode')
    }
    expect(requests).toBe(0)
  })

  it('does not fabricate answers when no UI answers and preserves public cancellation errors', async () => {
    const { ctx, agent } = await setup()
    plan(agent, true)
    const missing = await execute(ctx, agent, 'request_user_input', { questions })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('no user-questions answerer')
    const aborted = new AbortController()
    aborted.abort(new Error('fixture-cancelled'))
    const cancelled = await execute(ctx, agent, 'request_user_input', { questions }, aborted.signal)
    expect(cancelled.isError).toBe(true)
  })

  it('preserves public root ownership checks rather than giving a child an invented human backend', async () => {
    const { ctx, agent } = await setup()
    const child = await ctx.agents.create({ sessionId: SessionId('fixture-child'), parentAgent: agent,
      agentOptions: { provider: 'fixture', model: 'vision' } })
    plan(child.agent, true)
    const result = await execute(ctx, child.agent, 'request_user_input', { questions })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('owned by another live agent')
  })

  it('keeps the pinned nested schema closed and all required fields in the actual request declaration', async () => {
    const { ctx, agent } = await setup()
    const schema = ctx.codexyTools.schemas().find(item => item.name === 'request_user_input')!
    expect(schema.description).toBe('Request user input for one to three short questions and wait for the response. This tool is only available in Plan mode.')
    expect(schema.parameters).toEqual(requestUserInputParameters)
    const parameters = schema.parameters as { properties: Record<string, { items: { additionalProperties: boolean; required: string[]; properties: Record<string, unknown> } }> }
    const item = parameters.properties['questions']!.items
    expect(item.additionalProperties).toBe(false)
    expect(item.required).toEqual(['id', 'header', 'question', 'options'])
    expect(item.properties['options']).toMatchObject({ items: { additionalProperties: false, required: ['label', 'description'] } })
    plan(agent, true)
    for (const args of [{ questions, extra: true }, { questions: [{ ...questions[0], multiple: true }] },
      { questions: [{ ...questions[0], options: [{ label: 'Missing explanation' }] }] }]) {
      expect((await execute(ctx, agent, 'request_user_input', args)).isError).toBe(true)
    }
    const empty = await execute(ctx, agent, 'request_user_input', { questions: [{ ...questions[0], options: [] }] })
    expect(text(empty)).toBe('Error: request_user_input requires non-empty options for every question')
  })

  it('lets the actual answer backend cancel an already waiting question without inventing an answer', async () => {
    const { ctx, agent } = await setup()
    plan(agent, true)
    const controller = new AbortController()
    let answererStarted!: () => void
    const started = new Promise<void>(resolve => { answererStarted = resolve })
    ctx.on('user-questions/request', async request => {
      answererStarted()
      return await new Promise<never>((_resolve, reject) => {
        request.signal!.addEventListener('abort', () => { reject(request.signal!.reason) }, { once: true })
      })
    })
    const pending = execute(ctx, agent, 'request_user_input', { questions }, controller.signal)
    await started
    controller.abort(new Error('fixture-cancelled-human-wait'))
    const cancelled = await pending
    expect(cancelled.isError).toBe(true)
    expect(text(cancelled)).not.toContain('"answers"')
  })
})
