import { encodeProductEvents, projectProductEvents } from '@codexydsh/runtime/session'
import { snapshotProductEvents } from '@codexydsh/runtime/session'
/**
 * Continuable-child delegation policy: a fresh continuable start seeds the
 * parent's Auto identity, explicit sandbox override, and the pinned
 * `approval/policy: never` onto the child's own log, and a cold
 * resume replays that persisted snapshot instead of re-capturing the parent
 * (the one-shot `subagent-inprocess/tests/inheritance.spec.ts` counterpart).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@codexydsh/runtime'
import { mountAgentLoopTestDependencies } from '@codexydsh/runtime-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@codexydsh/runtime/types'
import JsonlSessionPersistence from '@codexydsh/runtime/persistence'
import { queueHostSubagentPrompt } from '@codexydsh/delegation/internal'
import * as SubagentFork from '@codexydsh/fork'
import * as SubagentSpawn from '@codexydsh/spawn'
import ApprovalService from '@codexydsh/approval'
import { captureDelegatedPolicyOverrides, appendDelegatedPolicyOverrides } from '../src/child-agent.ts'
import { MockAdapter, textResponse } from '@codexydsh/runtime-testkit/mock-adapter'
import SubagentRuntime from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { loadStoredSession } from './persistence-helpers.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const roots: string[] = []
const contexts: Context[] = []

it('inherits the automatic reviewer only for Codexful delegation', async () => {
  const { ctx, parent } = await setup([])
  ctx.codexyApproval.setReviewer(parent, 'auto_review')
  const child = Session.create(SessionId('automatic-review-child'))
  const captured = captureDelegatedPolicyOverrides(parent, 'inherit')
  expect(captured.approvalReviewer).toBe('auto_review')
  appendDelegatedPolicyOverrides(child, captured)
  expect(ctx.codexyApproval.reviewerOf(child)).toBe('auto_review')
  expect(snapshotProductEvents(child).some(event => event.type === 'approval/reviewer'
    && event.data.source === 'delegation')).toBe(true)
  expect(captureDelegatedPolicyOverrides(parent).approvalReviewer).toBeUndefined()
})

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Boot the continuable stack plus both policy services the manager consumes opportunistically. */
async function setup(script: Script, options: { codexfulHistory?: true } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-continuation-inherit-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root })
  await ctx.plugin(ApprovalService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork', ...options })
  const adapter = new MockAdapter(script)
  ctx.codexyRequests.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, adapter }
}

function startSpec(parent: Agent, provider = 'spawn') {
  return {
    provider,
    label: 'child task',
    request: { prompt: [{ type: 'text' as const, text: 'child task' }], parent },
    signal: new AbortController().signal,
  }
}

/** Wait until a child's Activation is gone, i.e. its handle finished disposal. */
async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.agents.get(childId)).toBeUndefined()
  }, { timeout: 15_000 })
}

function policyEvents(events: readonly SessionEvent[]) {
  return events.filter(event => event.type === 'sandbox/mode' || event.type === 'approval/policy')
}

function foldedSandboxMode(ctx: Context, id: SessionId, events: readonly SessionEvent[]): unknown {
  return ctx.sessionProjections.stateOf(Session.create(id, encodeProductEvents(events)), 'sandboxMode')
}

function foldedApprovalPolicy(ctx: Context, id: SessionId, events: readonly SessionEvent[]): unknown {
  return ctx.codexyApproval.overrideOf(Session.create(id, encodeProductEvents(events)))
}

describe('continuable policy inheritance', () => {
  it('restores a Codexful fork with its original current-turn cut and child-owned task', { timeout: 20_000 }, async () => {
    const { ctx, parent, adapter } = await setup([
      'hang', textResponse('child done'), textResponse('resumed child done'),
    ], { codexfulHistory: true })
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'parent current task' }], source: { kind: 'user' },
    }))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const inheritedCount = parent.session.snapshotEvents().length
    try {
      const started = await ctx.codexySubagents.startContinuable({
        ...startSpec(parent, 'fork'),
        label: '/root/worker',
        codexfulTask: true,
      })
      await ctx.agents.get(started.childId)!.whenIdle()
      await ctx.codexySubagents.drainContinuableChildren(parent, [started.childId])
      await waitNoActivation(ctx, started.childId)
      const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
      expect(loaded.inheritedEventCount).toBe(inheritedCount)
      expect(loaded.events[inheritedCount]).toMatchObject({
        type: 'session/end-seed', data: { inherited: true },
      })
      expect(loaded.events.filter(event => event.type === 'session/end-seed'
        && event.data.inherited === true)).toHaveLength(1)
      expect(loaded.events.some(event => event.type === 'turn/end'
        && event.data.reason.kind === 'forked')).toBe(true)
      expect(loaded.events.slice(inheritedCount).some(event => event.type === 'subagent/descriptor'
        && event.data.provider === 'fork')).toBe(true)
      expect(loaded.events.slice(inheritedCount).some(event => event.type === 'user/message'
        && event.data.source.kind === 'agent-message'
        && event.data.content[0]?.type === 'text'
        && event.data.content[0].text.startsWith('Message Type: NEW_TASK\nTask name: /root/worker'))).toBe(true)

      parent.cancel({ kind: 'user' })
      await parent.whenIdle()
      await queueHostSubagentPrompt(ctx.codexySubagents, parent, started.childId,
        [{ type: 'text', text: 'continue child' }], { kind: 'user' }, new AbortController().signal)
      await ctx.agents.get(started.childId)!.whenIdle()
      await ctx.codexySubagents.drainContinuableChildren(parent, [started.childId])
      await waitNoActivation(ctx, started.childId)
      const resumed = await loadStoredSession(ctx.sessionPersistence, started.childId)
      expect(resumed.inheritedEventCount).toBe(inheritedCount)
      expect(resumed.events.filter(event => event.type === 'session/end-seed'
        && event.data.inherited === true)).toHaveLength(1)
      expect(resumed.events.filter(event => event.type === 'subagent/descriptor')).toHaveLength(1)
      expect(resumed.events.filter(event => event.type === 'assistant/message'
        && event.data.message.content.some(block => block.type === 'text' && block.text === 'resumed child done')))
        .toHaveLength(1)
    } finally {
      if (parent.status === 'running') parent.cancel({ kind: 'user' })
      await parent.whenIdle()
    }
  })

  it.each(['auto', 'danger-full-access'] as const)(
    'persists the delegated %s identity across cold resume without reading the parent again',
    { timeout: 20_000 },
    async (preset) => {
      const { ctx, parent } = await setup([textResponse('child done'), textResponse('resumed child done')])
      parent.session.append('permission/preset', { preset })
      setSandboxMode(parent.session, 'danger-full-access')
      const current = vi.fn((session: Session) => session === parent.session ? preset : 'custom')
      ctx.provide('codexyPermissions', { current } as never)

      const started = await ctx.codexySubagents.startContinuable(startSpec(parent))
      await waitNoActivation(ctx, started.childId)

      const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
      expect(loaded.events.filter(event =>
        event.type === 'sandbox/mode'
        || event.type === 'approval/policy'
        || event.type === 'permission/preset',
      )).toMatchObject([
        { type: 'sandbox/mode', data: { mode: 'danger-full-access', source: 'delegation' } },
        { type: 'approval/policy', data: { policy: 'never', source: 'delegation' } },
        { type: 'permission/preset', data: { preset } },
      ])
      expect(current).toHaveBeenCalledExactlyOnceWith(parent.session)
      parent.session.append('permission/preset', { preset: preset === 'auto' ? 'danger-full-access' : 'auto' })
      current.mockImplementation(() => { throw new Error('cold resume must not read parent permission') })
      await queueHostSubagentPrompt(
        ctx.codexySubagents, parent, started.childId,
        [{ type: 'text', text: 'continue please' }], { kind: 'user' }, new AbortController().signal,
      )
      await waitNoActivation(ctx, started.childId)
      const resumed = await loadStoredSession(ctx.sessionPersistence, started.childId)
      expect(resumed.events.filter(event => event.type === 'permission/preset')).toMatchObject([
        { data: { preset } },
      ])
      expect(current).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    { seedPreset: 'auto', preset: 'danger-full-access' },
    { seedPreset: 'danger-full-access', preset: 'auto' },
  ] as const)('captures $preset before child creation and overrides the $seedPreset fork prefix', { timeout: 20_000 }, async ({ seedPreset, preset }) => {
    const { ctx, parent } = await setup([textResponse('parent turn'), textResponse('forked child')])
    parent.session.append('permission/preset', { preset: seedPreset })
    setSandboxMode(parent.session, 'danger-full-access')
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'parent work' }],
      source: { kind: 'user' },
    }))
    await parent.whenIdle()
    parent.session.append('permission/preset', { preset })
    let currentPreset: 'auto' | 'danger-full-access' = preset
    ctx.provide('codexyPermissions', {
      current: (session: Session) => session === parent.session ? currentPreset : 'custom',
    } as never)

    const starting = ctx.codexySubagents.startContinuable(startSpec(parent, 'fork'))
    currentPreset = seedPreset
    parent.session.append('permission/preset', { preset: seedPreset })
    const started = await starting
    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(loaded.events.filter(event => event.type === 'permission/preset')).toMatchObject([
      { data: { preset: seedPreset } },
      { data: { preset } },
    ])
  })

  it('seeds the parent sandbox override and pins approval to never', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('child done')])
    setSandboxMode(parent.session, 'danger-full-access')
    // No parent approval override: the child pin must not depend on one.
    expect(ctx.codexyApproval.overrideOf(parent.session)).toBeUndefined()
    let child: Agent | undefined
    ctx.on('agent/created', ({ agent }) => {
      if (agent !== parent) child = agent
    })

    const started = await ctx.codexySubagents.startContinuable(startSpec(parent))
    // The delegation events are appended in the creation window, so they are
    // already the child's effective policy at inbox acceptance.
    if (child === undefined) throw new Error('expected the continuable child to be created')
    expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('danger-full-access')
    expect(ctx.codexyApproval.overrideOf(child.session)).toBe('never')

    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(policyEvents(loaded.events)).toMatchObject([
      { type: 'sandbox/mode', data: { mode: 'danger-full-access', source: 'delegation' } },
      { type: 'approval/policy', data: { policy: 'never', source: 'delegation' } },
    ])
    // Durable: a reload folds the same effective policy.
    expect(foldedSandboxMode(ctx, started.childId, loaded.events)).toBe('danger-full-access')
    expect(foldedApprovalPolicy(ctx, started.childId, loaded.events)).toBe('never')
    expect(ctx.codexyApproval.overrideOf(parent.session)).toBeUndefined()
    const runtimeContext = loaded.events.find(
      (event): event is SessionEvent<'user/message'> => event.type === 'user/message'
        && event.data.source.kind === 'runtime-context',
    )
    const contextText = runtimeContext?.data.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('\n')
    expect(contextText).toContain('You are a delegated subagent')
  })

  it('captures policy at delegation before asynchronous child creation', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('child done')])
    setSandboxMode(parent.session, 'read-only')

    const starting = ctx.codexySubagents.startContinuable(startSpec(parent))
    // A parent switch after the synchronous capture belongs to the parent's
    // future, not to this child.
    setSandboxMode(parent.session, 'danger-full-access')
    const started = await starting

    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(ctx.sandboxPolicy.overrideOf(parent.session)).toBe('danger-full-access')
    expect(foldedSandboxMode(ctx, started.childId, loaded.events)).toBe('read-only')
  })

  it('leaves an unswitched sandbox on the deployment default while still pinning approval', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('child done')])

    const started = await ctx.codexySubagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(policyEvents(loaded.events)).toMatchObject([
      { type: 'approval/policy', data: { policy: 'never', source: 'delegation' } },
    ])
    expect(foldedSandboxMode(ctx, started.childId, loaded.events)).toBeNull()
  })

  it('pins approval after the fork prefix of an unswitched fork child', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('parent turn'), textResponse('forked child')])
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'parent work' }],
      source: { kind: 'user' },
    }))
    await parent.whenIdle()

    const started = await ctx.codexySubagents.startContinuable(startSpec(parent, 'fork'))
    await waitNoActivation(ctx, started.childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(loaded.inheritedEventCount).toBeGreaterThan(0)
    expect(policyEvents(loaded.events)).toMatchObject([
      { type: 'approval/policy', data: { policy: 'never', source: 'delegation' } },
    ])
    expect(foldedSandboxMode(ctx, started.childId, loaded.events)).toBeNull()
  })

  it('lets a later child-side switch win over the delegation snapshot', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('child done')])
    setSandboxMode(parent.session, 'danger-full-access')
    let child: Agent | undefined
    ctx.on('agent/created', ({ agent }) => {
      if (agent !== parent) child = agent
    })

    const started = await ctx.codexySubagents.startContinuable(startSpec(parent))
    if (child === undefined) throw new Error('expected the continuable child to be created')
    expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('danger-full-access')
    // Last event wins: the child's own runtime switch beats the seeded snapshot.
    setSandboxMode(child.session, 'read-only')
    expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('read-only')

    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(foldedSandboxMode(ctx, started.childId, loaded.events)).toBe('read-only')
  })

  it('cold-resumes on the persisted snapshot without re-capturing the parent', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('after resume')])
    setSandboxMode(parent.session, 'read-only')
    const started = await ctx.codexySubagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    // The parent widens AFTER the child was created; the resumed child keeps
    // the delegation-time snapshot from its own log.
    setSandboxMode(parent.session, 'danger-full-access')
    await queueHostSubagentPrompt(
      ctx.codexySubagents,
      parent,
      started.childId,
      [{ type: 'text', text: 'continue please' }],
      { kind: 'user' },
      new AbortController().signal,
    )
    await waitNoActivation(ctx, started.childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(loaded.events.filter(event => event.type === 'sandbox/mode')).toMatchObject([
      { data: { mode: 'read-only', source: 'delegation' } },
    ])
    expect(foldedSandboxMode(ctx, started.childId, loaded.events)).toBe('read-only')
    // The approval pin is seeded once at creation, never re-appended on resume.
    expect(loaded.events.filter(event => event.type === 'approval/policy')).toMatchObject([
      { data: { policy: 'never', source: 'delegation' } },
    ])
  })

  it('places inherited events after a fork prefix so fresh policy wins stale seed state', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('parent turn'), textResponse('forked child')])
    // The stale mode lands inside the completed turn the fork seed replays.
    setSandboxMode(parent.session, 'workspace-write')
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'parent work' }],
      source: { kind: 'user' },
    }))
    await parent.whenIdle()
    setSandboxMode(parent.session, 'read-only')

    const started = await ctx.codexySubagents.startContinuable(startSpec(parent, 'fork'))
    await waitNoActivation(ctx, started.childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(loaded.inheritedEventCount).toBeGreaterThan(0)
    expect(loaded.events.filter(event => event.type === 'sandbox/mode')).toMatchObject([
      { data: { mode: 'workspace-write' } },
      { data: { mode: 'read-only', source: 'delegation' } },
    ])
    expect(foldedSandboxMode(ctx, started.childId, loaded.events)).toBe('read-only')
  })
})
