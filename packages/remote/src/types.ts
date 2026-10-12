/** Browser projections of locally managed SSH connections. */

/** One remote Harness deployment; authentication belongs to OpenSSH. */
export interface RemoteHostConfig {
  /** OpenSSH alias or user@host. */
  host: string
  /** Remote Web profile selected through the dsh launcher. */
  profile: string
  /** Initial absolute remote directory, or empty for the remote home. */
  directory: string
  /** Remote Node executable name or absolute path. */
  node: string
  /** Remote dsh executable name or absolute path. */
  dsh: string
}

/** A saved host's current local tunnel state; disconnect leaves its remote process running. */
export interface RemoteHostStatus {
  /** Human-selected catalog name. */
  name: string
  /** Configured SSH destination. */
  host: string
  /** Configured remote profile. */
  profile: string
  /** Local connection lifecycle. */
  phase: 'disconnected' | 'connecting' | 'connected' | 'failed'
  /** Authenticated loopback URL while connected; never persist or log this value. */
  url: string | null
  /** Last connection failure, with launch tokens removed. */
  error: string | null
}
