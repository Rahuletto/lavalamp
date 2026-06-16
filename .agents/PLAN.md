# PLAN.md — lavalamp

> The roadmap for building a **Cloudflare-native, local AI coding harness** on
> **Flue + Rezi**. Read **`AGENTS.md`** first — it holds the architecture, the verified
> Flue API, the locked-in stack, and the model assignments. This file is the *plan*:
> philosophy, the agent roster, the plugin/permission designs, milestones, risks, and the
> decisions still open.

---

## 1. North star

A developer runs one command, **logs in with their Cloudflare account**, and gets a
terminal coding agent that builds software **on their own machine** using **Workers AI**
models billed to **them** (BYOK for anything else). It feels like Cloudflare shipped its own
OpenCode/Claude Code.

**The product is the harness, not the model.** We assume models are commodity and
swappable. We win on everything *around* the model:

1. **Reliable edits** across weak/cheap models (hash-anchored patches).
2. A **small composable tool surface** the model learns instantly.
3. A **roster of specialized agents** that keep the main context window clean.
4. A **real permission model** users trust.
5. A **plugin system** so the community extends us instead of forking us.
6. **First-class Cloudflare** login + Workers AI integration.

---

## 2. The formula we're copying (OpenCode / Amp / Pi / Factory) — and how we apply it

| # | Principle | Why it matters | How lavalamp does it |
| - | --------- | -------------- | -------------------- |
| 1 | **Composable primitives, not bespoke tools** | Every extra tool burns the model's attention budget learning your API. Pi's stance: "PRs are paths; `read` already handles them." | Tool surface is exactly `read write edit rename list glob grep bash lsp task`. No `gh_*`, no per-service tools — those become **MCP plugins**. |
| 2 | **Reliable edits = #1 quality lever** | Naive string-replace fails on whitespace/stale files; agents loop on "string not found." Pi's hashline measured ~10× pass-rate and 61% fewer output tokens. | Depend on **`@oh-my-pi/hashline`** as the `edit` engine. Don't reinvent. |
| 3 | **Subagents multiply context** | Keep 50k tokens of failed debugging / huge grep output **out of the main thread**; only the clean summary returns. | `build` delegates to read-only subagents via `session.task`. Each runs in isolated context (§4). |
| 4 | **Plan/spec phase before edits** | An agent 50 tool-calls into the wrong approach is expensive. Catch it at the cheapest point. | `plan` agent + `spec-mode` skill + an **approval gate** in the TUI before `build` mutates anything. |
| 5 | **Real permission model** | Trust + safety; prevents runaway/destructive actions and prompt-injection. | Amp-style rule engine with **safe defaults** (§7). |
| 6 | **LSP feedback after edits** | Catch type/lint errors in-loop instead of three turns later. | `lsp` tool over real language servers + **oxc** for fast JS/TS diagnostics (§ milestone M7). |
| 7 | **Context engineering > prompt engineering** | `AGENTS.md` + on-demand skills beat a bloated permanent system prompt. | Flue auto-reads `AGENTS.md` + `.agents/skills/`; we ship curated skills + 3-layer skill loading. |
| 8 | **Model is replaceable** | Never bet the product on one model/provider. | Per-agent model defaults + tier-swap menu + BYOK, all via `registerProvider`. |

---

## 3. Mental model of one turn (where the parts meet)

```diagram
TUI prompt
   │  session.prompt(text [, images])
   ▼
build (orchestrator, kimi-k2.7-code)
   │  reasons, streams text_delta → TUI
   ├─▶ tool call ─▶ PERMISSION ENGINE ─▶ allow/ask/deny/delegate ─▶ sandbox(local) ─▶ result
   ├─▶ session.task('map the auth flow', { agent:'explore' })  ──▶ isolated ctx ──▶ summary
   ├─▶ session.task('design the change',  { agent:'plan'    })  ──▶ spec ──▶ APPROVAL GATE
   ├─▶ (image + blind model) ─▶ session.task(img, { agent:'spectacle' }) ─▶ text description
   └─▶ session.task('review this diff',   { agent:'review'  })  ──▶ findings
   │
   ▼  observe() streams every event to the TUI (text/thinking/tool/task/idle…)
assistant result + diffs rendered
```

---

## 4. Agent roster (the multi-agent system)

One **orchestrator** (`build`) delegates to **specialized subagents**. Subagents are
**read-only by default** and run in isolated context so their token churn never pollutes the
main thread — only their summary returns. Model defaults are verified Workers AI IDs from
`AGENTS.md §7`; all are overridable.

```diagram
                          ╭───────────────────────────────╮
                          │  build  — orchestrator        │  full tools · owns approval gate
                          │  @cf/moonshotai/kimi-k2.7-code│  (vision ✅)
                          ╰───────────────┬───────────────╯
     ┌───────────┬──────────────┬─────────┼──────────────┬───────────────┬──────────────┐
     ▼           ▼              ▼         ▼              ▼               ▼              ▼
 ╭────────╮ ╭─────────╮  ╭───────────╮ ╭──────────╮ ╭──────────╮  ╭───────────╮ ╭──────────╮
 │explore │ │  plan   │  │ research  │ │  review  │ │spectacle │  │  scribe   │ │ plugins  │
 ╰────────╯ ╰─────────╯  ╰───────────╯ ╰──────────╯ ╰──────────╯  ╰───────────╯ ╰──────────╯
 glm-4.7-   glm-5.2      llama-3.3-70b  gpt-oss-120b llama-4-      llama-3.2-3b   (3rd-party
 flash      (plan/spec)  -fp8-fast      (review)     scout (👁)    (post-v1)      subagents)
 (map code) read-only    web+docs       read-only    img→text      docs/commits
```

| Agent | Role | Capability boundary (tools) | Default model | Vision |
| ----- | ---- | --------------------------- | ------------- | :----: |
| **build** | Primary orchestrator; writes code, runs commands, delegates, owns the approval gate | **full**: read/write/edit/rename/list/glob/grep/bash/lsp/task | `@cf/moonshotai/kimi-k2.7-code` | ✅ |
| **explore** | "Where is X? How does Y flow?" — maps the codebase, returns a structured summary | read-only: read/grep/glob/list/lsp | `@cf/zai-org/glm-4.7-flash` (cheap, 131k ctx) | ❌ |
| **plan** | Produces an implementation spec; **cannot edit** — output feeds the approval gate | read-only: read/grep/glob/list/lsp | `@cf/zai-org/glm-5.2` (agentic coding) | ❌ |
| **research** | External knowledge: library docs, web, API references | web_search / read_web_page (+ read) | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | ❌ |
| **review** | Adversarial review of a diff/change; returns findings only (Amp-Oracle role) | read-only: read/grep/glob/list/lsp/bash(read-only) | `@cf/openai/gpt-oss-120b` (reasoning) | ❌ |
| **spectacle** | **Vision bridge**: turn images into faithful text for blind models | (vision input only; no fs tools) | `@cf/meta/llama-4-scout-17b-16e-instruct` | ✅ |
| **scribe** *(post-v1)* | Commit messages, changelog, doc tidy-ups | read + write(docs only) + bash(git) | `@cf/meta/llama-3.2-3b-instruct` | ❌ |

**Design rules:**
- Only `build` (and `scribe`, narrowly) mutate state. Everything else is read-only —
  enforced by the permission engine, not just by prompt.
- `plan` → spec → **TUI approval gate** → `build` implements. (spec-mode skill drives this.)
- `review` runs on a change set **before "done"**; `build` decides what findings to act on.
- `spectacle` is invoked **automatically** when an image is attached and the target model
  lacks vision — driven by a model-capability table the harness maintains. Also callable
  explicitly. Cache descriptions by image hash.
- Each agent's model is overridable (per-config and via plugins) so users route cheap work
  to fast models and reasoning to stronger/BYOK models.

### Skills (3 layers)
1. **Bundled (ours):** `spec-mode`, `commit`, `review`, `debug`, `pr` — our differentiation.
2. **User-global:** `~/.config/lavalamp/skills/*/SKILL.md`.
3. **Project-local:** `<cwd>/.agents/skills/*/SKILL.md` (Flue auto-discovers).

---

## 5. Model strategy

- **Default to Workers AI**, billed to the user's own account. Surface neuron/credit usage
  in the TUI (free tier ≈ 10k neurons/day; then ~$0.011/1k neurons).
- **Capability table**: the harness keeps a map of `@cf/...` id → `{ vision, functionCalling,
  reasoning, contextWindow }` (sourced from the catalog). Used for: spectacle routing,
  warning when an agent's model lacks tool-calling, and the model picker UI.
- **Tier-swap menu** (per agent): premium-coding / reasoning / fast-cheap / code-specialist /
  vision lists in `AGENTS.md §7`.
- **BYOK**: same `registerProvider` path pointed at Anthropic/OpenAI/OpenRouter with the
  user's own key. Enables routing `plan`/`review` to a stronger closed model if desired.
- **AI Gateway (opt-in, M8)**: route through the user's own gateway for caching, spend
  limits, and logs — all on their account, zero server code for us.

---

## 6. Plugin system plan (extensibility like Claude Code / Codex)

A plugin is an npm package or local dir default-exporting `definePlugin({...})`. Flue
supplies the primitives; **we build the host**. Full contribution table + API in
`AGENTS.md §11`. Key plan points:

- **Contributions**: `tools` (defineTool), `subagents` (defineAgentProfile), `skills`,
  `commands` (TUI slash commands), `hooks` (lifecycle), `providers` (registerProvider),
  `mcpServers` (connectMcpServer), `permissions` (default rules).
- **MCP is the interop standard** — any MCP server becomes a plugin via `connectMcpServer`.
  This is how we get "all the integrations" without bespoke tools (principle #1).
- **Hooks**: read-only hooks ride on `observe()`; mutating/veto hooks (`onBeforeTool`) run
  through the permission engine.
- **Loading & precedence**: bundled → user-global → project-local; user config always wins.
- **Security**: plugin code is untrusted — its tools/hooks run under the permission engine;
  plugins can never auto-modify harness config or credentials.

---

## 7. Permission model plan

Amp-style rule engine (full spec in `AGENTS.md §10`):

- Sequential rules, first match wins: `{ tool, matches:{arg:glob|regex|list}, action:allow|ask|deny|delegate }`.
- `delegate` → external program decides (JSON on stdin, exit code out).
- **Safe defaults out of the box** (unlike Amp's off-by-default): read/grep/glob/list free;
  **ask** before destructive bash + edits outside project root.
- **Self-protection**: never auto-allow writes to permission config / harness config / creds.
- Implemented as a wrapper around each tool's `execute` (Flue has no native pre-tool veto).
- Config lives in `~/.config/lavalamp/config` (global) + `<cwd>/.lavalamp/config` (project override).

---

## 8. Build order (milestones)

### M0 — Scaffold & core harness loop  ⟵ DONE
- [x] `src/agents/build.ts`: `createAgent` with a hardcoded Workers AI model + `local()` sandbox.
- [x] In-process driver: `init(build)` → `session()` → `prompt()`; print streamed output.
- [x] Decide the **default build model** (benchmark edit reliability — see open Q2).
- **Exit:** the agent reads a file and proposes an edit on the real filesystem, end-to-end.

### M1 — Reliable edits + real tool surface  ⟵ DONE
- [x] Add **`@oh-my-pi/hashline`** as the `edit` tool engine (pluggable IO → sandbox fs).
- [x] Implement `write`, `rename` as dedicated `defineTool`s. Confirm `read/grep/glob/list/bash`.
- [x] Custom REPL with IPC, steering/queue, autocomplete, @file mentions, #skill mentions.
- **Exit:** edits succeed reliably on a *cheap* Workers AI model with no retry loops.

### M2 — Cloudflare login  ⟵ DONE
- [x] Manual-paste flow first: token + account id → `~/.config/lavalamp/credentials` (0600).
- [x] `registerProvider('cloudflare-workers-ai', { apiKey, baseUrl: account-scoped })` at startup.
- [x] Validate token against the AI run endpoint before saving.
- [x] Then add **Wrangler-OAuth reuse** as primary, paste as fallback.
- **Exit:** user logs in and runs a Workers AI model on their own account.

### M2.5 — Tool surface expansion  ⟵ DONE
- [x] `web_search` — DuckDuckGo search
- [x] `fetch_url` — Reader API (r.marban.lol) for clean markdown
- [x] `deepwiki` — DeepWiki MCP for repo docs
- [x] `codebase_search` — filename + content search
- [x] `oracle` — second opinion from a different model
- [x] `doom_loop` — recovery when stuck
- [x] `todowrite` / `todoread` — structured session todo list
- [x] `rename`, `undo`, `history` — file mutation tracking
- [x] `sessions`, `session_context` — session management
- [x] `memory_read`, `memory_write`, `memory_append` — persistent memory
- [x] Skill system: `#` prefix with autocomplete, `.agents/skills/` discovery
- [x] Slash commands: `/help`, `/clear`, `/compact`, `/sessions`, `/memory`, `/model`, `/workspace`, `/skills`, `/mcp`, `/tools`, `/plan`, `/copy`, `/undo`, `/quit`
- [x] `!` prefix for sandbox terminal commands
- [x] Plan mode (`/plan`) with teal accent (#2DD4BF)
- [x] Double-escape to interrupt
- [x] Session transcript `/copy` to clipboard

### M3 — Rezi TUI (in-process)
- [ ] Rezi app embedding the Flue runtime in **one process** (no localhost server).
- [ ] Panes: chat + token stream, **thinking/reasoning** display, tool-call timeline, **diff viewer**, file tree.
- [ ] Wire `observe()` events → UI; render permission prompts inline.
- [ ] **@-file/@-symbol mentions** that inline file contents into the prompt.
- [ ] **Slash commands** (core set) + **token/cost usage meter** (`PromptUsage`) + done **notification**.
- [ ] ⚠️ Pin Rezi/Zireael exact versions; isolate the render layer behind an interface.
- **Exit:** a full coding session driven entirely from the TUI.

### M4 — Permission engine
- [ ] Rule engine (allow/ask/deny/delegate, sequential, per-arg glob/regex) wrapping `execute`.
- [ ] Safe defaults; self-protection for config/cred files.
- **Exit:** destructive ops prompt; read-only ops flow freely; rules user-configurable.

### M5 — Agent roster + skills
- [ ] `explore`, `plan`, `research`, `review` profiles + `task` dispatch + capability boundaries.
- [ ] **spec-mode approval gate** (plan → approve → build).
- [ ] Bundle our skills; load user-global + project-local skill dirs.
- [ ] Background agent for research (Flue workflow pattern).
- **Exit:** `build` delegates exploration/planning/review; main context stays clean.

### M5.5 — Session safety & memory
- [ ] **Checkpoint / undo / rewind** — git snapshot per turn; revert from the TUI.
- [ ] **Rules / steering** — inject context only when a pattern matches the turn.
- [ ] **Headless mode** — TUI-less `run`/pipe/stdin for scripting and CI.
- **Exit:** users can safely undo agent changes and carry memory between sessions.

### M6 — spectacle (vision bridge)
- [ ] Model **capability table** (`@cf/...` → vision/tools/ctx).
- [ ] `spectacle` profile (`llama-4-scout`, fallbacks) tuned for faithful structured description.
- [ ] Auto-route images to spectacle when target model is blind; cache by image hash.
- **Exit:** attaching a screenshot works even on non-vision agents.

### M7 — LSP
- [ ] `lsp` tool over real language servers (hover/defs/refs/rename/diagnostics).
- [ ] Wire **oxc** (`oxlint --lsp`) as fast supplementary JS/TS diagnostics + autofix.
- [ ] Feed diagnostics back to the model after each edit.
- **Exit:** edits get type/lint feedback in-loop.

### M8 — Plugin system
- [ ] `definePlugin` manifest + loader (bundled → global → project precedence).
- [ ] Contributions: tools, subagents, skills, commands, hooks, providers, mcpServers, permissions.
- [ ] **MCP** plugin path via `connectMcpServer`; example plugin shipped.
- [ ] ⚠️ Flue adapts MCP **tools only** — add a thin **MCP resources/prompts** layer here *only if* a plugin needs it.
- **Exit:** a third party adds a tool + an MCP server + a slash command without forking.

### M9 — Polish & distribution
- [ ] Model picker (Workers AI catalog + BYOK) with the capability table.
- [ ] AI Gateway opt-in (caching, spend limits, logs on the user's account).
- [ ] Usage/neuron meter, config UX, install/packaging, `AGENTS.md` authoring helpers.

### Later / out of v1
- Cloudflare Sandbox **containers** ("run in the cloud" — needs Workers Paid).
- **Worktree isolation** for parallel sessions/subagents.
- **scribe** agent, PR automation.
- **Daemon mode** (this is the only place `@flue/sdk`-over-HTTP would return).
- Hosted/multi-tenant mode (would reintroduce DO/D1 + per-tenant cred storage).
- Optional **RAG**: `bge-m3` embeddings + `bge-reranker-base` for big-repo code search.
- Optional **voice** I/O: `whisper` (STT) + `aura-2`/`melotts` (TTS) for hands-free use.
- Optional **safety guardrail**: `llama-guard-3-8b` input/output classification.

---

## 9. Risks & mitigations

| Risk | Mitigation |
| ---- | ---------- |
| Wrangler on-disk token format is undocumented | Best-effort parse + version sniff; **manual paste always available**. |
| Rezi/Zireael core is **alpha** (wire format may break) | Pin exact versions; isolate render layer behind an interface; keep a fallback TUI plan (Ink/OpenTUI). |
| Weak Workers AI models fail edits | `@oh-my-pi/hashline` is exactly the fix; benchmark edit reliability per model (Q2). |
| Workers AI free-tier limits (≈10k neurons/day) | Surface usage meter; BYOK + AI Gateway spend limits as escape hatches. |
| Non-vision default models + image input | **spectacle** auto-bridge (M6) driven by capability table. |
| Prompt-injection self-allowlisting permissions | Never auto-allow writes to config/cred/plugin-manifest files. |
| Untrusted plugin code | Plugin tools/hooks run under the permission engine; no auto-access to config/creds. |
| `@flue/runtime` is **1.0.0-beta** (API churn) | Pin versions; the verified API in `AGENTS.md §6/§14` is current ground truth — re-verify on upgrade. |
| New model IDs change/deprecate | Keep model assignments in one config module; `kimi-k2.5` already shows as deprecated — track the catalog. |

---

## 10. Open questions (decide before the milestone they block)

1. **Default build model** — `@cf/moonshotai/kimi-k2.7-code` is the pick, but confirm via an
   **edit-reliability benchmark** (hashline pass-rate) vs `@cf/zai-org/glm-5.2`. *(blocks M0/M1)*
2. **review vs plan model split** — `review` = `gpt-oss-120b`, `plan` = `glm-5.2`; or unify on
   one strong reasoning model to cut cold-start variety? *(blocks M5)*
3. **spectacle default tier** — `llama-4-scout` (strong) vs `llama-3.2-11b-vision` (cheaper).
   Probably scout default + cheap fallback toggle. *(blocks M6)*
4. **AI Gateway: default-on or opt-in?** — lean opt-in for v1 (less setup friction). *(blocks M9)*
5. **Plugin manifest format** — TS module (`definePlugin`) only, or also a static
   `plugin.json` for non-code plugins (pure MCP/skills/commands)? *(blocks M8)*
6. **Reasoning tier source** — keep `plan`/`review` on Workers AI, or nudge power users to
   BYOK a frontier closed model for those two roles? *(blocks M5)*
