import { createAgent } from '@flue/runtime';
import { local } from '../sandbox/local';
import { BUILD_MODEL, resolveModelWithFallback } from '../config/models';

export default createAgent((ctx) => {
  const workspaceRoot = ctx.env.LAVALAMP_WORKSPACE ?? process.cwd();

  

  const model = resolveModelWithFallback(
    BUILD_MODEL,
    ctx.env as Record<string, string>,
  );

  const instructions = [
    'You are the spectacle expert agent of lavalamp.',
    'Your sole responsibility is reading image contents, screenshots, and visual designs, and explaining them in structured text.',
    '',
    '## Rules',
    '- Analyze visual layouts, text exactness, buttons, UI alignment, contrast, console/syntax error indicators.',
    '- Provide clean, structured visual descriptions to the routing text agent.',
    '- You do not edit code or run files directly.',
  ];

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
    tools: [],
  };
});
