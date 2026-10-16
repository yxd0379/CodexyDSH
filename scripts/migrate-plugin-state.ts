/** One-time transfer out of legacy session facts into the owning plugins' domains. */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import { memoryDomain } from '../packages/memory/src/domain.ts'
import { promptDomain } from '../packages/prompt/src/multi-agent-version.ts'
import { approvalDomain } from '../packages/approval/src/domain.ts'

export async function openPluginMigration(root: string) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root })
  await ctx.plugin(DomainStorage, { backend: 'json' })
  const memory = await ctx.storageDomain.open(memoryDomain)
  const prompt = await ctx.storageDomain.open(promptDomain)
  const approval = await ctx.storageDomain.open(approvalDomain)
  return {
    async write(sessionId: string, records: readonly any[]) {
      for (const event of records) {
        const data = event.data
        switch (event.type) {
          case 'memory/context':
            await memory.table('contexts').put(sessionId, data)
            break
          case 'codexful/multi-agent-version':
            await prompt.table('delegation').put(sessionId, { version: data.version })
            break
          case 'approval/reviewer':
            await approval.table('settings').put(sessionId, { reviewer: data.reviewer })
            break
          case 'approval/review':
            if (data.status === 'started' || data.status === 'inspecting') break
            await approval.table('reviews').put(`${sessionId}:${data.id}`, {
              sessionId, id: data.id, status: data.status,
              ...data.assessment === undefined ? {} : { assessment: data.assessment },
              ...data.error === undefined ? {} : { error: data.error },
            })
            break
        }
      }
    },
    async close() {
      await Promise.all([memory.close(), prompt.close(), approval.close()])
      await ctx.fiber.dispose()
    },
  }
}
