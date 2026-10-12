#!/bin/sh
# Prepare standard DSH entry profiles and Codexy aliases, without launching an app.
# Use an unpacked release, or download the explicitly selected release archive.
set -eu
release_dir=${CODEXY_RELEASE_DIR:-}
if [ -z "$release_dir" ] && [ -n "${CODEXY_RELEASE_URL:-}" ]; then
  release_dir=$(mktemp -d "${TMPDIR:-/tmp}/codexydsh-install.XXXXXXXX")
  trap 'rm -rf "$release_dir"' EXIT HUP INT TERM
  curl --fail --show-error --location --proto '=https' "$CODEXY_RELEASE_URL" --output "$release_dir/release.tar.gz"
  tar -xzf "$release_dir/release.tar.gz" -C "$release_dir"
fi
if [ -z "$release_dir" ]; then
  script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  if [ -f "$script_dir/release.json" ]; then
    release_dir="$script_dir"
  else
    release_dir="$script_dir/.artifacts"
  fi
fi
if [ ! -f "$release_dir/release.json" ]; then
  printf '%s\n' 'Build and pack this checkout first, or set CODEXY_RELEASE_URL to a published release archive.' >&2
  exit 1
fi
node "$release_dir/install.mjs" --release "$release_dir" "$@"
