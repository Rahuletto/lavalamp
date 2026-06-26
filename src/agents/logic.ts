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
    'You are the logic expert agent of lavalamp.',
    'Your main responsibility is programming logic, algorithms, type constraints, data structures, and debugging syntax/compilation issues.',
    '',
    '## Rules',
    '- Provide language- and framework-agnostic logical algorithms, structure patterns, and code safety guarantees.',
    '- Help debug complicated nested logic, conditional gates, and runtime flows.',
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
