import { createAgent } from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime';
import { local } from '../sandbox/local';
import { BUILD_MODEL, resolveModelWithFallback } from '../config/models';
import { getMemoryContext, createMemoryTools } from '../sessions';
import { createRipgrepTool } from '../tools/ripgrep';

export default createAgent((ctx) => {
  const workspaceRoot = ctx.env.LAVALAMP_WORKSPACE ?? process.cwd();

  

  const model = resolveModelWithFallback(
    BUILD_MODEL,
    ctx.env as Record<string, string>,
  );
  const memoryContext = getMemoryContext(workspaceRoot as string);

  const instructions = [
    'You are the refactor expert agent of lavalamp.',
    'Your main responsibility is clean code structure, refactoring, DRY principles, removing code slop, and simplifying conditional complexity.',
    '',
    '## Rules',
    '- Review code patterns for maintainability and size.',
    '- Suggest structural modifications to decouple components.',
    '- Strip unnecessary AI comments, verbose guards, and redundant boilerplate.',
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
      ...createMemoryTools(workspaceRoot as string).filter(
        (t: ToolDefinition) => t.name === 'memory_read',
      ),
      createRipgrepTool(workspaceRoot as string),
    ],
  };
});
