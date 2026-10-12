/** Real product registrations retain their localized browser command identities. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import McpManager from '@codexydsh/mcp'
import PermissionPresets from '@codexydsh/permissions'
import { registerSessionRenameCommand } from '../packages/api-session/src/rename-command.ts'
import { apply as applyRecap } from '../packages/prompt/src/recap.ts'
import { builtinCommandName, resolveCommand } from '../packages/ui-commands/src/client/resolution.ts'
import { createScope } from '@deepseek-ai/dsh-scope'
import { expect, it, onTestFinished } from 'vitest'

it('resolves owned permission, MCP, rename, and recap descriptors emitted by the public CommandRuntime', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  for (const plugin of [SessionStore, CommandRuntime, ToolRuntime, SystemPrompt, TypertRegistry, SessionProjections]) await ctx.plugin(plugin).await()
  ctx.provide('shell', { sandboxMode: 'workspace-write' } as never)
  ctx.provide('codexyApproval', { config: { policy: 'ask' } } as never)
  await ctx.plugin(McpManager, {}).await()
  await ctx.plugin(PermissionPresets, {}).await()
  await ctx.plugin({ inject: ['commands'], apply(owner: Context) { registerSessionRenameCommand(owner); applyRecap(owner) } }).await()
  const session = ctx.sessions.create(SessionId('product-command-owners'))
  const agent = { id: session.id, session } as Agent
  const scope = createScope(ctx, agent)
  Object.assign(agent, { ctx: scope.ctx })
  onTestFinished(() => scope.dispose())
  const descriptors = ctx.commands.list(agent)
  expect(descriptors.map(descriptor => descriptor.name).sort()).toEqual(['mcp', 'permission', 'recap', 'rename'])
  for (const [name, alias] of [['mcp', 'mcp'], ['permission', '权限'], ['rename', '重命名'], ['recap', 'recap']] as const) {
    const descriptor = descriptors.find(candidate => candidate.name === name)!
    expect(builtinCommandName(descriptor), descriptor.definitionId).toBe(name)
    expect(resolveCommand(alias, descriptors)).toBe(descriptor)
  }
})
