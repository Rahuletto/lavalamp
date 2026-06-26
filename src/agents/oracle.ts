import { createAgent } from '@flue/runtime';
import { local } from '../sandbox/local';
import { BUILD_MODEL, resolveModelWithFallback } from '../config/models';
import { startSession, getMemoryContext, createMemoryTools } from '../sessions';
import { createRipgrepTool } from '../tools/ripgrep';
import { createCodebaseSemanticSearchTool } from '../tools/codebase-semantic-search';

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
    'You are the oracle expert agent of lavalamp.',
    'Your main responsibility is scanning the entire codebase, cross-referencing code symbols, identifying design patterns, security risks, and verifying code compatibility.',
    '',
    '## Rules',
    '- Thoroughly analyze codebase dependencies and usage patterns.',
    '- Audit the overall code structure for consistency and logic leaks.',
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
      createCodebaseSemanticSearchTool(workspaceRoot),
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
