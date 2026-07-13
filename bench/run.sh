#!/usr/bin/env bash
set -euo pipefail

# run.sh — Quick runner for Terminal-Bench with lavalamp
#
# Usage:
#   ./bench/run.sh                                    # defaults: TB 2.0, default model
#   ./bench/run.sh --model anthropic/claude-sonnet-4-20250514  # override model
#   ./bench/run.sh --dataset terminal-bench@3.0       # different dataset
#   ./bench/run.sh --concurrent 8                     # parallelism

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${SCRIPT_DIR}/.."

# Defaults
DATASET="terminal-bench@2.0"
MODEL="${LAVALAMP_MODEL:-}"
CONCURRENT=4
EXTRA_ARGS=()

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--dataset)
      DATASET="$2"; shift 2 ;;
    -m|--model)
      MODEL="$2"; shift 2 ;;
    -n|--concurrent)
      CONCURRENT="$2"; shift 2 ;;
    -h|--help)
      cat <<'EOF'
Terminal-Bench runner for lavalamp

USAGE:
  ./bench/run.sh [OPTIONS]

OPTIONS:
  -d, --dataset DATASET    Benchmark dataset (default: terminal-bench@2.0)
  -m, --model MODEL        Model to use (default: LAVALAMP_MODEL env or harness default)
  -n, --concurrent N       Concurrent trials (default: 4)
  -h, --help               Show this help

EXAMPLES:
  ./bench/run.sh
  ./bench/run.sh -m cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code -n 8
  ./bench/run.sh -d terminal-bench@3.0
  ANTHROPIC_API_KEY=sk-... ./bench/run.sh -m anthropic/claude-sonnet-4-20250514
EOF
      exit 0
      ;;
    *)
      EXTRA_ARGS+=("$1"); shift ;;
  esac
done

# Validate prerequisites
echo "🔍 Checking prerequisites..."

if ! command -v harbor &> /dev/null; then
  echo "❌ Harbor not found. Install with: uv tool install harbor (or pip install harbor)"
  exit 1
fi
echo "  ✓ harbor $(harbor --version 2>/dev/null || echo 'installed')"

if ! command -v docker &> /dev/null; then
  echo "❌ Docker not found. Harbor requires Docker for container-based evaluation."
  exit 1
fi
echo "  ✓ docker"

if ! command -v bun &> /dev/null; then
  echo "❌ Bun not found. lavalamp requires bun >= 1.3.14"
  exit 1
fi
echo "  ✓ bun $(bun --version)"

# Check that lavalamp builds
if [ ! -f "${REPO_DIR}/dist/server.mjs" ]; then
  echo "⚠️  dist/server.mjs not found. Building..."
  (cd "$REPO_DIR" && bun run build)
fi
echo "  ✓ lavalamp built"

echo ""
echo "🚀 Running Terminal-Bench"
echo "   Dataset:    ${DATASET}"
echo "   Model:      ${MODEL:-<harness default>}"
echo "   Concurrent: ${CONCURRENT}"
echo ""

# Build the harbor command
CMD=(harbor run
  --dataset "$DATASET"
  --agent "bench.agent:LavalampAgent"
  --n-concurrent "$CONCURRENT"
)

if [ -n "$MODEL" ]; then
  CMD+=(--model "$MODEL")
fi

CMD+=("${EXTRA_ARGS[@]}")

# Run from repo root so the bench package is importable
cd "$REPO_DIR"
export PYTHONPATH="${REPO_DIR}:${PYTHONPATH:-}"

echo "$ ${CMD[*]}"
exec "${CMD[@]}"
