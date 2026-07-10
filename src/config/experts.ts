/**
 * Mixture-of-Experts roster for lavalamp.
 *
 * Experts are specialized *advisory* agents invoked via `query_expert`.
 * They must differ in role, preferred model, thinking level, toolkit, and
 * output contract — otherwise MoE is just ceremony over one agent.
 *
 * Override any expert model with LAVALAMP_EXPERT_<ID>_MODEL
 * (e.g. LAVALAMP_EXPERT_ORACLE_MODEL=anthropic/claude-sonnet-4-20250514).
 * Set LAVALAMP_EXPERTS_FOLLOW_SESSION=1 to force every expert onto the
 * session/default model (disables model specialization).
 */

import { BUILD_MODEL } from './models';
import { resolveSelectedModel } from './runtime-route';

export const EXPERT_IDS = [
  'ui',
  'refactor',
  'logic',
  'database',
  'oracle',
  'research',
  'critique',
  'spectacle',
] as const;

export type ExpertId = (typeof EXPERT_IDS)[number];

export type ExpertThinkingLevel = 'low' | 'medium' | 'high';

/** Toolkit tags — mapped to concrete tools in create-expert. */
export type ExpertToolkit =
  | 'memory_read'
  | 'ripgrep'
  | 'codebase_search'
  | 'semantic_search'
  | 'lsp'
  | 'web_search'
  | 'fetch_url'
  | 'deepwiki'
  | 'load_skill';

export interface ExpertProfile {
  id: ExpertId;
  displayName: string;
  /** One-line summary for tool descriptions and routing tables. */
  summary: string;
  whenToUse: string[];
  whenNotToUse: string[];
  /** Default model when no expert-specific env override is set. */
  preferredModel: string;
  thinkingLevel: ExpertThinkingLevel;
  toolkit: ExpertToolkit[];
  /**
   * Compaction budget. Deeper analysts keep more context.
   * keepRecentTokens / reserveTokens mirror Flue createAgent options.
   */
  compaction: { keepRecentTokens: number; reserveTokens: number };
}

/** Fast default for shallow / retrieval-heavy experts. */
const FAST = BUILD_MODEL;

/** Strong general reasoning (Workers AI). */
const STRONG = 'cloudflare-workers-ai/@cf/zai-org/glm-5.2';

/** Large-context code specialist. */
const CODE = 'cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code';

/** Deep second-pass model (different family from STRONG). */
const DEEP = 'cloudflare-workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** Vision-capable model for spectacle. */
const VISION =
  'cloudflare-workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct';

const CODE_SEARCH: ExpertToolkit[] = [
  'memory_read',
  'ripgrep',
  'codebase_search',
  'semantic_search',
];

export const EXPERT_PROFILES: Record<ExpertId, ExpertProfile> = {
  ui: {
    id: 'ui',
    displayName: 'UI / UX',
    summary:
      'Frontend layout, styling, a11y, design tokens, responsive behavior, motion.',
    whenToUse: [
      'Component structure, layout systems, CSS/Tailwind/theme tokens',
      'Accessibility, focus order, contrast, responsive breakpoints',
      'Interaction polish: loading states, empty states, transitions',
    ],
    whenNotToUse: [
      'Backend APIs, data models, algorithms, or pure refactor structure',
      'Screenshot interpretation (use spectacle)',
    ],
    preferredModel: FAST,
    thinkingLevel: 'medium',
    toolkit: [...CODE_SEARCH, 'load_skill'],
    compaction: { keepRecentTokens: 6000, reserveTokens: 16_000 },
  },

  refactor: {
    id: 'refactor',
    displayName: 'Refactor',
    summary:
      'Structure, DRY, extract modules, kill slop, shrink god-files and condition spaghetti.',
    whenToUse: [
      'Simplify tangled control flow or oversized modules',
      'Extract pure helpers, rename for clarity, remove AI slop',
      'Propose a safe refactor sequence with risk notes',
    ],
    whenNotToUse: [
      'Adding new features or greenfield design',
      'Database schema design (use database)',
      'Harsh security audit (use critique)',
    ],
    preferredModel: CODE,
    thinkingLevel: 'medium',
    toolkit: CODE_SEARCH,
    compaction: { keepRecentTokens: 8000, reserveTokens: 20_000 },
  },

  logic: {
    id: 'logic',
    displayName: 'Logic / Algorithms',
    summary:
      'Algorithms, types, concurrency, control-flow correctness, edge-case reasoning.',
    whenToUse: [
      'Hard branching, state machines, race conditions, type puzzles',
      'Complexity analysis, invariants, correctness proofs of a function',
      'Debugging "why is this branch never hit" style bugs',
    ],
    whenNotToUse: [
      'Visual design or styling',
      'Schema/migrations (use database)',
      'Broad architecture review (use oracle)',
    ],
    preferredModel: STRONG,
    thinkingLevel: 'high',
    toolkit: [...CODE_SEARCH, 'lsp'],
    compaction: { keepRecentTokens: 10_000, reserveTokens: 24_000 },
  },

  database: {
    id: 'database',
    displayName: 'Database',
    summary:
      'Schemas, migrations, indexes, query shape, caching, consistency trade-offs.',
    whenToUse: [
      'Table/collection design, relationships, constraints',
      'Index strategy, N+1 risk, query rewrite, migration plan',
      'Caching layers and transactional boundaries',
    ],
    whenNotToUse: [
      'UI binding of query results (use ui)',
      'General application architecture without data focus (use oracle)',
    ],
    preferredModel: STRONG,
    thinkingLevel: 'high',
    toolkit: CODE_SEARCH,
    compaction: { keepRecentTokens: 8000, reserveTokens: 20_000 },
  },

  oracle: {
    id: 'oracle',
    displayName: 'Oracle (codebase)',
    summary:
      'Deep cross-repo scan: patterns, coupling, security surface, fitness of a design.',
    whenToUse: [
      'Cross-cutting questions that need many files as evidence',
      'Architecture fitness, dependency direction, blast radius',
      'Compatibility and consistency audits across modules',
    ],
    whenNotToUse: [
      'Quick second opinion without repo context (use the oracle *tool*)',
      'External docs/API research (use research)',
      'Screenshot description (use spectacle)',
    ],
    preferredModel: DEEP,
    thinkingLevel: 'high',
    toolkit: [...CODE_SEARCH, 'deepwiki', 'lsp'],
    compaction: { keepRecentTokens: 12_000, reserveTokens: 28_000 },
  },

  research: {
    id: 'research',
    displayName: 'Research',
    summary:
      'External docs, APIs, libraries, changelogs — synthesize sources for the main agent.',
    whenToUse: [
      'Library/API how-tos, version constraints, migration guides',
      'Comparing third-party options with citations',
      'Reading remote docs the main agent should not bloat context with',
    ],
    whenNotToUse: [
      'In-repo symbol search or architecture (use oracle/explore)',
      'Implementing code changes',
    ],
    preferredModel: FAST,
    thinkingLevel: 'low',
    toolkit: ['web_search', 'fetch_url', 'deepwiki', 'load_skill'],
    compaction: { keepRecentTokens: 6000, reserveTokens: 16_000 },
  },

  critique: {
    id: 'critique',
    displayName: 'Critique',
    summary:
      'Adversarial review: bugs, security, edge cases, maintainability — severity-ranked.',
    whenToUse: [
      'Review a plan or patch before merge',
      'Hunt bugs, auth/permission holes, missing edge cases',
      'Harsh maintainability pass after implementation',
    ],
    whenNotToUse: [
      'Writing the first draft of a feature',
      'Pure visual QA from screenshots (use spectacle + critique)',
    ],
    preferredModel: DEEP,
    thinkingLevel: 'high',
    toolkit: CODE_SEARCH,
    compaction: { keepRecentTokens: 10_000, reserveTokens: 24_000 },
  },

  spectacle: {
    id: 'spectacle',
    displayName: 'Spectacle (vision)',
    summary:
      'Vision bridge: describe screenshots, UI mockups, error dialogs as structured text.',
    whenToUse: [
      'User pasted or attached an image the text agent cannot see',
      'Need exact on-screen text, layout, or error message extraction',
    ],
    whenNotToUse: [
      'Any code edit or non-visual task',
      'Design recommendations without an image (use ui)',
    ],
    preferredModel: VISION,
    thinkingLevel: 'low',
    toolkit: [],
    compaction: { keepRecentTokens: 4000, reserveTokens: 12_000 },
  },
};

/**
 * Resolve the model for an expert spawn.
 * Precedence: LAVALAMP_EXPERT_<ID>_MODEL → (optional follow session) → preferred.
 */
export function resolveExpertModel(
  id: ExpertId,
  env: Record<string, string | undefined> = process.env,
): string {
  const envKey = `LAVALAMP_EXPERT_${id.toUpperCase()}_MODEL`;
  const override = env[envKey];
  if (override !== undefined && override.length > 0) {
    return override;
  }

  if (env.LAVALAMP_EXPERTS_FOLLOW_SESSION === '1') {
    return resolveSelectedModel(undefined, env);
  }

  return EXPERT_PROFILES[id].preferredModel;
}

export function isExpertId(value: string): value is ExpertId {
  return (EXPERT_IDS as readonly string[]).includes(value);
}

/** Compact routing block for build-agent instructions / tool description. */
export function expertRoutingTable(): string {
  return EXPERT_IDS.map((id) => {
    const p = EXPERT_PROFILES[id];
    return `- \`${id}\` — ${p.summary}`;
  }).join('\n');
}

/** Longer routing guide for the build agent. */
export function expertRoutingGuide(): string {
  const lines: string[] = [
    '## Experts (Mixture of Experts)',
    'Delegate with `query_expert` when a specialized pass beats more main-agent context.',
    'Experts are READ-ONLY advisors — they return guidance; YOU apply edits.',
    'Pick exactly one expert per call. For independent topics, prefer `deploy_parallel_subs` or sequential expert calls.',
    '',
    '### Roster',
  ];

  for (const id of EXPERT_IDS) {
    const p = EXPERT_PROFILES[id];
    lines.push(`**${id}** — ${p.summary}`);
    lines.push(`- Use when: ${p.whenToUse.join('; ')}`);
    lines.push(`- Avoid when: ${p.whenNotToUse.join('; ')}`);
  }

  lines.push(
    '',
    '### Routing rules',
    '- Prefer `research` for external docs; prefer `oracle` for in-repo cross-cuts.',
    '- Prefer `critique` after a plan or patch; prefer `refactor` when the ask is structure/cleanup.',
    '- Prefer `logic` for pure algorithmic correctness; prefer `database` for schema/query design.',
    '- Prefer `ui` for interface design; prefer `spectacle` only when an image must be described.',
    '- Do not call an expert for trivial one-file edits you can finish yourself.',
    '- The `oracle` *tool* is a cheap second opinion from another model without tools; the `oracle` *expert* is a deep codebase analyst with search tools. Use the expert for repo questions.',
  );

  return lines.join('\n');
}
