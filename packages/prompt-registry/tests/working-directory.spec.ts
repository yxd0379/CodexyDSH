import { Context, Service } from '@deepseek-ai/cordis'
import StockPrompt from '@deepseek-ai/dsh-system-prompt'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@codexydsh/runtime/session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-working-directory'
import { describe, expect, it } from 'vitest'
import ProductPrompt from '../src/index.ts'

/** Public Service identity plus standard published context, without filesystem I/O. */
class DirectoryFixture extends Service {
  static inject = ['systemPrompt']

  constructor(ctx: Context) {
    super(ctx, 'workingDirectory')
    ctx.systemPrompt.context({ name: 'working-directory:current', order: 100, required: true, interpolate: false,
      text: context => context.agent === undefined ? '' : `Current working directory: ${JSON.stringify(this.get(context.agent.session))}.`,
    })
  }

  get(session: Session): string {
    return session.snapshotEvents().findLast(event => event.type === 'working-directory/change')?.data.cwd
      ?? session.header.cwd ?? '/fixture/default'
  }

  ensure(agent: Agent, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    return Promise.resolve(this.get(agent.session))
  }
}

function agent(ctx: Context, id = 'directory-registry'): Agent {
  const sessionId = SessionId(id)
  return {
    id: sessionId, ctx, options: { provider: 'fixture', model: 'fixture' },
    session: Session.create(sessionId, [], {
      version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, cwd: '/fixture/original', isSeeded: false,
    }),
  } as Agent
}

async function mounted(ctx: Context, directory = true): Promise<ProductPrompt> {
  await ctx.plugin(StockPrompt)
  await ctx.plugin(ProductPrompt)
  if (directory) await ctx.plugin(DirectoryFixture)
  // The runtime port requires explicit prepare; this registry's public API additionally supports previews.
  return ctx.codexyPrompt as ProductPrompt
}

describe('prompt registry working-directory snapshot', () => {
  it('retains the stock context and frozen cwd across changes, with the next preparation reading the new cwd', async () => {
    const ctx = new Context()
    try {
      const prompt = await mounted(ctx)
      const owner = agent(ctx)
      const context = { agent: owner }
      const token = await prompt.prepare(context)
      owner.session.append('working-directory/change', { cwd: '/fixture/original' })
      owner.session.append('working-directory/change', { cwd: '/fixture/current' })
      owner.session.append('request/header', { reason: 'initial', header: { config: { provider: 'fixture', model: 'fixture' } } })
      const assembly = await prompt.assemble(context, token)
      expect(prompt.preparedWorkingDirectory(token)).toBe('/fixture/original')
      expect(assembly.contexts).toEqual([{ name: 'working-directory:current',
        text: 'Current working directory: "/fixture/original".', interpolate: false }])
      const current = await prompt.prepare(context)
      expect(prompt.preparedWorkingDirectory(current)).toBe('/fixture/current')
      expect((await prompt.assemble(context, current)).contexts).toEqual([{ name: 'working-directory:current',
        text: 'Current working directory: "/fixture/current".', interpolate: false }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses the legacy no-service path without dropping a same-name context', async () => {
    const ctx = new Context()
    try {
      const prompt = await mounted(ctx, false)
      const owner = agent(ctx)
      const legacy = await prompt.prepare({ agent: owner })
      await expect(prompt.assemble({ agent: owner }, legacy)).resolves.toHaveProperty('contexts', [])
      expect(prompt.preparedWorkingDirectory(legacy)).toBeUndefined()
      ctx.systemPrompt.context({ name: 'working-directory:current', order: 100, required: true, interpolate: false,
        text: 'Current working directory: "/fixture/original".',
      })
      const withContext = await prompt.prepare({ agent: owner })
      expect(prompt.preparedWorkingDirectory(withContext)).toBeUndefined()
      expect((await prompt.assemble({ agent: owner }, withContext)).contexts).toEqual([{ name: 'working-directory:current',
        text: 'Current working directory: "/fixture/original".', interpolate: false }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['text', 'duplicate', 'role', 'interpolate', 'missing'] as const)(
    'preserves an altered inherited %s context instead of refusing preparation', async (alteration) => {
      const ctx = new Context()
      try {
        const prompt = await mounted(ctx)
        ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
          const assembly = await next()
          const current = assembly.contexts.find(context => context.name === 'working-directory:current')!
          if (alteration === 'text') current.text = 'Current working directory: "/fixture/forged".'
          if (alteration === 'duplicate') assembly.contexts.push({ ...current })
          if (alteration === 'role') Object.assign(current, { role: 'user' })
          if (alteration === 'interpolate') current.interpolate = true
          if (alteration === 'missing') assembly.contexts = assembly.contexts.filter(context => context !== current)
          return assembly
        }, { prepend: true })
        const owner = agent(ctx)
        const token = await prompt.prepare({ agent: owner })
        expect(prompt.preparedWorkingDirectory(token)).toBe('/fixture/original')
        const contexts = (await prompt.assemble({ agent: owner }, token)).contexts
        if (alteration === 'text') expect(contexts[0]?.text).toBe('Current working directory: "/fixture/forged".')
        if (alteration === 'duplicate') expect(contexts).toHaveLength(2)
        if (alteration === 'role') expect(contexts[0]?.role).toBe('user')
        if (alteration === 'interpolate') expect(contexts[0]?.interpolate).toBe(true)
        if (alteration === 'missing') expect(contexts).toEqual([])
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )

  it('keeps a captured cwd after a public provider changes, without requiring tracker identity', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(StockPrompt)
      await ctx.plugin(ProductPrompt)
      // Register from the root fiber so its public setter owns this test fixture.
      const first = new DirectoryFixture(ctx)
      const prompt = ctx.codexyPrompt as ProductPrompt
      const owner = agent(ctx)
      const context = { agent: owner }
      const token = await prompt.prepare(context)
      expect(ctx.workingDirectory).not.toBe(ctx.workingDirectory)
      const replacement = { get: () => '/fixture/replacement', ensure: async () => '/fixture/replacement' }
      ctx.set('workingDirectory', replacement as never)
      await expect(prompt.assemble(context, token)).resolves.toHaveProperty('contexts')
      expect(prompt.preparedWorkingDirectory(token)).toBe('/fixture/original')
      const changed = await prompt.prepare(context)
      expect(prompt.preparedWorkingDirectory(changed)).toBe('/fixture/replacement')
      ctx.set('workingDirectory', first as never)
      Object.assign(owner, { session: Session.create(owner.id, [], owner.session.header) })
      await expect(prompt.assemble(context, token)).resolves.toHaveProperty('contexts')
      expect(prompt.preparedWorkingDirectory(token)).toBe('/fixture/original')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('captures the public cwd from a plain optional service', async () => {
    const ctx = new Context()
    try {
      const prompt = await mounted(ctx, false)
      ctx.provide('workingDirectory', { get: () => '/fixture/original', ensure: async () => '/fixture/original' } as never)
      const token = await prompt.prepare({ agent: agent(ctx) })
      expect(prompt.preparedWorkingDirectory(token)).toBe('/fixture/original')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reuses the captured cwd after assembly instead of rereading the live directory', async () => {
    const ctx = new Context()
    try {
      const prompt = await mounted(ctx)
      const owner = agent(ctx)
      const context = { agent: owner }
      const token = await prompt.prepare(context)
      await prompt.assemble(context, token)
      owner.session.append('working-directory/change', { cwd: '/fixture/later' })
      expect(prompt.preparedWorkingDirectory(token)).toBe('/fixture/original')
      expect(prompt.preparedWorkingDirectory(await prompt.prepare(context))).toBe('/fixture/later')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
