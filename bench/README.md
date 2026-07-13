# Terminal-Bench Integration for Lavalamp

Benchmark lavalamp against Terminal-Bench using the [Harbor framework](https://github.com/harbor-framework/harbor).

## Prerequisites

- **Python ≥ 3.11** (for Harbor)
- **Docker** (Harbor runs tasks in containers)
- **Bun ≥ 1.3.14** (lavalamp runtime)
- **lavalamp** installed and built (`bun run build` in repo root)

## Quick Start

```bash
# 1. Install Harbor
uv tool install harbor
# or: pip install harbor

# 2. Run lavalamp on Terminal-Bench 2.0 (Kimi K2.7 Code via Workers AI — free on your CF account)
harbor run \
  --dataset terminal-bench@2.0 \
  --agent bench.agent:LavalampAgent \
  --model cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code \
  --n-concurrent 4

# 3. Or use a BYOK model (costs real money)
ANTHROPIC_API_KEY=sk-... harbor run \
  --dataset terminal-bench@2.0 \
  --agent bench.agent:LavalampAgent \
  --model anthropic/claude-sonnet-4-20250514 \
  --n-concurrent 4
```

## Architecture

```
Harbor Container
  └─ LavalampAgent (BaseInstalledAgent)
       ├─ install()  → installs bun + lavalamp inside container
       └─ run()      → lavalamp -p "INSTRUCTION" --yes --quiet --output-format json
                        └─ reads cwd, runs tools, edits files, exits
```

The adapter uses lavalamp's **print mode** (`-p`) which:
- Takes a single prompt, executes it non-interactively, and exits
- `--yes` auto-approves all tool calls (required for unattended benchmark runs)
- `--quiet` suppresses status messages
- `--output-format json` returns structured output for trajectory parsing

## Files

| File | Purpose |
|------|---------|
| `agent.py` | Harbor `BaseInstalledAgent` adapter for lavalamp |
| `run.sh` | Convenience wrapper for common benchmark runs |
| `README.md` | This file |

## Configuration

### Model Override

Pass `--model` to Harbor or set `LAVALAMP_MODEL`:

```bash
# Via Harbor CLI
harbor run -d terminal-bench@2.0 -a bench.agent:LavalampAgent -m cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code

# Via env var (forwarded into container)
LAVALAMP_MODEL=openai/gpt-4.1 harbor run -d terminal-bench@2.0 -a bench.agent:LavalampAgent
```

### API Keys

Keys are forwarded into the container via the adapter's `ENV_VARS`:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`
- `CF_ACCOUNT_ID` + `CF_API_TOKEN` (for Workers AI)

### Max Turns

```bash
harbor run -d terminal-bench@2.0 -a bench.agent:LavalampAgent --max_turns 50
```

## Interpreting Results

Harbor writes results to `~/.harbor/results/`. Each trial includes:
- `result.json` — pass/fail, timing, metadata
- `trajectory.json` — ATIF-format step-by-step agent trace
- `logs/` — raw lavalamp output

Use the Harbor viewer to explore results:
```bash
harbor results list
harbor results view <trial-id>
```
