// @vitest-environment jsdom
/** Shipped profile IDs reach the actual Settings projection and product browser consumers. */
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import * as BrowserSettings from '@deepseek-ai/dsh-client-ui-settings/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { parse } from 'yaml'
import { z } from 'zod'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SlotTestRuntime } from '@codexydsh/test-support/client'
import * as ChatHost from '@codexydsh/ui-chat'
import * as ConversationHost from '@codexydsh/ui-conversation'
import * as CommandsHost from '@codexydsh/ui-commands'
import * as SkillHost from '@codexydsh/ui-skill'
import * as MemoryHost from '@codexydsh/ui-memory'
import * as Chat from '@codexydsh/ui-chat/client'
import * as Conversation from '@codexydsh/ui-conversation/client'
import * as Commands from '@codexydsh/ui-commands/client'
import * as Skill from '@codexydsh/ui-skill/client'
import * as Memory from '@codexydsh/ui-memory/client'
import { InputTriggerService } from '@codexydsh/ui-input-trigger/client'
import type { EnterBehaviorRowInjected } from '../packages/ui-conversation/src/client/settings/EnterBehaviorRow.tsx'

const hosts = { chat: ChatHost, conversation: ConversationHost, commands: CommandsHost, skill: SkillHost, memory: MemoryHost }
const insertedRows = z.array(z.object({ insert: z.array(z.object({
  id: z.string(), name: z.string(), config: z.record(z.string(), z.unknown()).optional(),
})).optional() }).passthrough())

it('projects the shipped Web entries into ready forms used by all five configured product UI plugins', async () => {
  const rows = insertedRows.parse(parse(await readFile(resolve('packages/web/cordis.patch.yml'), 'utf8')))
    .flatMap(patch => patch.insert ?? []).filter(row => Object.hasOwn(hosts, row.name.slice('@codexydsh/ui-'.length)))
  expect(rows).toHaveLength(5)
  const home = await mkdtemp(join(tmpdir(), 'codexy-profile-settings-'))
  const dir = join(home, 'profiles', 'codexy')
  initProfile(dir, [])
  await writeFile(join(home, 'package.json'), '{"name":"settings-integration-fixture"}\n')
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = { name: 'codexy', startedBundles: [], dir, home, cwd: home,
    installAnchor: join(home, 'package.json'), patchPath: join(dir, 'cordis.patch.yml'), telemetryDisabledEnv: undefined,
    overlays: [{ insert: [
      { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
      ...rows.map(row => ({ ...row, name: 'cordis:' + row.name.slice('@codexydsh/ui-'.length) })),
    ] }],
  }
  let host: Context | undefined, runtime: SlotTestRuntime | undefined
  onTestFinished(async () => { await runtime?.dispose(); await host?.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  host = await boot('codexy', join(dir, 'cordis.yml'), readProfilePatches('codexy', profile), ctx => {
    ctx.provide('profileContext', profile)
    ctx.provide('appReady', { onReady(listener: () => void) { listener(); return () => {} } })
    Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, ...hosts })
  })
  await host.loader.await()
  expect(host.get('settings')).toBeDefined()
  const namespaces = JSON.parse(JSON.stringify(host.settings.describe({ redactSecrets: true })))
  runtime = await SlotTestRuntime.create()
  runtime.remote.provideNamespaces({
    settings: { describe: async () => ({ ok: true, value: { writable: true, hasDocument: true, namespaces } }) },
    commands: { list: async () => ({ ok: true, value: [] }) },
    skills: { list: async () => ({ ok: true, value: { skills: [], partial: false } }) },
    memory: {}, session: { openWorkspacePath: async () => ({ ok: true, value: { opened: true } }) },
  })
  await runtime.mount(BrowserSettings)
  await runtime.ctx.configForms.describe().ensure()
  const get = vi.spyOn(runtime.ctx.configForms, 'get')
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale); runtime.slots.installLocale(locale)
  runtime.ctx.provide('layout', { openRightbar: vi.fn(), closeRightbar: vi.fn() } as never)
  runtime.ctx.provide('sidebarRight', { openResource: vi.fn(), openTab: vi.fn() } as never)
  runtime.ctx.provide('sidebarRightTabs', { register: () => () => {}, get: () => ({}), subscribe: () => () => {} } as never)
  runtime.ctx.provide('resources', { register: () => () => {} } as never)
  runtime.ctx.provide('uiWorkspace', { openSession: vi.fn(), openWorkspace: vi.fn() } as never)
  await runtime.root.declare({ main: { kind: 'keyed', scope: 'root' },
    'settings.general.item': { kind: 'list', scope: 'root' }, 'settings.section': { kind: 'list', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' }, 'conversation.approval.detail': { kind: 'single', scope: 'session' },
  }, () => null)
  await runtime.mount(InputTriggerService)
  for (const plugin of [Conversation, Chat, Commands, Skill, Memory]) await runtime.mount(plugin)
  expect(new Set(get.mock.calls.map(([id]) => id))).toEqual(new Set(rows.map(row => row.id)))
  for (const row of rows) expect(runtime.ctx.configForms.get(row.id).getSnapshot(), row.id).toMatchObject({ status: 'ready', writable: true })
  expect(runtime.ctx.configForms.get('codexy-ui-chat').getSnapshot().value).toMatchObject({ codexful: true })
  expect(runtime.ctx.configForms.get('codexy-ui-commands').getSnapshot().value).toEqual({ shellInput: true })
  expect(runtime.ctx.configForms.get('codexy-ui-skill').getSnapshot().value).toEqual({ trigger: '$' })
  const enter = runtime.slots.entries('settings.general.item').find(entry => entry.options.id === 'composer-enter')
  const face = enter?.inject?.() as EnterBehaviorRowInjected | undefined
  expect(face?.hooks.busyEnter.getSnapshot()).toBe('steer')
})
