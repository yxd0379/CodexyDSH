/** Upstream directory browser, with its operations routed to the selected location. */
import { useCallback, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { RemoteSettings } from './model.ts'
import { DirectoryBrowser } from './directory/DirectoryBrowser.tsx'

export interface WorkspaceDirectoryInjected {
  hooks: { locations: ConfigForm<RemoteSettings> }
  listDirectory(host: string, path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  createDirectory(host: string, path: string, name: string): Promise<string>
  addRemote(host: string, path: string, signal: AbortSignal): Promise<void>
  t: TranslateNS<'remote-directory-browser'>
}
type Props = PropsRuntime<'sidebar.workspaces.directoryFlow'> & InjectFace<WorkspaceDirectoryInjected>

function DirectoryDialog({ useLocations, onPicked, onCancel, busy: ownerBusy, listDirectory, createDirectory, addRemote, t }: Props) {
  const hosts = useLocations(snapshot => snapshot.value?.hosts)
  const [location, setLocation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<AbortController>()
  const close = (): void => { pending.current?.abort(); onCancel() }
  const list = useCallback((path?: string, signal?: AbortSignal) => listDirectory(location, path, signal), [listDirectory, location])
  const create = useCallback((path: string, name: string) => createDirectory(location, path, name), [createDirectory, location])
  const submit = async (path: string): Promise<void> => {
    if (!location) { onPicked(path); return }
    const controller = new AbortController()
    pending.current = controller
    setBusy(true); setError('')
    try {
      await addRemote(location, path, controller.signal)
      if (!controller.signal.aborted) onCancel()
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure))
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return <DirectoryBrowser key={location} open busy={busy || ownerBusy} t={t}
    locations={Object.entries(hosts ?? {}).flatMap(([id, host]) => host ? [{ id, label: host.host }] : [])}
    location={location} onLocationChange={value => { setLocation(value); setError('') }}
    listDirectory={list} createDirectory={create} onOpen={path => { void submit(path) }}
    onClose={close} adoptionError={error} />
}

export function WorkspaceDirectoryFlow(props: Props) {
  return props.open ? <DirectoryDialog {...props} /> : null
}
