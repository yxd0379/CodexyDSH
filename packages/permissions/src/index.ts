/**
 * User-facing permission presets over independent sandbox-mode,
 * approval-policy, and reviewer knobs. A switch records the selected preset, then writes
 * changed knobs through their canonical setters. Execution, prompt narration,
 * and replay keep reading their knob folds. The preset event preserves user
 * intent when two presets share a bundle. The Auto review integration may
 * publish fixed current-session-only presets with synchronous admission
 * check; settings defaults remain limited to the configured table. The read
 * side exposes a process catalog plus the current-value-only `permissions`
 * Session projection; the write side ships as the `/permission` command.
 *
 * @module dsh-permission-presets
 */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile } from '@deepseek-ai/cordis'

import { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Session, SessionEvent as PlatformSessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { appendProductEvent, projectProductEvent } from '@codexydsh/runtime/session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SANDBOX_MODES, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
// Side-effect type import: declaration-merges `ctx.shell` (the capability fact
// `sandboxMode` this service reads), without a value dependency on the seam.
import type {} from '@deepseek-ai/dsh-shell'
import type { ApprovalPolicy, ApprovalReviewer } from '@codexydsh/approval'
import { APPROVAL_POLICIES, APPROVAL_REVIEWERS, setApprovalPolicy } from '@codexydsh/approval'
// Type-only: resolves the required projection service and optional settings/command children.
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-commands'
import type { PermissionCatalog, PermissionSelection, PresetOption } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    codexyPermissions: PermissionPresetService
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Latest logged permission overrides and constructor-seed status. */
    permissions: PermissionProjectionState
  }
}

declare module '@codexydsh/runtime/types' {
  interface SessionEventMap {
    /**
     * Records the selected preset as durable, log-only user intent. The knob
     * events follow in the same turn and control execution; this event stays
     * out of the model transcript and lets the permission projection unit
     * preserve a selection when bundles match.
     */
    'permission/preset': { preset: string }
  }
}

/** One preset's sandbox, approval, reviewer, and optional client presentation. */
export interface PresetSpec {
  /** The `sandbox/mode` value the preset writes through. */
  sandbox: SandboxMode
  /** The `approval/policy` value the preset writes through. */
  approval: ApprovalPolicy
  /** Reviewer used for required approvals; omitted means the human reviewer. */
  reviewer?: ApprovalReviewer
  /** The display label a client shows for this preset; the raw table key when omitted. */
  name?: string
  /** One user-facing sentence on what the preset means; omitted when not configured. */
  description?: string
}

/**
 * Returned when effective knob values match no available preset. Clients may
 * show it as the current value, but it is never a switch target or event payload.
 */
export const CUSTOM_PRESET = 'custom'

/** Canonical identity of the experimental per-call review preset. */
export const AUTO_PRESET = 'auto'

/** Codexful sandboxed execution with automatic review of required approvals. */
export const APPROVE_FOR_ME_PRESET = 'approve-for-me'

/** Fixed execution bundle for the live Auto integration. */
const AUTO_PRESET_SPEC: PresetSpec = {
  sandbox: 'danger-full-access',
  approval: 'never',
}

const APPROVE_FOR_ME_SPEC: PresetSpec = {
  sandbox: 'workspace-write', approval: 'ask', reviewer: 'auto_review',
  name: 'Approve for me', description: 'Keep the workspace sandbox and review requests for wider access automatically.',
}

/**
 * The projection unit's knob state: the last seen value of each knob event,
 * null before an override (composition defaults apply at view time).
 */
export interface KnobState {
  /** Last `permission/preset` payload, or null. */
  preset: string | null
  /** Last `sandbox/mode` payload, or null. */
  sandbox: SandboxMode | null
  /** Last `approval/policy` payload, or null. */
  approval: ApprovalPolicy | null
  /** Last independent reviewer override, or null. */
  reviewer: ApprovalReviewer | null
}

/** Projection state for permission overrides and constructor-seed status. */
interface PermissionProjectionState extends KnobState {
  sessionId: string
  /** Whether the log contains a constructor-seed boundary. */
  seeded: boolean
}

const permissionStateSchema: zod.ZodType<PermissionProjectionState> = zod.object({
  sessionId: zod.string(),
  preset: zod.string().nullable(),
  sandbox: zod.union([
    zod.literal('read-only'),
    zod.literal('workspace-write'),
    zod.literal('danger-full-access'),
  ]).nullable(),
  approval: zod.union([zod.literal('ask'), zod.literal('never')]).nullable(),
  reviewer: zod.union([zod.literal('user'), zod.literal('auto_review')]).nullable(),
  seeded: zod.boolean(),
}).strict()

/** State for the empty log: every knob at its composition default. */
const EMPTY_KNOBS: KnobState = { preset: null, sandbox: null, approval: null, reviewer: null }

/**
 * One-event permission-state transition (the projection unit's `apply`). Unrelated
 * events return the same reference — the registry's change gate.
 * @param state - the folded knob state before `event`.
 * @param event - one committed session event.
 * @returns the next state; the same reference when the event is unrelated.
 */
function applyPermissionEvent(
  state: PermissionProjectionState,
  rawEvent: PlatformSessionEvent,
): PermissionProjectionState {
  const event = projectProductEvent(rawEvent)
  switch (event.type) {
    case 'permission/preset':
      return { ...state, preset: event.data.preset }
    case 'sandbox/mode':
      return { ...state, sandbox: event.data.mode }
    case 'approval/policy':
      return { ...state, approval: event.data.policy }
    case 'approval/reviewer':
      return { ...state, reviewer: event.data.reviewer }
    case 'session/end-seed':
      return { ...state, seeded: true }
    default:
      return state
  }
}

/** User setting resolved when a new session receives its initial permission. */
export interface PermissionSettings {
  /** Preset pinned into a newly created session. */
  defaultPreset: string
}

/** The {@link PermissionPresetService} config: preset table and composition default. */
export interface Config {
  /**
   * The preset table: name → knob bundle. Defaults to `workspace-write`
   * (workspace-write + ask) and `danger-full-access` (danger-full-access +
   * never). The names `custom`, `auto`, and `approve-for-me` are reserved for
   * derived state and the fixed review integrations.
   */
  presets: Record<string, PresetSpec>
  /**
   * Default for new sessions. When omitted, the preset matching the composed
   * sandbox and approval defaults is used.
   */
  defaultPreset: Volatile<string | undefined>
}

/**
 * Owns the deployment's configured permission presets, the fixed Auto
 * integration hook, and their write path. Requires a confining `ctx.shell` executor and
 * `ctx.codexyApproval`; unmatched knob values are reported as
 * {@link CUSTOM_PRESET}, not an error.
 */
export class PermissionPresetService extends TypertRemoteService {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config = z.object({
    presets: z.dict(z.object({
      sandbox: z.union(SANDBOX_MODES as SandboxMode[]).required(),
      approval: z.union(APPROVAL_POLICIES as ApprovalPolicy[]).required(),
      reviewer: z.union(APPROVAL_REVIEWERS as ApprovalReviewer[]),
      name: z.string(),
      description: z.string(),
    })).default({
      'workspace-write': {
        sandbox: 'workspace-write', approval: 'ask',
        name: 'workspace-write', description: 'Write inside the workspace and permitted temporary directories; wider retries require approval.',
      },
      'danger-full-access': {
        sandbox: 'danger-full-access', approval: 'never',
        name: 'danger-full-access', description: 'Full file access without approval prompts.',
      },
    }),
    defaultPreset: z.string().volatile(),
  })

  static inject = ['shell', 'codexyApproval', 'sessions', 'sessionProjections']

  private readonly presets: Record<string, PresetSpec>
  private autoAdmit: (() => void) | undefined
  private reviewerAdmit: (() => void) | undefined
  private defaultSettings: () => PermissionSettings

  constructor(ctx: Context, config: Config) {
    super(ctx, 'codexyPermissions', { namespace: 'permissionPresets' })

    ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
    // The schema defaulted the table — the cast records that runtime fact.
    this.presets = config.presets
    if (CUSTOM_PRESET in this.presets) {
      throw new Error(`permission: "${CUSTOM_PRESET}" is reserved for the derived not-a-preset state and cannot name a table entry`)
    }
    if (AUTO_PRESET in this.presets) {
      throw new Error(`permission: "${AUTO_PRESET}" is reserved and cannot name a configured preset`)
    }
    if (APPROVE_FOR_ME_PRESET in this.presets) throw new Error('permission: "approve-for-me" is reserved for its reviewer integration')
    if (ctx.shell.sandboxMode === undefined) {
      throw new Error('permission: the mounted bash executor does not confine (no sandboxMode) — presets bundle a sandbox mode, so composing this plugin over an unconfined executor is a misconfiguration')
    }
    const inferredDefault = this.derive(EMPTY_KNOBS)
    const defaultPreset = config.defaultPreset.get() ?? inferredDefault
    if (defaultPreset === CUSTOM_PRESET) {
      throw new Error('permission: composed sandbox and approval defaults match no preset; configure defaultPreset explicitly')
    }
    this.resolve(defaultPreset)
    this.defaultSettings = () => {
      const defaultPreset = config.defaultPreset.get() ?? inferredDefault
      if (!Object.hasOwn(this.presets, defaultPreset)) throw new Error(`permission: unknown default preset "${defaultPreset}"`)
      return { defaultPreset }
    }

    const selectionSchema = zod.object({
      currentValue: zod.string().min(1),
    }) as zod.ZodType<PermissionSelection>
    ctx.sessionProjections.register({
      key: 'permissions',
      stateVersion: 4,
      stateSchema: permissionStateSchema,
      init: header => ({ ...EMPTY_KNOBS, seeded: false, sessionId: header.id }),
      apply: applyPermissionEvent,
      wire: { viewSchema: selectionSchema, view: state => ({ currentValue: this.derive({ ...state,
        reviewer: ctx.codexyApproval.reviewerOf({ id: SessionId(state.sessionId) }) }) }) },
    })
    ctx.on('session/created', (session) => {
      this.pinInitialPermission(session)
    })
    for (const session of ctx.sessions.list()) {
      this.pinInitialPermission(session)
    }

    // The /permission command: the one write path a web client uses (the
    // popup contribution submits the picked preset as this line). The child
    // activates only when a command registry is composed.
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        definitionId: CommandDefinitionId('@codexydsh/permissions'),
        name: 'permission',
        description: 'Switch sandbox mode, approval policy, and reviewer together',
        input: { hint: '<preset>' },
        // No settlement text labels its value with this command's own name: a
        // surface that renders `name · text` (the web command row) would
        // otherwise read `permission · Permission preset: workspace-write.`
        handler: async ({ agent, rawInput }) => {
          const name = rawInput.trim()
          if (name === '') {
            return { kind: 'success', text: `current preset ${this.current(agent.session)} (available: ${this.names.join(', ')})` }
          }
          if (!this.names.includes(name)) {
            return { kind: 'error', text: `unknown preset "${name}" (available: ${this.names.join(', ')})` }
          }
          await this.apply(agent.session, name, (policy) => { this.ctx.codexyApproval.setPolicy(agent, policy) },
            (reviewer) => this.ctx.codexyApproval.setReviewer(agent, reviewer))
          return { kind: 'success', text: `preset ${name}` }
        },
      })
    })
  }

  /**
   * The advertised preset names: configured entries in declaration order,
   * followed by fixed review options while their integrations are live.
   * @returns every switchable preset name.
   */
  get names(): readonly string[] {
    return [...Object.keys(this.presets), ...(this.autoAdmit === undefined ? [] : [AUTO_PRESET]),
      ...(this.reviewerAdmit === undefined ? [] : [APPROVE_FOR_ME_PRESET])]
  }

  /**
   * Read the complete process-level catalog exposed to current-session UI.
   * @returns every currently selectable preset in contribution order.
   */
  @Remote('catalog')
  catalog(): PermissionCatalog {
    return {
      options: this.names.map(name => this.optionOf(name)),
      defaultOptions: Object.keys(this.presets).map(name => this.optionOf(name)),
      defaultPreset: this.defaultSettings().defaultPreset,
    }
  }

  /**
   * Publish the fixed current-session Auto preset for the calling
   * integration's effect lifetime.
   * @param admit - synchronous gate run before live Auto selection or restore.
   * @returns the async effect disposer that removes Auto.
   */
  registerAuto(admit: () => void): () => Promise<void> {
    return this.ctx.effect(() => {
      if (this.autoAdmit !== undefined) throw new Error('permission: preset "auto" is already registered')
      this.autoAdmit = admit
      this.emitCatalogChanged()
      return () => {
        this.autoAdmit = undefined
        this.emitCatalogChanged()
      }
    }, 'permissionPresets.registerAuto()')
  }

  /**
   * Publish the sandboxed automatic-review option for this effect lifetime.
   * @param admit - synchronous availability check before selection or restoration.
   * @returns the disposer that removes the option.
   */
  registerApprovalReviewer(admit: () => void): () => Promise<void> {
    return this.ctx.effect(() => {
      if (this.reviewerAdmit !== undefined) throw new Error('permission: automatic reviewer is already registered')
      this.reviewerAdmit = admit
      this.emitCatalogChanged()
      return () => { this.reviewerAdmit = undefined; this.emitCatalogChanged() }
    }, 'permissionPresets.registerApprovalReviewer()')
  }

  /**
   * The preset currently selected as the default for future sessions.
   * @returns the resolved settings value, or the composition default without
   * a mounted settings provider.
   */
  get defaultPreset(): string {
    return this.defaultSettings().defaultPreset
  }

  private permissionState(session: Session): PermissionProjectionState {
    const state = this.ctx.sessionProjections.stateOf(session, 'permissions')
    if (state === undefined) throw new Error('permission: permissions session projection is not registered')
    return { ...state, reviewer: this.ctx.codexyApproval.reviewerOf(session) }
  }

  /**
   * Resolve the preset matching the effective knob values. A still-matching
   * last selection wins shared-bundle ties; otherwise the first configured
   * match wins. Returns
   * {@link CUSTOM_PRESET} when no available preset matches.
   * @param session - the session whose knob state is read.
   * @returns the effective preset name, or `custom` when nothing matches.
   */
  current(session: Session): string {
    return this.derive(this.permissionState(session))
  }

  /** Resolve the preset for one folded knob state (the shared mathematics of `current` and the projection unit). */
  private derive(state: KnobState): string {
    const sandbox = state.sandbox ?? this.ctx.shell.sandboxMode
    const approval = state.approval ?? this.ctx.codexyApproval.config.policy ?? 'ask'
    const reviewer = state.reviewer ?? this.ctx.codexyApproval.config.reviewer ?? 'user'
    const matches = (spec: PresetSpec): boolean => spec.sandbox === sandbox && spec.approval === approval && (spec.reviewer ?? 'user') === reviewer
    if (state.preset !== null) {
      const spec = this.specOf(state.preset)
      if (spec !== undefined && matches(spec)) return state.preset
    }
    for (const [name, spec] of Object.entries(this.presets)) {
      if (matches(spec)) return name
    }
    return CUSTOM_PRESET
  }

  /**
   * Resolve an available preset's knob bundle.
   * @param name - the preset name to resolve.
   * @returns the configured bundle.
   * @throws when `name` is neither configured nor a currently live review option.
   */
  resolve(name: string): PresetSpec {
    const spec = this.specOf(name)
    if (spec === undefined) {
      throw new Error(`permission: unknown preset "${name}" (known: ${this.names.join(', ')})`)
    }
    return spec
  }

  /**
   * Build the client option for an available preset or {@link CUSTOM_PRESET}.
   * A missing label falls back to the preset key.
   * @param name - a configured key, live review option, or `custom`.
   * @returns the option a client renders.
   * @throws when `name` is neither configured, a live review option, nor `custom`.
   */
  optionOf(name: string): PresetOption {
    if (name === CUSTOM_PRESET) {
      return { value: CUSTOM_PRESET, name: 'Custom', description: 'Current sandbox and approval settings do not match a preset.' }
    }
    const spec = this.resolve(name)
    return { value: name, name: spec.name ?? name, ...spec.description !== undefined ? { description: spec.description } : {} }
  }

  /**
   * Record a changed preset, then update each changed knob through its own
   * setter. Selecting the effective preset again appends nothing.
   * @param session - the session the switch belongs to.
   * @param name - the preset to switch to; unknown names throw.
   */
  async set(session: Session, name: string): Promise<void> {
    await this.apply(session, name, (policy) => { setApprovalPolicy(session, policy) },
      (reviewer) => this.ctx.codexyApproval.setSessionReviewer(session, reviewer))
  }

  /** Apply one preset through its durable identity and canonical knob setters. */
  private async apply(session: Session, name: string, setApproval: (policy: ApprovalPolicy) => void,
    setReviewer: (reviewer: ApprovalReviewer) => Promise<void>): Promise<void> {
    const spec = this.resolve(name)
    if (name === AUTO_PRESET) this.autoAdmit?.()
    if (name === APPROVE_FOR_ME_PRESET) this.reviewerAdmit?.()
    const current = this.current(session)
    const knobs = this.permissionState(session)
    const updateKnobs = async (): Promise<void> => {
      if (spec.sandbox !== (knobs.sandbox ?? this.ctx.shell.sandboxMode)) {
        setSandboxMode(session, spec.sandbox)
      }
      if (spec.approval !== (knobs.approval ?? this.ctx.codexyApproval.config.policy ?? 'ask')) {
        setApproval(spec.approval)
      }
      if ((spec.reviewer ?? 'user') !== (knobs.reviewer ?? this.ctx.codexyApproval.config.reviewer ?? 'user')) await setReviewer(spec.reviewer ?? 'user')
    }
    if (current !== name) appendProductEvent(session, 'permission/preset', { preset: name })
    await updateKnobs()
  }

  /**
   * Fill every missing permission fact before a session is published. A
   * genuinely fresh session uses the current user default; seeded or partially
   * initialized sessions preserve their effective knob values and only gain
   * the missing durable facts. A stored Auto identity requires its live
   * integration and passes its admission check before
   * publication.
   */
  private pinInitialPermission(session: Session): void {
    const state = this.permissionState(session)
    const { preset, sandbox, approval, seeded } = state
    if (preset === AUTO_PRESET) {
      if (this.autoAdmit === undefined) {
        throw new Error('permission: cannot restore preset "auto" without its active integration')
      }
      this.autoAdmit()
    }
    if (preset === APPROVE_FOR_ME_PRESET) {
      if (this.reviewerAdmit === undefined) throw new Error('permission: cannot restore "approve-for-me" without its reviewer')
      this.reviewerAdmit()
    }
    if (preset === null && sandbox === null && approval === null && !seeded) {
      const name = this.defaultPreset
      const spec = this.resolve(name)
      appendProductEvent(session, 'permission/preset', { preset: name })
      setSandboxMode(session, spec.sandbox)
      setApprovalPolicy(session, spec.approval)
      return
    }

    const effective = this.derive(state)
    if (preset === null && effective !== CUSTOM_PRESET) {
      appendProductEvent(session, 'permission/preset', { preset: effective })
    }
    if (sandbox === null) {
      setSandboxMode(session, this.ctx.shell.sandboxMode as SandboxMode)
    }
    if (approval === null) {
      setApprovalPolicy(session, this.ctx.codexyApproval.config.policy ?? 'ask')
    }
  }

  /** Publish a non-vetoing payload-free catalog invalidation. */
  private emitCatalogChanged(): void {
    for (const listener of this.ctx.events.dispatch('emit', ['permission-presets/catalog-changed']) as Array<() => unknown>) {
      try {
        const returned = listener()
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).catch((error: unknown) => {
            this.ctx.logger.warn(`permission: catalog-changed listener failed: ${error instanceof Error ? error.message : String(error)}`)
          })
        }
      } catch (error: unknown) {
        this.ctx.logger.warn(`permission: catalog-changed listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Resolve one configured or currently live fixed preset without throwing. */
  private specOf(name: string): PresetSpec | undefined {
    return this.presets[name]
      ?? (name === AUTO_PRESET && this.autoAdmit !== undefined ? AUTO_PRESET_SPEC : undefined)
      ?? (name === APPROVE_FOR_ME_PRESET && this.reviewerAdmit !== undefined ? APPROVE_FOR_ME_SPEC : undefined)
  }
}

export default PermissionPresetService
