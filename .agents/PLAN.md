# PLAN.md — lavalamp

> The roadmap for building a **Cloudflare-native, local AI coding harness**.
> Read **`AGENTS.md`** first — it holds the architecture, the verified API, the
> stack, and the current status. This file is the _plan_: milestones, philosophy,
> risks, and open questions.

---

## 1. North star

A developer runs one command, **logs in with their Cloudflare account**, and gets a
terminal coding agent that builds software **on their own machine** using **Workers AI**
models billed to **them** (BYOK for anything else). It feels like Cloudflare shipped its own
OpenCode/Claude Code.

**The product is the harness, not the model.** We win on everything _around_ the model:

1. **Reliable edits** across weak/cheap models (hash-anchored patches).
2. A **small composable tool surface** the model learns instantly.
3. A **real permission model** users trust.
4. **First-class Cloudflare** login + Workers AI integration.
5. A **great TUI** with streaming, diffs, vim bindings, session management.

---

## 2. Build order (milestones)

### M0 — Scaffold & core harness loop [DONE]

- [x] `src/agents/build.ts`: `createAgent` with Workers AI model + `local()` sandbox.
- [x] In-process driver → prompt → streamed output.
- **Exit:** agent reads a file and proposes an edit, end-to-end.

### M1 — Reliable edits + real tool surface [DONE]

- [x] **`@oh-my-pi/hashline`** as the `edit` tool engine.
- [x] `write`, `rename`, `read`, `grep`, `glob`, `bash` tools.
- [x] Custom TUI with IPC, steering/queue, autocomplete, @file/#skill mentions.
- **Exit:** edits succeed reliably with no retry loops.

### M2 — Cloudflare login [DONE]

- [x] Wrangler OAuth reuse (primary) + manual paste (fallback).
- [x] `registerProvider('cloudflare-workers-ai', ...)` at startup.
- [x] Credential validation + storage at `~/.config/lavalamp/credentials`.
- **Exit:** user logs in and runs a Workers AI model on their own account.

### M2.5 — Tool surface expansion [DONE]

- [x] `web_search`, `fetch_url`, `deepwiki`, `codebase_search`
- [x] `oracle`, `doom_loop`, `ripgrep`
- [x] `rename`, `undo`, `history` with ChangeTracker
- [x] `sessions`, `session_context`, `memory_read`, `memory_write`, `memory_append`
- [x] Task management: `create_task`, `start_task`, `complete_task`, `edit_task`, `delete_task`, `skip_task`, `list_tasks`
- [x] Skill system: `#` prefix with autocomplete, `.agents/skills/` discovery
- [x] Slash commands: `/help`, `/clear`, `/compact`, `/sessions`, `/memory`, `/model`, `/workspace`, `/skills`, `/mcp`, `/tools`, `/plan`, `/copy`, `/undo`, `/quit`
- [x] Plan mode (`/plan` + Shift+Tab) with teal accent
- [x] Session transcript `/copy` to clipboard

### M3 — OpenTUI-based TUI [DONE]

- [x] Replaced Rezi with `@opentui/core` (imperative TypeScript API).
- [x] Two-process IPC architecture: TUI spawns `dist/server.mjs` as child process.
- [x] Streaming markdown via `MarkdownRenderable` (streaming + conceal modes).
- [x] Collapsible thinking blocks (purple, merged across consecutive rounds).
- [x] Collapsible tool groups (green/red, closed by default, generic grouping).
- [x] Inline diffs for edit/write via `DiffRenderable` (unified view).
- [x] Inline code for read via `CodeRenderable` (syntax highlighting).
- [x] Full-screen diff viewer with vim bindings (`:q`, j/k, g/G, Ctrl+D/U, Ctrl+F/B).
- [x] Full-screen code viewer with syntax highlighting.
- [x] Clickable file path links (purple, underlined).
- [x] Multiline input (`TextareaRenderable`) — Enter sends, Shift+Enter newline.
- [x] Dynamic input height (1-6 rows) via word-wrap estimation.
- [x] Autocomplete: `/commands`, `@files`, `#skills` with fuzzy search popup.
- [x] Up/Down command history cycling.
- [x] Plan mode toggle (Shift+Tab) with accent color swap.
- [x] Queue panel for queued/steered prompts.
- [x] Task panel with status icons (`[ ]`/`[>]`/`[x]`/`[-]`).
- [x] Confirmation panel (yellow border) for Ctrl+C exit.
- [x] Result panel for slash command output (replaces inline pollution).
- [x] Session picker with arrow-key navigation.
- [x] Lava lamp ASCII animation (4 frames, 600ms cycle).
- [x] Spinner (braille animation) merged into status bar.
- [x] Session auto-save on every stream finalize.
- [x] Session resume via `--continue [id]` CLI flag.
- [x] Messages persist thinking + toolCalls for full replay on resume.
- [x] Fatal error handler saves session and prints resume command.
- [x] `-p` print mode with stdin piping, JSON output, quiet flag.
- [x] Design system: Red, Accent, Blue, Pink, Green, Cyan, Warn, Link color tokens.
- **Exit:** full coding session driven entirely from the TUI.

### M4 — Permission engine [DONE]

- [x] Rule engine (allow/ask/deny, per-tool, per-arg substring matching).
- [x] Autorun state persisted in `.lavalamp/autorun.json` with status bar indicator.
- [x] `/autorun`, `/sudo`, and `/permissions` TUI commands.
- [x] Command/pattern-based always-allow and dangerous allow-everything sudo toggle.
- [x] Safe defaults for read-only vs destructive/risky tools.
- [x] PermissionBox approval UI with bidirectional IPC gating around tool execution.
- [x] Sandbox-level permission wrapping (bash, write gated via IPC).
- [x] Custom tool wrapping via `gate()` in build agent.
- [x] Auto-deny timeout (30s) for unattended permission requests.
- [x] User-configurable rules via `.lavalamp/rules.json`.
- **Exit:** destructive ops prompt; read-only ops flow freely; rules user-configurable.

### M5 — Agent roster + parallel subagents [DONE]

- [x] `deploy_parallel_subs` tool (up to 3 concurrent research agents).
- [x] `SubAgentManager` orchestration module.
- [x] Subagent panel and `/subagents` command.
- [x] Auto-merge results back to the main agent.
- [x] `explore`, `plan`, `research`, `review` profiles + `task` dispatch + capability boundaries.
- [x] **spec-mode approval gate** (plan → approve → build).
- [x] Bundle our skills; load user-global + project-local skill dirs.
- [x] **Mixture of Experts (MoE)** — specialized experts (ui, refactor, logic, database, oracle, research, critique, spectacle) with distinct preferred models, toolkits, thinking levels, and output contracts; roster in `src/config/experts.ts`, factory in `src/config/create-expert-agent.ts`, routed via `query_expert`.
- **Exit:** `build` delegates exploration/planning/review/expert tasks; main context stays clean.

### M5.5 — Session safety & memory

- [x] **Checkpoint / undo / rewind** — file backups per turn; revert from the TUI.
- [x] **Rules / steering** — inject context dynamically when pattern matches prompt.
- [x] **Headless mode** — single-shot `-p` and interactive `--repl` REPL with stdin piping, `--output-format json|text`, `--quiet`, `--yes` auto-approve, interactive permission prompts, `/exit`/`/clear`/`/help` commands. See `src/run.ts`.
- [x] **Live bash output streaming** — child process stdout/stderr stream over IPC in real time (`bash_stream` messages); rendered live in the TUI tool panel and streamed to stdout/stderr in headless `-p`/`--repl` modes.
- **Exit:** users can safely undo agent changes and carry memory between sessions.

### M6 — spectacle (vision bridge) [DONE]

- [x] Model **capability table** (`@cf/...` → vision/tools/ctx) in `src/config/models.ts` (`MODEL_REGISTRY`/`CAPABILITIES`).
- [x] TUI image paste and Spectacle bridge (Cloudflare Vision API via `llama-4-scout-17b-16e-instruct`, fallback `llama-3.2-11b-vision-instruct`).
- [x] **Capability-driven auto-routing** — when the active model has `vision: true`, images are passed directly as `PromptImage[]` to the model (no text bridge); non-vision models fall back to the spectacle text bridge.
- [x] **IPC image passthrough** — post-build `build/patch-server.ts` patches `dist/server.mjs` so `parseIpcAgentMessage` extracts `images` and `invokeDirectAttached` forwards them.
- [x] In-memory hash cache for repeated image descriptions.
- **Exit:** pasting and attaching a screenshot works on both vision and non-vision models.

### M7 — LSP

- [x] `lsp_hover` + `lsp_definition` over a real language server (`textDocument/hover`, `textDocument/definition`) in `src/tools/lsp-client.ts`.
- [ ] `lsp_references`, `lsp_rename`, `lsp_diagnostics` tools (not yet implemented).
- [ ] Wire **oxc** (`oxlint --lsp`) as fast supplementary JS/TS diagnostics + autofix.
- [ ] Feed diagnostics back to the model after each edit.
- **Exit:** edits get type/lint feedback in-loop.

### M8 — Polish & distribution

- [x] Release hardening: package bin points at `bin/lavalamp`, shell args preserve quoted prompts, install PATH uses `INSTALL_DIR`, runtime permission state is ignored.
- [x] Config/model UX: persisted config, model listing, AI Gateway opt-in, Gateway routes, headless JSON route metadata, and TUI neuron meter.
- [x] Interactive auth preflight: validate/reauthenticate Cloudflare before opening the TUI when the selected route needs Cloudflare.
- [x] Move runtime backups/steering out of the workspace into OS-native lavalamp data storage; create backups only at mutating tool start, and only for concrete target paths.
- [ ] Live Workers AI catalog refresh instead of a curated static model registry.
- [ ] AI Gateway spend/log deep links and account-side observability UX.
- [ ] Final release packaging.

### Later / out of v1

- Cloudflare Sandbox containers ("run in the cloud" — needs Workers Paid).
- Worktree isolation for parallel sessions/subagents.
- **scribe** agent, PR automation.
- **Daemon mode** (Flue over HTTP for remote sessions).
- Optional **RAG**: `bge-m3` embeddings + `bge-reranker-base`.
- Optional **voice** I/O: `whisper` + `aura-2`/`melotts`.
- Optional **safety guardrail**: `llama-guard-3-8b`.

---

## 3. Risks & mitigations

| Risk                                          | Mitigation                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| Wrangler on-disk token format is undocumented | Best-effort parse + version sniff; manual paste always available.               |
| Weak Workers AI models fail edits             | `@oh-my-pi/hashline` is exactly the fix; benchmark edit reliability per model.  |
| Workers AI free-tier limits                   | Surface usage meter; BYOK + AI Gateway spend limits as escape hatches.          |
| Non-vision default models + image input       | spectacle auto-bridge (M6) driven by capability table.                          |
| OpenTUI alpha/beta API churn                  | Pin exact `@opentui/core` version; isolate behind `src/tui/` module boundaries. |
| `@flue/runtime` is beta (API churn)           | Pin versions; re-verify on upgrade.                                             |
| Two-process IPC overhead                      | Acceptable for TUI use case; streaming events are low-latency.                  |

---

## 4. Open questions

1. ~~**Permission engine design** — Amp-style sequential rules vs simpler deny-list?~~ _(resolved by M4 — Amp-style sequential rules shipped.)_
2. ~~**review vs plan model split** — unify on one reasoning model or keep separate?~~ _(resolved by M5 — separate profiles shipped; all overridable.)_
3. ~~**spectacle default tier** — code currently uses `llama-3.2-11b-vision`; `llama-4-scout` (stronger) was the alternative. Still open alongside the auto-routing gap.~~ _(resolved by M6 — `llama-4-scout-17b-16e-instruct` is the primary spectacle model with `llama-3.2-11b-vision-instruct` as fallback; capability-driven auto-routing ships vision images directly to vision-capable models.)_
4. ~~**AI Gateway: default-on or opt-in?**~~ _(resolved by M8 — opt-in for v1.)_
5. ~~**Live bash output streaming** — tap into child process stdout during tool execution for real-time terminal output in TUI. Currently bash output only appears after command completes.~~ _(resolved by M5.5 — `bash_stream` IPC messages stream stdout/stderr in real time to the TUI tool panel and to headless stdout/stderr.)_
