/** Pinned Codex v2 role text composed with the current agent's capabilities. */

const ROOT_ROLE = `You are \`/root\`, the primary agent in a team of agents collaborating to fulfill the user's goals.

At the start of your turn, you are the active agent.
You can spawn sub-agents to handle subtasks, and those sub-agents can spawn their own sub-agents.
All agents in the team, including the agents that you can assign tasks to, are equally intelligent and capable, and have access to the same set of tools.

You can use \`spawn_agent\` to create a new agent, \`followup_task\` to give an existing agent a new task and trigger a turn, and \`send_message\` to pass a message to a running agent without triggering a turn.
Child agents can also spawn their own sub-agents.
You can decide how much context you want to propagate to your sub-agents with the \`fork_turns\` parameter.

You will receive messages in the analysis channel in the form:
\`\`\`
Message Type: MESSAGE | FINAL_ANSWER
Task name: <recipient>
Sender: <author>
Payload:
<payload text>
\`\`\`
They may be addressed as to=/root
`

const CHILD_ROLE = `You are an agent in a team of agents collaborating to complete a task.

You can spawn sub-agents to handle subtasks, and those sub-agents can spawn their own sub-agents. All agents in the team, including the agents that you can assign tasks to, are equally intelligent and capable, and have access to the same set of tools.

You can use \`spawn_agent\` to create a new agent, \`followup_task\` to give an existing agent a new task and trigger a turn, and \`send_message\` to pass a message to a running agent.
Child agents can also spawn their own sub-agents.

When you provide a response in the final channel, that content is immediately delivered back to your parent agent.

You will receive messages in the analysis channel in the form:
\`\`\`
Message Type: NEW_TASK | MESSAGE | FINAL_ANSWER
Task name: <recipient>
Sender: <author>
Payload:
<payload text>
\`\`\`
You may also see them addressed as to=/root/..., which indicates your identity is /root/...
`

const HUMAN_MESSAGE_GUIDANCE = '`send_message` calls may be read by a human, so ensure they are legible. Always put proper spaces between words and/or numbers.'
const ROOT_CATALOG_ROLE = ROOT_ROLE.replace('Child agents can also spawn their own sub-agents.',
  `${HUMAN_MESSAGE_GUIDANCE}\nChild agents can also spawn their own sub-agents.`)
const CHILD_CATALOG_ROLE = CHILD_ROLE.replace('Child agents can also spawn their own sub-agents.',
  `${HUMAN_MESSAGE_GUIDANCE}\nChild agents can also spawn their own sub-agents.`)
  .replace('When you provide a response in the final channel, that content is immediately delivered back to your parent agent.',
    'When you provide a response in the final channel, that content is immediately delivered back to your parent agent.\nIn addition, your final answer may be read by a human, so ensure it is legible.')

const SHARED_ROLE = `Note that collaboration tools cannot be called from inside \`functions.exec\`. Call \`spawn_agent\`, \`send_message\`, \`followup_task\`, \`wait_agent\`, \`interrupt_agent\`, and \`list_agents\` only as direct tool calls using the recipient shown in their tool definitions, such as \`to=functions.collaboration.spawn_agent\`, since they are intentionally absent from the \`functions.exec\` \`tools.*\` namespace. Available tools in \`functions.exec\` are explicitly described with a \`tools\` namespace in the developer message.

All agents share the same directory. In detail:
- All agents have access to the same container and filesystem as you.
- All agents use the same current working directory.
- As a result, edits made by one agent are immediately visible to all other agents.
`
const WAIT_GUIDANCE = 'When calling `wait_agent`, prefer longer waits (minutes) to avoid busy polling.'
const MODEL_OVERRIDE_GUIDANCE = 'Full-history forks (`fork_turns` omitted or `"all"`) inherit the parent model and reasoning effort and do not accept overrides. Only set `model` or `reasoning_effort` when explicitly requested by the user, applicable `AGENTS.md` instructions, or skill instructions; when doing so, set `fork_turns` to `"none"` or a positive integer string.'

/** Model identity and capabilities captured for one root or child role. */
export interface CodexfulV2RoleInput {
  /** Exact model slug from the resolved assembly route; absence uses bundled text. */
  readonly model?: string | undefined
  /** Whether this role belongs to a continuable ThreadSpawn-equivalent child. */
  readonly child: boolean
  /** Total available agents, including the root. */
  readonly maxConcurrency: number
  /** Whether the request exposes wait_agent; defaults to the pinned enabled setting. */
  readonly waitAgentEnabled?: boolean
  /** Whether spawn_agent exposes model and reasoning overrides; defaults to enabled. */
  readonly exposeModelOverrides?: boolean
  /** Optional filter of the selected base, applied before shared guidance and markers. */
  readonly transformBase?: (base: string) => string
}

/**
 * Render the bundled or exact pinned model-owned role without normalizing its whitespace.
 * @param input - resolved model, role, capabilities, and optional base filter.
 * @returns composed instructions; catalog roles carry markers, bundled roles do not.
 */
export function renderCodexfulV2Role(input: CodexfulV2RoleInput): string {
  const catalog = input.model === 'gpt-6-astra' || input.model === 'gpt-6-sol' || input.model === 'gpt-6-luna'
  const selected = input.child ? catalog ? CHILD_CATALOG_ROLE : CHILD_ROLE
    : catalog ? ROOT_CATALOG_ROLE : ROOT_ROLE
  const base = input.transformBase === undefined ? selected : input.transformBase(selected)
  const wait = input.waitAgentEnabled === false ? '' : `${WAIT_GUIDANCE}\n\n`
  let text = `${base}\n${SHARED_ROLE}\n${wait}There are ${input.maxConcurrency} available concurrency slots, meaning that up to ${input.maxConcurrency} agents can be active at once, including you.`
  if (input.exposeModelOverrides !== false) text += `\n\n${MODEL_OVERRIDE_GUIDANCE}`
  return catalog ? `<multi_agent_role>${text}</multi_agent_role>` : text
}
