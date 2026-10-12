/** Draft validation and field mutations preserving redacted MCP secrets. */
import { z } from 'zod'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'

/** Settings fields returned after Host secret redaction. */
export interface SavedServerView {
  serverName: string
  transport: 'stdio' | 'streamable-http'
  autoConnect: boolean
  command?: string
  args?: string[]
  cwd?: string
  url?: string
}

/** The MCP manager's settings section. */
export interface CatalogSettings { servers: Record<string, SavedServerView | null> }

/** Editable values and the revision captured when opening the editor. */
export interface ServerDraft {
  originalName?: string
  revision: number
  serverName: string
  transport: 'stdio' | 'streamable-http'
  autoConnect: boolean
  command: string
  args: string
  cwd: string
  url: string
  secrets: string
}

/** A field error translated by the settings contribution. */
export class DraftError extends Error {
  /** @param key - Localized field-validation key. */
  constructor(readonly key: 'invalidName' | 'invalidCommand' | 'invalidUrl' | 'invalidArgs' | 'invalidSecrets') {
    super(key)
    this.name = 'McpDraftError'
  }
}

/** Create a detached editor draft without copying secret values.
 * @param revision - Settings revision fencing the eventual save.
 * @param server - Existing public server fields; absent for a new server.
 * @returns Draft with blank write-only authentication fields.
 */
export function draftOf(revision: number, server?: SavedServerView): ServerDraft {
  return {
    revision, ...server ? { originalName: server.serverName } : {},
    serverName: server?.serverName ?? '', transport: server?.transport ?? 'stdio',
    autoConnect: server?.autoConnect ?? false, command: server?.command ?? '',
    args: JSON.stringify(server?.args ?? []), cwd: server?.cwd ?? '', url: server?.url ?? '', secrets: '',
  }
}

function parseJson<T>(text: string, schema: z.ZodType<T>, key: DraftError['key']): T {
  try { return schema.parse(JSON.parse(text)) }
  catch (_error) { throw new DraftError(key) }
}

/** Validate a draft and write only edited fields; a blank secret field preserves stored authentication.
 * @param draft - Current editor values.
 * @returns Ordered atomic settings edits preserving fields omitted by the editor.
 * @throws DraftError when an editor field is invalid.
 */
export function draftOperations(draft: ServerDraft): SettingsPathOpView[] {
  if (!/^[A-Za-z0-9_-]{1,32}$/u.test(draft.serverName)) throw new DraftError('invalidName')
  const fields: Record<string, string | boolean | string[] | Record<string, string>> = {
    serverName: draft.serverName, transport: draft.transport, autoConnect: draft.autoConnect,
  }
  if (draft.originalName === undefined) fields[draft.transport === 'stdio' ? 'env' : 'headers'] = {}
  if (draft.transport === 'stdio') {
    if (!draft.command.trim()) throw new DraftError('invalidCommand')
    fields.command = draft.command.trim()
    fields.args = parseJson(draft.args, z.array(z.string()), 'invalidArgs')
    fields.cwd = draft.cwd
  } else {
    let url: URL
    try { url = new URL(draft.url) } catch (_error) { throw new DraftError('invalidUrl') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new DraftError('invalidUrl')
    fields.url = draft.url
  }
  if (draft.secrets.trim()) fields[draft.transport === 'stdio' ? 'env' : 'headers'] =
    parseJson(draft.secrets, z.record(z.string(), z.string()), 'invalidSecrets')
  return Object.entries(fields).map(([field, value]) => ({ op: 'set', path: ['servers', draft.serverName, field], value }))
}
