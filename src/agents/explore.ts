import { createAgent } from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime';
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
import { createLoadSkillTool } from '../tools/skills';
import { createCodebaseSemanticSearchTool } from '../tools/codebase-semantic-search';
import { createLspTools } from '../tools/lsp-client';
import { createQueryExpertTool } from '../tools/query-expert';

export default createAgent((ctx) => {
  const workspaceRoot = ctx.env.LAVALAMP_WORKSPACE ?? process.cwd();
  const guard = new WorkspaceGuard(workspaceRoot as string);

  const model = resolveSelectedModel(
    BUILD_MODEL,
    ctx.env as Record<string, string | undefined>,
  );
  const memoryContext = getMemoryContext(workspaceRoot as string);

  const instructions = [
    'You are the explore agent of lavalamp.',
    'Your main responsibility is codebase exploration, search, structure mapping, and finding specific files/tokens.',
    '',
    '## Capability Boundaries & Rules',
    '- You are strictly a READ-ONLY agent.',
    '- DO NOT attempt to write, edit, modify files or execute shell commands.',
    '- Focus on tracing code flow, finding relevant files, mapping imports, and clarifying context.',
    '- Use `ripgrep` for fast codebase search with regex.',
    '- Use `read` with offset/limit to read chunks of large files.',
    '',
    '## Tools',
    '- `read` → read file contents (supports offset/limit for chunks)',
    '- `ripgrep` → search file contents with regex',
    '- `glob` → find files by pattern',
    '- `codebase_search` → search codebase by filename and content',
    '- `web_search` → search the web for information',
    '- `fetch_url` → fetch a URL and return clean markdown',
    '- `oracle` → get second opinion from a different model',
    '- `load_skill` → load instructions for a specific skill',
    '- `codebase_semantic_search` → search codebase semantically',
    '- `lsp_hover` → query LSP hover information',
    '- `lsp_definition` → query LSP symbol definition location',
    '- `query_expert` → delegate specialized query to expert agents',
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
      ...createMemoryTools(workspaceRoot as string).filter(
        (t: ToolDefinition) => t.name === 'memory_read',
      ),
      createWebSearchTool(),
      createFetchUrlTool(),
      createDeepWikiTool(),
      createCodebaseSearchTool(guard),
      createOracleTool(),
      createRipgrepTool(workspaceRoot as string),
      createLoadSkillTool(workspaceRoot as string),
      createCodebaseSemanticSearchTool(workspaceRoot as string),
      ...createLspTools(workspaceRoot as string),
      createQueryExpertTool(workspaceRoot as string),
    ],
  };
});
