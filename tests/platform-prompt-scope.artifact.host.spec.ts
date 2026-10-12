/** Installed product peers share the platform's scope tags, registries, and effect owners. */
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

const profileHome = process.env.CODEXY_PACKED_PROFILE_HOME
const executable = process.env.CODEXY_PACKED_DSH

const probe = String.raw`
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [home, executable] = process.argv.slice(1)
const installation = createRequire(realpathSync(executable))
const profileDir = join(home, 'profiles/codexy')
const product = createRequire(join(profileDir, 'package.json'))
const published = specifier => import(pathToFileURL(installation.resolve(specifier)).href)
const owned = specifier => import(pathToFileURL(product.resolve(specifier)).href)
const { Context } = await published('@deepseek-ai/cordis')
const { PluginPackages, createRuntimeResolution, loadProfileDirectory } = await published('@deepseek-ai/dsh-app-boot')
const installAnchor = installation.resolve('@deepseek-ai/dsh/package.json')
const profile = loadProfileDirectory('dsh', profileDir, installAnchor)
assert.deepEqual(profile.skippedBundles, [])
const resolution = await createRuntimeResolution({ installAnchor, profile, home })
const ctx = new Context()
try {
  await ctx.plugin(PluginPackages, { resolution }).await()
  const platformScope = await published('@deepseek-ai/dsh-scope')
  const productScope = await owned('@deepseek-ai/dsh-scope')
  assert.equal(productScope.scopeOf, platformScope.scopeOf)
  assert.equal(productScope.createScope, platformScope.createScope)
  const [llm, sessions, projections, prompt, agents, references, requests, tools, registry, runtime] = await Promise.all([
    published('@deepseek-ai/dsh-llm'), published('@deepseek-ai/dsh-session'),
    published('@deepseek-ai/dsh-session-projection'), published('@deepseek-ai/dsh-system-prompt'),
    published('@deepseek-ai/dsh-agent'), published('@deepseek-ai/dsh-file-reference-local'),
    owned('@codexydsh/bridges'), owned('@codexydsh/bridges/tools'),
    owned('@codexydsh/prompt-registry'), owned('@codexydsh/runtime'),
  ])
  await ctx.plugin(llm.default).await()
  await ctx.plugin(sessions.default).await()
  await ctx.plugin(projections.default).await()
  await ctx.plugin(prompt.default).await()
  await ctx.plugin(tools.NativeToolRuntime).await()
  await ctx.plugin(agents.default).await()
  await ctx.plugin(registry.default).await()
  await ctx.plugin(tools.NativeTools).await()
  await ctx.plugin(requests.default).await()
  const directory = session => session.header.cwd ?? process.cwd()
  ctx.provide('workingDirectory', { defaultDirectory: process.cwd(), get: directory, ensure: async agent => directory(agent.session) })
  await ctx.plugin(references.default).await()
  await ctx.plugin(runtime.AgentLoop, { agents: [] }).await()
  const first = await ctx.agents.create({ sessionId: sessions.SessionId('installed-scope-first'), agentOptions: {} })
  first.agent.ctx.codexyPrompt.section({ name: 'fixture:owner', order: 1, text: 'first' })
  const second = await ctx.agents.create({ sessionId: sessions.SessionId('installed-scope-second'), agentOptions: {} })
  second.agent.ctx.codexyPrompt.section({ name: 'fixture:owner', order: 1, text: 'second' })
  assert.equal(platformScope.scopeOf(first.agent.ctx), first.agent)
  assert.equal(platformScope.scopeOf(second.agent.ctx), second.agent)
  assert.deepEqual(ctx.agents.list(), [first.agent, second.agent])
  const captured = []
  first.agent.ctx.on('codexy-prompt/prepare', async (_variables, _context, next) => { captured.push('first'); return next() })
  second.agent.ctx.on('codexy-prompt/prepare', async (_variables, _context, next) => { captured.push('second'); return next() })
  const inspect = async (agent, owner) => {
    const context = { scope: agent, agent }
    assert.equal((await ctx.systemPrompt.assemble(context)).sections.filter(section => section.name === 'context:file-reference').length, 1)
    const prepared = await ctx.codexyPrompt.prepare(context)
    const assembly = await ctx.codexyPrompt.assemble(context, prepared)
    assert.equal(assembly.sections.find(section => section.name === 'fixture:owner')?.text, owner)
  }
  await inspect(first.agent, 'first')
  await inspect(second.agent, 'second')
  assert.deepEqual(captured, ['first', 'second'])
  assert.equal((await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'context:file-reference'), false)
  await first.dispose()
  assert.deepEqual(ctx.agents.list(), [second.agent])
  assert.equal((await ctx.systemPrompt.assemble({ scope: first.agent, agent: first.agent })).sections.some(section => section.name === 'context:file-reference'), false)
  await inspect(second.agent, 'second')
  assert.deepEqual(captured, ['first', 'second', 'second'])
  await second.dispose()
  const prepared = await ctx.codexyPrompt.prepare({})
  assert.equal((await ctx.codexyPrompt.assemble({}, prepared)).sections.some(section => section.name === 'fixture:owner'), false)
  process.stdout.write('CODEXY_INSTALLED_SCOPE_OK\n')
} finally { await ctx.fiber.dispose() }
`

it.skipIf(profileHome === undefined || executable === undefined)('shares the released scope instance across installed products and two live Sessions', () => {
  if (profileHome === undefined || executable === undefined) throw new Error('packed profile inputs are required')
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe, profileHome, executable], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, DSH_HOME: profileHome },
  })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('CODEXY_INSTALLED_SCOPE_OK')
}, 35000)
