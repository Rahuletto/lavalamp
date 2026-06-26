import * as v from 'valibot';
import { defineTool } from '@flue/runtime';

const MAX_RESULTS = 100;
const MAX_OUTPUT_BYTES = 50 * 1024;

const ripgrepSchema = v.object({
  context: v.optional(v.number()),
  fileType: v.optional(v.string()),
  ignoreCase: v.optional(v.boolean()),
  maxResults: v.optional(v.number()),
  multiline: v.optional(v.boolean()),
  path: v.optional(v.string()),
  pattern: v.string(),
  wholeWord: v.optional(v.boolean()),
});

export function createRipgrepTool(cwd: string) {
  return defineTool({
    description:
      'Search file contents using ripgrep with regex support. Faster and more powerful than the built-in grep tool. Returns file paths, line numbers, and matching lines. Use this instead of grep for codebase searches.',
    execute: async (args) => {
      const rgArgs = ['-n', '--no-heading', '--color=never'];

      if (args.ignoreCase) {rgArgs.push('-i');}
      if (args.wholeWord) {rgArgs.push('-w');}
      if (args.multiline) {rgArgs.push('-U');}
      if (args.context !== null) {rgArgs.push(`-C${args.context}`);}
      if (args.fileType !== null && args.fileType !== undefined) {rgArgs.push('-t', args.fileType);}

      const limit = Math.min(args.maxResults ?? MAX_RESULTS, MAX_RESULTS);
      rgArgs.push('--max-count', String(limit), args.pattern);

      const searchPath = args.path !== null && args.path !== undefined ? `${cwd}/${args.path}` : cwd;
      rgArgs.push(searchPath, '--glob', '!node_modules', '--glob', '!.git', '--glob', '!dist', '--glob', '!.next', '--glob', '!coverage');

      try {
        const proc = Bun.spawn(['rg', ...rgArgs], {
          cwd,
          stderr: 'pipe',
          stdout: 'pipe',
        });

        const stdout = await new Response(proc.stdout).arrayBuffer();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        let output = new TextDecoder().decode(stdout);

        if (exitCode === 1 && !output.trim()) {
          return `No matches found for pattern: ${args.pattern}`;
        }

        if (exitCode === 2) {
          throw new Error(
            `ripgrep error: ${stderr.trim() || 'exited with code 2'}`,
          );
        }

        const lines = output.trim().split('\n');
        const truncated = lines.length > limit;
        if (truncated) {
          output = lines.slice(0, limit).join('\n');
        }

        const bytes = new TextEncoder().encode(output).byteLength;
        if (bytes > MAX_OUTPUT_BYTES) {
          const truncatedLines: string[] = [];
          let totalBytes = 0;
          for (const line of lines) {
            const lineBytes = new TextEncoder().encode(`${line  }\n`).byteLength;
            if (totalBytes + lineBytes > MAX_OUTPUT_BYTES) {break;}
            truncatedLines.push(line);
            totalBytes += lineBytes;
          }
          output = truncatedLines.join('\n');
        }

        const resultLines = output.trim().split('\n');
        const stripped = resultLines.map((l) =>
          l.startsWith(`${cwd  }/`) ? l.slice(cwd.length + 1) : l,
        );

        const header = `[ripgrep: ${stripped.length} matches]`;
        const footer = truncated
          ? `\n[Results truncated. Refine pattern or increase maxResults.]`
          : '';

        return [header, ...stripped].join('\n') + footer;
      } catch (error) {
        throw new Error(
          `ripgrep failed: ${error instanceof Error ? error.message : String(error)}. Is ripgrep installed? (brew install ripgrep)`, { cause: error },
        );
      }
    },
    name: 'ripgrep',
    parameters: ripgrepSchema,
  });
}
