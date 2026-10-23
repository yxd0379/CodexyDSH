/** Product browser test fixtures use the public DSH services and React subscriptions. */
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector.js'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
export { stubConfigForm } from './config-form.ts'
export type { StubConfigForm } from './config-form.ts'
export { makeTranslate } from './translate.ts'
export { FixtureSession, TestSessions } from './sessions.ts'
export { sessionSnapshot, chatSnapshot, conversationSnapshot, workspaceSnapshot } from './fixtures.ts'
export type { SessionFixture, SessionFixtureSnapshot, SessionBehaviorOverrides, Stabilizer, FixtureSnapshot } from './fixtures.ts'
export { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** Bind a snapshot selector to React's external store lifecycle.
 * @param source - Subscription and immutable snapshot source.
 * @returns A selector hook whose selected value changes with the source.
 */
export function bindSnapshotSelector<T>(source: HostObservable<T>): SnapshotSelectorHook<T> {
  const subscribe = (listener: () => void): (() => void) => source.subscribe(listener)
  const snapshot = (): T => source.getSnapshot()
  return function useSelector<S>(selector: (value: T) => S, equal?: (a: S, b: S) => boolean): S {
    return useSyncExternalStoreWithSelector(subscribe, snapshot, undefined, selector, equal)
  }
}

export { TestRemote } from './remote.ts'
export { TestWorkspaces } from './workspaces.ts'
export { usePinnedBrowserLanguages } from './locale-env.ts'
export { SlotTestRuntime, TestRoot } from './slot-runtime.ts'
export type { SlotView, FeatureHandle, SlotTestRenderOptions } from './slot-runtime.ts'
export { domSnapshotSerializer, registerDomSnapshotSerializer } from './snapshot.ts'
export type { UseSession } from '@deepseek-ai/dsh-client-ui-session/client'

export { commonEn, commonZh } from './common-locales.ts'
export { settingsFixture } from './settings.ts'
