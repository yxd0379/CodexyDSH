import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Runtime from '@codexydsh/runtime'
import ProductPrompt from '@codexydsh/prompt-registry'
import { NativeToolRuntime, NativeTools } from '@codexydsh/bridges/tools'
import { RequestProviders } from '@codexydsh/bridges'
import ApprovalService from '@codexydsh/approval'
import * as Spawn from '@codexydsh/spawn'
import * as Fork from '@codexydsh/fork'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { MockAdapter, textResponse } from '../../../test-support/codexy-runtime-testkit/src/mock-adapter.ts'
import Subagents from '../src/index.ts'

/** Load the actual product services: child scopes must not inherit root test privileges. */
async function bench() {
  const root = await mkdtemp(join(tmpdir(), 'codexy-delegation-loader-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  })
  const modules = new Map<string, unknown>([
    ['llm', LlmRuntime], ['session', SessionStore], ['projections', SessionProjectionRegistry],
    ['prompt', SystemPrompt], ['tools', NativeToolRuntime], ['agents', AgentRegistry],
    ['product-prompt', ProductPrompt], ['product-tools', NativeTools], ['requests', RequestProviders],
    ['storage', Storage], ['storage-json', StorageJson], ['storage-domain', StorageDomain],
    ['persistence', Persistence], ['approval', ApprovalService], ['runtime', Runtime],
    ['subagents', Subagents], ['spawn', Spawn], ['fork', Fork],
  ])
  const config = {
    'storage-json': { root: join(root, 'plugins') }, 'storage-domain': { backend: 'json' },
    persistence: { root: join(root, 'sessions'), compression: 'none' },
    approval: { policy: 'ask', reviewer: 'auto_review' }, runtime: { agents: [] },
    spawn: { providerName: 'spawn' }, fork: { providerName: 'fork', codexfulHistory: true },
  }
  await writeFile(join(root, 'cordis.yml'), JSON.stringify([...modules.keys()].map(name => ({
    id: name, name: `@test/${name}`, ...name in config ? { config: config[name as keyof typeof config] } : {},
  }))))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const module = modules.get(specifier.replace('@test/', ''))
      if (module === undefined) throw new Error(`unexpected fixture module ${specifier}`)
      return module
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(root, 'cordis.yml')).href } })
  await ctx.loader.await()
  ctx.codexyRequests.registerAdapter(['fixture'], new MockAdapter([textResponse('CHILD_OK')]))
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'fixture', model: 'fixture' }, { cwd: root })
  parent.session.append('turn/start', { turn: 1 })
  parent.session.append('step/start', { turn: 1, step: 1 })
  parent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Parent instruction retained by fork.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  parent.session.append('step/end', { turn: 1, step: 1 })
  parent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return { ctx, parent }
}

describe('delegated reviewer inheritance through the real Loader', () => {
  it.each([
    { mode: 'one-shot', provider: 'spawn' }, { mode: 'one-shot', provider: 'fork' },
    { mode: 'continuable', provider: 'spawn' }, { mode: 'continuable', provider: 'fork' },
  ] as const)('creates a $mode $provider child with the parent reviewer', async ({ mode, provider }) => {
    const { ctx, parent } = await bench()
    const published = new Map<SessionId, Agent>()
    ctx.on('agent/created', ({ agent }) => { published.set(agent.id, agent) })
    const request = {
      parent, prompt: [{ type: 'text' as const, text: 'Return CHILD_OK.' }],
      delegatedApprovalPolicy: 'inherit' as const,
      ...provider === 'fork' ? { forkTurns: 1 } : {},
    }
    if (mode === 'one-shot') {
      const run = await ctx.codexySubagents.start(provider, { ...request, signal: new AbortController().signal })
      try {
        expect(ctx.codexyApproval.reviewerOf(run.localAgent!.session)).toBe('auto_review')
        expect(await run.result).toMatchObject({ stopReason: 'completed', output: [{ type: 'text', text: 'CHILD_OK' }] })
      } finally { await run.dispose() }
    } else {
      const started = await ctx.codexySubagents.startContinuable({
        provider, label: 'child', request, signal: new AbortController().signal,
        codexV1Identity: { nickname: 'fixture-child' },
      })
      expect(started.childId).not.toBe(parent.id)
      expect(ctx.codexyApproval.reviewerOf({ id: started.childId })).toBe('auto_review')
      expect(ctx.codexySubagents.identityOf(started.childId)?.nickname).toBe('fixture-child')
      const child = published.get(started.childId)
      expect(child).toBeDefined()
      await child!.whenIdle()
      expect(child!.session.deriveMessages()).toContainEqual(expect.objectContaining({
        role: 'assistant', content: [{ type: 'text', text: 'CHILD_OK' }],
      }))
    }
  })
})
