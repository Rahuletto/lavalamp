import * as v from 'valibot';
import { defineTool } from '@flue/runtime';
import type { ChangeTracker } from './change-tracker';

const renameSchema = v.object({
  newPath: v.string(),
  oldPath: v.string(),
});

export function createRenameTool(tracker: ChangeTracker) {
  return defineTool({
    description:
      'Rename or move a file within the workspace. Explicit so it can be permission-gated separately from bash mv.',
    execute: async (args) => {
      const file = Bun.file(args.oldPath);
      if (!(await file.exists())) {
        throw new Error(`Source not found: ${args.oldPath}`);
      }

      await tracker.record(`rename: ${args.oldPath} -> ${args.newPath}`, [
        args.oldPath,
        args.newPath,
      ]);

      await Bun.write(args.newPath, await file.text());
      await Bun.file(args.oldPath).delete();

      return `Renamed ${args.oldPath} -> ${args.newPath}`;
    },
    name: 'rename',
    parameters: renameSchema,
  });
}
