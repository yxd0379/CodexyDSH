/** Product schema options compiled by the public DSH schema validator. */
export * from '@deepseek-ai/dsh-tools'
export type { ToolDefinition, ToolExecutionInput, ToolSchemaRequest, ToolRequestBinding, ToolRequestCapture } from '@codexydsh/runtime/tools'
import { defineTool as platformDefineTool, type DefineToolOptions as PlatformOptions,
  type ParameterSchemaSpec, type ValueSchemaSpec, type InferArgs, type InferValue } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@codexydsh/runtime/tools'
import type { FunctionToolSchema, ToolSchema } from '@codexydsh/runtime/llm'

export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> extends Omit<PlatformOptions<S, O>, 'output'> {
  namespace?: ToolSchema['namespace']
  requiredOrder?: readonly Extract<keyof S, string>[]
  closedParameters?: true
  inputSchemaMaxBytes?: number
  outputSchema?: Record<string, unknown>
  output: PlatformOptions<S, O>['output'] & {
    codeModeResult?(args: InferArgs<S>, value: InferValue<NoInfer<O>>, renderedContent: readonly ContentBlock[]): JsonValue
  }
}

/** Keep JSON validation and add product namespaces, ordering, and code-mode projections. */
export function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(options: DefineToolOptions<S, O>): ToolDefinition & FunctionToolSchema {
  const encryption = new Map<string, boolean>()
  const compilerParameters = Object.fromEntries(Object.entries(options.parameters).map(([name, spec]) => {
    if (!('type' in spec) || spec.type !== 'string' || !('encrypted' in spec)) return [name, spec]
    const { encrypted, ...value } = spec
    if (typeof encrypted !== 'boolean') throw new Error(`encrypted annotation for ${name} must be a boolean`)
    encryption.set(name, encrypted)
    return [name, value]
  })) as S
  const tool = platformDefineTool<S, O>({ ...options, parameters: compilerParameters })
  const parameters = tool.parameters
  const properties = parameters['properties']
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [name, encrypted] of encryption) {
      const property = Reflect.get(properties, name)
      if (property !== null && typeof property === 'object') Reflect.set(property, 'encrypted', encrypted)
    }
  }
  if (options.requiredOrder !== undefined) {
    const required = parameters['required']
    if (!Array.isArray(required) || options.requiredOrder.length !== required.length
      || new Set(options.requiredOrder).size !== required.length
      || options.requiredOrder.some(key => !required.includes(key))) throw new Error('requiredOrder must contain every required property exactly once')
    parameters['required'] = [...options.requiredOrder]
  }
  if (options.closedParameters === true) parameters['additionalProperties'] = false
  const projection = options.output.codeModeResult
  return { ...tool,
    ...options.namespace === undefined ? {} : { namespace: structuredClone(options.namespace) },
    ...options.inputSchemaMaxBytes === undefined ? {} : { inputSchemaMaxBytes: options.inputSchemaMaxBytes },
    ...options.outputSchema === undefined ? {} : { outputSchema: structuredClone(options.outputSchema) },
    output: { ...tool.output, ...projection === undefined ? {} : {
      codeModeResult: (args: unknown, value: JsonValue, content: readonly ContentBlock[]) => projection(args as InferArgs<S>, value as InferValue<NoInfer<O>>, content),
    } },
  }
}
