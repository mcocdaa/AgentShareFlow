#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"
echo "==> [AgentShareFlow] Typecheck..."
pnpm typecheck
echo "==> [AgentShareFlow] Unit tests..."
pnpm test
echo "==> [AgentShareFlow] Build verification..."
pnpm build
echo "✓ 全部检查通过 (AgentShareFlow)"
