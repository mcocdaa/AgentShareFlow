#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH="${DSH_REPO:-$ROOT/refs/deepseek-harness}"
CORE_DEST="$DSH/packages/community/agentshare-core"
PLUGIN_DEST="$DSH/packages/community/dsh-agentshare"

if [ ! -d "$DSH" ]; then
  echo "missing DeepSeek Harness clone at $DSH" >&2
  echo "clone it there, or set DSH_REPO=/path/to/deepseek-harness" >&2
  exit 1
fi

echo "building @agentshare/core..."
pnpm --filter @agentshare/core build

mkdir -p "$CORE_DEST"
rsync -a --delete "$ROOT/packages/core/src/" "$CORE_DEST/src/"
rsync -a --delete "$ROOT/packages/core/dist/" "$CORE_DEST/dist/"
cp "$ROOT/packages/core/package.json" "$CORE_DEST/package.json"
cp "$ROOT/packages/core/tsconfig.json" "$CORE_DEST/tsconfig.json"

mkdir -p "$PLUGIN_DEST"
rsync -a --delete --exclude node_modules --exclude lib "$ROOT/packages/dsh-plugin/" "$PLUGIN_DEST/"

echo "synced:"
echo "  $CORE_DEST"
echo "  $PLUGIN_DEST"
echo
echo "next:"
echo "  cd $DSH && pnpm install"
echo "  pnpm run dsh web --patch ./packages/community/dsh-agentshare/cordis.source.patch.yml"
