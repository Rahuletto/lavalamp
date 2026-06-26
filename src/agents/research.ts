import { createAgent, registerProvider } from '@flue/runtime';
import { local } from '../sandbox/local';
import { BUILD_MODEL, resolveModelWithFallback } from '../config/models';
import {
  startSession,
  createSessionsTool,
  createSessionContextTool,
  createPullSessionTool,
} from '../sessions';
import { createWebSearchTool } from '../tools/web-search';
import { createFetchUrlTool } from '../tools/fetch-url';
import { createDeepWikiTool } from '../tools/deepwiki';
import { createLoadSkillTool } from '../tools/skills';

export default createAgent((ctx) => {
  const workspaceRoot = ctx.env.LAVALAMP_WORKSPACE ?? process.cwd();

  const session = startSession(
    ctx.payload?.prompt ?? 'interactive',
    workspaceRoot,
    resolveModelWithFallback(BUILD_MODEL, ctx.env as Record<string, string>),
  );

  const model = resolveModelWithFallback(
    BUILD_MODEL,
    ctx.env as Record<string, string>,
  );

  const instructions = [
    'You are the research agent of lavalamp.',
    'Your main responsibility is detailed external or domain investigation, gathering APIs, reading documentation, and web searches.',
    '',
    '## Capability Boundaries & Rules',
    '- You are strictly a research agent.',
    '- Focus on web search, documentation fetching, and summarizing external references.',
    '- Do not perform edits or run commands.',
    '',
    '## Tools',
    '- `web_search` → search the web for information',
    '- `fetch_url` → fetch a URL and return clean markdown',
    '- `deepwiki` → query repository documentation via DeepWiki MCP',
    '- `load_skill` → load instructions for a specific skill',
  ];

  return {
    compaction: {
      keepRecentTokens: 8_000,
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
      createWebSearchTool(),
      createFetchUrlTool(),
      createDeepWikiTool(),
      createLoadSkillTool(workspaceRoot),
    ],
  };
});
