/** Codex 0.162.1 tool interfaces backed by public filesystem and human-input services. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@codexydsh/tool-schema'
import type { ToolExecution } from '@codexydsh/runtime/tools'
import { snapshotProductEvents } from '@codexydsh/runtime/session'
import type {} from '@deepseek-ai/dsh-user-questions'
import { IMAGE_READ_SCHEMA, imageRefFromValue, readImageFile } from './read-image.ts'

// Pinned public tool descriptions and arguments: openai/codex rust-v0.162.1,
// core/src/tools/handlers/{view_image,request_user_input}_spec.rs, Apache-2.0.
export const VIEW_IMAGE_DESCRIPTION = 'View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.'
export const REQUEST_USER_INPUT_DESCRIPTION = 'Request user input for one to three short questions and wait for the response. This tool is only available in Plan mode.'

/** Register only inside the composing plugin's real attachment-service scope. */
export function applyViewImageTool(ctx: Context): void {
  ctx.codexyTools.register(defineTool({
    name: 'view_image',
    description: VIEW_IMAGE_DESCRIPTION,
    closedParameters: true,
    parameters: {
      path: { type: 'string', required: true, description: 'Local filesystem path to an image file.' },
    },
    output: {
      schema: IMAGE_READ_SCHEMA,
      // The native Codex result carries an image, not read_image's text envelope.
      render: (_args, value) => [{ type: 'image', attachment: imageRefFromValue(value.image) }],
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    isConcurrencySafe: () => true,
    execute: (args, exec) => readImageFile(ctx, args.path, exec),
  }))
}

/** Accepted logged mode, not a guessed model capability or an uncommitted UI selection. */
function inCommittedPlanMode(exec: ToolExecution): boolean {
  if (exec.agent === undefined) return false
  let active = false
  for (const event of snapshotProductEvents(exec.agent.session)) {
    if (String(event.type) !== 'plan/mode') continue
    const data: unknown = event.data
    if (typeof data === 'object' && data !== null && 'active' in data && typeof data.active === 'boolean') {
      active = data.active
    }
  }
  return active
}

/** Translate the exact native interface into the public, scoped human-answer waterfall. */
export function applyRequestUserInputTool(ctx: Context): void {
  ctx.codexyTools.register(defineTool({
    name: 'request_user_input',
    description: REQUEST_USER_INPUT_DESCRIPTION,
    closedParameters: true,
    parameters: {
      questions: {
        type: 'array', required: true, description: 'Questions to show the user. Prefer 1 and do not exceed 3',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Stable identifier for mapping answers (snake_case).' },
            header: { type: 'string', required: true, description: 'Short header label shown in the UI (12 or fewer chars).' },
            question: { type: 'string', required: true, description: 'Single-sentence prompt shown to the user.' },
            options: {
              type: 'array', required: true,
              description: 'Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". Do not include an "Other" option in this list; the client will add a free-form "Other" option automatically.',
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  label: { type: 'string', required: true, description: 'User-facing label (1-5 words).' },
                  description: { type: 'string', required: true, description: 'One short sentence explaining impact/tradeoff if selected.' },
                },
              },
            },
          },
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false,
        properties: { answers: { type: 'object', required: true, additionalProperties: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('request_user_input requires an owning agent')
      if (!inCommittedPlanMode(exec)) throw new Error('request_user_input is unavailable in Default mode')
      if (args.questions.some(question => question.options.length === 0)) {
        throw new Error('request_user_input requires non-empty options for every question')
      }
      const service = ctx.get('userQuestions')
      if (service === undefined) throw new Error('request_user_input has no user-questions service')
      const result = await service.ask({
        questions: args.questions.map(question => ({ ...question, options: question.options.map(option => ({ ...option })) })),
        agent: exec.agent, signal: exec.signal, wait: { callId: exec.callId },
      })
      return { answers: Object.fromEntries(result.answers.map(answer => [answer.id, {
        answers: [...answer.selected, ...answer.custom === undefined ? [] : [answer.custom]],
      }])) }
    },
  }))
}
