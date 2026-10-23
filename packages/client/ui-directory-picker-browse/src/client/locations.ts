/** Directory sources registered by the application that owns each machine connection. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** One additional machine in the workspace-directory location menu. */
export interface DirectoryPickerLocation {
  /** Unique machine identity; `local` belongs to the original workspace flow. */
  readonly id: string
  /** User-facing machine name. */
  readonly label: string
  /** List a directory, or the machine's home when path is absent. */
  readonly listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  /** Create a child directory on this machine. */
  readonly createDirectory: (path: string, name: string) => Promise<string>
  /** Adopt the selected directory on this machine; resolution closes the owning flow. */
  readonly onPicked: (path: string) => Promise<void>
}

/** JSON-only menu entry; operation callbacks stay with the owning registry. */
export type DirectoryPickerLocationInfo = Pick<DirectoryPickerLocation, 'id' | 'label'>

/** Registration surface for additional directory-browsing machines. */
export interface DirectoryPickerLocations {
  /** Current connected locations, excluding the built-in local entry. */
  readonly locations: HostObservable<readonly DirectoryPickerLocationInfo[]>
  /**
   * Register one connected machine for the caller's effect lifetime.
   * @param location - Browsing and workspace-adoption callbacks for one machine.
   * @returns Disposer removing precisely this registration.
   */
  register(location: DirectoryPickerLocation): () => void
}

/** Package-owned directory registry; components receive menu data and callbacks separately. */
export class DirectoryLocationRegistry implements DirectoryPickerLocations {
  private readonly entries = new Map<string, DirectoryPickerLocation>()
  readonly locations = createSnapshotStore<readonly DirectoryPickerLocationInfo[]>([])

  register(location: DirectoryPickerLocation): () => void {
    if (location.id === 'local' || this.entries.has(location.id)) throw new Error(`directory location already registered: ${location.id}`)
    this.entries.set(location.id, location)
    this.publish()
    return () => {
      if (this.entries.get(location.id) !== location) return
      this.entries.delete(location.id)
      this.publish()
    }
  }

  /** Read one still-connected source at the operation's start. */
  get(id: string): DirectoryPickerLocation {
    const entry = this.entries.get(id)
    if (entry === undefined) throw new Error(`directory location is disconnected: ${id}`)
    return entry
  }

  private publish(): void {
    this.locations.set([...this.entries.values()].map(({ id, label }) => ({ id, label })))
  }
}
