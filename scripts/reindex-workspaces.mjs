/** After offline session migration, let upstream rebuild workspace membership on next startup. */
import { readFile, copyFile, writeFile, rename } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const path = process.argv[2] && resolve(process.argv[2])
if (!path) throw new Error('Stop the owning DSH instance, then run: node scripts/reindex-workspaces.mjs <DSH_HOME/storages/workspace.json>')
const value = JSON.parse(await readFile(path, 'utf8'))
if (value.unit?.name !== 'workspace' || value.unit.version !== 2 || !value.global || !value.tables?.workspaces) {
  throw new Error('Expected upstream workspace storage version 2; original file left unchanged')
}
const backup = `${path}.before-session-reindex-${randomUUID()}`
await copyFile(path, backup, constants.COPYFILE_EXCL)
// Keep all records, titles, pinned/archived sessions and workspace identities.
// Upstream startup resolves each session cwd and merges its membership itself.
value.global.initialized = false
const temporary = `${backup}.next`
await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
await rename(temporary, path)
console.log(`Workspace membership will be rebuilt by upstream on startup. Backup: ${backup}`)
