import * as v from 'valibot';
import { defineTool } from '@flue/runtime';

const deployParallelSubsSchema = v.object({
  queries: v.array(v.string()),
});

export function createDeployParallelSubsTool() {
  return defineTool({
    name: 'deploy_parallel_subs',
    description:
      'Deploy up to 3 parallel research agents to investigate multiple topics simultaneously. Each agent runs independently and results are merged back. Use for exploring multiple code paths, comparing approaches, or gathering information from different sources at once.',
    parameters: deployParallelSubsSchema,
    execute: async (args) => {
      const queries = args.queries.slice(0, 3);
      if (queries.length === 0) {
        return { error: 'At least one query is required' };
      }
      return {
        type: 'parallel_deploy',
        queries,
        status: 'deployed',
        message: `${queries.length} research agent(s) deployed`,
      };
    },
  });
}
