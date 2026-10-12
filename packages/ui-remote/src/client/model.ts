/** Remote host editor values and locale-owned validation errors. */
import type { RemoteHostConfig } from '@codexydsh/remote/types'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'

/** Editable host catalog exposed by settings. */
export interface RemoteSettings { hosts: Record<string, RemoteHostConfig | null> }

/** Detached editor values fenced by the revision at opening. */
export interface HostDraft extends RemoteHostConfig {
  name: string
  originalName?: string
  revision: number
}

/** Editor failure translated by the settings registration. */
export class DraftError extends Error {
  /** @param key - Localized field-validation key. */
  constructor(readonly key: 'invalidName' | 'invalidHost' | 'invalidProfile' | 'invalidDirectory' | 'invalidExecutable' | 'duplicate') {
    super(key)
    this.name = 'RemoteHostDraftError'
  }
}

/** Create a draft with remote launcher defaults.
 * @param revision - settings revision fencing the write.
 * @param name - existing host name.
 * @param host - existing host definition.
 * @returns independent editor values.
 */
export function draftOf(revision: number, name?: string, host?: RemoteHostConfig): HostDraft {
  return { name: name ?? '', ...(name === undefined ? {} : { originalName: name }), revision,
    host: host?.host ?? '', profile: host?.profile ?? 'codexy', directory: host?.directory ?? '',
    node: host?.node ?? 'node', dsh: host?.dsh ?? 'dsh' }
}

/** Validate and replace one non-secret host definition.
 * @param draft - editor values captured against a settings revision.
 * @returns one atomic host-definition write.
 * @throws DraftError when a field is invalid.
 */
export function draftOperations(draft: HostDraft): SettingsPathOpView[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(draft.name)) throw new DraftError('invalidName')
  if (!/^[^\s\0-][^\s\0]*$/u.test(draft.host)) throw new DraftError('invalidHost')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(draft.profile)) throw new DraftError('invalidProfile')
  if (draft.directory !== '' && (!draft.directory.startsWith('/') || /[\0\r\n]/u.test(draft.directory))) throw new DraftError('invalidDirectory')
  if (![draft.node, draft.dsh].every(value => value.trim() !== '' && !/[\0\r\n]/u.test(value))) throw new DraftError('invalidExecutable')
  return [{ op: 'set', path: ['hosts', draft.name], value: {
    host: draft.host, profile: draft.profile, directory: draft.directory, node: draft.node, dsh: draft.dsh,
  } }]
}
