import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { Patch, Patcher, NodeFilesystem, InMemorySnapshotStore } from '@oh-my-pi/hashline';
import { WorkspaceGuard } from '../sandbox/workspace';
import { getDiagnosticsForFile } from './lsp-client';

const fs = new NodeFilesystem();
export const sharedSnapshots = new InMemorySnapshotStore();
const patcher = new Patcher({ fs, snapshots: sharedSnapshots });

export const customReadTool = defineTool({
  description: 'Read file contents (supports offset/limit for chunks)',
  execute: async (args, ctx) => {
    const workspaceRoot = ctx.env.LAVALAMP_WORKSPACE ?? process.cwd();
    const guard = new WorkspaceGuard(workspaceRoot);
    const resolvedPath = guard.constrain(args.filePath);
    if (!existsSync(resolvedPath)) {
      throw new Error(`File does not exist: ${args.filePath}`);
    }
    const content = readFileSync(resolvedPath, 'utf8');

    // Mint tag in the shared snapshot store
    const tag = sharedSnapshots.record(resolvedPath, content);

    // Format like hashline expects: [path#tag] and line numbers
    const lines = content.split('\n');
    const offset = args.offset ?? 0;
    const limit = args.limit ?? lines.length;
    const sliced = lines.slice(offset, offset + limit);
    const formattedLines = sliced.map((line, i) => `${offset + i + 1}:${line}`).join('\n');
    return `[${args.filePath}#${tag}]\n${formattedLines}`;
  },
  name: 'read',
  parameters: v.object({
    filePath: v.string(),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  }),
});

export const customWriteTool = defineTool({
  description: 'Create or overwrite a file',
  execute: async (args, ctx) => {
    const workspaceRoot = ctx.env.LAVALAMP_WORKSPACE ?? process.cwd();
    const guard = new WorkspaceGuard(workspaceRoot);
    const resolvedPath = guard.constrain(args.filePath);

    mkdirSync(dirname(resolvedPath), { recursive: true });
    writeFileSync(resolvedPath, args.content, 'utf8');

    // Update the snapshot store so future edits have a starting snapshot
    sharedSnapshots.record(resolvedPath, args.content);

    let result = `Wrote file successfully to ${args.filePath}.\n`;
    const errors = await getDiagnosticsForFile(workspaceRoot, args.filePath);
    if (errors.length > 0) {
      result += `\n[Warning: Diagnostics detected after write]\n${errors.join('\n')}\n`;
    }
    return result;
  },
  name: 'write',
  parameters: v.object({
    content: v.string(),
    filePath: v.string(),
  }),
});

export const customEditTool = defineTool({
  description: 'Apply a hashline patch to modify a file',
  execute: async (args, ctx) => {
    const workspaceRoot = ctx.env.LAVALAMP_WORKSPACE ?? process.cwd();
    const guard = new WorkspaceGuard(workspaceRoot);

    const patch = Patch.parse(args.patch);
    for (const section of patch.sections) {
      guard.constrain(section.filePath);
    }

    try {
      const applied = await patcher.apply(patch);
      const filePaths = patch.sections.map((s) => s.filePath);

      let result = 'Applied hashline patch successfully.\n';

      const diagParts: string[] = [];
      for (const filePath of filePaths) {
        const errors = await getDiagnosticsForFile(workspaceRoot, filePath);
        if (errors.length > 0) {
          diagParts.push(`Diagnostics for ${filePath}:\n${errors.join('\n')}`);
        }
      }

      if (diagParts.length > 0) {
        result += `\n[Warning: Diagnostics detected after edit]\n${diagParts.join('\n')}\n`;
      }

      return result;
    } catch (error: any) {
      return `Error applying patch: ${error.message}`;
    }
  },
  name: 'edit',
  parameters: v.object({
    patch: v.string(),
  }),
});
