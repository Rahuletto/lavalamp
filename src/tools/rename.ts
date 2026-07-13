import * as v from 'valibot';
import { defineTool } from '@flue/runtime';
import type { ChangeTracker } from './change-tracker';
import { mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { WorkspaceGuard } from '../sandbox/workspace';

const renameSchema = v.object({
  newPath: v.string(),
  oldPath: v.string(),
});

export function createRenameTool(tracker: ChangeTracker, workspaceRoot: string) {
  const guard = new WorkspaceGuard(workspaceRoot);

  return defineTool({
    description:
      'Rename or move a file within the workspace. Explicit so it can be permission-gated separately from bash mv.',
    execute: async (args) => {
      const oldPath = guard.constrainEntry(args.oldPath);
      const newPath = guard.constrainEntry(args.newPath);
      const file = Bun.file(oldPath);
      if (!(await file.exists())) {
        throw new Error(`Source not found: ${args.oldPath}`);
      }

      await tracker.record(`rename: ${args.oldPath} -> ${args.newPath}`, [
        oldPath,
        newPath,
      ]);

      if (
        guard.constrainEntry(args.oldPath) !== oldPath ||
        guard.constrainEntry(args.newPath) !== newPath
      ) {
        throw new Error('Rename paths changed during validation');
      }
      await mkdir(dirname(newPath), { recursive: true });
      await rename(oldPath, newPath);

      return `Renamed ${args.oldPath} -> ${args.newPath}`;
    },
    name: 'rename',
    parameters: renameSchema,
  });
}
