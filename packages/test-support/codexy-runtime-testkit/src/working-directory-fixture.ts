/** Fixed directory collaborator for tool consumers whose tests do not exercise directory changes. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Supply the Session header directory without filesystem admission or durable transitions. */
export function provideWorkingDirectoryFixture(ctx: Context, defaultDirectory = process.cwd()): void {
  const get = (session: Session): string => session.header.cwd ?? defaultDirectory
  ctx.provide('workingDirectory', { defaultDirectory, get,
    ensure: (agent: Agent): Promise<string> => Promise.resolve(get(agent.session)),
  })
}
