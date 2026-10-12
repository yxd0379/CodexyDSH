/** Runs only in a temporary home with a separately resolved public runtime. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendProductEvent, appendProductRecord, deriveProductMessages, interruptedTurnClosers, requestHeaderOf, snapshotProductEvents } from './session.js'
import { decodeCodexyArtifact, encodeArtifactHeader, encodeArtifactEvents } from './persistence-codec.js'

const require = createRequire(import.meta.url)
const version = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-session/package.json'), 'utf8')).version
const id = SessionId('compatibility-facts')
const header = { version: 4, id, createdAt: 1000, isSeeded: false }
const session = Session.create(id, undefined, header)
appendProductEvent(session, 'runtime/feature', { name: 'native-request-header', version: 1 })
session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'model-visible input' }] }), { surfaceOp: 'append' })
session.append('turn/start', { turn: 1 })
session.append('step/start', { turn: 1, step: 1 })
appendProductEvent(session, 'request/header', { reason: 'initial', header: {
  config: { provider: 'codex', model: 'test', codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'auto' } },
  tools: [{ name: 'native', kind: 'freeform', description: 'native wire input', format: { type: 'grammar', syntax: 'regex', definition: '.*' } }],
} })
const before = deriveProductMessages(session)
const diagnostic = { turn: 1, step: 1, timing: { phase: 'http-start', time: 1234 } }
appendProductRecord(session, 'llm/request-timing', diagnostic)
diagnostic.timing.time = 9999
assert.deepEqual(deriveProductMessages(session), before)
assert.equal(snapshotProductEvents(session).at(-1).data.timing.time, 1234)
const tail = session.snapshotEvents().at(-1)
assert.equal(tail.type, version === '0.2.0-rc.2' ? 'codexy/fact' : 'plugin:codexy/runtime')
assert.equal(tail.ignorable, version === '0.2.0-rc.2' ? undefined : true)
const count = session.seq
assert.throws(() => appendProductRecord(session, 'llm/request-timing', { invalid: undefined }))
assert.throws(() => appendProductEvent(session, 'runtime/import', { invalid: undefined }))
assert.equal(session.seq, count)
// An incomplete turn is intentionally persisted: recovery must retain its facts.
const metadata = { kind: 'codexy-session', version: 1, session: header, inheritedEventCount: SessionLogOffset(0) }
await writeFile('session.codexy.jsonl', encodeArtifactHeader(metadata) + encodeArtifactEvents(session.snapshotEvents()))
const artifact = decodeCodexyArtifact(await readFile('session.codexy.jsonl'))
const restored = Session.fromRestore(id, artifact.events, header, artifact.metadata.inheritedEventCount, 'detached')
assert.deepEqual(restored.snapshotEvents().slice(0, count), session.snapshotEvents())
assert.equal(restored.snapshotEvents().at(-1).type, 'session/end-seed')
assert.deepEqual(deriveProductMessages(restored), before)
assert.deepEqual(requestHeaderOf(restored), requestHeaderOf(session))
assert.equal(requestHeaderOf(restored).tools[0].kind, 'freeform')
assert.equal(requestHeaderOf(restored).config.codexfulResponses.omitDefaultMaxTokens, true)
assert.equal(snapshotProductEvents(restored).find(event => event.type === 'llm/request-timing').data.timing.time, 1234)
assert.deepEqual(interruptedTurnClosers(restored.snapshotEvents()).map(event => event.type), ['step/end', 'turn/end'])
assert.throws(() => validateStoredEvents(header, [...restored.snapshotEvents()]), /unknown to this harness/)
process.stdout.write(JSON.stringify({ version, restored: true, rejectedInvalidJson: true, modelInputUnchanged: true }))
