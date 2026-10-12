/** Retained real compaction facts through the product codec and actual pi SDK. */
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import LlmRuntime, { type GenerateOptions } from '@codexydsh/runtime/llm'
import { RequestProviders } from '@codexydsh/bridges'
import { Session, deriveProductMessages, requestHeaderOf, snapshotProductEvents } from '@codexydsh/runtime/session'
import { decodeCodexyArtifact, encodeArtifactEvents, encodeArtifactHeader } from '../../runtime/src/persistence-codec.ts'
import { resolveProfiles } from '../src/config.ts'
import { PiAiAdapter } from '../src/adapter.ts'
import { memoryAuth } from './auth-double.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(closeMockServers)

const cassettePath = process.env.CODEXY_RESPONSES_CASSETTE
const sessionPath = process.env.CODEXY_COMPACTION_SESSION
const observationsPath = process.env.CODEXY_COMPACTION_REQUESTS

interface ArchivedRow { type: string; id?: number; data?: string; request?: { body: string } }
interface Observation { id: number; request: { body: string }; responsePrefixes?: { transactionId: number; chunkCount: number }[] }

describe('restored compaction context grouping', () => {
  it('serializes actual tx4 prepared input and the full tx5 input with the already admitted identity bijection', {
    skip: cassettePath === undefined || sessionPath === undefined || observationsPath === undefined,
  }, async () => {
    if (cassettePath === undefined || sessionPath === undefined || observationsPath === undefined) {
      throw new Error('explicit retained cassette, session and request paths required')
    }
    const artifact = await readFile(sessionPath)
    const decoded = decodeCodexyArtifact(artifact)
    expect(deepEqualJson(Buffer.from(encodeArtifactHeader(decoded.metadata) + encodeArtifactEvents(decoded.events)), artifact)).toBe(true)
    const restored = Session.fromRestore(decoded.metadata.session.id, decoded.events, decoded.metadata.session,
      decoded.metadata.inheritedEventCount, 'detached')
    const facts = snapshotProductEvents(restored)
    const compaction = facts.find(row => row.type === 'compaction/request')
    if (compaction?.type !== 'compaction/request') throw new Error('missing actual prepared compaction input')
    const before = encodeArtifactEvents(restored.snapshotEvents())
    const prepared = compaction.data.preparedInput
    const rows = (await readFile(cassettePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as ArchivedRow)
    const raw = Buffer.concat(rows.filter(row => row.type === 'chunk' && row.id === 4).map(row => Buffer.from(row.data!, 'base64')))
    const observations = (await readFile(observationsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Observation)
    const nextRecorded = JSON.parse(Buffer.from(observations[5]!.request.body, 'base64').toString()) as { input: Record<string, unknown>[] }
    const done = { type: 'message', id: 'msg_fixture_done', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'fixture response; no additional task execution' }] }
    const server = await mockServer([
      { body: raw.toString(), headers: { 'content-type': 'text/event-stream' } },
      { events: [JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: done }),
        JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: done }),
        JSON.stringify({ type: 'response.completed', response: { id: 'resp_fixture_done', status: 'completed', output: [done],
          usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } })] },
    ])
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(RequestProviders)
      const profiles = resolveProfiles({ [prepared.provider]: { api: 'openai-responses', baseURL: server.url, transport: 'sse',
        backendHostedTools: ['web_search'], backendWebSearchExternalAccess: true, compat: { supportsDeveloperRole: true, supportsOpenAIGrammarTools: true },
        models: [{ id: prepared.model, contextWindow: 32768, maxTokens: 8192, reasoningEfforts: { xhigh: 'xhigh' } }] } })
      ctx.codexyRequests.registerAdapter([prepared.provider], new PiAiAdapter({ profiles: () => profiles,
        resolveApiKey: () => Promise.resolve('fixture-key'), auth: memoryAuth() }))
      await assemble(ctx, prepared)
      const preparedBody = server.requests[0] as { input: unknown[] }
      const originalPreparedBody = JSON.parse(Buffer.from(observations[4]!.request.body, 'base64').toString()) as { input: unknown[] }
      expect(deepEqualJson(preparedBody.input, originalPreparedBody.input)).toBe(true)

      const header = requestHeaderOf(restored)
      if (header === undefined) throw new Error('missing retained next-request config')
      const messages = deriveProductMessages(restored)
      const sourceBefore = structuredClone(messages)
      const next: GenerateOptions = { ...header.config, messages, sessionId: restored.id }
      await assemble(ctx, next)
      const input = (server.requests[1] as { input: Record<string, unknown>[] }).input
      expect(input).toHaveLength(5)
      expect(input.map(item => ({ type: item['type'], role: item['role'], count: (item['content'] as unknown[]).length })))
        .toEqual([{ type: 'message', role: 'developer', count: 1 }, { type: 'message', role: 'developer', count: 2 },
          { type: 'message', role: 'user', count: 1 }, { type: 'message', role: 'user', count: 1 }, { type: 'message', role: 'user', count: 1 }])
      expect(input[1]!['id']).toBe(nextRecorded.input[1]!['id'])
      const initial = JSON.parse(Buffer.from(observations[0]!.request.body, 'base64').toString()) as { input: Record<string, unknown>[] }
      expect(input[1]!['id']).not.toBe(initial.input[1]!['id'])

      // Reuse the existing comparator unchanged, after admitting the prior
      // five requests and delivered prefixes. Substitute only this fixture's
      // actual SDK input into the retained next-request envelope: every field
      // of that input, not a text-only projection, participates in comparison.
      const verifier = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import {readFile} from 'node:fs/promises';
        import {captureRequest,createRequestMatcher,readCassette,TRACE_IDENTITY_ENVELOPE_POLICY} from ${JSON.stringify(import.meta.resolve('dsh-parity/src/cassette.mjs'))};
        let bytes='';for await(const part of process.stdin)bytes+=part;
        const {cassettePath,observationsPath,input}=JSON.parse(bytes);
        const cassette=await readCassette(cassettePath);
        const observations=(await readFile(observationsPath,'utf8')).trim().split('\\n').map(JSON.parse);
        const matcher=createRequestMatcher({traceIdentityPolicy:TRACE_IDENTITY_ENVELOPE_POLICY});
        let mismatch;
        for(let index=0;index<6;index++){
          const observation=observations[index];
          for(const prefix of observation.responsePrefixes??[])matcher.observeResponsePrefix(cassette.transactions[prefix.transactionId],prefix.chunkCount);
          let actual=observation.request;
          if(index===5){const body=JSON.parse(Buffer.from(actual.body,'base64').toString());body.input=input;
            actual=captureRequest(actual.method,actual.target,actual.headers,Buffer.from(JSON.stringify(body)));}
          mismatch=matcher.match(cassette.transactions[index].request,actual);
          if(mismatch)break;
        }
        process.stdout.write(JSON.stringify({mismatch:mismatch??null,matched:matcher.report().matchedCount}));
        if(mismatch)process.exitCode=1;
      `], { input: JSON.stringify({ cassettePath, observationsPath, input }), encoding: 'utf8', timeout: 30000 })
      expect(verifier.status, verifier.stderr + verifier.stdout).toBe(0)
      expect(JSON.parse(verifier.stdout)).toEqual({ mismatch: null, matched: 6 })
      expect(messages).toEqual(sourceBefore)
      expect(encodeArtifactEvents(restored.snapshotEvents())).toBe(before)
      const restoredAgain = decodeCodexyArtifact(Buffer.from(encodeArtifactHeader(decoded.metadata) + encodeArtifactEvents(decoded.events)))
      expect(restoredAgain.events).toEqual(decoded.events)
    } finally { await ctx.fiber.dispose() }
  })
})
