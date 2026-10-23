/**
 * The browse picking occupant (package-internal; the `./client` surface
 * exposes only the Loader exports). Same-package tests exercise it directly
 * through this module.
 */
import { createElement, useCallback, useState } from 'react'
import type { ReactElement } from 'react'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import type { Translate } from '@deepseek-ai/dsh-client-locale/client'
import type { HostObservable, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the owner contract of the directory-flow holes.
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { DirectoryBrowser } from './DirectoryBrowser.tsx'
import type { DirectoryPickerLocationInfo } from './locations.ts'

/** Injected face: the browse wire calls and copy the dialog drives (bound in apply's closure). */
export interface BrowseFlowInjected {
  /** List one directory level (absent path = the Host home directory); the signal aborts a superseded scan. */
  listDirectory: (path?: string, signal?: AbortSignal, location?: string) => Promise<DirectoryListing>
  /** Create one child directory under an existing parent. */
  createDirectory: (path: string, name: string, location?: string) => Promise<string>
  /** Adopt a path on an additional machine without invoking the local workspace callback. */
  pickLocation: (location: string, path: string) => Promise<void>
  /** Connected machine menu data, bound to a selector hook by the renderer. */
  hooks: { locations: HostObservable<readonly DirectoryPickerLocationInfo[]> }
  /** Localized dialog copy (this package's namespace). */
  t: Translate
}

/**
 * Flow occupant: adapts the hole's owner conversation onto the browser
 * dialog — a confirmed directory is the picked path, dismissal is the
 * cancellation. Browse failures (unreadable targets, create conflicts) stay
 * inside the dialog's own alert surfaces, so the owner's `onError` arm is
 * driven only for additional-machine workspace adoption failures.
 * @param props - owner conversation plus the injected browse face.
 * @returns the dialog element (renders nothing while closed).
 */
export function BrowseDirectoryFlow(props: DirectoryFlowOwnerProps & InjectFace<BrowseFlowInjected>): ReactElement {
  const locations = props.useLocations(value => value)
  const [selection, setSelection] = useState('local')
  const [picking, setPicking] = useState(false)
  const location = locations.some(item => item.id === selection) ? selection : 'local'
  const listDirectory = useCallback((path?: string, signal?: AbortSignal) =>
    props.listDirectory(path, signal, location), [props.listDirectory, location])
  const createDirectory = useCallback((path: string, name: string) =>
    props.createDirectory(path, name, location), [props.createDirectory, location])
  const onOpen = (path: string): void => {
    if (location === 'local') { props.onPicked(path); return }
    setPicking(true)
    void Promise.resolve().then(() => props.pickLocation(location, path)).then(props.onCancel, (reason: unknown) => {
      props.onError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setPicking(false) })
  }
  return createElement(DirectoryBrowser, {
    // A different machine is a different filesystem; keep the owner flow but retire its old directory view.
    key: location,
    open: props.open,
    busy: props.busy || picking,
    listDirectory,
    createDirectory,
    t: props.t,
    locations: [{ id: 'local', label: props.t('browser.local') }, ...locations],
    locationId: location,
    onLocationChange: setSelection,
    onOpen,
    onClose: props.onCancel,
  })
}
