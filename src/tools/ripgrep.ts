import * as v from 'valibot';
import { defineTool } from '@flue/runtime';

const MAX_RESULTS = 100;
const MAX_OUTPUT_BYTES = 50 * 1024;

const ripgrepSchema = v.object({
  pattern: v.string(),
  path: v.optional(v.string()),
  ignoreCase: v.optional(v.boolean()),
  fileType: v.optional(v.string()),
  context: v.optional(v.number()),
  maxResults: v.optional(v.number()),
  wholeWord: v.optional(v.boolean()),
  multiline: v.optional(v.boolean()),
});

export function createRipgrepTool(cwd: string) {
  return defineTool({
    name: 'ripgrep',
    description:
      'Search file contents using ripgrep with regex support. Faster and more powerful than the built-in grep tool. Returns file paths, line numbers, and matching lines. Use this instead of grep for codebase searches.',
    parameters: ripgrepSchema,
    execute: async (args) => {
      const rgArgs = [
        '-n',
        '--no-heading',
        '--color=never',
      ];

      if (args.ignoreCase) rgArgs.push('-i');
      if (args.wholeWord) rgArgs.push('-w');
      if (args.multiline) rgArgs.push('-U');
      if (args.context != null) rgArgs.push(`-C${args.context}`);
      if (args.fileType) rgArgs.push('-t', args.fileType);

      const limit = Math.min(args.maxResults ?? MAX_RESULTS, MAX_RESULTS);
      rgArgs.push('--max-count', String(limit));

      rgArgs.push(args.pattern);

      const searchPath = args.path ? `${cwd}/${args.path}` : cwd;
      rgArgs.push(searchPath);

      rgArgs.push('--glob', '!node_modules');
      rgArgs.push('--glob', '!.git');
      rgArgs.push('--glob', '!dist');
      rgArgs.push('--glob', '!.next');
      rgArgs.push('--glob', '!coverage');

      try {
        const proc = Bun.spawn(['rg', ...rgArgs], {
          stdout: 'pipe',
          stderr: 'pipe',
          cwd,
        });

        const stdout = await new Response(proc.stdout).arrayBuffer();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        let output = new TextDecoder().decode(stdout);

        if (exitCode === 1 && !output.trim()) {
          return `No matches found for pattern: ${args.pattern}`;
        }

        if (exitCode === 2) {
          return `ripgrep error: ${stderr.trim() || 'exited with code 2'}`;
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
            const lineBytes = new TextEncoder().encode(line + '\n').byteLength;
            if (totalBytes + lineBytes > MAX_OUTPUT_BYTES) break;
            truncatedLines.push(line);
            totalBytes += lineBytes;
          }
          output = truncatedLines.join('\n');
        }

        const resultLines = output.trim().split('\n');
        const stripped = resultLines.map((l) =>
          l.startsWith(cwd + '/') ? l.slice(cwd.length + 1) : l,
        );

        const header = `[ripgrep: ${stripped.length} matches]`;
        const footer = truncated
          ? `\n[Results truncated. Refine pattern or increase maxResults.]`
          : '';

        return [header, ...stripped].join('\n') + footer;
      } catch (err) {
        return `ripgrep failed: ${err instanceof Error ? err.message : String(err)}. Is ripgrep installed? (brew install ripgrep)`;
      }
    },
  });
}
