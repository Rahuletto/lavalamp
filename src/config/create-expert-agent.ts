import { createAgent } from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime';
import { readOnlyLocal } from '../sandbox/local';
import { WorkspaceGuard } from '../sandbox/workspace';
import { getMemoryContext, createMemoryTools } from '../sessions';
import { createRipgrepTool } from '../tools/ripgrep';
import { createCodebaseSearchTool } from '../tools/codebase-search';
import { createCodebaseSemanticSearchTool } from '../tools/codebase-semantic-search';
import { createLspTools } from '../tools/lsp-client';
import { createWebSearchTool } from '../tools/web-search';
import { createFetchUrlTool } from '../tools/fetch-url';
import { createDeepWikiTool } from '../tools/deepwiki';
import { createLoadSkillTool } from '../tools/skills';
import { withResultBudget } from '../tools/result-budget';
import { customReadTool } from '../tools/file-tools';
import {
  type ExpertId,
  type ExpertToolkit,
  EXPERT_PROFILES,
  resolveExpertModel,
} from './experts';
import { ensureProviders } from './register-providers';

ensureProviders();

const SHARED_PREAMBLE = [
  'You are a specialized *expert* inside lavalamp (Mixture of Experts).',
  'You advise the main coding agent. You do NOT apply file mutations yourself.',
  '',
  '## Hard rules',
  '- ALWAYS respond in English.',
  '- READ-ONLY: do not write, edit, rename, or run mutating shell commands.',
  '- Stay inside your domain. If the ask is outside your specialty, say so briefly and name the better expert.',
  '- Cite concrete file paths (and line ranges when known). Prefer evidence over vibes.',
  '- Keep the final answer actionable for the main agent that will implement it.',
  '',
].join('\n');

function buildToolkit(
  toolkit: ExpertToolkit[],
  workspaceRoot: string,
): ToolDefinition[] {
  const guard = new WorkspaceGuard(workspaceRoot);
  const tools: ToolDefinition[] = [];
  if (
    toolkit.some((tag) =>
      ['codebase_search', 'lsp', 'ripgrep', 'semantic_search'].includes(tag),
    )
  ) {
    tools.push(customReadTool);
  }

  for (const tag of toolkit) {
    switch (tag) {
      case 'memory_read':
        tools.push(
          ...createMemoryTools(workspaceRoot).filter(
            (t: ToolDefinition) => t.name === 'memory_read',
          ),
        );
        break;
      case 'ripgrep':
        tools.push(createRipgrepTool(workspaceRoot));
        break;
      case 'codebase_search':
        tools.push(createCodebaseSearchTool(guard));
        break;
      case 'semantic_search':
        tools.push(createCodebaseSemanticSearchTool(workspaceRoot));
        break;
      case 'lsp':
        tools.push(...createLspTools(workspaceRoot));
        break;
      case 'web_search':
        tools.push(createWebSearchTool());
        break;
      case 'fetch_url':
        tools.push(createFetchUrlTool());
        break;
      case 'deepwiki':
        tools.push(createDeepWikiTool());
        break;
      case 'load_skill':
        tools.push(createLoadSkillTool(workspaceRoot));
        break;
    }
  }

  return tools.map(withResultBudget);
}

function toolLegend(toolkit: ExpertToolkit[]): string {
  if (toolkit.length === 0) {
    return '- (no tools — rely on the prompt / attached images only)';
  }
  const labels: Record<ExpertToolkit, string> = {
    memory_read: '`memory_read` — project memory',
    ripgrep: '`ripgrep` — fast regex search (preferred over grep)',
    codebase_search: '`codebase_search` — filename + content search',
    semantic_search: '`codebase_semantic_search` — semantic code search',
    lsp: '`lsp_hover` / `lsp_definition` — language server queries',
    web_search: '`web_search` — web search',
    fetch_url: '`fetch_url` — fetch a URL as clean markdown',
    deepwiki: '`deepwiki` — repo documentation via DeepWiki',
    load_skill: '`load_skill` — load a SKILL.md on demand',
  };
  return toolkit.map((t) => `- ${labels[t]}`).join('\n');
}

export interface ExpertInstructionParts {
  /** Domain identity + mission (after shared preamble). */
  role: string[];
  /** Domain-specific rules. */
  rules: string[];
  /** Required output shape the main agent can consume. */
  outputContract: string[];
  /** Optional method / workflow steps. */
  method?: string[];
}

/**
 * Build a Flue expert agent from the roster profile + domain instructions.
 */
export function createExpertAgent(
  id: ExpertId,
  parts: ExpertInstructionParts,
) {
  const profile = EXPERT_PROFILES[id];

  return createAgent((ctx) => {
    const workspaceRoot = (ctx.env.LAVALAMP_WORKSPACE ??
      process.cwd()) as string;
    const model = resolveExpertModel(
      id,
      ctx.env as Record<string, string | undefined>,
    );
    const memoryContext = getMemoryContext(workspaceRoot);

    const instructions: string[] = [
      SHARED_PREAMBLE,
      `## Identity`,
      `You are the **${profile.displayName}** expert (\`${id}\`).`,
      profile.summary,
      '',
      ...parts.role,
      '',
      '## Domain rules',
      ...parts.rules,
      '',
      '## Method',
      ...(parts.method ?? [
        '- Read only what you need to answer precisely.',
        '- Prefer ripgrep/semantic search over blind full-file reads.',
        '- If evidence is missing, say what you would need next.',
      ]),
      '',
      '## Output contract',
      ...parts.outputContract,
      '',
      '## Tools',
      toolLegend(profile.toolkit),
      '',
      '## Out of scope',
      ...profile.whenNotToUse.map((w) => `- ${w}`),
    ];

    if (memoryContext !== null && profile.toolkit.includes('memory_read')) {
      instructions.push('', memoryContext);
    }

    return {
      compaction: profile.compaction,
      cwd: workspaceRoot,
      instructions: instructions.join('\n'),
      model,
      sandbox: readOnlyLocal({ env: { PATH: process.env.PATH ?? '' } }),
      thinkingLevel: profile.thinkingLevel,
      tools: buildToolkit(profile.toolkit, workspaceRoot),
    };
  });
}
