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

- **A harness, not a hosted service.** It runs as a **single local process** on the
  developer's own machine — a terminal UI (TUI) plus an embedded agent runtime. There is
  exactly **one tenant per process**: the person at the keyboard. No servers to deploy,
  no multi-tenant database, no per-user credential vault.
- **Cloudflare-first for models.** The user "logs in with Cloudflare" and runs
  **Workers AI** models on **their own Cloudflare account**, billed to them. Other
  providers are supported via BYOK (bring-your-own-key), but Workers AI is the default
  and the thing we integrate most deeply.
- **An editor of the user's real filesystem.** The agent operates on the actual project
  in `cwd` via Flue's `local()` sandbox — real files, real shell, real git.

**Why this is a good idea, concretely:** Flue (our agent framework) ships *native*
Cloudflare Workers AI and AI Gateway providers — we are not bolting Workers AI on with a
generic OpenAI shim. The harness engine underneath Flue (Pi) already solved the single
hardest problem in coding agents — reliable edits across weak models — and publishes that
as a reusable package. So a huge fraction of "build a great coding agent" is *assembly*
of strong existing parts, and our differentiation budget goes to: the **agent roster**,
the **permission model**, the **plugin system**, **Cloudflare login**, and the **TUI**.

**What we are NOT building (v1 non-goals):**
- No hosted/SaaS/multi-tenant mode (that reintroduces Durable Objects + D1 + cred storage).
- No Cloudflare Sandbox *containers* (they need Workers Paid; out of scope — `local()` is our sandbox).
- No worktree isolation, no "run in the cloud" offload — both are post-v1.

---

## 2. Glossary / mental model

| Term            | Meaning in this project                                                                 |
| --------------- | --------------------------------------------------------------------------------------- |
| **Harness**     | The whole local app: TUI + embedded Flue runtime + tools + permissions + plugins.       |
| **Flue**        | `@flue/runtime` — the agent framework. Gives us agents, sessions, tools, skills, subagents, sandboxes, providers, MCP. |
| **Pi**          | The harness engine *under* Flue (`@earendil-works/pi-agent-core`, a.k.a. oh-my-pi). Source of hash-anchored edits. |
| **Agent**       | A `createAgent(...)` default-exported from `src/agents/<name>.ts`. Addressable by name + instance `id`. |
| **Profile**     | A `defineAgentProfile(...)` — reusable behavior (model/instructions/tools) used as a baseline or a **subagent**. |
| **Subagent**    | A profile listed in `subagents:` that the parent delegates to via `session.task(msg, { agent })`. Runs in **isolated context**. |
| **Session**     | A named conversation inside a harness (`harness.session()`), backed by durable history. |
| **Tool**        | A `defineTool({...})` the model can call. Our file/shell/lsp capabilities are tools.     |
| **Skill**       | A `SKILL.md` of reusable instructions, loaded on demand. Guides behavior; adds no code.  |
| **Sandbox**     | Where tools run. We use `local()` = host fs + shell. (Default = in-memory just-bash.)    |
| **Plugin**      | A user/3rd-party package that contributes tools, subagents, skills, commands, hooks, MCP servers, providers, or permission rules. |
| **Spectacle**   | Our vision-bridge subagent: turns images into text for models that can't see (see §7).   |

---

## 3. The stack (locked-in choices)

| Layer            | Choice                                              | Why this and not the alternative                                                            |
| ---------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Agent framework  | **Flue** `@flue/runtime` (Node target)              | Native `cloudflare-workers-ai` + `cloudflare-ai-gateway` providers, durable sessions, subagents, skills, sandboxes, MCP — all the primitives we'd otherwise hand-build. |
| Harness engine   | **Pi** (under Flue) + **`@oh-my-pi/hashline`**      | Hash-anchored edits = the single biggest edit-reliability lever. MIT, standalone, pluggable IO. Do **not** reinvent. |
| TUI              | **Rezi** (`rezitui.dev`)                            | Native C render engine ("Zireael"), constraint layout, no hardcoded FPS cap. ⚠️ Zireael is **alpha** — pin exact versions, isolate behind an interface. |
| Models (default) | **Cloudflare Workers AI** (`@cf/...`)               | User runs on their own CF account; deep first-class Flue support; generous free tier; one provider for many open models. |
| Models (BYOK)    | Anthropic / OpenAI / OpenRouter / etc.              | Same `registerProvider` mechanism; lets power users route reasoning to stronger closed models. |
| Login            | **Wrangler OAuth reuse** (primary) + **manual paste** (fallback) | No public "Sign in with Cloudflare" exists; see §8.                              |
| Schemas          | **valibot**                                         | What Flue's `defineTool` expects.                                                            |
| Runtime / PM     | **Node ≥ 22.19** / **bun**                          | Flue's engine requirement; `bun.lock` is committed.                                          |

---

## 4. Architecture — and the "TUI-as-SDK" question, answered

Earlier I floated two ways to wire the TUI to the agent. **You were right to push back** —
since we're "just building a harness," we go with the **single-process, in-process embed**:

- **In-process embed (CHOSEN):** the Rezi TUI and the Flue runtime live in the **same Node
  process**. The TUI drives the agent directly through Flue's in-process API
  (`init(agent)` → `harness.session()` → `session.prompt()/.task()/.shell()`, and
  `observe(...)` for the event stream that paints the UI). One binary, no localhost HTTP
  hop, lowest latency, simplest mental model. This is what a local harness should be.
- **SDK-over-HTTP (REJECTED for v1):** running Flue as a localhost Hono server and pointing
  a `@flue/sdk` client at it. That's the *hosted* shape — useful only if we later add a
  daemon mode or remote sessions. "TUI-as-SDK" just meant "the TUI is a client of a Flue
  server"; we are **not** doing that. We keep `@flue/sdk` in our back pocket only for an
  optional future daemon.

```diagram
╭──────────────────────────────── lavalamp (one local process) ───────────────────────────────╮
│                                                                                              │
│   ╭───────────────────────────╮         ╭──────────────────────────────────────────────╮   │
│   │  Rezi TUI                  │ events  │  Flue runtime (embedded, Node target)         │   │
│   │  • chat / stream           │◀────────│  init(agent) → harness.session()             │   │
│   │  • diff viewer             │ observe │  session.prompt / .task / .shell / .fs       │   │
│   │  • file tree               │────────▶│                                              │   │
│   │  • permission prompts      │ prompt  │  agents/  build · plan · explore · research · │   │
│   │  • slash commands          │         │           review · spectacle (+ plugins)     │   │
│   ╰───────────────────────────╯         ╰───────────────┬──────────────────────────────╯   │
│                                                          │                                  │
│        ╭──────────────────────────╮      ╭──────────────┴───────────╮   ╭──────────────╮   │
│        │ Permission engine        │      │ local() sandbox          │   │ Plugin host  │   │
│        │ allow/ask/deny/delegate  │      │ real fs + shell @ cwd    │   │ tools/agents │   │
│        ╰──────────────────────────╯      │ reads AGENTS.md + skills │   │ /skills/hooks│   │
│                                          ╰──────────────────────────╯   ╰──────────────╯   │
╰────────────────────────────────────────────┬─────────────────────────────────────────────╯
                                              │ HTTPS (user's CF token + account id)
                                ╭─────────────▼──────────────╮
                                │ Cloudflare Workers AI       │  models run on the
                                │ / AI Gateway (user account) │  user's own account
                                ╰────────────────────────────╯
        Credentials & config: ~/.config/lavalamp/{credentials, config, skills/, plugins/}
```

---

## 5. Process model & turn lifecycle

A single "turn" (user sends a message) flows like this:

```diagram
user input ─▶ TUI ─▶ session.prompt(text)
                          │
                          ▼
              build agent plans, may call tools
                          │
            ┌─────────────┼───────────────────────────────┐
            ▼             ▼                                 ▼
      file tools     bash tool                       session.task(agent)
      (read/edit/    (permission-gated)              delegates to a subagent
       write/...)         │                          (explore/plan/review/...)
            │             │                                 │ isolated context,
            ▼             ▼                                 ▼ returns summary only
      permission engine evaluates each tool call ◀──────────┘
       (allow → run · ask → TUI prompt · deny → tool error · delegate → external prog)
            │
            ▼
      tool result ─▶ back to model ─▶ more turns ─▶ assistant text
            │
            ▼
      observe() events stream to TUI the whole time (text_delta, tool_start, tool,
      thinking_delta, task_start, message_end, idle, …) for live rendering
```

Images: if the user attaches an image and the **target model lacks vision**, the harness
routes the image through **`spectacle`** first (see §7), injecting a textual description so
the blind model can still reason about it.

---

## 6. How Flue actually works here (verified against installed `@flue/runtime@1.0.0-beta.2`)

This is ground truth — checked against the installed `.d.mts` files, not guessed.

- **Project layout**: source under `src/` — `app.ts` (optional Hono composition),
  `cloudflare.ts` (Cloudflare-only, unused in v1), `agents/` (one file = one agent, flat,
  lower-kebab-case), `workflows/`, `channels/`. Filename becomes the agent name.
- **Agent definition**:
  ```ts
  export default createAgent((ctx /* { id, env, payload } */) => ({
    model: 'cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code', // string, or false
    instructions: '...',           // or import a .md with { type: 'markdown' }
    tools: [...],                  // ToolDefinition[]
    skills: [...],                 // imported SKILL.md with { type: 'skill' }
    subagents: [...],              // AgentProfile[] for session.task()
    sandbox: local(),             // from '@flue/runtime/node'
    cwd: process.cwd(),
    thinkingLevel: 'medium',       // reasoning effort
    compaction: { /* ... */ },     // auto context compaction (or false)
  }));
  ```
- **`model` is a plain string** `'<provider>/<model>'` or `false`. There is **no**
  `providers:` field on the config.
- **Per-user provider credentials** are injected at **startup** via:
  ```ts
  import { registerProvider } from '@flue/runtime';
  registerProvider('cloudflare-workers-ai', {
    apiKey: userToken,
    baseUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`, // account-scoped
    headers: { /* optional */ },
  });
  ```
  `registerApiProvider(...)` exists for registering a *brand-new wire protocol*; we won't need it for Cloudflare.
- **Tools**: `defineTool({ name, description, parameters: v.object({...}), execute: async (args) => string })`.
  Args are validated against the valibot schema before `execute` runs.
- **Subagents**: `defineAgentProfile({ name, description, instructions, model?, tools?, skills? })` →
  list in `subagents:` → call `session.task(message, { agent: 'name' })`. Subagents run in
  isolated context and return only their final summary — this is how we keep the main thread clean.
- **Skills**: `import review from '../skills/review/SKILL.md' with { type: 'skill' }` →
  `skills: [review]`. Flue **also auto-discovers** `<cwd>/.agents/skills/<name>/SKILL.md`
  and reads `<cwd>/AGENTS.md` as system context from the sandbox at init — free with `local()`.
- **Sandbox**: `local()` from `@flue/runtime/node` = host fs + shell at `process.cwd()`;
  pass `local({ env: { ... } })` to expose specific host env vars to the agent's shell.
  Default (no `sandbox`) = in-memory just-bash virtual sandbox.
- **Driving in-process**: `const harness = await init(agent); const session = await harness.session();`
  then `session.prompt(text)`, `session.task(...)`, `session.shell(cmd)`, `session.skill(...)`,
  `session.fs` (read/write without recording in transcript).
- **Events / hooks**: `observe(subscriber)` returns an unsubscribe fn and streams typed
  `FlueEvent`s: `text_delta · thinking_delta · tool_start · tool · task_start · task ·
  message_start · message_end · turn_* · operation_* · agent_* · idle · log · compaction_* ·
  submission_settled`. This is **read-only** (telemetry + TUI rendering). A pre-tool **veto**
  (block/ask before a tool runs) is **our** permission engine wrapping each tool's `execute`,
  not a Flue feature.
- **MCP**: `connectMcpServer(name, { url, transport, headers, ... })` returns a connection
  whose tools become available to the agent. This is the backbone of plugin-contributed MCP servers.
- **Result shaping**: `session.prompt(text, { result: v.object({...}) })` returns validated typed data.

**Flue gives us primitives; the *harness* (commands, hooks, permission veto, plugin loader,
model-capability routing, login) is ours to build on top.**

---

## 7. Model selection (Workers AI) — per agent

All IDs below are **verified exact** against the Cloudflare catalog (June 2026). In Flue,
prefix with the provider: `cloudflare-workers-ai/<id>` (or `cloudflare-ai-gateway/...`).
Every assignment is a **default** — users/plugins can override per agent.

| Agent         | Default model                                  | Exact Workers AI ID                                  | Vision | Why this model                                                                 |
| ------------- | ---------------------------------------------- | ---------------------------------------------------- | :----: | ----------------------------------------------------------------------------- |
| **build**     | Kimi K2.7 Code (Moonshot)                      | `@cf/moonshotai/kimi-k2.7-code`                      |  ✅   | Frontier 1T params, 262k ctx, multi-turn **tool calling**, structured outputs, **vision** — purpose-built for agentic coding. Vision means build itself rarely needs spectacle. |
| **plan**      | GLM-5.2 (Zhipu)                                | `@cf/zai-org/glm-5.2`                                |  ❌   | Flagship **agentic coding** model w/ reasoning — excellent at decomposing work into a spec. No vision → uses spectacle for image input. |
| **explore**   | GLM-4.7-Flash (Zhipu)                          | `@cf/zai-org/glm-4.7-flash`                          |  ❌   | Fast + cheap, **131k ctx** (read lots of files), function calling. Ideal for high-volume read-only mapping where we don't want to burn the premium model. |
| **research**  | Llama 3.3 70B fp8 fast (Meta)                  | `@cf/meta/llama-3.3-70b-instruct-fp8-fast`          |  ❌   | Fast, solid general reasoning + function calling for summarizing docs/web findings. |
| **review**    | GPT-OSS-120B (OpenAI)                           | `@cf/openai/gpt-oss-120b`                            |  ❌   | Strong **reasoning** for adversarial code review (Amp-Oracle role). Read-only; slower/stronger is the point. Alt: `@cf/nvidia/nemotron-3-120b-a12b`. |
| **spectacle** | Llama 4 Scout 17B (Meta)                        | `@cf/meta/llama-4-scout-17b-16e-instruct`           |  ✅   | Natively multimodal, strong image understanding + describes well. Light fallback: `@cf/meta/llama-3.2-11b-vision-instruct`; budget: `@cf/llava-hf/llava-1.5-7b-hf`. |
| **scribe** (post-v1) | Llama 3.2 3B (Meta)                     | `@cf/meta/llama-3.2-3b-instruct`                     |  ❌   | Tiny/cheap for commit messages, changelog, doc tidy-ups.                      |

**Tier-swap menu** (let users trade quality↔cost/latency per agent):

- Premium coding: `@cf/moonshotai/kimi-k2.7-code`, `@cf/zai-org/glm-5.2`, `@cf/moonshotai/kimi-k2.6`
- Reasoning: `@cf/openai/gpt-oss-120b`, `@cf/nvidia/nemotron-3-120b-a12b`, `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`, `@cf/qwen/qwen3-30b-a3b-fp8`
- Fast/cheap: `@cf/zai-org/glm-4.7-flash`, `@cf/openai/gpt-oss-20b`, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, `@cf/meta/llama-3.2-3b-instruct`
- Code-specialist (budget): `@cf/qwen/qwen2.5-coder-32b-instruct`
- Vision: `@cf/meta/llama-4-scout-17b-16e-instruct`, `@cf/meta/llama-3.2-11b-vision-instruct`, `@cf/llava-hf/llava-1.5-7b-hf`, `@cf/google/gemma-4-26b-a4b-it`, `@cf/mistralai/mistral-small-3.1-24b-instruct`

**Harness infrastructure models** (not agents — internal services):

- **Reranker** (rank code-search hits): `@cf/baai/bge-reranker-base`
- **Embeddings** (semantic index, post-v1 RAG): `@cf/baai/bge-m3`
- **Safety guard** (optional input/output classification for the permission/guardrail layer): `@cf/meta/llama-guard-3-8b`

### The `spectacle` pattern (vision bridge) — your idea, designed

Several of our default agent models can't see (`plan`, `explore`, `research`, `review`),
and a user may swap any agent to a non-vision model. So:

```diagram
image attached ─▶ harness checks target model's `vision` capability
                       │
        vision? ──yes──▶ pass image straight to the model
                       │
                  no ──▶ session.task(image, { agent: 'spectacle' })
                          spectacle runs a vision model, returns a thorough
                          textual description (layout, text/OCR, diagram structure,
                          error messages, UI state, colors that matter)
                          │
                          ▼
                  inject description as text into the blind model's context
```

- `spectacle` is a normal `defineAgentProfile` subagent whose model is vision-capable.
- Invocation is **automatic**, driven by a **model-capability table** the harness keeps
  (which `@cf/...` ids have `vision`). It's also callable explicitly.
- Its prompt is tuned for **faithful, structured description** (not chit-chat): transcribe
  on-screen text, describe diagram topology, capture error dialogs verbatim, note UI state.
- Caching: key descriptions by image hash so we don't re-describe the same screenshot.

---

## 8. Login: the honest design

There is **no** public "Sign in with Cloudflare" OAuth product (like Sign in with Google).
`dash.cloudflare.com/oauth2/auth` is real OAuth2 + PKCE but is Cloudflare's **internal**
server for a hardcoded Wrangler client (localhost redirect only). We do **not** impersonate it.

1. **Primary — Wrangler OAuth reuse.** Shell out to the *real* `wrangler login --scopes
   account:read ai:write offline_access`. The consent screen correctly says "Wrangler"
   because the user genuinely uses Wrangler. Then read the OAuth token Wrangler writes to
   its local config dir. ⚠️ That on-disk format is an **undocumented implementation detail**
   — version-sniff it, treat as best-effort, always fall through to (2).
2. **Fallback — manual paste.** User creates a **`Workers AI: Edit`-scoped** API token in
   their dashboard (least privilege — never request more) and pastes it + their Account ID.

Both paths yield the same two values: **account id + bearer token**. Persist to
`~/.config/lavalamp/credentials` (mode `0600`). Validate immediately against the AI run
endpoint before saving. Never commit, never log, never put in a skill/plugin dir.

---

## 9. Tool surface (v1)

`read · write · edit · rename · list · glob · grep · bash · lsp · task`

- **edit** = wrap **`@oh-my-pi/hashline`** (line-anchored hash patches; point its pluggable
  IO at the sandbox fs). Highest-leverage piece of the whole project. **Never** hand-roll
  naive string-replace edits — they fail constantly on weak/cheap models.
- **write** = create/overwrite (`path` + `content`). Do **not** create files via `bash`/heredoc.
- **rename** = explicit (`old` → `new`) so it's permissionable separately from `bash mv`.
- **No dedicated `format`/`lint` tools** — when an LSP exists for the file's language it
  already does format-on-write + diagnostics; otherwise it's just `bash npm run lint`.
- **lsp** = real per-language servers (typescript-language-server / pyright / gopls /
  rust-analyzer …) for hover/defs/refs/rename/diagnostics. Wire **oxc** (`oxlint --lsp`) as
  a *fast supplementary* diagnostics + autofix source for JS/TS only — it is **not** a
  tsserver replacement (no hover/defs/refs).
- **task** = subagent dispatch (`session.task`).

---

## 10. Permissions (Amp-style engine, safe defaults)

A **sequential rule list, first match wins**:
`{ tool, matches: { arg: glob | regex | list }, action: allow | ask | deny | delegate }`.

- **delegate** hands the decision to an external executable on `$PATH`: tool call as JSON on
  stdin, decision via exit code (`0` allow / `1` ask / `2` deny; stderr forwarded to the model).
- **Ship SAFE DEFAULTS** (unlike Amp, which is off-by-default): allow `read`/`grep`/`glob`/
  `list` freely; **ask** before destructive `bash` (`rm -rf`, `git push`, `git reset --hard`,
  …) and before `write`/`edit`/`rename` **outside the project root**.
- **Self-protection**: the permission config itself and the harness's own config/plugin
  files are **never** auto-allowed for `write`/`edit` — there's a real-world Amp exploit
  where a prompt-injected agent edited its own settings to self-allowlist. Don't let our
  agent write its own leash.
- Implemented as a wrapper around each tool's `execute` (Flue has no built-in pre-tool veto).

---

## 11. Plugin system (extensibility, like Claude Code / Codex)

Plugins let users and third parties extend the harness without forking it. A plugin is an
**npm package or local directory** that default-exports a manifest. Flue already provides
the primitives a plugin needs (tools, subagents, skills, providers, MCP); the **plugin host
is ours** — it loads manifests, merges contributions, and enforces permissions on them.

```ts
// our API (to be built)
export default definePlugin({
  name: 'acme-postgres',
  version: '1.0.0',
  tools:       [/* defineTool(...) */],          // model-callable capabilities
  subagents:   [/* defineAgentProfile(...) */],  // new specialized agents
  skills:      [/* imported SKILL.md refs */],   // reusable instructions
  commands:    [/* TUI slash commands: /deploy, /migrate ... */],
  hooks:       { onSessionStart, onBeforeTool, onAfterTool, onSessionEnd },
  providers:   [/* { id, apiKey, baseUrl } → registerProvider */],
  mcpServers:  [/* { name, url, transport } → connectMcpServer */],
  permissions: [/* default permission rules this plugin ships with */],
});
```

| Contribution    | Backed by                          | Notes                                                              |
| --------------- | ---------------------------------- | ----------------------------------------------------------------- |
| `tools`         | Flue `defineTool`                  | Merged into the active agent's tools; name-collision → error.      |
| `subagents`     | Flue `defineAgentProfile`          | Become available to `session.task`.                               |
| `skills`        | Flue skills                        | Same loading path as bundled/local/global skills.                 |
| `commands`      | **ours** (TUI)                     | Slash commands that expand to a prompt/skill/task.                |
| `hooks`         | **ours**, `onBefore/AfterTool` veto via permission layer; read-only hooks via `observe()` | Lifecycle interception. |
| `providers`     | Flue `registerProvider`            | Add a model provider (e.g. a private gateway).                    |
| `mcpServers`    | Flue `connectMcpServer`            | The interop standard — wraps any MCP server's tools.             |
| `permissions`   | **ours** (permission engine)       | Plugin-shipped default rules (still overridable by the user).    |

**Loading order & precedence:** bundled (ours) → user-global (`~/.config/lavalamp/plugins/`)
→ project-local (`<cwd>/.lavalamp/plugins/`). Later layers can override earlier ones; user
config always wins over plugin defaults. **Plugins are untrusted code** — their tools/hooks
run under the same permission engine, and we never auto-allow a plugin to modify harness
config or credentials.

---

## 12. Skills — three layers

1. **Bundled (ours)** — shipped with the harness; where "best harness" differentiation
   lives: `spec-mode`, `commit`, `review`, `debug`, `pr`. Imported with `{ type: 'skill' }`.
2. **User-global** — `~/.config/lavalamp/skills/*/SKILL.md`.
3. **Project-local** — `<cwd>/.agents/skills/*/SKILL.md` (auto-discovered by Flue).

Name collisions between an imported skill and a discovered skill **fail init** rather than
silently picking one. `AGENTS.md` at `<cwd>` is read as system context automatically.

---

## 13. Repo conventions

- Runtime **Node ≥ 22.19**, package manager **bun** (`bun.lock` committed).
- Source under `src/`; agents/workflows flat + **lower-kebab-case**; nested files aren't discovered.
- Tool/agent schemas: **valibot** (`v.object({...})`).
- Pin exact versions for **Rezi/Zireael** (alpha) and **`@flue/*`** (beta).
- Never commit `.env`, `~/.config/lavalamp/*`, or any credential. Never log tokens.
- **Verify before "done":** `npx flue build --target node` must pass; exercise the actual
  agent loop end-to-end where feasible. Report failures honestly.

---

## 14. Verified API quick reference (`@flue/runtime`)

```
createAgent · defineAgentProfile · defineTool · registerProvider · registerApiProvider
connectMcpServer · observe · dispatch · listAgents · listRuns · getRun · bash
from '@flue/runtime/node': local
Session: prompt · task · shell · skill · fs · (events via observe)
AgentRuntimeConfig: profile model instructions skills tools subagents thinkingLevel
                    compaction durability cwd sandbox
AgentCreateContext: { id, env, payload }
```

---

## 15. Capability matrix — "all the modern bells & whistles"

This is the checklist that nothing modern gets forgotten. **Legend:** ✅ native to Flue
(use it) · 🔨 we build it (Flue gives no equivalent) · 🧩 via plugin/MCP · ⏳ post-v1 ·
🚫 out of scope (with reason). Verified against `@flue/runtime@1.0.0-beta.2`.

### Model & inference
| Feature | Status | Notes |
| ------- | :----: | ----- |
| Multi-provider / BYOK | ✅ | `registerProvider` / `registerApiProvider`. |
| Workers AI native provider | ✅ | `cloudflare-workers-ai/@cf/...` (+ `cloudflare-ai-gateway/...`). |
| Streaming responses | ✅ | `observe()` → `text_delta`. |
| Reasoning / thinking display | ✅ | `thinking_delta` events + `thinkingLevel` config. |
| Structured / JSON output | ✅ | `prompt(text, { result: v.object(...) })`; `give_up` → `ResultUnavailableError`. |
| Vision / multimodal input | ✅ | `PromptImage`; **+ `spectacle` bridge** for blind models (§7). |
| Token & cost tracking | ✅ | `PromptUsage` (input/output/cache/cost) → 🔨 TUI usage meter. |
| Context compaction / auto-summarize | ✅ | `compaction` config + `session.compact()`; overflow recovery built in. |
| AI Gateway (cache / spend limits / logs) | ✅ | opt-in, on the user's own account (M9). |
| Prompt caching | ⚠️ | provider-dependent; surfaced in usage. Don't assume on Workers AI. |
| Embeddings + reranking (RAG code search) | ⏳ | `@cf/baai/bge-m3` + `@cf/baai/bge-reranker-base`. |
| Voice (STT / TTS) | ⏳ | optional flourish: `@cf/openai/whisper-*`, `@cf/deepgram/aura-2-en`, `@cf/myshell/melotts`. |

### Tools & capabilities
| Feature | Status | Notes |
| ------- | :----: | ----- |
| Core file/shell tools | ✅/🔨 | sandbox provides shell; we author `read/write/edit/rename/list/glob/grep`. |
| Hash-anchored reliable edits | 🔨 | wrap **`@oh-my-pi/hashline`**. |
| LSP diagnostics / navigation | 🔨 | real language servers + oxc (M7). |
| Custom tools | ✅ | `defineTool`. |
| **MCP tools** | ✅ | `connectMcpServer` → tools named `mcp__<server>__<tool>`. |
| **MCP resources / prompts** | 🔨/⚠️ | Flue adapts **tools only** — resources/prompts are **not** native. Build a thin layer only if a plugin needs them. |
| Web search / fetch | 🔨 | `research` agent tools. |
| TODO / task-list tool | 🔨 | Claude-Code-style in-session task tracking. |
| Background / async / durable tasks | ✅ | durable submissions (`submission_settled`); survives process restart. |

### Agents & orchestration
| Subagents / delegation | ✅ | `session.task(msg, { agent })`, isolated context. |
| Agent profiles | ✅ | `defineAgentProfile`. |
| Plan / spec mode + approval gate | 🔨 | `spec-mode` skill + TUI gate. |
| Multi-agent roster | 🔨 | build · explore · plan · research · review · spectacle (§7, PLAN §4). |

### Context & memory
| AGENTS.md auto-load | ✅ | read from `<cwd>` at init. |
| Skills (bundled + global + project) | ✅ | 3-layer loading (§12). |
| @-file / @-symbol mentions in prompts | 🔨 | TUI affordance that inlines file contents/refs. |
| Persistent memory across sessions | 🔨 | a memory file/skill the agent can append to. |
| Rules / steering (conditional context) | 🔨 | inject context only when a pattern matches the turn. |

### Sessions & UX
| Durable sessions + history | ✅ | SQLite-backed; survives restart. |
| Resume / continue / multiple named sessions | ✅ | `FlueSessions.get/create/delete`. |
| Checkpoint / undo / rewind | 🔨 | git snapshot per turn → revert. (Important modern feature.) |
| Diff review & approval | 🔨 | TUI diff viewer + approval gate. |
| Slash commands | 🔨/🧩 | core + plugin-contributed. |
| Themes / keybindings | 🔨 | Rezi layer. |
| Notifications (done bell / desktop) | 🔨 | on `idle`/`message_end`. |
| Headless / non-interactive (CI, pipe, stdin) | ✅/🔨 | `flue run` exists; we add a TUI-less mode for scripting. |

### Safety & control
| Permission engine (allow/ask/deny/delegate) | 🔨 | §10. |
| Sandbox levels | ✅ | `local()` (host) / virtual just-bash. |
| Self-protection (no self-allowlisting) | 🔨 | config/cred/plugin files never auto-writable. |
| Safety classification (optional) | 🧩 | `@cf/meta/llama-guard-3-8b` as an opt-in guardrail. |

### Extensibility & observability
| Plugin system | 🔨 | `definePlugin` (§11). |
| MCP servers | ✅ | `connectMcpServer`. |
| Hooks (lifecycle) | ✅/🔨 | read-only via `observe()`; veto via permission layer. |
| Custom providers | ✅ | `registerProvider`. |
| OpenTelemetry / Sentry / Braintrust | ✅ | native Flue integrations. |
| Event stream for tooling | ✅ | `observe()` (25+ event types). |

### Out of scope (stated honestly)
| Item | Why |
| ---- | --- |
| Channels (Slack/Discord/GitHub/Linear/… bots) | Flue *has* these, but they're **hosted-server ingress**, not a local TUI feature. 🚫 v1. |
| Cloudflare Sandbox **containers** | needs Workers Paid. 🚫 v1 (post-v1 "run in cloud"). |
| Worktree isolation | ⏳ post-v1. |
| Multi-tenant / SaaS / daemon-over-HTTP | non-goal; would reintroduce DO/D1 + cred vault. |

---

## 16. Current status

Greenfield. Present: `package.json`, `flue.config.ts` (`target: 'node'`), deps installed
(`@flue/cli`, `@flue/runtime`), `bun.lock`. No `src/` yet. See **`PLAN.md`** for milestones,
the agent roster build order, the plugin/permission plans, risks, and open questions.
