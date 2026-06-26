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
    'You are the database expert agent of lavalamp.',
    'Your main responsibility is database structures, schema configurations, SQL/NoSQL setups, migrations, query performance optimization, and caching strategies.',
    '',
    '## Rules',
    '- Provide language- and database-agnostic schemas, relational designs, and query optimizations.',
    '- Assist with partitioning, indexing, caching layout, and transactional logic.',
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
