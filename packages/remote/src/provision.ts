/** Pinned, user-owned Linux ARM64 provisioning over an ordinary SSH shell. */
import { createHash } from 'node:crypto'

/** Official https://nodejs.org/dist/v24.22.0/SHASUMS256.txt; never use a mutable latest URL. */
export const provisionNode = {
  version: '24.22.0',
  file: 'node-v24.22.0-linux-arm64.tar.gz',
  sha256: 'b7e7991d5407815adfa74a2a9cd4db683552c8ce32ff4a295c22e972849c3f5d',
} as const

const pnpmVersion = '11.7.0'
const marker = 'DSH_REMOTE_PROVISION'
const shellDollar = '$'

/** Result shared by the read-only probe and completed provisioning command. */
export interface ProvisionProbe {
  installed: boolean
  node: string
  dsh: string
  profile: string
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

function validateIdentity(releaseId: string, profile: string): void {
  if (!/^[a-f0-9]{64}$/u.test(releaseId)) throw new Error('Invalid remote release identity')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(profile)) throw new Error('Invalid remote profile name')
}

const warmProfile = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
try {
  const [home, profile, key, runtime, pnpm] = process.argv.slice(1);
  const release = JSON.parse(fs.readFileSync(path.join(runtime, 'release/release.json'), 'utf8'));
  if (crypto.createHash('sha256').update(JSON.stringify(release)).digest('hex') !== key) process.exit(1);
  const manifest = JSON.parse(fs.readFileSync(path.join(home, 'profiles', profile, 'package.json'), 'utf8'));
  for (const name of ['@codexydsh/remote', '@codexydsh/bundle', '@codexydsh/web']) {
    const item = release.packages.find(item => item.name === name);
    if (!item || manifest.dependencies?.[name] !== 'file:' + path.join(home, 'products/codexy/releases', key, item.file)) process.exit(1);
  }
  for (const [name, version] of [['@deepseek-ai/dsh', release.platform.version], ['pnpm', pnpm]]) {
    if (JSON.parse(fs.readFileSync(path.join(runtime, 'lib/node_modules', name, 'package.json'), 'utf8')).version !== version) process.exit(1);
  }
} catch { process.exit(1); }
`

/** Shell preflight does not need Node and does not create or edit any file. */
function preflight(releaseId: string, profile: string): string {
  validateIdentity(releaseId, profile)
  const identity = createHash('sha256').update(`${releaseId}\n${profile}\n${provisionNode.version}\n${pnpmVersion}`).digest('hex')
  return String.raw`
set -eu
unset NODE_OPTIONS NODE_PATH
fail() { printf '%s\n' "$1" >&2; exit 1; }
os=$(uname -s)
arch=$(uname -m)
[ "$os" = Linux ] || fail 'Automatic remote installation currently supports Linux ARM64 only; this host OS is unsupported.'
case "$arch" in aarch64|arm64) ;; *) fail 'Automatic remote installation currently supports Linux ARM64 only; this host architecture is unsupported.' ;; esac
libc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || fail 'Automatic remote installation requires glibc 2.28 or newer; musl and unknown libc are unsupported.'
case "$libc" in 'glibc '*) ;; *) fail 'Automatic remote installation requires glibc 2.28 or newer.' ;; esac
libc_version=${shellDollar}{libc#glibc }
libc_major=${shellDollar}{libc_version%%.*}
libc_minor=${shellDollar}{libc_version#*.}
libc_minor=${shellDollar}{libc_minor%%.*}
case "$libc_major:$libc_minor" in *[!0-9:]*|:*|*:) fail 'Cannot determine remote glibc version.' ;; esac
{ [ "$libc_major" -gt 2 ] || { [ "$libc_major" -eq 2 ] && [ "$libc_minor" -ge 28 ]; }; } || fail 'Automatic remote installation requires glibc 2.28 or newer.'
for tool in tar gzip curl sha256sum mkdir mktemp cat chmod mv rmdir; do
  command -v "$tool" >/dev/null 2>&1 || fail "Automatic remote installation requires the remote tool: $tool"
done
case "${shellDollar}{HOME:-}" in /*) ;; *) fail 'Remote HOME must be an absolute path.' ;; esac
dsh_home=${shellDollar}{DSH_HOME:-$HOME/.dsh}
case "$dsh_home" in /*) ;; *) fail 'Remote DSH_HOME must be an absolute path.' ;; esac
case "$dsh_home" in *'
'*) fail 'Remote DSH_HOME cannot contain newlines.' ;; esac
cr=$(printf '\r')
case "$dsh_home" in *"$cr"*) fail 'Remote DSH_HOME cannot contain carriage returns.' ;; esac
profile=${quote(profile)}
base="$dsh_home/products/codexy/remote-runtimes/${identity}"
lock="$dsh_home/products/codexy/remote-runtimes/profile-${createHash('sha256').update(profile).digest('hex')}.lock"
runtime=
installed=0
if [ -f "$base.ready" ]; then
  IFS= read -r runtime < "$base.ready" || runtime=
  case "$runtime" in "$base".????????) ;; *) fail 'Invalid managed remote runtime record; existing files were retained.' ;; esac
  if [ -x "$runtime/node/bin/node" ] && [ -x "$runtime/launch-dsh" ] && [ -f "$dsh_home/profiles/$profile/package.json" ] && [ -d "$dsh_home/profiles/$profile/node_modules" ]; then
    if [ "$("$runtime/node/bin/node" --version 2>/dev/null)" = 'v${provisionNode.version}' ] && "$runtime/node/bin/node" -e ${quote(warmProfile)} "$dsh_home" "$profile" '${releaseId}' "$runtime" '${pnpmVersion}'; then installed=1; fi
  fi
fi
emit() {
  printf '%s\nos=%s\narch=%s\nlibc=%s\ninstalled=%s\nnode=%s\ndsh=%s\nprofile=%s\n%s\n' '${marker}' "$os" "$arch" "$libc" "$installed" "${shellDollar}{runtime:+$runtime/node/bin/node}" "${shellDollar}{runtime:+$runtime/launch-dsh}" "$profile" '${marker}_END'
}
`
}

/** Build the read-only shell probe; unsupported platforms fail before any write.
 * @param releaseId - Verified release manifest digest.
 * @param profile - Selected remote Web profile.
 * @returns A single POSIX shell command safe for the SSH command argument.
 */
export function buildProvisionProbe(releaseId: string, profile = 'codexy'): string {
  return `exec sh -c ${quote(preflight(releaseId, profile) + '\nemit\n')}`
}

const verifyRelease = String.raw`
import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
const [root, version, releaseId] = process.argv.slice(1);
const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
if (createHash('sha256').update(JSON.stringify(release)).digest('hex') !== releaseId || release.format !== 1 || release.platform?.version !== version) throw new Error('Remote release identity mismatch');
const required = ['install.mjs', 'profiles/codexy/package.json', 'profiles/codexy-headless/package.json'];
if (!Array.isArray(release.packages) || !Array.isArray(release.deploymentFiles) || release.deploymentFiles.length !== required.length || required.some(file => !release.deploymentFiles.some(item => item.file === file))) throw new Error('Remote release does not include its verified deployment installer');
const files = [...release.packages, ...(release.providerPatches ?? []), ...release.deploymentFiles];
const seen = new Set();
for (const item of files) {
  if (typeof item.file !== 'string' || !/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\.tgz|patches\/[A-Za-z0-9._-]+\.patch|install\.mjs|profiles\/codexy(?:-headless)?\/package\.json)$/.test(item.file) || !/^[a-f0-9]{64}$/.test(item.sha256) || seen.has(item.file)) throw new Error('Invalid remote release file');
  seen.add(item.file);
  const path = join(root, item.file);
  if (!(await lstat(path)).isFile() || createHash('sha256').update(await readFile(path)).digest('hex') !== item.sha256) throw new Error('Remote release checksum mismatch: ' + item.file);
}
`

/** Exact upload identity and selected profile for a provisioning attempt. */
export interface ProvisionInstall {
  sha256: string
  dshVersion: string
  releaseId: string
  profile?: string
}

/** Build an install command that receives the release tar archive on stdin.
 * @param options - Verified local release and archive identities.
 * @returns User-owned installation command; old runtimes and all session data remain in place.
 */
export function buildProvisionInstall(options: ProvisionInstall): string {
  const { sha256, dshVersion, releaseId, profile = 'codexy' } = options
  validateIdentity(releaseId, profile)
  if (!/^[a-f0-9]{64}$/u.test(sha256) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(dshVersion)) throw new Error('Invalid remote installation identity')
  const script = preflight(releaseId, profile) + String.raw`
if [ "$installed" = 1 ]; then cat >/dev/null; emit; exit 0; fi
umask 077
unset NODE_OPTIONS NODE_PATH
mkdir -p "$dsh_home/products/codexy/remote-runtimes"
mkdir "$lock" 2>/dev/null || fail 'Another managed remote installation for this profile is in progress; wait for it to finish. Existing files were retained.'
trap 'rmdir "$lock" 2>/dev/null || :' EXIT
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
cat > "$runtime/release.tar.gz"
printf '%s  %s\n' '${sha256}' "$runtime/release.tar.gz" | sha256sum -c >/dev/null 2>&1 || fail 'Uploaded remote release checksum mismatch; no installer was run.'
mkdir "$runtime/release" "$runtime/node"
tar -xzf "$runtime/release.tar.gz" --no-same-owner --no-same-permissions -C "$runtime/release"
run_owned curl --fail --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 --retry 2 --output "$runtime/node.tar.gz" 'https://nodejs.org/dist/v${provisionNode.version}/${provisionNode.file}'
printf '%s  %s\n' '${provisionNode.sha256}' "$runtime/node.tar.gz" | sha256sum -c >/dev/null 2>&1 || fail 'Downloaded Node runtime checksum mismatch; no downloaded code was run.'
tar -xzf "$runtime/node.tar.gz" --no-same-owner --no-same-permissions --strip-components=1 -C "$runtime/node"
PATH="$runtime/node/bin:$runtime/bin:$PATH"
export PATH
DSH_HOME="$dsh_home"
export DSH_HOME
"$runtime/node/bin/node" --input-type=module -e ${quote(verifyRelease)} "$runtime/release" '${dshVersion}' '${releaseId}'
run_owned "$runtime/node/bin/node" "$runtime/node/lib/node_modules/npm/bin/npm-cli.js" install --global --prefix "$runtime" --ignore-scripts --include=optional --no-audit --no-fund --registry https://registry.npmjs.org '${'@deepseek-ai/dsh@' + dshVersion}' 'pnpm@${pnpmVersion}'
printf '%s\n' "$dsh_home" > "$runtime/dsh-home"
printf '%s\n' '#!/bin/sh' 'set -eu' 'runtime=${shellDollar}{0%/*}' 'IFS= read -r DSH_HOME < "$runtime/dsh-home"' 'export DSH_HOME' 'PATH="$runtime/node/bin:$runtime/bin:$PATH"' 'export PATH' 'exec "$runtime/node/bin/node" "$runtime/bin/dsh" "$@"' > "$runtime/launch-dsh"
chmod 700 "$runtime/launch-dsh"
run_owned "$runtime/node/bin/node" "$runtime/release/install.mjs" --release "$runtime/release" --home "$dsh_home" --dsh "$runtime/launch-dsh" --web --managed-profile "$profile"
printf '%s\n' "$runtime" > "$runtime/ready"
mv "$runtime/ready" "$base.ready"
installed=1
emit
`
  return `exec sh -c ${quote(script)}`
}

/** Validate the complete protocol frame without interpreting shell output as commands.
 * @param output - Bounded SSH stdout from a probe or install.
 * @returns Strict platform and runtime result.
 */
export function parseProvisionProbe(output: string): ProvisionProbe {
  const lines = output.split('\n')
  const start = lines.indexOf(marker)
  const end = lines.indexOf(`${marker}_END`, start + 1)
  if (start < 0 || end < 0 || lines.lastIndexOf(marker) !== start || lines.lastIndexOf(`${marker}_END`) !== end) throw new Error('Remote installation did not report a valid result')
  const fields: Record<string, string> = Object.create(null) as Record<string, string>
  for (const line of lines.slice(start + 1, end)) {
    const match = /^([a-z]+)=([^\0\r\n]*)$/u.exec(line)
    if (match === null || Object.hasOwn(fields, match[1]!)) throw new Error('Invalid remote installation result')
    fields[match[1]!] = match[2]!
  }
  if (Object.keys(fields).sort().join(',') !== 'arch,dsh,installed,libc,node,os,profile'
    || fields.os !== 'Linux' || !['aarch64', 'arm64'].includes(fields.arch!)
    || !/^glibc \d+\.\d+(?:\.\d+)?$/u.test(fields.libc!) || !['0', '1'].includes(fields.installed!)
    || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(fields.profile!)) throw new Error('Unsupported or invalid remote installation result')
  const version = fields.libc!.slice(6).split('.').map(Number)
  if (version[0]! < 2 || version[0] === 2 && version[1]! < 28) throw new Error('Automatic remote installation requires glibc 2.28 or newer')
  const absolute = (value: string): boolean => value.startsWith('/') && !/[\0\r\n]/u.test(value)
  if (fields.installed === '1' && (!absolute(fields.node!) || !absolute(fields.dsh!) || !fields.node!.endsWith('/node/bin/node') || !fields.dsh!.endsWith('/launch-dsh') || fields.node!.slice(0, -14) !== fields.dsh!.slice(0, -11))) throw new Error('Invalid managed remote executable paths')
  return { installed: fields.installed === '1', node: fields.node!, dsh: fields.dsh!, profile: fields.profile! }
}
