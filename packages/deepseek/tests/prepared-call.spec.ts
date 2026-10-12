import { RequestProviders } from '@codexydsh/bridges'
/** Prepared calls retain their endpoint and credential generation. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ReasoningEffortId } from '@codexydsh/runtime/llm'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { Config, DeepSeekAdapter, plainOptions, resolveAdapterOptions } from '../src/index.ts'
import type { DeepSeekConnectionOptions } from '../src/index.ts'
import { assemble, chunks, MODEL, options, server } from './helpers.ts'

const close: (() => Promise<void>)[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  while (close.length) await close.pop()!()
})

it('derives another Messages model from the captured connection rather than the live configuration', async () => {
  const first = await endpoint(), second = await endpoint()
  const connectionFor = (next: boolean) => resolveAdapterOptions({
    baseURL: next ? second.url : first.url, apiKeyEnv: next ? 'SECOND_KEY' : 'FIRST_KEY',
    models: [
      { id: MODEL, contextWindow: 16_384, maxTokens: 512 },
      { id: 'previous-model', contextWindow: next ? 32_768 : 65_536, maxTokens: next ? 222 : 111 },
    ],
  })
  let connection = connectionFor(false)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(RequestProviders)
  ctx.codexyRequests.registerAdapter(['deepseek-official'], adapter(() => connection))
  const current = await ctx.codexyRequests.prepareModel('deepseek-official', MODEL)
  connection = connectionFor(true)
  const previous = await current.withModel('previous-model')
  const call = previous.prepareCall({ provider: 'deepseek-official', model: 'previous-model',
    reasoningEffort: ReasoningEffortId('low'),
  })
  expect(call.context?.contextWindow).toBe(65_536)
  expect(call.config.maxTokens).toBe(111)
  expect(call.developerHistory).toBeUndefined()
  expect((await previous.withModel(MODEL)).model.context?.contextWindow).toBe(16_384)
  const output = await chunks(call.stream({ ...options(), ...call.config }))
  expect(output.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  expect(first.requests).toHaveLength(1)
  expect(first.requests[0]).toMatchObject({ headers: { 'x-api-key': 'key-for-FIRST_KEY' },
    body: { model: 'previous-model', max_tokens: 111, output_config: { effort: 'low' } },
  })
  expect(second.requests).toHaveLength(0)
  const next = (await ctx.codexyRequests.prepareModel('deepseek-official', 'previous-model'))
    .prepareCall({ provider: 'deepseek-official', model: 'previous-model' })
  await chunks(next.stream({ ...options(), ...next.config }))
  expect(second.requests[0]).toMatchObject({ headers: { 'x-api-key': 'key-for-SECOND_KEY' },
    body: { model: 'previous-model', max_tokens: 222 },
  })
})
async function endpoint(...args: Parameters<typeof server>) {
  const instance = await server(...args)
  close.push(() => instance.close())
  return instance
}
function adapter(connection: () => DeepSeekConnectionOptions) {
  return new DeepSeekAdapter({
    options: connection,
    resolveApiKey: snapshot => Promise.resolve(`key-for-${snapshot.apiKeyEnv}`),
    resolveUserId: () => '00000000-0000-4000-8000-000000000001' as AnonymousUserId,
    prepareExtensions: () => Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
  })
}

it.each([false, true])('uses Messages, schema=%s', async (schema) => {
  const http = await endpoint()
  const raw = { baseURL: http.url }
  const connection = resolveAdapterOptions(schema ? plainOptions(Config(raw)) : raw)
  const response = await assemble(adapter(() => connection).stream(options()))

  expect(response.message.content).toEqual([{ type: 'text', text: 'Hello 世界' }])
  expect(http.requests).toHaveLength(1)
  expect(http.requests[0]).toMatchObject({
    path: '/anthropic/v1/messages',
    headers: { 'x-api-key': 'key-for-DEEPSEEK_API_KEY', 'anthropic-version': '2023-06-01' },
    body: { model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
  })
})

it('keeps the prepared credential reference and endpoint after configuration changes', async () => {
  const first = await endpoint(), second = await endpoint()
  let connection = resolveAdapterOptions({ baseURL: first.url, apiKeyEnv: 'FIRST_KEY', maxTokens: 12 })
  const llm = adapter(() => connection)
  const prepared = await llm.prepareCall('deepseek-official', MODEL)
  connection = resolveAdapterOptions({ baseURL: second.url, apiKeyEnv: 'SECOND_KEY', maxTokens: 24 })
  await chunks(prepared.stream(options()))
  await chunks(prepared.stream(options()))
  expect(prepared.model.defaultMaxTokens).toBe(12)
  expect((await prepared.resolveModel?.(MODEL))?.defaultMaxTokens).toBe(12)
  expect(await prepared.listModels?.()).toEqual(await adapter(() => resolveAdapterOptions({
    baseURL: first.url, apiKeyEnv: 'FIRST_KEY', maxTokens: 12,
  })).listModels('deepseek-official'))
  expect((await llm.resolveModel('deepseek-official', MODEL)).defaultMaxTokens).toBe(24)
  await chunks(llm.stream(options()))
  expect(first.requests).toHaveLength(2)
  for (const request of first.requests) expect(request).toMatchObject({
    path: '/anthropic/v1/messages', headers: { 'x-api-key': 'key-for-FIRST_KEY' }, body: { max_tokens: 12 },
  })
  expect(second.requests).toHaveLength(1)
  expect(second.requests[0]).toMatchObject({ path: '/anthropic/v1/messages', headers: { 'x-api-key': 'key-for-SECOND_KEY' } })
})
