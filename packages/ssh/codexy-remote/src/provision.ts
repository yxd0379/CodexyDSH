/** Content-addressed standalone server installation in an independent product home. */
import { z } from 'zod'

const marker = 'CODEXY_REMOTE_PROVISION'
const dollar = '$'

/** Remote runtime discovered without changing its files. */
export interface ProvisionProbe {
  readonly installed: boolean
  readonly node: string
  readonly dsh: string
  readonly home: string
}

/** Selected standalone runtime and independent remote home. */
export interface ProvisionInstall {
  readonly releaseId: string
  readonly profile: string
  readonly home?: string
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

function preflight(releaseId: string, profile: string, home?: string): string {
  if (!/^[a-f0-9]{64}$/u.test(releaseId)) throw new Error('Invalid Remote server archive digest')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(profile)) throw new Error('Invalid Remote profile')
  if (home !== undefined && (!home.startsWith('/') || /[\0\r\n]/u.test(home))) throw new Error('Remote product home must be an absolute path')
  return String.raw`
set -eu
umask 077
fail() { printf '%s\n' "$1" >&2; exit 1; }
[ "$(uname -s)" = Linux ] || fail 'Automatic Remote setup currently supports Linux ARM64 only.'
case "$(uname -m)" in aarch64|arm64) ;; *) fail 'Automatic Remote setup currently supports Linux ARM64 only.' ;; esac
libc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || fail 'Automatic Remote setup requires glibc 2.28 or newer.'
case "$libc" in 'glibc '*) ;; *) fail 'Automatic Remote setup requires glibc 2.28 or newer.' ;; esac
version=${dollar}{libc#glibc }
major=${dollar}{version%%.*}
minor=${dollar}{version#*.}
minor=${dollar}{minor%%.*}
case "$major:$minor" in *[!0-9:]*|:*|*:) fail 'Cannot determine remote glibc version.' ;; esac
{ [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 28 ]; }; } || fail 'Automatic Remote setup requires glibc 2.28 or newer.'
for tool in tar gzip sha256sum mkdir mktemp mv flock; do
  command -v "$tool" >/dev/null 2>&1 || fail "Automatic Remote setup requires $tool."
done
case "${dollar}{HOME:-}" in /*) ;; *) fail 'Remote HOME must be an absolute path.' ;; esac
home=${home === undefined ? '"$HOME/.codexydsh"' : quote(home)}
base="$home/remote-server/releases/${releaseId}"
record="$base.ready"
runtime=
installed=0
probe() {
  if [ -f "$record" ]; then
    IFS= read -r runtime < "$record" || runtime=
    case "$runtime" in "$base".????????) ;; *) fail 'Invalid Remote runtime record; existing files were retained.' ;; esac
    if [ -x "$runtime/node/bin/node" ] && [ -x "$runtime/bin/codexydsh" ] && [ -f "$runtime/dsh/lib/bin.js" ]; then installed=1; fi
  fi
}
emit() {
  printf '%s\ninstalled=%s\nnode=%s\ndsh=%s\nhome=%s\n%s\n' '${marker}' "$installed" "${dollar}{runtime:+$runtime/node/bin/node}" "${dollar}{runtime:+$runtime/bin/codexydsh}" "$home" '${marker}_END'
}
probe
`
}

/**
 * Build a read-only platform and installed-runtime probe.
 * @param releaseId - SHA-256 identity of the selected archive.
 * @param profile - Launcher profile selected by this host.
 * @param home - Independent remote product home; omission selects ~/.codexydsh.
 * @returns One quoted POSIX shell command.
 */
export function buildProvisionProbe(releaseId: string, profile: string, home?: string): string {
  return `exec sh -c ${quote(preflight(releaseId, profile, home) + '\nemit\n')}`
}

/**
 * Build an installation command accepting the exact archive bytes on stdin.
 * @param options - Expected digest, profile, and independent home.
 * @returns A command that retains old runtimes and reuses a completed identical installation.
 */
export function buildProvisionInstall(options: ProvisionInstall): string {
  const script = preflight(options.releaseId, options.profile, options.home) + String.raw`
if [ "$installed" = 1 ]; then cat >/dev/null; emit; exit 0; fi
mkdir -p "$home/remote-server/releases"
exec 9>"$base.install.flock"
flock -w 20 9 || fail 'Another Remote server installation is running; retry after it finishes.'
probe
if [ "$installed" = 1 ]; then cat >/dev/null; emit; exit 0; fi
owned_pid=
cancel() {
  trap '' INT HUP TERM
  if [ -n "$owned_pid" ]; then
    kill -TERM "$owned_pid" 2>/dev/null || :
    wait "$owned_pid" 2>/dev/null || :
  fi
  exit 143
}
trap cancel INT HUP TERM
run_owned() {
  "$@" &
  owned_pid=$!
  result=0
  wait "$owned_pid" || result=$?
  owned_pid=
  return "$result"
}
runtime=$(mktemp -d "$base.XXXXXXXX")
cat > "$runtime/server.tar.gz"
printf '%s  %s\n' '${options.releaseId}' "$runtime/server.tar.gz" | sha256sum -c >/dev/null 2>&1 || fail 'Remote server checksum mismatch; the previous runtime was retained.'
run_owned tar -xzf "$runtime/server.tar.gz" --no-same-owner --no-same-permissions -C "$runtime"
[ -x "$runtime/node/bin/node" ] && [ -x "$runtime/bin/codexydsh" ] && [ -f "$runtime/dsh/lib/bin.js" ] || fail 'The server archive is missing its standalone runtime entry; existing runtimes were retained.'
"$runtime/node/bin/node" --version >/dev/null || fail 'The installed Node executable does not run on this machine.'
printf '%s\n' "$runtime" > "$record.new.$$"
mv "$record.new.$$" "$record"
installed=1
emit
`
  return `exec sh -c ${quote(script)}`
}

const probe = z.object({
  installed: z.enum(['0', '1']), node: z.string(), dsh: z.string(), home: z.string().startsWith('/'),
}).strict()

/**
 * Read only the delimited installation response, excluding unrelated shell output.
 * @param text - Remote shell stdout.
 * @returns The declared independent home and executable locations.
 */
export function parseProvisionProbe(text: string): ProvisionProbe {
  const start = text.indexOf(marker + '\n')
  const end = text.indexOf('\n' + marker + '_END', start)
  if (start < 0 || end < 0) throw new Error('Remote setup did not report its runtime')
  const value = probe.parse(Object.fromEntries(text.slice(start + marker.length + 1, end).split('\n').map(line => {
    const equal = line.indexOf('=')
    return [line.slice(0, equal), line.slice(equal + 1)]
  })))
  if (value.installed === '1' && (!value.node.startsWith('/') || !value.dsh.startsWith('/'))) throw new Error('Remote setup returned non-absolute runtime paths')
  return { ...value, installed: value.installed === '1' }
}
