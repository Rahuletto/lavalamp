# AGENTS.md — lavalamp

> Guidance for AI coding agents **and** humans working **on this repository**.
> Read this top-to-bottom before editing anything. When an architectural decision
> changes, update this file in the same change. `PLAN.md` is the roadmap; this is
> the contract.

---

## 1. What we are building (and why)

**lavalamp** is a **Cloudflare-native, local AI coding harness** — the thing you'd get
if Cloudflare shipped its own answer to OpenCode / Claude Code / Amp / Codex.

It is:

- **A harness, not a hosted service.** It runs as a **two-process local application** on
  the developer's own machine — a TUI process (OpenTUI) that spawns a Flue server child
  process. One tenant per process, no servers to deploy.
- **Cloudflare-first for models.** The user "logs in with Cloudflare" and runs
  **Workers AI** models on **their own Cloudflare account**, billed to them. BYOK
  (Anthropic, OpenAI, OpenRouter) also supported.
- **An editor of the user's real filesystem.** The agent operates on the actual project
  in `cwd` via Flue's `local()` sandbox — real files, real shell, real git.

**Why this is a good idea:** Flue ships *native* Workers AI and AI Gateway providers.
Pi (under Flue) already solved reliable edits via hash-anchored patches. Our
differentiation budget goes to: the **TUI**, the **tool surface**, **session management**,
and **Cloudflare login**.

**What we are NOT building (v1 non-goals):**
- No hosted/SaaS/multi-tenant mode.
- No Cloudflare Sandbox containers (need Workers Paid).
- No worktree isolation, no "run in the cloud" offload.

---

## 2. Glossary

| Term | Meaning |
| ---- | ------- |
| **Harness** | The whole local app: TUI + Flue server child process + tools + sessions. |
| **Flue** | `@flue/runtime` — the agent framework. Agents, sessions, tools, skills, subagents, sandboxes, providers, MCP. |
| **Pi** | `@earendil-works/pi-agent-core` — harness engine under Flue. Source of hash-anchored edits. |
| **OpenTUI** | `@opentui/core` — the TUI rendering framework (imperative API, not React). |
| **Agent** | A `createAgent(...)` default-exported from `src/agents/<name>.ts`. |
| **Tool** | A `defineTool({...})` the model can call. |
| **Skill** | A `SKILL.md` of reusable instructions, loaded on demand. |
| **Sandbox** | Where tools run. We use `local()` = host fs + shell at cwd. |
| **IPC** | The TUI communicates with the Flue server via Node.js IPC channel (`child.send`/`child.on('message')`). |

---

## 3. The stack

| Layer | Choice | Why |
| ----- | ------ | ----- |
| Agent framework | **Flue** `@flue/runtime` (Node target) | Native Workers AI + AI Gateway providers, durable sessions, subagents, skills, MCP. |
| Harness engine | **Pi** + **`@oh-my-pi/hashline`** | Hash-anchored edits = the single biggest edit-reliability lever. |
| TUI | **OpenTUI** `@opentui/core` | Imperative TypeScript API, MarkdownRenderable, DiffRenderable, CodeRenderable, ScrollBox with viewport culling, TextareaRenderable. Replaced Rezi. |
| Process model | **Two-process IPC** | TUI spawns `dist/server.mjs` as child process. IPC channel for structured events. TUI handles all rendering. |
| Models (default) | **Cloudflare Workers AI** | User runs on their own CF account. Default: `@cf/zai-org/glm-4.7-flash`. |
| Models (BYOK) | Anthropic / OpenAI / OpenRouter | Same `registerProvider` mechanism. |
| Login | **Wrangler OAuth reuse** + **manual paste** fallback | No public "Sign in with Cloudflare" exists. |
| Schemas | **valibot** | What Flue's `defineTool` expects. |
| Runtime / PM | **Bun** (>= 1.3.14) | `bun.lock` committed. Build via `flue build --target node`. |

---

## 4. Architecture

```
bin/lavalamp (bash wrapper)
  └─> bun run src/run.ts
        ├─ [-p mode] → FlueProcess → direct stdout streaming
        └─ [interactive] → startTui()
              │
              ├─ FlueProcess (ipc.ts)
              │   Spawns dist/server.mjs as child process
              │   Communicates via Node IPC channel
              │   prompt() → sends type:"prompt", receives events
              │   cancel() → SIGTERM + restart
              │
              ├─ OpenTUI renderer (app.ts, ~2600 lines)
              │   Widget tree: header, messagesScroll, completionBox,
              │   lavaLampBox, taskStatusBar, resultBox, confirmBox,
              │   queueBox, taskBox, subBox, inputRow, statusBar, viewerOverlay
              │
              └─ Shared modules
                  state.ts    — Message, ToolCall, Task, SubAgent, AppState
                  theme.ts    — COLORS (accent, plan accent, 20+ colors)
                  art.ts      — Slash commands, lava lamp frames, syntaxStyle
                  discover.ts — File/skill discovery, fuzzy search
                  sessions.ts — Session save/load/list (JSON in ~/.lavalamp/sessions/)
                  subs.ts     — SubAgentManager; spawns parallel FlueProcess children
                  tools.ts    — Tool arg/result summarization, diff detection,
                                file path extraction, language detection, EXT_LANG_MAP
```

**Event flow:**
1. User types → `sendPrompt()` → `flue.prompt(text, callbacks)`
2. FlueProcess sends IPC message to server child process
3. Server streams events: `text_delta`, `thinking_delta`, `tool_start`, `tool`, `result`
4. `handleEvent()` updates UI in real-time (streaming markdown, thinking blocks, tool groups)
5. On result: finalize stream, save session, extract file links, print usage

---

## 5. Tool surface (current)

**Agent-defined tools (src/tools/):**
- `rename`, `undo`, `history` — file mutation tracking with ChangeTracker
- `web_search` — DuckDuckGo search
- `fetch_url` — Reader API (r.marban.lol) for clean markdown
- `deepwiki` — DeepWiki MCP for repo docs
- `codebase_search` — filename + content search
- `oracle` — second opinion from a different model
- `doom_loop` — recovery when stuck
- `ripgrep` — wraps `rg` binary with regex, file type, context, case-insensitive, multiline
- `deploy_parallel_subs` — returns a structured marker for the TUI to spawn up to 3 parallel research agents
- `create_task`, `start_task`, `complete_task`, `edit_task`, `delete_task`, `skip_task`, `list_tasks`
- `sessions`, `session_context` — session introspection
- `memory_read`, `memory_write`, `memory_append` — persistent project memory

**Flue built-in tools:**
- `read`, `write`, `edit`, `bash`, `grep`, `glob`
- Permission defaults allow read-only `bash` commands that start with `sed ` so the harness can inspect precise file ranges; other `bash` commands still ask.

**TUI-local slash commands (not sent to agent):**
- `/help`, `/clear`, `/compact`, `/sessions`, `/memory`, `/model`, `/workspace`, `/skills`, `/mcp`, `/tools`, `/subagents`, `/autorun`, `/permissions`, `/plan`, `/copy`, `/undo`, `/quit`
- `/sudo` toggles dangerous allow-everything mode and always shows a confirmation box before enabling.

**Permission engine (fully wired):**
- `src/permissions/rules.ts` — default allow/ask/deny rules plus `.lavalamp/rules.json` loading/saving.
- `src/permissions/autorun.ts` — persisted command/pattern always-allow plus `/sudo` allow-all state in `.lavalamp/autorun.json`.
- `src/permissions/middleware.ts` — server-side permission gating via bidirectional IPC. Sends `permission_request` to TUI, awaits `permission_response`. Auto-denies after 30s.
- Sandbox (`src/sandbox/local.ts`) wraps `exec()` and `writeFile()` with permission checks.
- Custom tools wrapped with `gate()` in `src/agents/build.ts`.

---

## 6. TUI features

**Streaming:**
- Character-by-character markdown rendering via `MarkdownRenderable` (streaming + conceal modes)
- Collapsible thinking blocks (purple, `▸`/`▼` toggle, consecutive blocks merge into one)
- Collapsible tool groups (closed by default, green/red headers based on success/error)
- Generic tool grouping — consecutive same-tool calls grouped (e.g., `read x3`)
- Tool output: diffs inline for edit/write, code blocks for read, text for bash/others
- Task status bar above input showing current tool being executed
- Spinner (braille animation) merged into status bar

**Input:**
- Multiline textarea (`TextareaRenderable`) — Enter sends, Shift+Enter newline
- Dynamic height (1-6 rows) via word-wrap estimation
- Autocomplete: `/commands`, `@files`, `#skills` with fuzzy search popup
- Up/Down command history cycling
- Plan mode toggle via Shift+Tab (teal accent)
- Queue panel for queued/steered prompts

**Views:**
- Full-screen diff viewer with vim bindings (`:q`, j/k, g/G, Ctrl+D/U)
- Full-screen code viewer with syntax highlighting (CodeRenderable)
- Clickable file path links (purple, underlined) after assistant responses
- Session picker with arrow-key navigation

**Sessions:**
- Auto-save on every stream finalize (JSON in `~/.lavalamp/sessions/`)
- `/sessions` to browse and resume (arrow keys, Enter to resume)
- `/clear` creates new session
- `--continue [id]` CLI flag to resume
- Messages include thinking and toolCalls for full replay

**Safety:**
- PermissionBox (yellow border) for destructive tool approval: `[y] Allow  [n] Deny  [a] Always Allow`
- Bidirectional IPC: server blocks tool execution until TUI responds; auto-deny after 30s
- Confirmation panel (yellow border) for Ctrl+C exit (double-press pattern)
- Autorun/SUDO indicator in pink status bar when persisted always-allow or allow-all is active
- Fatal error handler saves session and prints resume command

**Parallel subagents:**
- `deploy_parallel_subs` tool result is intercepted by the TUI.
- `SubAgentManager` spawns up to 3 isolated `FlueProcess` children with focused research prompts.
- Subagent panel shows running/done/failed state; `q` kills the first running subagent.
- When all subagents finish, results are merged into a follow-up prompt for the main agent.

---

## 7. Model selection (current)

Default model: `cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash`

Overridable via:
- `LAVALAMP_MODEL` environment variable
- `-m` / `--model` CLI flag

**Registered providers:**
1. `cloudflare-workers-ai` — from `~/.config/lavalamp/credentials`
2. `anthropic` — from `ANTHROPIC_API_KEY` env
3. `openai` — from `OPENAI_API_KEY` env
4. `openrouter` — from `OPENROUTER_API_KEY` env

**Capability table** (in `src/config/models.ts`): 10 models with vision, functionCalling, contextWindow, provider info. Used for model fallback routing.

---

## 8. Repo conventions

- Runtime **Bun** (>= 1.3.14), `bun.lock` committed.
- Source under `src/`; flat structure within each directory.
- Build: `flue build --target node` outputs to `dist/server.mjs`.
- TUI entry: `src/tui/app.ts` (monolithic, ~2600 lines — internal functions close over renderer/state).
- Shared modules: `src/tui/{theme,art,discover,sessions,tools,state,ipc}.ts`.
- Tool schemas: **valibot** (`v.object({...})`).
- Never commit `.env`, credentials, or tokens.
- **Verify before "done":** `bun run build` must pass.

---

## 9. File structure

```
lavalamp/
├── bin/lavalamp              # Bash entry script (flag parsing, login/logout)
├── src/
│   ├── run.ts                # Main entry (-p print mode, --continue resume, TUI launch)
│   ├── config/models.ts      # Model registry, capability table, fallback logic
│   ├── agents/build.ts       # Primary agent definition (model, instructions, 20+ tools)
│   ├── sandbox/              # Local sandbox (shell exec, file I/O, workspace guard)
│   ├── sessions/             # Session persistence, memory, session/memory tools
│   ├── auth/                 # Cloudflare login, credential storage
│   ├── cli/auth.ts           # CLI auth subcommands
│   ├── permissions/          # Rule engine, autorun state, permission middleware scaffold
│   ├── tools/                # Agent-callable tools (rename, undo, web, ripgrep, tasks, etc.)
│   └── tui/                  # Terminal UI
│       ├── app.ts            # Main TUI (renderer, events, keybinds, viewers, ~2600 lines)
│       ├── state.ts          # Message, ToolCall, Task, AppState interfaces
│       ├── ipc.ts            # FlueProcess class (spawn, prompt, cancel, restart)
│       ├── subs.ts           # Parallel subagent orchestration
│       ├── theme.ts          # COLORS design tokens
│       ├── art.ts            # Slash commands, lava lamp frames, syntaxStyle
│       ├── discover.ts       # File/skill discovery, fuzzy search
│       ├── sessions.ts       # TUI session save/load/list
│       ├── tools.ts          # Tool utilities (summarize, diff, detect, extract)
│       └── index.ts          # Barrel exports
├── dist/server.mjs           # Built Flue server (spawned by TUI)
├── flue.config.ts            # { target: 'node' }
├── package.json              # Dependencies: @flue/runtime, @opentui/core, @oh-my-pi/hashline, valibot
└── bun.lock
```

---

## 10. Skills

**Bundled (referenced in agent instructions):**
- `thermo-nuclear-code-quality-review` — strict maintainability review
- `thermo-nuclear-review` — security and correctness audit
- `deslop` — remove AI-generated code slop
- `find-skills` — discover and install skills

**Discovery paths (in `discover.ts`):**
1. `<cwd>/.agents/skills/`
2. `<cwd>/../.agents/skills/`
3. `~/.agents/skills/`

**Global skills available (15):** agents-sdk, cloudflare-workflows, deslop, documentation, durable-objects, find-skills, reader-fetch, refactor, thermo-nuclear-code-quality-review, typescript-advanced-types, ui-ux-pro-max, web-design-guidelines, web-perf, workers-best-practices, wrangler.

---

## 11. Verified API (`@flue/runtime`)

```
createAgent · defineAgentProfile · defineTool · registerProvider
connectMcpServer · observe · dispatch
from '@flue/runtime/node': local
Session: prompt · task · shell · skill · fs
Events: text_delta · thinking_delta · tool_start · tool · task_start · task
        · message_start · message_end · compaction_start · compaction
        · error · log · idle · submission_settled
```

---

## 12. Current status

**M0-M4 complete.** Full agent with 20+ tools, local sandbox, Cloudflare login,
session persistence, memory, rich OpenTUI with streaming, tool groups, thinking blocks,
diff viewer, code viewer, vim keybindings, autocomplete, plan mode, session management.
Permission engine with PermissionBox UI, bidirectional IPC gating, sandbox-level
wrapping, autorun/sudo, and user-configurable rules.

**M5 in progress.** `deploy_parallel_subs`, `SubAgentManager`, subagent panel, and
auto-merge follow-up are implemented. Dedicated explore/plan/research/review profiles
and spec-mode approval gate remain.

**Remaining milestones:** Finish multi-agent roster (M5),
checkpoint/undo via git (M5.5), spectacle vision bridge (M6), LSP (M7), plugin system
(M8), model picker + AI Gateway (M9).
