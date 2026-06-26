import * as v from 'valibot';
import { defineTool } from '@flue/runtime';
import type { ChangeTracker } from './change-tracker';

export function createUndoTool(tracker: ChangeTracker) {
  return defineTool({
    description:
      'Reverse the last file-changing operation. Restores every file that was modified by the most recent write/edit/rename/bash call to its exact state before that call. Use this when a tool call corrupted a file or produced wrong results — then re-read and try a better edit.',
    execute: async () => {
      if (tracker.size === 0) {
        return 'Nothing to undo — change history is empty.';
      }

      const { restored, label } = await tracker.undoLast();

      const lines = [
        `Undone: ${label}`,
        `Restored ${restored.length} file(s):`,
        ...restored.map((f) => `  ${f}`),
        '',
        'Re-read the file(s) before trying again.',
      ];
      return lines.join('\n');
    },
    name: 'undo',
    parameters: v.object({}),
  });
}

export function createHistoryTool(tracker: ChangeTracker) {
  return defineTool({
    description:
      'Show the list of file-modifying operations in this session (oldest first). Use before undo to see what can be reversed.',
    execute: async () => {
      if (tracker.size === 0) {
        return 'No file changes recorded yet.';
      }
      return tracker.history.join('\n');
    },
    name: 'history',
    parameters: v.object({}),
  });
}
