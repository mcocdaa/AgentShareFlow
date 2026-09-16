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

node -e '
const fs = require("node:fs");
const source = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const output = {
  name: source.name,
  version: source.version,
  type: "module",
  main: "lib/index.js",
  types: "lib/types/index.d.ts",
  exports: { ".": { types: "./lib/types/index.d.ts", default: "./lib/index.js" } },
  ...(source.dependencies === undefined ? {} : { dependencies: source.dependencies }),
};
fs.writeFileSync(process.argv[2], JSON.stringify(output, null, 2) + "\n");
' "$ROOT/packages/core/package.json" "$CORE_DEST/package.json"

cat > "$CORE_DEST/tsconfig.json" <<'EOF'
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types"
  },
  "include": ["src"]
}
EOF

mkdir -p "$PLUGIN_DEST"
rsync -a --delete --exclude node_modules --exclude lib "$ROOT/packages/dsh-plugin/" "$PLUGIN_DEST/"

node -e '
const fs = require("node:fs");
const file = process.argv[1];
let text = fs.readFileSync(file, "utf8");
const entries = [
  "    { \"path\": \"./packages/community/agentshare-core\" },",
  "    { \"path\": \"./packages/community/dsh-agentshare\" },",
];
let changed = false;
for (const entry of entries) {
  if (text.includes(entry.trim())) continue;
  if (!text.includes("\"references\": [\n")) throw new Error("references block not found");
  text = text.replace("\"references\": [\n", `"references": [\n${entry}\n`);
  changed = true;
}
if (changed) {
  fs.writeFileSync(file, text);
  console.log("wired packages into tsconfig.host.json");
} else {
  console.log("tsconfig.host.json already wired");
}
' "$DSH/tsconfig.host.json"

echo "synced:"
echo "  $CORE_DEST"
echo "  $PLUGIN_DEST"
echo
echo "next:"
echo "  cd $DSH && pnpm install"
echo "  pnpm run build"
echo "  DSH_HOME=<isolated> AGENTSHARE_TOKEN=<relay token> pnpm run dsh web --patch ./packages/community/dsh-agentshare/cordis.source.patch.yml"
