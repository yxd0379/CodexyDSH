/** Browser projections of locally managed SSH connections. */

/** One remote Harness deployment; authentication belongs to OpenSSH. */
export interface RemoteHostConfig {
  /** OpenSSH alias or user@host. */
  host: string
  /** Automatically provision the pinned server, or use explicit existing executables. */
  deployment?: 'auto' | 'existing'
  /** Remote Web profile selected through the dsh launcher. */
  profile: string
  /** Initial absolute remote directory, or empty for the remote home. */
  directory: string
  /** Remote Node executable name or absolute path. */
  node: string
  /** Remote dsh executable name or absolute path. */
  dsh: string
  /** Network policy for the remote server and managed downloads, never the local UI. */
  proxyMode?: 'inherit' | 'custom' | 'direct'
  /** HTTP(S) proxy as seen from the remote machine. */
  proxyUrl?: string
  /** Comma-separated hosts that bypass a custom proxy. Loopback always bypasses it. */
  noProxy?: string
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
  /** Same-origin embedded runtime path, or an authenticated loopback launch URL when no Web carrier is mounted. */
  url: string | null
  /** Last connection failure, with launch tokens removed. */
  error: string | null
  /** Current connection step and bounded diagnostic output; never launch credentials. */
  progress?: string
  log?: string
  /** Ephemeral OpenSSH password, passphrase, or keyboard-interactive question. */
  authChallenge?: { id: string; prompt: string }
}
