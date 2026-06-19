import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

export type PermissionAction = 'allow' | 'ask' | 'deny';

export interface PermissionRule {
  tool: string;
  argPattern?: string;
  action: PermissionAction;
  description?: string;
}

const DEFAULT_RULES: PermissionRule[] = [
  { tool: 'read', action: 'allow', description: 'Read file contents' },
  { tool: 'glob', action: 'allow', description: 'Find files by pattern' },
  { tool: 'grep', action: 'allow', description: 'Search file contents' },
  { tool: 'ripgrep', action: 'allow', description: 'Search with regex' },
  { tool: 'list_tasks', action: 'allow', description: 'List tasks' },
  { tool: 'memory_read', action: 'allow', description: 'Read project memory' },
  { tool: 'sessions', action: 'allow', description: 'List sessions' },
  { tool: 'session_context', action: 'allow', description: 'Get session details' },
  { tool: 'web_search', action: 'allow', description: 'Search the web' },
  { tool: 'fetch_url', action: 'allow', description: 'Fetch URL content' },
  { tool: 'deepwiki', action: 'allow', description: 'Query repo docs' },
  { tool: 'codebase_search', action: 'allow', description: 'Search codebase' },
  { tool: 'history', action: 'allow', description: 'Show change history' },
  { tool: 'create_task', action: 'allow', description: 'Create a task' },
  { tool: 'start_task', action: 'allow', description: 'Start a task' },
  { tool: 'complete_task', action: 'allow', description: 'Complete a task' },
  { tool: 'edit_task', action: 'allow', description: 'Edit a task' },
  { tool: 'delete_task', action: 'allow', description: 'Delete a task' },
  { tool: 'skip_task', action: 'allow', description: 'Skip a task' },
  { tool: 'bash', argPattern: '"command":"sed ', action: 'allow', description: 'Read file snippets with sed' },
  { tool: 'write', action: 'ask', description: 'Create or overwrite file' },
  { tool: 'edit', action: 'ask', description: 'Apply hashline patch' },
  { tool: 'bash', action: 'ask', description: 'Run shell command' },
  { tool: 'rename', action: 'ask', description: 'Move or rename file' },
  { tool: 'undo', action: 'ask', description: 'Reverse last file mutation' },
  { tool: 'memory_write', action: 'ask', description: 'Overwrite project memory' },
  { tool: 'memory_append', action: 'ask', description: 'Append to project memory' },
  { tool: 'deploy_parallel_subs', action: 'ask', description: 'Deploy parallel research agents' },
  { tool: 'oracle', action: 'ask', description: 'Get second opinion from different model' },
  { tool: 'doom_loop', action: 'ask', description: 'Get recovery steps when stuck' },
];

function matchArgPattern(args: Record<string, unknown>, pattern?: string): boolean {
  if (!pattern) return true;
  const argsStr = JSON.stringify(args);
  return argsStr.includes(pattern);
}

export function matchRules(toolName: string, args: Record<string, unknown>, rules: PermissionRule[]): PermissionAction {
  for (const rule of rules) {
    if (rule.tool !== toolName) continue;
    if (!matchArgPattern(args, rule.argPattern)) continue;
    return rule.action;
  }
  return 'ask';
}

export function loadRules(cwd: string): PermissionRule[] {
  const rulesPath = join(cwd, '.lavalamp', 'rules.json');
  if (!existsSync(rulesPath)) return [...DEFAULT_RULES];
  try {
    const content = readFileSync(rulesPath, 'utf-8');
    const parsed = JSON.parse(content) as { rules?: PermissionRule[] };
    const userRules = parsed.rules ?? [];
    return [...DEFAULT_RULES, ...userRules];
  } catch {
    return [...DEFAULT_RULES];
  }
}

export function saveRules(cwd: string, rules: PermissionRule[]): void {
  const dirPath = join(cwd, '.lavalamp');
  const rulesPath = join(dirPath, 'rules.json');
  if (!existsSync(dirPath)) {
    const { mkdirSync } = require('fs');
    mkdirSync(dirPath, { recursive: true });
  }
  writeFileSync(rulesPath, JSON.stringify({ rules }, null, 2));
}

export function getDefaultRules(): PermissionRule[] {
  return [...DEFAULT_RULES];
}
