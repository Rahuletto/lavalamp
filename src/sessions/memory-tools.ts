import * as v from 'valibot';
import { defineTool } from '@flue/runtime';
import { loadMemory, saveMemory, appendMemory } from './memory';

export function createMemoryTools(cwd: string) {
  const readMemory = defineTool({
    description:
      'Read the persistent project memory file. This contains notes, decisions, and context from previous sessions. Use this at the start of a session to understand what was done before.',
    execute: async () => {
      const memory = loadMemory(cwd);
      if (!memory) return 'No project memory found yet.';
      return memory;
    },
    name: 'memory_read',
    parameters: v.object({}),
  });

  const writeMemory = defineTool({
    description:
      'Overwrite the entire project memory file with new content. Use this for major updates or restructuring of the memory.',
    execute: async (args) => {
      saveMemory(cwd, args.content);
      return 'Project memory updated.';
    },
    name: 'memory_write',
    parameters: v.object({
      content: v.string(),
    }),
  });

  const appendMemoryTool = defineTool({
    description:
      'Append an entry to the project memory file. Use this to record important decisions, discoveries, or context that should persist across sessions.',
    execute: async (args) => {
      appendMemory(cwd, args.entry);
      return `Appended to project memory: "${args.entry.slice(0, 60)}${args.entry.length > 60 ? '...' : ''}"`;
    },
    name: 'memory_append',
    parameters: v.object({
      entry: v.string(),
    }),
  });

  return [readMemory, writeMemory, appendMemoryTool];
}
