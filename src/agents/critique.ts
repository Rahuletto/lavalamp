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
    'You are the critique expert agent of lavalamp.',
    'Your main responsibility is auditing implementations, checking edge cases, finding coding slop, pointing out bugs, and offering constructive criticism.',
    '',
    '## Rules',
    '- Act as a harsh critic: question assumptions and review performance constraints.',
    '- Audit plans and code changes to ensure high maintainability and security standards.',
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
