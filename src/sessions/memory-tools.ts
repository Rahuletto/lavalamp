import * as v from 'valibot';
import { defineTool } from '@flue/runtime';
import { loadMemory, saveMemory, appendMemory } from './memory';

export function createMemoryTools(cwd: string) {
  const readMemory = defineTool({
    name: 'memory_read',
    description:
      'Read the persistent project memory file. This contains notes, decisions, and context from previous sessions. Use this at the start of a session to understand what was done before.',
    parameters: v.object({}),
    execute: async () => {
      const memory = loadMemory(cwd);
      if (!memory) return 'No project memory found yet.';
      return memory;
    },
  });

  const writeMemory = defineTool({
    name: 'memory_write',
    description:
      'Overwrite the entire project memory file with new content. Use this for major updates or restructuring of the memory.',
    parameters: v.object({
      content: v.string(),
    }),
    execute: async (args) => {
      saveMemory(cwd, args.content);
      return 'Project memory updated.';
    },
  });

  const appendMemoryTool = defineTool({
    name: 'memory_append',
    description:
      'Append an entry to the project memory file. Use this to record important decisions, discoveries, or context that should persist across sessions.',
    parameters: v.object({
      entry: v.string(),
    }),
    execute: async (args) => {
      appendMemory(cwd, args.entry);
      return `Appended to project memory: "${args.entry.slice(0, 60)}${args.entry.length > 60 ? '...' : ''}"`;
    },
  });

  return [readMemory, writeMemory, appendMemoryTool];
}
