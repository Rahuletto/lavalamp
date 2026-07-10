import { createAgent } from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime';
import { local } from '../sandbox/local';
import { BUILD_MODEL } from '../config/models';
import { resolveSelectedModel } from '../config/runtime-route';
import { ensureProviders } from '../config/register-providers';
import { expertRoutingGuide } from '../config/experts';
import {
  createSessionsTool,
  createSessionContextTool,
  createPullSessionTool,
  getMemoryContext,
  createMemoryTools,
} from '../sessions';
import {
  ChangeTracker,
  createRenameTool,
  createUndoTool,
  createHistoryTool,
  createDeployParallelSubsTool,
  createLoadSkillTool,
  createCodebaseSemanticSearchTool,
  createLspTools,
  createQueryExpertTool,
} from '../tools';

import { createWebSearchTool } from '../tools/web-search';
import { getDiagnosticsForFile } from '../tools/lsp-client';
import { createFetchUrlTool } from '../tools/fetch-url';
import { createDeepWikiTool } from '../tools/deepwiki';
import { createCodebaseSearchTool } from '../tools/codebase-search';
import { WorkspaceGuard } from '../sandbox/workspace';
import { createOracleTool } from '../tools/oracle';
import { createDoomLoopTool } from '../tools/doom-loop';
import { createRipgrepTool } from '../tools/ripgrep';
import { TaskStore } from '../tools/task-store';
import { createTaskTools } from '../tools/task-tools';
import { wrapToolExecute } from '../permissions/middleware';
import { loadAutorun } from '../permissions/autorun';

ensureProviders();

export default createAgent((ctx) => {
  const workspaceRoot = ctx.env.LAVALAMP_WORKSPACE ?? process.cwd();
  const guard = new WorkspaceGuard(workspaceRoot as string);
  const tracker = new ChangeTracker();
  const taskStore = new TaskStore();

  loadAutorun(workspaceRoot as string);

  function gate(tool: ToolDefinition): ToolDefinition {
    const orig = tool.execute;
    if (typeof orig !== 'function') {
      return tool;
    }
    return {
      ...tool,
      execute: wrapToolExecute(
        tool.name,
        orig as (args: Record<string, unknown>) => Promise<unknown>,
        workspaceRoot as string,
      ) as ToolDefinition['execute'],
    };
  }

  const model = resolveSelectedModel(
    BUILD_MODEL,
    ctx.env as Record<string, string | undefined>,
  );

  const memoryContext = getMemoryContext(workspaceRoot as string);

  const instructions = [
    'You are lavalamp — a coding assistant that operates on real files in the workspace.',
    '',
    '## Language',
    '- ALWAYS respond in English. Never use any other language, regardless of what the user writes in.',
    '',
    '## Core rules',
    '- Always `read` a file before editing it.',
    '- Use `ripgrep` (not `grep`) for all codebase searches — it is faster and supports full regex.',
    '- You may use `bash` with read-only `sed -n` commands to inspect precise file ranges when needed.',
    '- Use `deploy_parallel_subs` when independent research can run in parallel (up to 3 focused queries).',
    '- Use `read` with offset/limit to read specific chunks of large files instead of the entire file.',
    '- Edits use hashline format: [path#tag] header + SWAP/DEL/INS operations with +body lines.',
    '- Ranges are TIGHT: cover only lines that change. Use SWAP.BLK for whole functions/blocks.',
    '- After every edit, the tag changes. Re-read before the next edit on the same file.',
    '- If an edit fails or corrupts a file, call `undo` to restore it, then re-read and try again.',
    '- After every edit or write, critical type/lint errors are checked automatically and returned in-loop if found.',
    '- You can ONLY operate inside the workspace directory.',
    '',
    '## Plan mode',
    'If a message starts with <<PLAN_MODE>>, you are in plan mode. In plan mode:',
    '- DO NOT use write, edit, bash, rename, or undo. These are forbidden.',
    '- DO NOT create, modify, or delete any files.',
    '- DO NOT run any shell commands.',
    '- ONLY use read, grep, ripgrep, glob, codebase_search, web_search, fetch_url, deepwiki, oracle, memory_read.',
    '- Your job: research the codebase, analyze requirements, think deeply about architecture.',
    '- Use create_task to build a structured implementation plan with clear steps.',
    '- Each task should be specific, actionable, and ordered by dependency.',
    '- Explain your reasoning and trade-offs for each step.',
    '- When done, summarize the full plan. The user will approve before you execute.',
    '',
    'If a message starts with <<BUILD_MODE>> (or does not start with <<PLAN_MODE>>), you are in build/execution mode. You must use write, edit, bash, and other tools to implement the changes outlined in the plan.',
    '',
    '## Skills',
    'Skills are specialized instruction files that load on demand. You have these bundled skills:',
    '',
    '### thermo-nuclear-code-quality-review',
    'Extremely strict maintainability review. Use when: user asks for code quality review, maintainability audit, harsh review, or "thermonuclear" review of code changes. Focuses on abstraction quality, file size, spaghetti-condition growth, and structural simplification.',
    '',
    '### thermo-nuclear-review',
    'Comprehensive security and correctness audit. Use when: user asks for security review, bug audit, correctness check, or "thermonuclear" review of a branch/diff. Traces side effects, checks for breaking changes, feature-gate leaks, and devex regressions.',
    '',
    '### deslop',
    'Remove AI-generated code slop. Use when: user asks to clean up AI-written code, remove unnecessary comments, defensive checks, type casts, or inconsistent style introduced by AI. Run git diff against main to identify slop.',
    '',
    '### find-skills',
    'Discover and install skills from the open ecosystem. Use when: user asks "how do I do X", "find a skill for X", "is there a skill that can...", or wants to extend capabilities. Runs `npx skills find [query]` to search.',
    '',
    'When a task matches a skill description above, automatically activate it by reading the skill file at .agents/skills/<skill-name>/SKILL.md and following its instructions. Do not wait for the user to mention skills by name.',
    '',
    '## Task management',
    '- Use `create_task` to add a new task with title and optional description.',
    '- Use `start_task` to mark a task as being worked on.',
    '- Use `complete_task` to mark a task as done. Completed tasks stay visible with [x].',
    '- Use `edit_task` to update a task title or description.',
    '- Use `delete_task` to permanently remove a task by ID.',
    '- Use `skip_task` to cancel/remove a task that is no longer needed.',
    '- Use `list_tasks` to see all tasks and their status.',
    '- Tasks show in the TUI task panel in real-time. All tasks completed = panel hides.',
    '',
    '## Tools',
    '- `read` → read file contents (supports offset/limit for chunks)',
    '- `write` → create or overwrite a file',
    '- `edit` → apply a hashline patch',
    '- `bash` → run shell commands',
    '- `grep` → search file contents (basic)',
    '- `ripgrep` → search file contents with regex (preferred over grep)',
    '- `glob` → find files by pattern',
    '- `rename` → move/rename a file',
    '- `undo` → reverse the last file mutation',
    '- `history` → show recorded changes in this session',
    '- `sessions` → list recent sessions',
    '- `session_context` → get details of a specific session',
    '- `pull_session` → pull full conversation history of a specific past session. When the user mentions a session ID using the prefix $, e.g. $session_12345, use this tool to retrieve its messages and work with it as context.',
    '- `memory_read` → read persistent project memory',
    '- `memory_append` → add entry to project memory',
    '- `memory_write` → overwrite project memory',
    '- `web_search` → search the web for information',
    '- `fetch_url` → fetch a URL and return clean markdown content',
    '- `deepwiki` → query repo docs via DeepWiki MCP',
    '- `codebase_search` → search codebase by filename and content',
    '- `oracle` → get second opinion from a different model',
    '- `doom_loop` → call when stuck to get recovery steps',
    '- `create_task` → add a task',
    '- `start_task` → mark task in-progress',
    '- `complete_task` → mark task done',
    '- `edit_task` → update a task',
    '- `delete_task` → remove a task',
    '- `skip_task` → cancel a task',
    '- `list_tasks` → list all tasks',
    '- `deploy_parallel_subs` → deploy up to 3 parallel research agents for independent investigation',
    '- `query_expert` → delegate a specialized READ-ONLY task to a domain expert (ui, refactor, logic, database, oracle, research, critique, spectacle)',
    '- `codebase_semantic_search` → semantic code search',
    '- `lsp_hover` / `lsp_definition` / `lsp_references` / `lsp_rename` / `lsp_diagnostics` / `lsp_oxc_diagnostics` → language server/linter queries',
    '- `load_skill` → load a SKILL.md on demand',
    '',
    expertRoutingGuide(),
  ];

  if (memoryContext !== null) {
    instructions.push('', memoryContext);
  }

  return {
    compaction: {
      keepRecentTokens: 8000,
      reserveTokens: 20_000,
    },
    cwd: workspaceRoot,
    instructions: instructions.join('\n'),
    model,
    sandbox: (() => {
      const baseSandbox = local({ env: { PATH: process.env.PATH ?? '' } });
      return {
        createSessionEnv: async () => {
          const env = await baseSandbox.createSessionEnv();
          const originalWriteFile = env.writeFile;
          env.writeFile = async (filePath: string, content: string | Uint8Array) => {
            await originalWriteFile(filePath, content);
            try {
              const errors = await getDiagnosticsForFile(workspaceRoot as string, filePath);
              if (errors.length > 0) {
                throw new Error(
                  `Diagnostic check failed after writing ${filePath}:\n${errors.join('\n')}\nNote: The file WAS successfully written to disk. If this error is due to missing imports or dependencies from other files you intend to modify/create next, you can safely ignore this error and proceed to write/edit those files.`
                );
              }
            } catch (err: any) {
              if (err.message && err.message.includes('Diagnostic check failed')) {
                throw err;
              }
              // Ignore other errors (e.g. if LSP server isn't installed/starts/fails) so it doesn't break basic file writing
            }
          };
          return env;
        }
      };
    })(),
    thinkingLevel: 'medium',
    tools: [
      gate(createRenameTool(tracker)),
      gate(createUndoTool(tracker)),
      createHistoryTool(tracker),
      createSessionsTool(),
      createSessionContextTool(),
      createPullSessionTool(),
      ...createMemoryTools(workspaceRoot as string).map((t: ToolDefinition) =>
        ['memory_write', 'memory_append'].includes(t.name) ? gate(t) : t,
      ),
      createWebSearchTool(),
      createFetchUrlTool(),
      createDeepWikiTool(),
      createCodebaseSearchTool(guard),
      gate(createOracleTool()),
      gate(createDoomLoopTool()),
      createRipgrepTool(workspaceRoot as string),
      gate(createDeployParallelSubsTool()),
      createLoadSkillTool(workspaceRoot as string),
      createCodebaseSemanticSearchTool(workspaceRoot as string),
      ...createLspTools(workspaceRoot as string),
      createQueryExpertTool(workspaceRoot as string),
      ...createTaskTools(taskStore),
    ],
  };
});
