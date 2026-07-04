import { createAgent } from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime';
import { local } from '../sandbox/local';
import { BUILD_MODEL } from '../config/models';
import { resolveSelectedModel } from '../config/runtime-route';
import { getMemoryContext, createMemoryTools } from '../sessions';
import { createRipgrepTool } from '../tools/ripgrep';

export default createAgent((ctx) => {
  const workspaceRoot = ctx.env.LAVALAMP_WORKSPACE ?? process.cwd();

  const model = resolveSelectedModel(
    BUILD_MODEL,
    ctx.env as Record<string, string | undefined>,
  );
  const memoryContext = getMemoryContext(workspaceRoot as string);

  const instructions = [
    'You are the logic expert agent of lavalamp.',
    'Your main responsibility is programming logic, algorithms, type constraints, data structures, and debugging syntax/compilation issues.',
    '',
    '## Rules',
    '- Provide language- and framework-agnostic logical algorithms, structure patterns, and code safety guarantees.',
    '- Help debug complicated nested logic, conditional gates, and runtime flows.',
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
