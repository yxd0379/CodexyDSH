/** Account-only routing, request generations and durable native Messages behavior. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import type { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { ReasoningEffortId } from '@codexydsh/runtime/llm'
import type { GenerateOptions } from '@codexydsh/runtime/llm'
import { RequestProviders } from '@codexydsh/bridges'
import Runtime from '@codexydsh/runtime'
import Persistence, { decodeCodexyArtifact } from '@codexydsh/runtime/persistence'
import { snapshotProductEvents } from '@codexydsh/runtime/session'
import { mountAgentLoopTestDependencies } from '@codexydsh/runtime-testkit'
import { liveConfig } from '@codexydsh/test-support/config'
import * as Account from '../src/account.ts'
import { PUBLIC_BASE_URL } from '../src/config.ts'
import { assemble } from './assemble.ts'
import { end, options, requestImageStore, sse, start, textEvents, user } from './helpers.ts'

const PROVIDER = 'deepseek-account'
const MODEL = 'deepseek-flash'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function boot(config: object = {}, signedIn = true, fullLoop = false, legacy?: object) {
  const home = await mkdtemp(join(tmpdir(), 'codexy-account-route-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-key-must-not-be-used')
  vi.stubEnv('DEEPSEEK_BASE_URL', PUBLIC_BASE_URL)
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  if (fullLoop) {
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeHarnessIdentity: false } })
    await ctx.plugin(Persistence, { root: join(home, 'sessions') })
    await ctx.plugin(Runtime, { agents: [] })
  } else {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
  }
  let current: string | undefined = signedIn ? 'fixture-login-a' : undefined
  const resolveToken = vi.fn(async (url: string) => new URL(url).origin === 'https://api.deepseek.com' ? current : undefined)
  const rejectToken = vi.fn(async (token: string) => { if (current === token) current = undefined })
  const account: Pick<DeepSeekAccount, 'resolveToken' | 'rejectToken'> = { resolveToken, rejectToken }
  ctx.provide('deepseekAccount', account as DeepSeekAccount)
  const credentials = vi.fn(async () => { throw new Error('account route accessed API-key credentials') })
  ctx.provide('credentials', { resolve: credentials } as never)
  if (legacy !== undefined) {
    await ctx.plugin(Loader)
    await ctx.loader.create({ id: 'llm-deepseek-account', name: '@deepseek-ai/dsh-llm-deepseek-account', disabled: true, config: legacy })
  }
  const live = await liveConfig(ctx, { ...Account, name: 'codexy-llm-deepseek-account' }, config)
  const wire: Array<{ url: string; headers: Headers; body: Record<string, unknown>; redirect: RequestRedirect | undefined }> = []
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    if (url !== `${PUBLIC_BASE_URL}/v1/messages` && url !== `${PUBLIC_BASE_URL}/v1/files`) throw new Error('unexpected fixture destination')
    wire.push({ url, headers: new Headers(init?.headers), body: typeof init?.body === 'string'
      ? JSON.parse(init.body) as Record<string, unknown> : {}, redirect: init?.redirect })
    return new Response(sse(textEvents), { headers: { 'content-type': 'text/event-stream' } })
  })
  vi.stubGlobal('fetch', fetchImpl)
  const send = (extra: Partial<GenerateOptions> = {}) => assemble(ctx, options({ provider: PROVIDER, model: MODEL, ...extra }))
  return { ctx, home, live, wire, fetchImpl, send, resolveToken, rejectToken, credentials,
    rotate: (token: string | undefined) => { current = token }, current: () => current }
}

describe('DeepSeek Account product route', () => {
  it('inherits only legacy protocol fields without mutating YAML expressions or overriding them with schema defaults', async () => {
    const raw = { maxTokens: { __jsExpr: '128 + 128' }, reasoningEffort: 'low',
      models: [{ id: 'legacy-account-model', contextWindow: 16_384 }],
      apiKeyEnv: { __jsExpr: '(() => { throw new Error("secret expression evaluated") })()' },
      headers: { __jsExpr: '(() => { throw new Error("header expression evaluated") })()' } }
    const original = structuredClone(raw)
    const h = await boot({}, true, false, raw)
    expect(await h.ctx.llm.listModels(PROVIDER)).toMatchObject([{ id: 'legacy-account-model' }])
    expect((await h.send()).finish).toEqual({ kind: 'stop' })
    expect(h.wire[0]!.body).toMatchObject({ max_tokens: 256, output_config: { effort: 'low' } })
    expect(raw).toEqual(original)
    expect(h.ctx.loader.resolve('llm-deepseek-account').fiber).toBeUndefined()
    await h.ctx.loader.resolve('llm-deepseek-account').update({ config: { maxTokens: 999 } })
    await h.send()
    expect(h.wire[1]!.body.max_tokens).toBe(256)
    await h.live.update({ maxTokens: 333, models: [], thinking: 'disabled', reasoningEffort: 'off', retryPolicy: { mode: 'normal', maxRetries: 0 } })
    expect(await h.ctx.llm.listModels(PROVIDER)).toEqual([])
    await h.send()
    expect(h.wire[2]!.body).toMatchObject({ max_tokens: 333, thinking: { type: 'disabled' } })
    expect((await h.ctx.codexyRequests.prepareCall({ provider: PROVIDER, model: MODEL })).retryPolicy.maxRetries).toBe(0)
    expect(h.credentials).not.toHaveBeenCalled()
  })

  it.each(['different-module', 'nested-group'] as const)('does not inherit a %s legacy lookalike', async kind => {
    const h = await boot()
    await h.live.fiber.dispose()
    const row = { id: 'llm-deepseek-account', name: kind === 'different-module'
      ? '@codexydsh/not-the-stock-provider' : '@deepseek-ai/dsh-llm-deepseek-account',
    disabled: true, config: { maxTokens: 777, models: [{ id: 'must-not-be-inherited' }] } }
    if (kind === 'nested-group') {
      h.ctx.loader.builtins.group = Group
      await h.ctx.loader.create({ id: 'legacy-nested', name: 'cordis:group', config: [row] })
    } else await h.ctx.loader.create(row)
    await liveConfig(h.ctx, { ...Account, name: 'codexy-test-account-replacement' })
    expect((await h.ctx.llm.listModels(PROVIDER)).map(model => model.id)).toEqual([MODEL, 'deepseek-v4-pro'])
    await h.send()
    expect(h.wire[0]!.body.max_tokens).toBe(256_000)
  })

  it('inherits a custom legacy endpoint but sends nothing until the public account service authorizes it', async () => {
    const h = await boot({}, true, false, { baseURL: 'https://unapproved.example/anthropic' })
    expect(await h.ctx.llm.listModels(PROVIDER)).toEqual([])
    expect((await h.send()).finish).toMatchObject({ kind: 'error', failure: { code: 'ACCOUNT_SIGN_IN_REQUIRED' } })
    expect(h.fetchImpl).not.toHaveBeenCalled()
    await h.live.update({ baseURL: PUBLIC_BASE_URL })
    expect((await h.send()).finish).toEqual({ kind: 'stop' })
    expect(h.credentials).not.toHaveBeenCalled()
  })

  it('registers the exact account route but exposes no models or API-key fallback while signed out', async () => {
    const h = await boot({}, false)
    expect(h.ctx.codexyRequests.listProviders()).toEqual([{ id: PROVIDER, name: 'DeepSeek Account' }])
    expect(h.ctx.llm.listProviders()).toEqual([{ id: PROVIDER, name: 'DeepSeek Account' }])
    expect(await h.ctx.llm.listModels(PROVIDER)).toEqual([])
    expect((await h.send()).finish).toMatchObject({ kind: 'error', failure: { code: 'ACCOUNT_SIGN_IN_REQUIRED' } })
    expect(h.fetchImpl).not.toHaveBeenCalled()
    expect(h.credentials).not.toHaveBeenCalled()
    expect(Object.hasOwn(Account.Config({}), 'apiKeyEnv')).toBe(false)
    await h.live.fiber.dispose()
    expect(h.ctx.codexyRequests.listProviders()).toEqual([])
    expect(h.ctx.llm.listProviders()).toEqual([])
  })

  it('keeps official endpoint authorization, catalog IDs, high reasoning, account-only headers and policy', async () => {
    const h = await boot()
    expect((await h.ctx.llm.listModels(PROVIDER)).map(model => model.id)).toEqual([MODEL, 'deepseek-v4-pro'])
    const model = await h.ctx.codexyRequests.prepareModel(PROVIDER, MODEL)
    expect(model.model).toMatchObject({ provider: PROVIDER, id: MODEL,
      inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history', defaultMaxTokens: 256_000,
      context: { contextWindow: 1_000_000 }, reasoning: { defaultEffort: 'high' } })
    const call = model.prepareCall({ provider: PROVIDER, model: MODEL, reasoningEffort: ReasoningEffortId('high') })
    expect(call.retryPolicy.maxRetries).toBe(5)
    expect((await h.send()).finish).toEqual({ kind: 'stop' })
    expect(h.resolveToken).toHaveBeenLastCalledWith(PUBLIC_BASE_URL)
    expect(h.wire[0]).toMatchObject({ url: `${PUBLIC_BASE_URL}/v1/messages`, redirect: 'error',
      body: { model: MODEL, max_tokens: 256_000, thinking: { type: 'enabled' }, output_config: { effort: 'high' } } })
    expect(h.wire[0]!.headers.get('x-dsh-auth-token')).toBe('fixture-login-a')
    expect(h.wire[0]!.headers.has('x-api-key')).toBe(false)
    expect(h.credentials).not.toHaveBeenCalled()
  })

  it('uses a captured authorized endpoint and rejects the next unapproved URL without a fallback', async () => {
    const h = await boot({ maxTokens: 111 })
    const model = await h.ctx.codexyRequests.prepareModel(PROVIDER, MODEL)
    await h.live.update({ baseURL: 'https://unapproved.example/anthropic', maxTokens: 222 })
    const call = model.prepareCall({ provider: PROVIDER, model: MODEL })
    for await (const _chunk of call.stream(options({ ...call.config }))) { /* drain captured generation */ }
    expect(h.wire).toHaveLength(1)
    expect(h.wire[0]!.body.max_tokens).toBe(111)
    expect((await h.send()).finish).toMatchObject({ kind: 'error', failure: { code: 'ACCOUNT_SIGN_IN_REQUIRED' } })
    expect(h.wire).toHaveLength(1)
    expect(h.resolveToken).toHaveBeenLastCalledWith('https://unapproved.example/anthropic')
    expect(h.credentials).not.toHaveBeenCalled()
  })

  it('rejects only the token actually sent, preserving a newer login generation', async () => {
    const h = await boot()
    h.fetchImpl.mockImplementationOnce(async (_input, init) => {
      expect(new Headers(init?.headers).get('x-dsh-auth-token')).toBe('fixture-login-a')
      h.rotate('fixture-login-b')
      return new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'expired' } }), { status: 401 })
    })
    expect((await h.send()).finish).toMatchObject({ kind: 'error', failure: { code: 'ACCOUNT_TOKEN_INVALID', status: 401 } })
    expect(h.rejectToken).toHaveBeenCalledExactlyOnceWith('fixture-login-a')
    expect(h.current()).toBe('fixture-login-b')
    expect((await h.send()).finish).toEqual({ kind: 'stop' })
    expect(h.wire[0]!.headers.get('x-dsh-auth-token')).toBe('fixture-login-b')
  })

  it.each(['http', 'sse'] as const)('maps %s quota failures to account quota without invalidating the login', async (kind) => {
    const h = await boot()
    const error = { type: 'error', error: { type: 'quota_exceeded', message: 'Insufficient balance' } }
    h.fetchImpl.mockResolvedValueOnce(kind === 'http'
      ? new Response(JSON.stringify(error), { status: 402 })
      : new Response(sse([error]), { headers: { 'content-type': 'text/event-stream' } }))
    expect((await h.send()).finish).toMatchObject({ kind: 'error', failure: { code: 'ACCOUNT_QUOTA' } })
    expect(h.rejectToken).not.toHaveBeenCalled()
    expect(h.current()).toBe('fixture-login-a')
  })

  it.each([401, 402])('treats Files HTTP %s as an account failure rather than retrying rejected credentials inline', async status => {
    const h = await boot()
    const attachment = { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png' as const,
      bytes: 3, width: 1, height: 1 }
    const image: RequestImageAttachment = { variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`), attachment,
      data: Uint8Array.of(1, 2, 3), mediaType: 'image/png', bytes: 3, width: 1, height: 1,
      depth: 'uchar', space: 'srgb', hasAlpha: true }
    h.ctx.provide('attachments', requestImageStore(() => Promise.resolve(image)))
    h.fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ error: status === 402
      ? { type: 'quota_exceeded', message: 'Account balance quota exceeded' }
      : { type: 'authentication_error', message: 'request rejected' } }), { status }))
    const response = await h.send({ messages: [user('image'),
      { ...user(), content: [{ type: 'image', attachment }] }] })
    expect(response.finish).toMatchObject({ kind: 'error', failure: { code: status === 401 ? 'ACCOUNT_TOKEN_INVALID' : 'ACCOUNT_QUOTA', status } })
    expect(h.fetchImpl).toHaveBeenCalledOnce()
    expect(String(h.fetchImpl.mock.calls[0]![0])).toBe(`${PUBLIC_BASE_URL}/v1/files`)
    expect(h.credentials).not.toHaveBeenCalled()
  })

  it('preserves account native request capture, tool execution, signed replay and persisted resume', async () => {
    const h = await boot({}, true, true)
    const captured: GenerateOptions[] = []
    h.ctx.on('codexy-llm/stream', (request, next) => { captured.push(request); return next() })
    const execute = vi.fn(async () => 'LOCAL_TOOL_OK')
    h.ctx.codexyTools.register({ name: 'fixture_echo', description: 'Local deterministic echo', parameters: { type: 'object', properties: {} },
      execute, output: { schema: { type: 'string' }, render: (_input, output) => [{ type: 'text', text: String(output) }] } })
    h.fetchImpl.mockResolvedValueOnce(new Response(sse([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'local plan', signature: 'fixture-signature' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'fixture-call', name: 'fixture_echo', input: {} } },
      { type: 'content_block_stop', index: 1 }, ...end('tool_use'),
    ]), { headers: { 'content-type': 'text/event-stream' } }))
    const id = SessionId('account-tool-resume')
    const handle = await h.ctx.agents.create({ sessionId: id, agentOptions: { provider: PROVIDER, model: MODEL, reasoningEffort: ReasoningEffortId('high') } })
    handle.agent.followup(user('run local tool'))
    await handle.agent.whenIdle()
    expect(execute).toHaveBeenCalledOnce()
    expect(captured).toHaveLength(2)
    expect(captured.every(request => request.provider === PROVIDER && request.model === MODEL && Object.isFrozen(request))).toBe(true)
    expect(h.wire[0]!.body.messages).toEqual(expect.arrayContaining([
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'local plan', signature: 'fixture-signature' },
        { type: 'tool_use', id: 'fixture-call', name: 'fixture_echo', input: {} },
      ] },
    ]))
    expect(JSON.stringify(h.wire[0]!.body.messages)).toContain('LOCAL_TOOL_OK')
    await h.ctx.sessionPersistence.flush()
    const bytes = await readFile(join(h.home, 'sessions', `${id}.codexy.jsonl`))
    expect(bytes.toString()).not.toMatch(/fixture-login|fixture-key-must-not-be-used/)
    expect(decodeCodexyArtifact(bytes).events.some(event => event.type === 'codexy/fact')).toBe(true)
    await handle.dispose()
    const resumed = await h.ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: PROVIDER, model: MODEL } })
    resumed.agent.followup(user('continue after restore'))
    await resumed.agent.whenIdle()
    expect(execute).toHaveBeenCalledOnce()
    expect(captured).toHaveLength(3)
    expect(JSON.stringify(h.wire.at(-1)!.body.messages)).toContain('fixture-signature')
    expect(snapshotProductEvents(resumed.agent.session).filter(event => event.type === 'request/header')).toHaveLength(2)
    await resumed.dispose()
  })
})
