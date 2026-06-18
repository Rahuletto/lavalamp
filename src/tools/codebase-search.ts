import * as v from 'valibot';
import { defineTool } from '@flue/runtime';
import type { WorkspaceGuard } from '../sandbox/workspace';

const codebaseSearchSchema = v.object({
  query: v.string(),
  pattern: v.optional(v.string()),
});

export function createCodebaseSearchTool(guard: WorkspaceGuard) {
  let cachedBackend: 'rg' | 'grep' | 'bun' | null = null;

  async function detectBackend(): Promise<'rg' | 'grep' | 'bun'> {
    if (cachedBackend) return cachedBackend;
    try {
      const proc = Bun.spawn(['rg', '--version'], { stdout: 'pipe', stderr: 'pipe' });
      await proc.exited;
      cachedBackend = 'rg';
    } catch {
      try {
        const proc = Bun.spawn(['grep', '--version'], { stdout: 'pipe', stderr: 'pipe' });
        await proc.exited;
        cachedBackend = 'grep';
      } catch {
        cachedBackend = 'bun';
      }
    }
    return cachedBackend;
  }

  return defineTool({
    name: 'codebase_search',
    description:
      'Search the codebase for files and code matching a query. Combines filename matching and content search. Use to find relevant files, functions, classes, or patterns across the project.',
    parameters: codebaseSearchSchema,
    execute: async (args) => {
      const backend = await detectBackend();
      const results: string[] = [];

      const glob = new Bun.Glob(`**/*${args.query}*`);
      for await (const match of glob.scan({ cwd: guard.root })) {
        if (!match.includes('node_modules') && !match.includes('.git')) {
          results.push(`file: ${match}`);
        }
        if (results.length >= 20) break;
      }

      const searchPattern = args.pattern ?? args.query;
      try {
        let output = '';
        if (backend === 'rg') {
          const proc = Bun.spawn(
            ['rg', '-n', '--no-heading', '-i', searchPattern, guard.root, '--glob', '!node_modules', '--glob', '!.git'],
            { stdout: 'pipe', stderr: 'pipe' }
          );
          output = await new Response(proc.stdout).text();
        } else if (backend === 'grep') {
          const proc = Bun.spawn(
            ['grep', '-rn', '-i', searchPattern, guard.root, '--exclude-dir=node_modules', '--exclude-dir=.git'],
            { stdout: 'pipe', stderr: 'pipe' }
          );
          output = await new Response(proc.stdout).text();
        } else {
          const regex = new RegExp(searchPattern, 'gi');
          const glob = new Bun.Glob('**/*');
          for await (const match of glob.scan({ cwd: guard.root })) {
            if (match.includes('node_modules') || match.includes('.git')) continue;
            const file = Bun.file(`${guard.root}/${match}`);
            if (!(await file.exists())) continue;
            const text = await file.text();
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push(`${match}:${i + 1}: ${lines[i].trim()}`);
              }
              regex.lastIndex = 0;
            }
            if (results.length >= 50) break;
          }
        }

        if (output.trim()) {
          const lines = output.trim().split('\n').slice(0, 30);
          results.push(...lines.map((l) => l.replace(guard.root + '/', '')));
        }
      } catch {}

      if (results.length === 0) {
        return `No results found for: ${args.query}`;
      }

      return results.slice(0, 40).join('\n');
    },
  });
}
