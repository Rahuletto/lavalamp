import { createAgent } from '@flue/runtime';
import { local } from '../sandbox/local';
import { BUILD_MODEL, resolveModelWithFallback } from '../config/models';
import { startSession, getMemoryContext, createMemoryTools } from '../sessions';
import { createRipgrepTool } from '../tools/ripgrep';

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
  const memoryContext = getMemoryContext(workspaceRoot);

  const instructions = [
    'You are the UI expert agent of lavalamp.',
    'Your main responsibility is frontend design, user interface elements, layouts, styling, themes, responsiveness, and transitions.',
    '',
    '## Rules',
    '- Provide language- and framework-agnostic design structures.',
    '- Help build rich user interfaces, responsive grids, and animation specs.',
  ];

  if (memoryContext) {
    instructions.push('', memoryContext);
  }

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
      ...createMemoryTools(workspaceRoot).filter(
        (t: any) => t.name === 'memory_read',
      ),
      createRipgrepTool(workspaceRoot),
    ],
  };
});
