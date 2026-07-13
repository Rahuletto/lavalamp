#!/usr/bin/env bash
set -euo pipefail

# run.sh — Quick runner for Terminal-Bench with lavalamp
#
# Usage:
#   ./bench/run.sh                                    # defaults: TB 2.1, default model
#   ./bench/run.sh --model cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code
#   ./bench/run.sh --dataset terminal-bench@3.0       # different dataset
#   ./bench/run.sh --concurrent 8                     # parallelism

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${SCRIPT_DIR}/.."

# Defaults
DATASET="terminal-bench/terminal-bench-2-1"
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
  -d, --dataset DATASET    Benchmark dataset (default: terminal-bench/terminal-bench-2-1)
  -m, --model MODEL        Model to use (default: LAVALAMP_MODEL env or harness default)
  -n, --concurrent N       Concurrent trials (default: 4)
  -h, --help               Show this help

EXAMPLES:
  ./bench/run.sh
  ./bench/run.sh -m cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash -n 8
  ./bench/run.sh -d terminal-bench/terminal-bench-2-1
  CF_ACCOUNT_ID=xxx CF_API_TOKEN=xxx ./bench/run.sh
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
if ! docker info &> /dev/null; then
  echo "❌ Docker daemon not running. Start Docker and try again."
  exit 1
fi
echo "  ✓ docker (daemon running)"

if ! command -v bun &> /dev/null; then
  echo "⚠️  Bun not found locally (will be installed inside containers)"
else
  echo "  ✓ bun $(bun --version)"
fi

# Check that lavalamp builds
if [ ! -f "${REPO_DIR}/dist/server.mjs" ]; then
  echo "⚠️  dist/server.mjs not found. Building..."
  (cd "$REPO_DIR" && bun run build)
fi
echo "  ✓ lavalamp built"

# Warn about missing CF credentials for Workers AI
if [ -z "${CF_ACCOUNT_ID:-}" ] || [ -z "${CF_API_TOKEN:-}" ]; then
  if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ] && [ -z "${OPENROUTER_API_KEY:-}" ]; then
    echo ""
    echo "⚠️  No API credentials detected!"
    echo "   For Workers AI (Kimi K2.7): export CF_ACCOUNT_ID=xxx CF_API_TOKEN=xxx"
    echo "   For BYOK: export ANTHROPIC_API_KEY=xxx (or OPENAI/OPENROUTER)"
    echo ""
  fi
fi

echo ""
echo "🚀 Running Terminal-Bench"
echo "   Dataset:    ${DATASET}"
echo "   Model:      ${MODEL:-<harness default>}"
echo "   Concurrent: ${CONCURRENT}"
echo "   ATIF:       ✓ enabled (verified submission)"
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
