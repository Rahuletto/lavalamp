import * as v from 'valibot';
import { defineTool } from '@flue/runtime';
import { CodebaseIndexer } from '../storage/indexer';

const codebaseSemanticSearchSchema = v.object({
  query: v.string(),
  limit: v.optional(v.number()),
});

export function createCodebaseSemanticSearchTool(workspaceRoot: string) {
  const indexer = new CodebaseIndexer(workspaceRoot);
  // Warm up / start background indexing and watching
  indexer.startIndexing().catch(() => {});
  indexer.watchWorkspace();


  return defineTool({
    name: 'codebase_semantic_search',
    description:
      'Search the codebase semantically using vector database similarity. Best for finding code by intent, meaning, or functionality, rather than exact keyword matches.',
    parameters: codebaseSemanticSearchSchema,
    execute: async (args) => {
      return indexer.semanticSearch(args.query, args.limit ?? 5);
    },
  });
}
