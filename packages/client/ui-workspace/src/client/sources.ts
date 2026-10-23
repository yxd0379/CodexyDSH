/** Plain sidebar projections and actions owned by another Host or Workspace source. */
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GroupNode } from './tree.ts'
import type { StartSessionOptions } from './navigation.ts'

/** Source-owned visible groups; ids are meaningful only inside this source. */
export interface WorkspaceSourceSnapshot {
  /** Keep loaded Session rows while collapsed; the browser applies expansion, title search, and archive visibility. */
  readonly groups: readonly GroupNode[]
  readonly selectedSessionId?: SessionId
  readonly home?: string
}

/** Every action stays with the source that owns the row, never the local Controllers. */
export interface WorkspaceSourceActions {
  toggleWorkspace(groupKey: string): void
  openSession(sessionId: SessionId): void
  /** Start on this source without losing any explicit draft or Agent preset choices. */
  startSession(workspaceId: WorkspaceId | undefined, options?: StartSessionOptions): void
  renameWorkspace(group: GroupNode): void
  archiveWorkspace(group: GroupNode): void
  showWorkspaceDetails(group: GroupNode): void
  renameSession(sessionId: SessionId, currentTitle: string): void
  archiveSession(sessionId: SessionId): void
  unarchiveSession(sessionId: SessionId): void
}

/** Effect-owned native sidebar contribution; archives and restoration remain source policy. */
export interface WorkspaceSource {
  readonly id: string
  readonly label: string
  readonly state: HostObservable<WorkspaceSourceSnapshot>
  readonly actions: WorkspaceSourceActions
}

/** A reactive display cut, with the contributing source identity attached. */
export interface WorkspaceSourceView extends WorkspaceSourceSnapshot {
  readonly id: string
  readonly label: string
}
