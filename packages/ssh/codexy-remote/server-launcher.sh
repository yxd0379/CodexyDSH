#!/bin/sh
set -eu
server_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PATH="$server_root/node/bin:$PATH"
export PATH
exec "$server_root/node/bin/node" "$server_root/dsh/lib/bin.js" "$@"
