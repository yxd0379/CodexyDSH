/** Same-origin frame messages; Session identities remain scoped to their sending frame. */
import z from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import type { GroupNode, SessionNode, WorkspaceSourceSnapshot } from '@deepseek-ai/dsh-client-ui-workspace/client'

/** Electron's privileged standard scheme can expose an opaque serialized location origin. */
export function acceptsFrameOrigin(origin: string, location: Pick<Location, 'origin' | 'protocol' | 'host'>): boolean {
  if (location.protocol === 'dsh-app:' && location.host === 'app') {
    return origin === location.origin || origin === 'dsh-app://app'
  }
  return location.origin !== 'null' && origin === location.origin
}

/** Only the exact Window already checked by the receiver is addressed for opaque Desktop origins. */
export function frameTargetOrigin(location: Pick<Location, 'origin' | 'protocol' | 'host'>): string {
  return location.origin === 'null' && location.protocol === 'dsh-app:' && location.host === 'app'
    ? '*' : location.origin
}

const sessionId = z.string().min(1).transform(value => value as SessionId)
const workspaceId = z.string().min(1).transform(value => value as WorkspaceId)
const startOptions = z.object({ prompt: z.string().optional(), clearPreviousDraft: z.boolean().optional(), agentPreset: z.string().optional() })
  .transform(({ prompt, clearPreviousDraft, agentPreset }) => ({
    ...(prompt === undefined ? {} : { prompt }), ...(clearPreviousDraft === undefined ? {} : { clearPreviousDraft }),
    ...(agentPreset === undefined ? {} : { agentPreset }),
  }))
const session: z.ZodType<SessionNode> = z.object({
  id: sessionId, title: z.string(), blank: z.boolean(), running: z.boolean(),
  runningSubagentCount: z.number().int().nonnegative(), completed: z.boolean(),
  pinned: z.boolean(), archived: z.boolean(), updatedAt: z.number(),
  pendingInteraction: z.enum(['approval', 'plan-review', 'question']).optional(),
}).transform(({ pendingInteraction, ...row }) => ({
  ...row, ...(pendingInteraction === undefined ? {} : { pendingInteraction }),
}))
const group: z.ZodType<GroupNode> = z.object({
  key: z.string(), workspaceId: workspaceId.optional(), cwd: z.string().optional(),
  createdAt: z.number().optional(), label: z.string(), sessionCount: z.number().int().nonnegative(),
  expanded: z.boolean(), containsCurrent: z.boolean(), sessions: z.array(session),
}).transform(row => ({ ...row, workspaceId: row.workspaceId, cwd: row.cwd, createdAt: row.createdAt }))
/** Complete sidebar metadata from a native remote Client, never Session log contents. */
export const snapshotSchema: z.ZodType<WorkspaceSourceSnapshot> = z.object({
  groups: z.array(group), selectedSessionId: sessionId.optional(), home: z.string().optional(),
}).transform(({ selectedSessionId, home, ...snapshot }) => ({ ...snapshot,
  ...(selectedSessionId === undefined ? {} : { selectedSessionId }),
  ...(home === undefined ? {} : { home }),
}))
const directoryEntry = z.object({ name: z.string(), path: z.string(), hidden: z.boolean() })
/** Directory listing returned by the selected remote Host. */
export const directorySchema: z.ZodType<DirectoryListing> = z.object({
  path: z.string(), home: z.string(), crumbs: z.array(directoryEntry),
  entries: z.array(directoryEntry), truncated: z.boolean(),
})
/** Navigation and directory operations accepted by one native child Client. */
export const commandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('refresh') }),
  z.object({ kind: z.literal('settings') }),
  z.object({ kind: z.literal('open'), sessionId }),
  z.object({ kind: z.literal('start'), workspaceId: workspaceId.optional(), options: startOptions.optional() }),
  z.object({ kind: z.literal('renameWorkspace'), workspaceId, title: z.string() }),
  z.object({ kind: z.literal('renameSession'), sessionId, title: z.string() }),
  z.object({ kind: z.literal('archiveSession'), sessionId }),
  z.object({ kind: z.literal('unarchiveSession'), sessionId }),
  z.object({ kind: z.literal('listDirectory'), path: z.string().optional() }),
  z.object({ kind: z.literal('createDirectory'), path: z.string(), name: z.string() }),
  z.object({ kind: z.literal('createWorkspace'), path: z.string() }),
])
export type FrameCommand = z.infer<typeof commandSchema>
/** Incoming command envelope. */
export const requestSchema = z.object({
  source: z.literal('codexydsh-parent'), id: z.string().min(1), frameId: z.string().min(1).optional(), command: commandSchema,
})
/** Child snapshots and operation receipts. */
export const responseSchema = z.union([
  z.object({ source: z.literal('codexydsh-child'), frameId: z.string().min(1), kind: z.literal('snapshot'), value: snapshotSchema }),
  z.object({ source: z.literal('codexydsh-child'), frameId: z.string().min(1), kind: z.literal('result'), id: z.string().min(1),
    ok: z.literal(true), value: z.unknown() }),
  z.object({ source: z.literal('codexydsh-child'), frameId: z.string().min(1), kind: z.literal('result'), id: z.string().min(1),
    ok: z.literal(false), error: z.string() }),
])
