import { defineTool } from '@flue/runtime';
import * as path from 'node:path';
import * as v from 'valibot';
import { GraphIndexer } from '../storage/graph-indexer';

const indexers = new Map<string, GraphIndexer>();

const schema = v.object({
  query: v.string(),
  depth: v.optional(v.number()),
  limit: v.optional(v.number()),
});

export function createCodebaseGraphTool(workspaceRoot: string) {
  const workspaceKey = path.resolve(workspaceRoot);
  return defineTool({
    name: 'codebase_graph',
    description:
      'Query the offline symbol and file dependency graph. Returns concise definitions, imports, reverse dependencies, and references with source locations.',
    parameters: schema,
    execute: async (args) => {
      const depth = Math.max(0, Math.min(Math.floor(args.depth ?? 1), 1));
      let indexer = indexers.get(workspaceKey);
      if (!indexer) {
        indexer = new GraphIndexer(workspaceKey);
        indexers.set(workspaceKey, indexer);
      }
      return indexer.query(
        args.query,
        Math.max(1, Math.min(Math.floor(args.limit ?? 20), 50)),
        depth,
      );
    },
  });
}
