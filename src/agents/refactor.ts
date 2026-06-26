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
    resolveModelWithFallback(BUILD_MODEL, ctx.env as Record<string, string>)
  );

  const model = resolveModelWithFallback(BUILD_MODEL, ctx.env as Record<string, string>);
  const memoryContext = getMemoryContext(workspaceRoot);

  const instructions = [
    'You are the refactor expert agent of lavalamp.',
    'Your main responsibility is clean code structure, refactoring, DRY principles, removing code slop, and simplifying conditional complexity.',
    '',
    '## Rules',
    '- Review code patterns for maintainability and size.',
    '- Suggest structural modifications to decouple components.',
    '- Strip unnecessary AI comments, verbose guards, and redundant boilerplate.',
  ];

  if (memoryContext) {
    instructions.push('', memoryContext);
  }

  return {
    model,
    instructions: instructions.join('\n'),
    tools: [
      ...createMemoryTools(workspaceRoot).filter((t: any) => t.name === 'memory_read'),
      createRipgrepTool(workspaceRoot),
    ],
    sandbox: local({ env: { PATH: process.env.PATH ?? '' } }),
    cwd: workspaceRoot,
    thinkingLevel: 'medium',
    compaction: {
      reserveTokens: 20_000,
      keepRecentTokens: 8_000,
    },
  };
});
