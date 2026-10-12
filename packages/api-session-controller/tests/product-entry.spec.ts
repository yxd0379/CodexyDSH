/** Product Web entry points preserve native selection intent and Remote model metadata. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import type { FileUploads } from '@deepseek-ai/dsh-client-file-upload'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, ReasoningEffortId, createUserMessage } from '@codexydsh/runtime/llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@codexydsh/runtime/llm'
import CodexyRuntime from '@codexydsh/runtime'
import { requestHeaderOf, snapshotProductEvents } from '@codexydsh/runtime/session'
import { mountAgentLoopTestDependencies } from '@codexydsh/runtime-testkit'
import { textResponse } from '@codexydsh/runtime-testkit/mock-adapter'
import { ApiSessionAgentController } from '../src/agent.ts'
import { installModelSelectionProjection } from '../src/model-selection-projection.ts'
import { buildModelCatalog } from '../src/catalog.ts'
import { TYPERT } from '../src/typert.ts'
import { TYPERT_REMOTE } from '../src/remote.ts'
import SessionController from '../src/index.ts'

class NativeModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override listModels(): Promise<LlmModelInfo[]> {
    return Promise.resolve(['primary', 'other'].map(id => ({ id, name: id,
      showInPicker: id === 'primary', multiAgentVersion: 'v2', serviceTiers: ['auto', 'priority'],
    })))
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, codexResponsesLite: true,
      reasoning: { efforts: [
        { id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' },
      ], defaultEffort: ReasoningEffortId('low') },
    })
  }
  override async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    return { model: await this.resolveModel(provider, model), developerHistory: 'native', stream: options => this.stream(options) }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield* textResponse('done')
  }
}

describe('owned Session Web entry', () => {
  const resources: Array<{ ctx: Context; root: string }> = []
  afterEach(async () => {
    for (const { ctx, root } of resources.splice(0)) {
      try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
    }
  })

  async function assembly(): Promise<{ ctx: Context; root: string; adapter: NativeModel }> {
    const ctx = new Context()
    const root = await mkdtemp(join(tmpdir(), 'codexy-api-entry-'))
    resources.push({ ctx, root })
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeHarnessIdentity: false } })
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(AgentDefaultModel, { provider: 'native', model: 'primary', reasoningEffort: 'high' })
    await ctx.plugin(CodexyRuntime, { agents: [] })
    const adapter = new NativeModel()
    ctx.codexyRequests.registerAdapter(['native'], adapter)
    return { ctx, root, adapter }
  }

  it('creates a Web Agent with the product selector and clears inherited effort on a later model selection', async () => {
    const { ctx, root, adapter } = await assembly()
    installModelSelectionProjection(ctx)
    const controller = new ApiSessionAgentController(ctx)
    const agent = await controller.ensureSession(SessionId('web-native-selection'), root, false)
    const prompt = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
    agent.followup(prompt('first task'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'native', model: 'primary', reasoningEffort: 'high' })

    controller.selectForNextRequest(agent, { provider: 'native', model: 'other' })
    agent.followup(prompt('next task'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]).toMatchObject({ provider: 'native', model: 'other', reasoningEffort: 'low' })
    expect(requestHeaderOf(agent.session)).toMatchObject({ config: { model: 'other', reasoningEffort: 'low' }, adapterDefaults: { reasoningEffort: true } })
    expect(ctx.sessionProjections.stateOf(agent.session, 'modelSelection')).toMatchObject({ lastUsed: { model: 'other', reasoningEffort: 'low' } })
    expect(snapshotProductEvents(agent.session).some(event => event.type === 'user/message' && event.data.source.kind === 'model-selection')).toBe(true)
    await expect(controller.composeAgent('unavailable')).rejects.toMatchObject({ code: 'agent-preset/not-found' })
  })

  it('retains native picker fields through both Host and mounted Client Remote result codecs', async () => {
    const { ctx } = await assembly()
    const value = await buildModelCatalog(ctx)
    const host = TYPERT.invocations.find(descriptor => descriptor.namespace === 'session' && descriptor.method === 'modelCatalog')!
    const remote = TYPERT_REMOTE.descriptors.find(descriptor => descriptor.namespace === 'session' && descriptor.method === 'modelCatalog')!
    ctx.typert.register(TYPERT)
    const remove = ctx.typert.remotes.register(TYPERT_REMOTE)
    try {
      for (const descriptor of [host, remote, ctx.typert.remotes.get('session/modelCatalog')!]) {
        expect(descriptor.result.create().parse(value)).toMatchObject({
          groups: [{ models: [
            { id: 'primary', showInPicker: true, multiAgentVersion: 'v2', serviceTiers: ['auto', 'priority'] },
            { id: 'other', showInPicker: false, multiAgentVersion: 'v2', serviceTiers: ['auto', 'priority'] },
          ] }],
        })
      }
    } finally { remove() }
  })

  it('dispatches catalog and control through the published Gateway service identity', async () => {
    const { ctx } = await assembly()
    ctx.provide('fileUploads', {
      registerAgentResolver: () => () => {},
    } satisfies Pick<FileUploads, 'registerAgentResolver'>)
    new SessionController(ctx, { nativeOpen: false })
    ctx.typert.register(TYPERT)
    await ctx.plugin(TypertGateway)

    await expect(ctx.typertGateway.invoke({ namespace: 'session', method: 'modelCatalog', args: {} })).resolves.toMatchObject({
      groups: [{ models: [{ id: 'primary', showInPicker: true }, { id: 'other', showInPicker: false }] }],
    })
    const abort = new AbortController()
    const uplink: AsyncIterable<never> = { async *[Symbol.asyncIterator]() {} }
    const stream = await ctx.typertGateway.wireStream.open('session/control', { args: {} }, uplink, undefined, abort.signal)
    const iterator = stream[Symbol.asyncIterator]()
    try {
      await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: 'baseline', value: { projections: {} } } })
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  })
})
