/**
 * Configuration normalization for workspace instruction discovery and rendering.
 *
 * @module @codexydsh/instructions/config
 */

import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'] as const
const DEFAULT_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const
const DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md'] as const
const CODEX_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.override.md', 'AGENTS.md'] as const
const DEFAULT_MAX_SOURCE_BYTES = 1_048_576
const RESERVED_PATH_SEGMENTS = new Set(['', '.', '..'])

/** User-facing workspace instruction loader configuration. */
export interface Config {
  /** Use Codex's project-file precedence, root-first source budget, and AGENTS.md message wrapper. */
  instructionFormat?: 'dsh' | 'codex'
  /** Include Codex-home instructions before project files in Codex format; disabled outside Codexful. */
  codexGlobalInstructions?: boolean
  /** Codex home for global instructions; defaults to `$CODEX_HOME` or `~/.codex` when enabled. */
  codexHome?: string
  /** Refresh changed project instructions after file tools, or retain the session's initial project snapshot. */
  instructionRefresh?: 'touch' | 'session'
  /** Harness home containing the DSH-format user-global `AGENTS.md`; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Directory entries that identify the project root while walking upward from the session cwd. */
  projectRootMarkers?: string[]
  /** DSH: rendered baseline cap; Codex: root-first project source byte cap.
   * Also bounds DSH and Codex project updates; non-positive or non-finite disables loading. */
  maxBytes: number
  /** DSH source-file and optional Codex-home file cap; Codex project files use the shared `maxBytes` cap. */
  maxSourceBytes?: number
  /**
   * Ordered same-directory project candidates; every existing file loads, with
   * per-directory trimmed-content duplicates collapsed to the earliest candidate.
   * Codex format fixes the candidates to `AGENTS.override.md`, then `AGENTS.md`.
   */
  instructionFileCandidates?: string[]
  /**
   * Ordered same-directory local-overlay candidates loaded after the base files
   * under the same per-directory trimmed-content dedup; empty disables the overlay.
   * Codex format loads no local overlay.
   */
  localInstructionFileCandidates?: string[]
}

export const Config: z<Config> = z.object({
  instructionFormat: z.union([z.const('dsh'), z.const('codex')]).default('dsh'),
  codexGlobalInstructions: z.boolean().default(false),
  codexHome: z.string(),
  instructionRefresh: z.union([z.const('touch'), z.const('session')]).default('touch'),
  dshHome: z.string(),
  projectRootMarkers: z.array(z.string()).default([...DEFAULT_PROJECT_ROOT_MARKERS]),
  maxBytes: z.number().required(),
  maxSourceBytes: z.number().step(1).min(1).default(DEFAULT_MAX_SOURCE_BYTES),
  instructionFileCandidates: z.array(z.string()).default([...DEFAULT_INSTRUCTION_FILE_CANDIDATES]),
  localInstructionFileCandidates: z.array(z.string()).default([...DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES]),
})

/** Normalized instruction discovery configuration. */
export interface ResolvedDiscoveryConfig {
  instructionFormat: 'dsh' | 'codex'
  codexGlobalInstructions: boolean
  codexHome: string
  dshHome: string
  projectRootMarkers: string[]
  instructionFileCandidates: string[]
  localInstructionFileCandidates: string[]
}

/** Normalized configuration used by discovery and reconciliation. */
export interface ResolvedConfig extends ResolvedDiscoveryConfig {
  instructionRefresh: 'touch' | 'session'
  maxBytes: number
  maxSourceBytes: number
}

/**
 * Identify the discovery, precedence, and budget semantics of one baseline.
 * @param config - normalized plugin configuration.
 * @param cwd - absolute session working directory.
 * @param projectRoot - project root selected for the current baseline.
 * @returns stable serialized identity for compatibility checks on resume.
 */
export function workspaceBaselineIdentity(
  config: ResolvedConfig,
  cwd: string,
  projectRoot: string,
): string {
  return JSON.stringify({
    ...config.instructionFormat === 'codex' ? { instructionFormat: 'codex' } : {},
    ...config.codexGlobalInstructions ? { codexGlobalInstructions: true, codexHome: config.codexHome } : {},
    ...config.instructionRefresh === 'session' ? { instructionRefresh: 'session' } : {},
    projectRoot: relative(cwd, projectRoot),
    projectRootMarkers: config.projectRootMarkers,
    maxBytes: config.maxBytes,
    maxSourceBytes: config.maxSourceBytes,
    instructionFileCandidates: config.instructionFileCandidates,
    localInstructionFileCandidates: config.localInstructionFileCandidates,
  })
}

/**
 * Check a persisted baseline against current configuration without probing the filesystem.
 * @param config - normalized plugin configuration.
 * @param cwd - immutable session working directory.
 * @param identity - baseline identity read from Session history.
 * @returns whether the baseline still uses the current discovery and budget settings.
 */
export function workspaceBaselineMatchesConfig(config: ResolvedConfig, cwd: string, identity: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(identity)
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null || !('projectRoot' in parsed)
    || typeof parsed.projectRoot !== 'string') return false
  return workspaceBaselineIdentity(config, cwd, resolve(cwd, parsed.projectRoot)) === identity
}

/**
 * Resolve defaults, the harness home, and valid same-directory candidates.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    ...resolveDiscoveryConfig(config),
    instructionRefresh: config.instructionRefresh ?? 'touch',
    maxBytes: config.maxBytes,
    maxSourceBytes: config.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
  }
}

/**
 * Resolve the subset of configuration used before instruction content is rendered.
 * @param config - optional discovery controls.
 * @returns normalized home, root markers, and instruction candidates.
 */
export function resolveDiscoveryConfig(
  config: Pick<Config, 'instructionFormat' | 'codexGlobalInstructions' | 'codexHome' | 'dshHome' | 'projectRootMarkers' | 'instructionFileCandidates' | 'localInstructionFileCandidates'>,
): ResolvedDiscoveryConfig {
  const instructionFormat = config.instructionFormat ?? 'dsh'
  if (instructionFormat !== 'codex' && (config.codexGlobalInstructions === true || config.codexHome !== undefined)) {
    throw new Error('Codex-home instructions require the Codex instruction format')
  }
  if (config.codexHome !== undefined && config.codexGlobalInstructions !== true) {
    throw new Error('codexHome requires codexGlobalInstructions')
  }
  if (config.codexHome !== undefined && config.codexHome.trim().length === 0) {
    throw new Error('codexHome must name a directory')
  }
  if (instructionFormat === 'codex' && (
    config.instructionFileCandidates !== undefined
      && !sameCandidates(config.instructionFileCandidates, DEFAULT_INSTRUCTION_FILE_CANDIDATES)
      && !sameCandidates(config.instructionFileCandidates, CODEX_INSTRUCTION_FILE_CANDIDATES)
    || config.localInstructionFileCandidates !== undefined
      && config.localInstructionFileCandidates.length > 0
      && !sameCandidates(config.localInstructionFileCandidates, DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES)
  )) {
    throw new Error('Codex instruction format uses AGENTS.override.md then AGENTS.md; custom candidate lists are unavailable')
  }
  return {
    instructionFormat,
    codexGlobalInstructions: config.codexGlobalInstructions ?? false,
    codexHome: resolve(expandHomePath(config.codexHome ?? (process.env.CODEX_HOME || join(homedir(), '.codex')))),
    dshHome: resolveDshHome(config.dshHome),
    projectRootMarkers: config.projectRootMarkers ?? [...DEFAULT_PROJECT_ROOT_MARKERS],
    instructionFileCandidates: instructionFormat === 'codex'
      ? [...CODEX_INSTRUCTION_FILE_CANDIDATES]
      : resolveInstructionFileCandidates(config.instructionFileCandidates, DEFAULT_INSTRUCTION_FILE_CANDIDATES),
    localInstructionFileCandidates: instructionFormat === 'codex'
      ? []
      : resolveInstructionFileCandidates(config.localInstructionFileCandidates, DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES),
  }
}

function sameCandidates(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((candidate, index) => candidate === expected[index])
}

function resolveInstructionFileCandidates(candidates: string[] | undefined, fallback: readonly string[]): string[] {
  return (candidates ?? [...fallback]).filter(candidate => (
    !RESERVED_PATH_SEGMENTS.has(candidate) && !/[\\/]/.test(candidate)
  ))
}
