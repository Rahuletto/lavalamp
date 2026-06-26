import { createAgent } from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime';
import { local } from '../sandbox/local';
import { BUILD_MODEL, resolveModelWithFallback } from '../config/models';
import { getMemoryContext, createMemoryTools } from '../sessions';
import { createRipgrepTool } from '../tools/ripgrep';
import { createCodebaseSemanticSearchTool } from '../tools/codebase-semantic-search';

export default createAgent((ctx) => {
  const workspaceRoot = ctx.env.LAVALAMP_WORKSPACE ?? process.cwd();

  

  const model = resolveModelWithFallback(
    BUILD_MODEL,
    ctx.env as Record<string, string>,
  );
  const memoryContext = getMemoryContext(workspaceRoot as string);

  const instructions = [
    'You are the oracle expert agent of lavalamp.',
    'Your main responsibility is scanning the entire codebase, cross-referencing code symbols, identifying design patterns, security risks, and verifying code compatibility.',
    '',
    '## Rules',
    '- Thoroughly analyze codebase dependencies and usage patterns.',
    '- Audit the overall code structure for consistency and logic leaks.',
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
      createCodebaseSemanticSearchTool(workspaceRoot as string),
    ],
  };
});
