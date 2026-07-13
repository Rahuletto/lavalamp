# Terminal-Bench Integration for Lavalamp

Benchmark lavalamp against Terminal-Bench using the [Harbor framework](https://github.com/harbor-framework/harbor).

## Prerequisites

- **Python ≥ 3.11** (for Harbor)
- **Docker** (Harbor runs tasks in containers)
- **Bun ≥ 1.3.14** (lavalamp runtime — installed automatically inside containers)
- **lavalamp** built (`bun run build` in repo root)

## Quick Start

```bash
# 1. Install Harbor
uv tool install harbor
# or: pip install harbor

# 2. Run lavalamp on Terminal-Bench 2.1 (GLM 4.7 Flash via Workers AI — free on your CF account)
CF_ACCOUNT_ID=xxx CF_API_TOKEN=xxx \
harbor run \
  --dataset terminal-bench/terminal-bench-2-1 \
  --agent bench.agent:LavalampAgent \
  --model cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash \
  --n-concurrent 4

# 3. Or use a BYOK model (costs real money)
ANTHROPIC_API_KEY=sk-... harbor run \
  --dataset terminal-bench/terminal-bench-2-1 \
  --agent bench.agent:LavalampAgent \
  --model anthropic/claude-sonnet-4-20250514 \
  --n-concurrent 4
```

## Architecture

```
Harbor Docker Container
  └─ LavalampAgent (BaseInstalledAgent, ATIF=True)
       ├─ install()                → apt + bun + git clone lavalamp + bun install + bun run build
       ├─ run()                    → lavalamp -p "INSTRUCTION" --sudo --quiet --output-format json
       │                             └─ copies session JSON out of container for trajectory
       └─ populate_context_post_run() → parses session.json → ATIF Trajectory (Steps + ToolCalls)
```

The adapter uses lavalamp's **print mode** (`-p`) which:
- Takes a single prompt, executes it non-interactively, and exits
- `--sudo` dangerously auto-approves all tool calls for the headless run. It does not elevate the operating-system user.
- `--quiet` suppresses status messages
- `--output-format json` returns structured output for trajectory parsing

## ATIF Trajectory Support

`SUPPORTS_ATIF = True` — after each run, the adapter:
1. Reads lavalamp's session JSON from `~/.local/share/lavalamp/sessions/` inside the container
2. Converts `Message[]` → ATIF `Step[]` with `ToolCall`, `Observation`, reasoning content
3. Populates `context.trajectory` for verified leaderboard submission

## Files

| File | Purpose |
|------|---------|
| `agent.py` | Harbor `BaseInstalledAgent` adapter with ATIF trajectory support |
| `run.sh` | Convenience wrapper for common benchmark runs |
| `README.md` | This file |

## Configuration

### Model Override

```bash
# Via Harbor CLI
harbor run -d terminal-bench/terminal-bench-2-1 -a bench.agent:LavalampAgent \
  -m cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash

# Via env var
LAVALAMP_MODEL=openai/gpt-4.1 harbor run -d terminal-bench/terminal-bench-2-1 -a bench.agent:LavalampAgent
```

### API Keys

Forwarded into the container via the adapter's `ENV_VARS`:

- `CF_ACCOUNT_ID` + `CF_API_TOKEN` (Workers AI — Kimi K2.7 Code)
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`

## Leaderboard Submission

1. Run the benchmark: `./bench/run.sh`
2. Results saved to `~/.harbor/results/`
3. Fork [harborframework/terminal-bench-2-leaderboard](https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard)
4. Add results to `submissions/terminal-bench/2.1/lavalamp__kimi-k2.7-code/`
5. Open PR → verified review → published on [tbench.ai](https://tbench.ai)
