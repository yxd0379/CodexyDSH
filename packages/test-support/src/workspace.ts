/** Temporary workspaces whose containment tests cannot inherit temporary write grants. */
import { homedir } from 'node:os'
import { isAbsolute, relative, sep } from 'node:path'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'

/** Use a private atomic test directory under home, outside platform temporary roots. */
export function outsideTempWorkspaceParent(): string { return homedir() }
/** Refuse fixtures whose expected containment denial would be bypassed by temp grants. */
export function assertWorkspaceOutsideTemp(cwd: string): void {
  const path = canonicalPath(cwd)
  for (const root of writableRoots({ mode: 'workspace-write', workspaceRoot: '/tmp' })) {
    const suffix = relative(root, path)
    if (suffix === '' || suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix)) {
      throw new Error('containment fixture must be outside temporary writable roots')
    }
  }
}
