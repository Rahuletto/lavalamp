import * as v from 'valibot';
import { defineTool } from '@flue/runtime';
import * as path from 'node:path';
import { CodebaseIndexer } from '../storage/indexer';

const indexers = new Map<string, CodebaseIndexer>();

const codebaseSemanticSearchSchema = v.object({
  limit: v.optional(v.number()),
  query: v.string(),
});

export function createCodebaseSemanticSearchTool(workspaceRoot: string) {
  const workspaceKey = path.resolve(workspaceRoot);

  return defineTool({
    description:
      'Search the codebase semantically using vector database similarity. Best for finding code by intent, meaning, or functionality, rather than exact keyword matches.',
    execute: async (args) => {
      let indexer = indexers.get(workspaceKey);
      if (!indexer) {
        indexer = new CodebaseIndexer(workspaceKey);
        indexers.set(workspaceKey, indexer);
      }
      await indexer.startIndexing();
      return indexer.semanticSearch(args.query, Math.min(args.limit ?? 5, 10));
    },
    name: 'codebase_semantic_search',
    parameters: codebaseSemanticSearchSchema,
  });
}
