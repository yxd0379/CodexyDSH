// @vitest-environment jsdom
/** Machine selection reuses the native browser and never creates a local workspace for a remote path. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import { BrowseDirectoryFlow } from '../src/client/flow.ts'
import { DirectoryLocationRegistry } from '../src/client/locations.ts'

afterEach(cleanup)

function listing(path: string): DirectoryListing {
  return { path, home: path, entries: [], crumbs: [{ name: path, path, hidden: false }], truncated: false }
}

it('registers only connected machine metadata and removes its effect contribution', () => {
  const registry = new DirectoryLocationRegistry()
  const source = { id: 'ascend', label: 'Ascend', listDirectory: vi.fn(async () => listing('/remote')), createDirectory: vi.fn(async () => '/remote/new'), onPicked: vi.fn(async () => {}) }
  const dispose = registry.register(source)
  expect(registry.locations.getSnapshot()).toEqual([{ id: 'ascend', label: 'Ascend' }])
  expect(registry.get('ascend')).toBe(source)
  dispose()
  expect(registry.locations.getSnapshot()).toEqual([])
  expect(() => registry.get('ascend')).toThrow('disconnected')
})

it('selects a remote home, pins the flow during adoption, and closes without invoking local adoption', async () => {
  const registry = new DirectoryLocationRegistry()
  const done = Promise.withResolvers<void>()
  const remotePick = vi.fn(() => done.promise)
  registry.register({ id: 'ascend', label: 'Ascend', listDirectory: async () => listing('/remote/home'), createDirectory: async () => '/remote/new', onPicked: remotePick })
  const onPicked = vi.fn()
  const onCancel = vi.fn()
  const onError = vi.fn()
  const listDirectory = vi.fn(async (_path?: string, _signal?: AbortSignal, id = 'local') => id === 'local' ? listing('/local/home') : registry.get(id).listDirectory())
  render(<BrowseDirectoryFlow
    open busy={false} onPicked={onPicked} onCancel={onCancel} onError={onError}
    listDirectory={listDirectory}
    createDirectory={vi.fn(async () => '')}
    pickLocation={(id, path) => registry.get(id).onPicked(path)}
    useLocations={bindSnapshotSelector(registry.locations)}
    t={key => key}
  />)
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: 'browser.open' }).disabled).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: 'browser.location' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Ascend' }))
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: 'browser.open' }).disabled).toBe(false) })
  expect(listDirectory).toHaveBeenCalledWith(undefined, expect.any(AbortSignal), 'ascend')
  fireEvent.click(screen.getByRole('button', { name: 'browser.open' }))
  await waitFor(() => { expect(remotePick).toHaveBeenCalledWith('/remote/home') })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'browser.location' }).disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'browser.cancel' }).disabled).toBe(true)
  expect(onPicked).not.toHaveBeenCalled()
  await act(async () => { done.resolve(); await done.promise })
  await waitFor(() => { expect(onCancel).toHaveBeenCalledOnce() })
  expect(onError).not.toHaveBeenCalled()
})
