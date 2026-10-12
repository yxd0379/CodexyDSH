/**
 * Trajectory turn-fold state, held per Session so switching views does not
 * discard the reader's choice. `collapsed` is the folded set; `auto` is the
 * toolbar switch's last explicit position and decides whether turns arriving
 * from a later history load start folded.
 */
export interface TrajectoryTurnFold {
  /** Folded turn ids. */
  readonly collapsed: ReadonlySet<number>
  /** Whether a turn that arrives from a later history load starts folded. */
  readonly auto: boolean
}

/**
 * Create the initial fold state: nothing folded, no automatic folding.
 * @returns a fresh fold state; each caller owns its own collapsed set.
 */
export function createTrajectoryTurnFold(): TrajectoryTurnFold {
  return { collapsed: new Set(), auto: false }
}
