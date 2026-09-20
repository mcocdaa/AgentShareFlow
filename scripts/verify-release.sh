#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

ARCHIVE_DIR=""
DRY_RUN_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive)
      ARCHIVE_DIR="$2"
      shift 2
      ;;
    --dry-run-only)
      DRY_RUN_ONLY=true
      shift
      ;;
    -h|--help)
      echo "用法: $0 [选项]"
      echo "选项:"
      echo "  --archive <dir>     将打包生成的 tarball 归档至指定目录"
      echo "  --dry-run-only      仅运行 npm publish --dry-run 检查，跳过 tarball 校验"
      echo "  -h, --help          显示帮助信息"
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      exit 1
      ;;
  esac
done

echo "==> [AgentShareFlow] 1. 运行完整代码质量门禁 (Typecheck, Unit tests, Build)..."
bash "$SCRIPT_DIR/check.sh"

if [ "$DRY_RUN_ONLY" = true ]; then
  echo "==> [AgentShareFlow] 2. 模拟发布 (publish dry-run)..."
  pnpm --filter @agentshare/core publish --dry-run --no-git-checks
  pnpm --filter @agentshare/cli publish --dry-run --no-git-checks
  echo "✓ 模拟发布预检通过！"
  exit 0
fi

echo "==> [AgentShareFlow] 2. 验证 @agentshare/core 与 @agentshare/cli 打包产物与规范..."
TMP_PACK_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_PACK_DIR"
}
trap cleanup EXIT

# 打包 @agentshare/core
pnpm --filter @agentshare/core pack --pack-destination "$TMP_PACK_DIR" > /dev/null
CORE_TGZ="$(find "$TMP_PACK_DIR" -name "agentshare-core-*.tgz" | head -n 1)"
if [ -z "$CORE_TGZ" ]; then
  echo "❌ 错误: 未生成 @agentshare/core tarball" >&2
  exit 1
fi
CORE_SIZE="$(stat -c%s "$CORE_TGZ")"
echo "  ✓ @agentshare/core 打包成功: $(basename "$CORE_TGZ") (${CORE_SIZE} 字节)"

# 检查 core tarball 必要文件（避免 pipefail 下 grep -q 导致 SIGPIPE 141）
CORE_CONTENTS="$(tar -tf "$CORE_TGZ")"
echo "$CORE_CONTENTS" | grep -F "package/dist/index.js" > /dev/null || { echo "❌ @agentshare/core 缺少 dist/index.js"; exit 1; }
echo "$CORE_CONTENTS" | grep -F "package/dist/index.d.ts" > /dev/null || { echo "❌ @agentshare/core 缺少 dist/index.d.ts"; exit 1; }
echo "$CORE_CONTENTS" | grep -F "package/package.json" > /dev/null || { echo "❌ @agentshare/core 缺少 package.json"; exit 1; }
echo "$CORE_CONTENTS" | grep -F "package/README.md" > /dev/null || { echo "❌ @agentshare/core 缺少 README.md"; exit 1; }

# 打包 @agentshare/cli
pnpm --filter @agentshare/cli pack --pack-destination "$TMP_PACK_DIR" > /dev/null
CLI_TGZ="$(find "$TMP_PACK_DIR" -name "agentshare-cli-*.tgz" | head -n 1)"
if [ -z "$CLI_TGZ" ]; then
  echo "❌ 错误: 未生成 @agentshare/cli tarball" >&2
  exit 1
fi
CLI_SIZE="$(stat -c%s "$CLI_TGZ")"
echo "  ✓ @agentshare/cli 打包成功: $(basename "$CLI_TGZ") (${CLI_SIZE} 字节)"

# 检查 cli tarball 必要文件
CLI_CONTENTS="$(tar -tf "$CLI_TGZ")"
echo "$CLI_CONTENTS" | grep -F "package/dist/index.js" > /dev/null || { echo "❌ @agentshare/cli 缺少 dist/index.js"; exit 1; }
echo "$CLI_CONTENTS" | grep -F "package/package.json" > /dev/null || { echo "❌ @agentshare/cli 缺少 package.json"; exit 1; }
echo "$CLI_CONTENTS" | grep -F "package/README.md" > /dev/null || { echo "❌ @agentshare/cli 缺少 README.md"; exit 1; }

echo "==> [AgentShareFlow] 3. 模拟发布 (publish dry-run 验证元数据与 workspace 解析)..."
pnpm --filter @agentshare/core publish --dry-run --no-git-checks
pnpm --filter @agentshare/cli publish --dry-run --no-git-checks

if [ -n "$ARCHIVE_DIR" ]; then
  mkdir -p "$ARCHIVE_DIR"
  cp "$CORE_TGZ" "$ARCHIVE_DIR/"
  cp "$CLI_TGZ" "$ARCHIVE_DIR/"
  echo "==> [AgentShareFlow] 4. Tarball 已成功归档至: $ARCHIVE_DIR"
  ls -lh "$ARCHIVE_DIR"
fi

echo
echo "========================================================"
echo "✓ 全部发布预检通过！"
echo "  - @agentshare/core 与 @agentshare/cli 打包产物完整"
echo "  - TypeScript 声明文件、入口、bin 均符合 npm 规范"
echo "  - publish --dry-run 验证 workspace 依赖解析正常"
echo "========================================================"
