/** Read shell commands and PTC source from recorded tool arguments and schemas. */
import type { TrajectoryCellProps } from './trajectory-record.ts'

/** Recorded name of the programmatic tool-calling entry point. */
export const PTC_TOOL_NAME = 'run_code'

/** Validated source and original arguments for a recorded shell or PTC call. */
export interface CodeProgram {
  rawInput: string
  source: string
  description: string
  arguments: Record<string, unknown>
  language: 'typescript' | 'python' | 'shellscript' | undefined
  shell?: boolean
  workdir?: string | undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function parseRecord(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  try {
    return record(JSON.parse(value))
  } catch {
    return undefined
  }
}

function recordedLanguage(schemaRaw: string | undefined): CodeProgram['language'] {
  const schema = parseRecord(schemaRaw)
  const properties = record(record(schema?.parameters)?.properties)
  const description = record(properties?.code)?.description
  if (typeof description !== 'string') return undefined
  const typescript = /\bTypeScript\b/i.test(description)
  const python = /\bPython\b/i.test(description)
  if (typescript === python) return undefined
  return typescript ? 'typescript' : 'python'
}

/**
 * Resolve shell or PTC source without guessing its language from source or current runtime settings.
 * @param cell - Recorded tool arguments and the schema visible at call time.
 * @returns The program, or undefined for another tool or unsupported arguments.
 */
export function codeProgram(cell: TrajectoryCellProps): CodeProgram | undefined {
  if (cell.kind !== 'tool' && cell.kind !== 'subtool') return undefined
  if (cell.inputDetail === undefined) return undefined
  const args = parseRecord(cell.inputDetail)
  if (cell.toolName === 'exec_command' || cell.toolName === 'write_stdin') {
    const source = cell.toolName === 'exec_command' ? args?.cmd : args?.chars ?? ''
    if (typeof source !== 'string' || args === undefined) return undefined
    return { rawInput: cell.inputDetail, source, description: '', arguments: args, language: 'shellscript', shell: true,
      workdir: typeof args.workdir === 'string' ? args.workdir : undefined }
  }
  if (cell.toolName !== PTC_TOOL_NAME) return undefined
  if (typeof args?.code !== 'string') return undefined
  if (args.description !== undefined && typeof args.description !== 'string') return undefined
  return {
    rawInput: cell.inputDetail,
    source: args.code,
    description: typeof args.description === 'string' && args.description.trim() !== ''
      ? args.description
      : args.code.split(/\r?\n/).find(line => line.trim() !== '')?.trim() ?? '',
    arguments: args,
    language: recordedLanguage(cell.schemaDetail),
  }
}
