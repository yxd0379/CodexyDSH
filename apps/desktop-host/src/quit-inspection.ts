/** Quit-time inspection of interruptible work for the Electron shell. */

import type { Context } from '@deepseek-ai/cordis'
import { hasDesktopActiveTasks } from './update-tasks.ts'

/** What quitting the Host now would affect. */
export interface DesktopQuitInspection {
  /** Work the shared update-restart check also counts: running agents, queued messages, live jobs. */
  readonly activeTasks: boolean
  /** Kept for the Desktop lifecycle protocol; reminders are not mounted in this build. */
  readonly scheduledTasks: boolean
}

/**
 * Register the quit inspector on the owning Host context.
 * @param ctx - Booted Desktop profile context; disposal makes the inspector reject.
 * @returns Inspector reporting whether interruptible work remains.
 */
export function installDesktopQuitInspection(ctx: Context): () => Promise<DesktopQuitInspection> {
  let stopped = false
  ctx.effect(() => () => { stopped = true })
  return async () => {
    if (stopped) throw new Error('desktop quit: Host is stopping')
    const agents = ctx.get('agents')
    const jobs = ctx.get('jobs')
    if (agents === undefined || jobs === undefined) throw new Error('desktop quit: task services are unavailable')
    const liveAgents = agents.list()
    const activeTasks = hasDesktopActiveTasks(liveAgents, jobs)
    return { activeTasks, scheduledTasks: false }
  }
}
