import * as v from 'valibot';
import { defineTool } from '@flue/runtime';

const doomLoopSchema = v.object({
  attempts: v.optional(v.string()),
  issue: v.string(),
});

export function createDoomLoopTool() {
  return defineTool({
    description:
      'Call this when you are stuck in a loop, repeating the same failing approach, or unable to make progress. Provides structured recovery steps to break out of the pattern.',
    execute: async (args) => {
      const attempts = args.attempts ?? 'unknown';
      return [
        `## Doom Loop Detected`,
        '',
        `**Issue:** ${args.issue}`,
        `**Previous attempts:** ${attempts}`,
        '',
        `### Recovery Steps`,
        '',
        '1. **Stop** — Do NOT retry the same approach.',
        '2. **Re-read** — Read the file(s) involved again. The state may have changed.',
        '3. **Simplify** — Break the problem into the smallest possible step.',
        '4. **Try alternative** — Use a completely different approach than what you attempted.',
        '5. **Ask user** — If still stuck, explain what you tried and ask for guidance.',
        '',
        'Do not repeat any approach that has already failed.',
      ].join('\n');
    },
    name: 'doom_loop',
    parameters: doomLoopSchema,
  });
}
