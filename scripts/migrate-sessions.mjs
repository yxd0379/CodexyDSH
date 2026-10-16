/** One-time session migration. Sources are copied, never changed or removed. */
import { parseArgs } from 'node:util'
import { cp, mkdtemp, readdir, realpath, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { Session } from '@deepseek-ai/dsh-session'
import { convertLegacySession } from './legacy-session-conversion.ts'
import { openPluginMigration } from './migrate-plugin-state.ts'

const { values } = parseArgs({ options: {
  source: { type: 'string' }, target: { type: 'string' },
  'storage-target': { type: 'string' },
  check: { type: 'boolean', default: false },
} })
if (!values.source || (!values.target && !values.check)) {
  throw new Error('Usage: node --import tsx scripts/migrate-sessions.mjs --source <backup sessions directory> [--check | --target <new sessions directory>]')
}
const source = await realpath(values.source)
const target = values.target === undefined ? undefined : resolve(values.target)
if (target === source) throw new Error('Use a separate target; the source must remain untouched')

// The native backend rejects legacy flat files in a project directory. Stage
// only native project directories, so unrelated old product stores cannot hide
// otherwise valid upstream sessions. Keep this copy for inspection afterwards.
const staging = await mkdtemp(join(tmpdir(), 'dsh-session-migration-'))
const entries = await readdir(source, { withFileTypes: true })
const skipped = []
for (const entry of entries) {
  if (entry.isDirectory() && entry.name.startsWith('--')) {
    await cp(join(source, entry.name), join(staging, entry.name), { recursive: true, errorOnExist: true, force: false })
  } else skipped.push(entry.name)
}
const input = new Context()
const output = new Context()
const storageTarget = values['storage-target'] ?? join(staging, 'plugin-state')
const pluginState = values.check ? undefined : await openPluginMigration(storageTarget)
const report = { staging, storageTarget, checked: 0, migrated: 0, legacyChecked: 0, legacyMigrated: 0, skipped, failures: [] }
try {
  await input.plugin(JsonlSessionPersistence, { root: staging })
  if (!values.check) await output.plugin(JsonlSessionPersistence, { root: target })
  for (const snapshot of await input.sessionPersistence.list()) {
    let reader
    let writer
    try {
      reader = await input.sessionPersistence.open(snapshot.header.id, 'read')
      const read = await reader.read()
      const restored = Session.fromRestore(reader.id, read.events, reader.header,
        reader.inheritedEventCount, read.eventState)
      const messages = restored.deriveMessages()
      report.checked++
      if (!values.check) {
        // Native create refuses an existing id. Never overwrite or merge logs.
        writer = await output.sessionPersistence.create(reader.header,
          { inheritedEventCount: reader.inheritedEventCount })
        await writer.append(read.events)
        await writer.flush()
        await writer.close()
        writer = undefined
        const verification = await output.sessionPersistence.open(reader.id, 'read')
        try {
          const written = await verification.read()
          const reopened = Session.fromRestore(verification.id, written.events,
            verification.header, verification.inheritedEventCount, written.eventState)
          if (JSON.stringify(reopened.deriveMessages()) !== JSON.stringify(messages)) {
            throw new Error('Migrated model history differs from the source')
          }
        } finally { await verification.close() }
        report.migrated++
      }
    } catch (error) {
      report.failures.push({ id: snapshot.header.id, error: String(error) })
    } finally {
      await writer?.close()
      await reader?.close()
    }
  }
  // Old product containers are converted only here, never during application startup.
  for (const folder of ['codexy', 'codexful']) {
    if (!entries.some(entry => entry.isDirectory() && entry.name === folder)) continue
    for (const name of await readdir(join(source, folder), { recursive: true })) {
      if (name.split('/').some(part => part.startsWith('.'))) continue
      if (!name.endsWith('.codexy.jsonl') && !/session\.v5\.jsonl(?:\.zstd|\.zst)?$/.test(name)) continue
      const path = join(source, folder, name)
      let writer
      try {
        const converted = convertLegacySession(await readFile(path), path)
        report.legacyChecked++
        // An audit export, not a runtime compatibility store. Originals remain intact.
        await writeFile(join(staging, `${converted.header.id}.private-records.json`),
          JSON.stringify(converted.privateRecords), { flag: 'wx', mode: 0o600 })
        if (!values.check) {
          writer = await output.sessionPersistence.create(converted.header,
            { inheritedEventCount: converted.inheritedEventCount })
          await writer.append(converted.events)
          await writer.flush()
          await writer.close()
          writer = undefined
          const verification = await output.sessionPersistence.open(converted.header.id, 'read')
          try {
            const written = await verification.read()
            const restored = Session.fromRestore(verification.id, written.events, verification.header,
              verification.inheritedEventCount, written.eventState)
            if (JSON.stringify(restored.deriveMessages()) !== JSON.stringify(converted.messages)) {
              throw new Error('Native writer round-trip changed the conversation')
            }
          } finally { await verification.close() }
          await pluginState.write(converted.header.id, converted.privateRecords)
          report.legacyMigrated++
        }
      } catch (error) {
        report.failures.push({ path, error: String(error) })
      } finally { await writer?.close() }
    }
  }
} finally {
  await pluginState?.close()
  await input.fiber.dispose()
  await output.fiber.dispose()
}
console.log(JSON.stringify(report, null, 2))
if (report.failures.length) process.exitCode = 1
