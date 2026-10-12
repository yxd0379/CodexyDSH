/** Product-owned declaration order for the explicit Codex 0.162.1 wire profile.
 * Source: openai/codex 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d,
 * core/src/tools/spec_plan.rs (Git blob 7e2213456dcb0e5b2784f848c0fca061e7c2e677,
 * SHA256 db040c0c07160af64bebd5a7a5071658cb7ff58db341edd70e2795958b1d07f3).
 * The registry preserves insertion order, namespaces retain their first slot,
 * children are sorted by Rust str.cmp, and hosted specs follow local specs.
 * The known sequence is independently observed in all nine non-compaction V5
 * requests (cassette SHA256 df0fa6c61b5736e89b91058791b6d4d467e393826ecbbc8c5a2da7faca0ee2f8).
 * This sorts declarations only: it adds/removes no capability or schema field.
 */
import { Buffer } from 'node:buffer'

const localOrder = ['exec_command', 'write_stdin', 'request_user_input', 'view_image',
  'multi_agent_v1', 'get_goal', 'create_goal', 'update_goal'] as const

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function rank(tool: unknown): number {
  if (!object(tool)) return localOrder.length
  if (tool['type'] === 'web_search') return localOrder.length + 1
  if (tool['type'] !== 'function' && tool['type'] !== 'custom' && tool['type'] !== 'namespace') return localOrder.length
  const name = tool['name']
  const index = localOrder.findIndex(known => known === name)
  // A function named multi_agent_v1 is not the native namespace (and vice versa).
  return index < 0 || (tool['type'] === 'namespace') !== (name === 'multi_agent_v1') ? localOrder.length : index
}
function orderedNamespace(tool: unknown): unknown {
  if (!object(tool) || tool['type'] !== 'namespace' || !Array.isArray(tool['tools'])) return tool
  const children = tool['tools'] as unknown[]
  // Unknown/malformed children retain their slots; valid Function/Custom names
  // follow the pinned merge_into_namespaces UTF-8 lexical ordering.
  const named = (child: unknown): child is Record<string, unknown> & { name: string } => object(child)
    && (child['type'] === 'function' || child['type'] === 'custom') && typeof child['name'] === 'string'
  const ordered = children.filter(named).toSorted((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
  let cursor = 0
  return { ...tool, tools: children.map(child => named(child) ? ordered[cursor++] : child) }
}

/** Unknown/product tools remain present in stable order before backend-hosted search.
 * Other profiles, missing tools and compaction's empty list remain untouched.
 */
export function orderCodex01621Tools(payload: Record<string, unknown>, wireProfile?: string): Record<string, unknown> {
  if (wireProfile !== 'codex-0.162.1' || !Array.isArray(payload['tools']) || payload['tools'].length === 0) return payload
  const tools = (payload['tools'] as unknown[]).map(orderedNamespace).toSorted((left, right) => rank(left) - rank(right))
  return { ...payload, tools }
}
