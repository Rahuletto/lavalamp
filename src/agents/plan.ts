import { createAgent } from '@flue/runtime';
import { local } from '../sandbox/local';
import { BUILD_MODEL } from '../config/models';
import { resolveSelectedModel } from '../config/runtime-route';
import {
  createSessionsTool,
  createSessionContextTool,
  createPullSessionTool,
  getMemoryContext,
  createMemoryTools,
} from '../sessions';
import { createWebSearchTool } from '../tools/web-search';
import { createFetchUrlTool } from '../tools/fetch-url';
import { createDeepWikiTool } from '../tools/deepwiki';
import { createCodebaseSearchTool } from '../tools/codebase-search';
import { WorkspaceGuard } from '../sandbox/workspace';
import { createOracleTool } from '../tools/oracle';
import { createRipgrepTool } from '../tools/ripgrep';
import { TaskStore } from '../tools/task-store';
import { createTaskTools } from '../tools/task-tools';
import { createLoadSkillTool } from '../tools/skills';
import { createCodebaseSemanticSearchTool } from '../tools/codebase-semantic-search';

export default createAgent((ctx) => {
  const workspaceRoot = ctx.env.LAVALAMP_WORKSPACE ?? process.cwd();
  const guard = new WorkspaceGuard(workspaceRoot as string);
  const taskStore = new TaskStore();

  const model = resolveSelectedModel(
    BUILD_MODEL,
    ctx.env as Record<string, string | undefined>,
  );
  const memoryContext = getMemoryContext(workspaceRoot as string);

  const instructions = [
    'You are the plan agent of lavalamp.',
    'Your main responsibility is high-level architectural planning and creating specific implementation steps.',
    '',
    '## Language',
    '- ALWAYS respond in English. Never use any other language, regardless of what the user writes in.',
    '',
    '## Capability Boundaries & Rules',
    '- You are strictly a planning agent.',
    '- DO NOT use write, edit, rename, undo, or run any shell commands.',
    '- DO NOT modify any files.',
    '- Your main job: research the codebase, analyze requirements, think deeply about architecture, and build a structured plan.',
    '- Use task management tools (create_task, edit_task, list_tasks) to build a clear roadmap of work.',
    '- Explain reasoning and trade-offs for each step.',
    '',
    '## Tools',
    '- `read` → read file contents',
    '- `ripgrep` → search file contents with regex',
    '- `glob` → find files by pattern',
    '- `codebase_search` → search codebase',
    '- `oracle` → get second opinion',
    '- `create_task` → add a task',
    '- `start_task` → mark task in-progress',
    '- `complete_task` → mark task done',
    '- `list_tasks` → list all tasks',
    '- `load_skill` → load instructions for a specific skill',
    '- `codebase_semantic_search` → search codebase semantically',
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
    sandbox: local({ env: { PATH: process.env.PATH ?? '' } }),
    thinkingLevel: 'medium',
    tools: [
      createSessionsTool(),
      createSessionContextTool(),
      createPullSessionTool(),
      ...createMemoryTools(workspaceRoot as string),
      createWebSearchTool(),
      createFetchUrlTool(),
      createDeepWikiTool(),
      createCodebaseSearchTool(guard),
      createOracleTool(),
      createRipgrepTool(workspaceRoot as string),
      createLoadSkillTool(workspaceRoot as string),
      createCodebaseSemanticSearchTool(workspaceRoot as string),
      ...createTaskTools(taskStore),
    ],
  };
});
