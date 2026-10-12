/** Codex Responses Lite request conversion for explicitly opted-in routes. */
import { createHash } from 'node:crypto'
import { LlmError } from '@codexydsh/runtime/llm'
import type { ToolSchema } from '@codexydsh/runtime/llm'

const OID_NAMESPACE = '6ba7b812-9dad-11d1-80b4-00c04fd430c8'
const UUID_SUFFIX = /(?:^|-)session-([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i

/** Model entries selecting Lite in the pinned Codex models.json. */
const SUPPORTED_MODELS = new Set([
  'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
])

/**
 * Select Lite only for a model with its pinned prompt and an explicit provider-route declaration.
 * @param routeMode - provider's validated Lite tool capability.
 * @param model - exact request model slug and protocol.
 * @returns whether this route can use the Lite wire form.
 */
export function supportsCodexResponsesLite(
  routeMode: 'flat' | 'namespaced' | undefined,
  model: { id: string; api: string },
): boolean {
  return routeMode !== undefined && model.api === 'openai-responses' && SUPPORTED_MODELS.has(model.id)
}

function uuidBytes(value: string): Buffer {
  return Buffer.from(value.replaceAll('-', ''), 'hex')
}

function uuidV5(namespace: string, value: string): string {
  const bytes = createHash('sha1').update(uuidBytes(namespace)).update(value, 'utf8').digest().subarray(0, 16)
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6)
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8)
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Group namespace tools in first-seen order, with flat tools first in ordinary Responses. */
function groupNamespaceTools(tools: unknown[], schemas: readonly ToolSchema[], lite: boolean): unknown[] {
  if (tools.length !== schemas.length) {
    throw new LlmError('pi-ai changed the Codex Responses tool list', 'UNSUPPORTED_OPTION')
  }
  const groups = new Map<string, { type: 'namespace'; name: string; description: string; tools: Record<string, unknown>[] }>()
  const names = new Map<string, Set<string>>()
  const result: unknown[] = []
  for (const [index, schema] of schemas.entries()) {
    const tool = tools[index]
    if (!isRecord(tool) || tool['type'] !== (schema.kind === 'freeform' ? 'custom' : 'function') || tool['name'] !== schema.name) {
      throw new LlmError('pi-ai changed the Codex Responses tool order', 'UNSUPPORTED_OPTION')
    }
    if (!lite && schema.namespace === undefined) {
      result.push(tool)
      continue
    }
    const name = schema.namespace?.name ?? 'functions'
    const description = schema.namespace?.description ?? ''
    const toolName = schema.namespace?.toolName ?? schema.name
    if (name.length === 0 || toolName.length === 0) {
      throw new LlmError('Codex Responses namespace and tool names must be non-empty', 'UNSUPPORTED_OPTION')
    }
    let group = groups.get(name)
    if (group === undefined) {
      group = { type: 'namespace', name, description, tools: [] }
      groups.set(name, group)
      names.set(name, new Set())
      result.push(group)
    } else if (description.length > 0 && group.description.length > 0 && group.description !== description) {
      throw new LlmError(`Codex Responses namespace "${name}" has conflicting descriptions`, 'UNSUPPORTED_OPTION')
    } else if (description.length > 0) {
      group.description = description
    }
    const groupNames = names.get(name)
    if (groupNames === undefined) throw new Error('Codex Responses namespace grouping lost its tool names')
    if (groupNames.has(toolName)) {
      throw new LlmError(`Codex Responses namespace "${name}" repeats tool "${toolName}"`, 'UNSUPPORTED_OPTION')
    }
    groupNames.add(toolName)
    group.tools.push({ ...tool, name: toolName })
  }
  return lite ? result : [
    ...result.filter(tool => !isRecord(tool) || tool['type'] !== 'namespace'),
    ...groups.values(),
  ]
}

/**
 * Present namespaced functions in an ordinary Responses tool list.
 * @param standard - Codexful ordinary Responses request body.
 * @param schemas - internal tool identities in request order.
 * @returns request with namespace objects beside flat functions.
 */
export function ordinaryNamespaceToolsPayload(
  standard: Record<string, unknown>,
  schemas: readonly ToolSchema[],
): Record<string, unknown> {
  const tools = standard['tools']
  if (!Array.isArray(tools)) {
    throw new LlmError('Codex Responses requires a tool list for namespaces', 'UNSUPPORTED_OPTION')
  }
  // Backend-hosted search has no local executor/schema entry. Preserve its
  // declaration separately while validating every local function/custom tool
  // against its captured schema; a local function named web_search stays local.
  const hosted = tools.filter((tool: unknown) => isRecord(tool) && tool['type'] === 'web_search')
  const local = tools.filter((tool: unknown) => !isRecord(tool) || tool['type'] !== 'web_search')
  return { ...standard, tools: [...groupNamespaceTools(local, schemas, false), ...hosted] }
}

/**
 * Move standard Responses instructions and function/custom tools into Codex Lite prefix items.
 * Prefix IDs are rebuilt from the Session identity and visible content for every retry.
 * @param standard - already validated Codexful ordinary Responses payload.
 * @param systemPrompt - durable base instructions removed from the leading system message.
 * @param sessionId - Session identity used to derive stable prefix IDs.
 * @param toolSchemas - model-visible schemas used to preserve internal names outside the wire payload.
 * @param grouping - Lite tool form supported by this route.
 * @returns a detached Responses Lite request body.
 */
export function responsesLitePayload(
  standard: Record<string, unknown>,
  systemPrompt: string | undefined,
  sessionId: string | undefined,
  toolSchemas: readonly ToolSchema[],
  grouping: 'flat' | 'namespaced',
): Record<string, unknown> {
  if (sessionId === undefined || sessionId.length === 0) {
    throw new LlmError('Codex Responses Lite requires a Session id for stable prefix items', 'UNSUPPORTED_OPTION')
  }
  if (!Array.isArray(standard['input']) || standard['instructions'] !== (systemPrompt ?? '')) {
    throw new LlmError('Codexful Responses input changed before Lite conversion', 'UNSUPPORTED_OPTION')
  }
  const input: unknown[] = standard['input'].map((item: unknown): unknown => item)
  const rawTools = standard['tools'] === undefined ? [] : standard['tools']
  if (!Array.isArray(rawTools) || rawTools.some(tool => !isRecord(tool)
    || (tool['type'] !== 'function' && tool['type'] !== 'custom') || typeof tool['name'] !== 'string')) {
    throw new LlmError('Codex Responses Lite requires function or custom tools', 'UNSUPPORTED_OPTION')
  }
  const tools = grouping === 'namespaced' ? groupNamespaceTools(rawTools, toolSchemas, true) : rawTools
  if (input.some(item => isRecord(item) && item['type'] === 'additional_tools')) {
    throw new LlmError('pi-ai already supplied Responses additional_tools', 'UNSUPPORTED_OPTION')
  }
  const threadId = UUID_SUFFIX.exec(sessionId)?.[1] ?? sessionId
  const prefixNamespace = uuidV5(OID_NAMESPACE, threadId)
  const prefix: unknown[] = [{
    type: 'additional_tools',
    id: `at_${uuidV5(prefixNamespace, JSON.stringify(tools))}`,
    role: 'developer',
    tools,
  }]
  if (systemPrompt !== undefined && systemPrompt.length > 0) {
    prefix.push({
      type: 'message',
      id: `msg_${uuidV5(prefixNamespace, systemPrompt)}`,
      role: 'developer',
      content: [{ type: 'input_text', text: systemPrompt }],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: ['model.base_instructions'],
      },
    })
  }
  const { instructions: _instructions, tools: _tools, ...request } = standard
  const reasoning = isRecord(request['reasoning']) ? request['reasoning'] : {}
  return {
    ...request,
    input: [...prefix, ...input],
    parallel_tool_calls: false,
    reasoning: { ...reasoning, context: 'all_turns' },
  }
}
