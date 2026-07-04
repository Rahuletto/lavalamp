import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { classifyShellCommand } from './shell-policy';

export type PermissionAction = 'allow' | 'ask' | 'deny';

export interface PermissionRule {
  tool: string;
  argPattern?: string;
  commandClass?: 'read' | 'mutation' | 'unknown';
  action: PermissionAction;
  description?: string;
}

const DEFAULT_RULES: PermissionRule[] = [
  { action: 'allow', description: 'Read file contents', tool: 'read' },
  { action: 'allow', description: 'Find files by pattern', tool: 'glob' },
  { action: 'allow', description: 'Search file contents', tool: 'grep' },
  { action: 'allow', description: 'Search with regex', tool: 'ripgrep' },
  { action: 'allow', description: 'List tasks', tool: 'list_tasks' },
  { action: 'allow', description: 'Read project memory', tool: 'memory_read' },
  { action: 'allow', description: 'List sessions', tool: 'sessions' },
  {
    action: 'allow',
    description: 'Get session details',
    tool: 'session_context',
  },
  { action: 'allow', description: 'Search the web', tool: 'web_search' },
  { action: 'allow', description: 'Fetch URL content', tool: 'fetch_url' },
  { action: 'allow', description: 'Query repo docs', tool: 'deepwiki' },
  { action: 'allow', description: 'Search codebase', tool: 'codebase_search' },
  { action: 'allow', description: 'Show change history', tool: 'history' },
  { action: 'allow', description: 'Create a task', tool: 'create_task' },
  { action: 'allow', description: 'Start a task', tool: 'start_task' },
  { action: 'allow', description: 'Complete a task', tool: 'complete_task' },
  { action: 'allow', description: 'Edit a task', tool: 'edit_task' },
  { action: 'allow', description: 'Delete a task', tool: 'delete_task' },
  { action: 'allow', description: 'Skip a task', tool: 'skip_task' },
  {
    action: 'allow',
    commandClass: 'read',
    description: 'Run read-only shell inspection',
    tool: 'bash',
  },
  { action: 'ask', description: 'Create or overwrite file', tool: 'write' },
  { action: 'ask', description: 'Apply hashline patch', tool: 'edit' },
  { action: 'ask', description: 'Run shell command', tool: 'bash' },
  { action: 'ask', description: 'Move or rename file', tool: 'rename' },
  { action: 'ask', description: 'Reverse last file mutation', tool: 'undo' },
  {
    action: 'ask',
    description: 'Overwrite project memory',
    tool: 'memory_write',
  },
  {
    action: 'ask',
    description: 'Append to project memory',
    tool: 'memory_append',
  },
  {
    action: 'ask',
    description: 'Deploy parallel research agents',
    tool: 'deploy_parallel_subs',
  },
  {
    action: 'ask',
    description: 'Get second opinion from different model',
    tool: 'oracle',
  },
  {
    action: 'ask',
    description: 'Get recovery steps when stuck',
    tool: 'doom_loop',
  },
];

function matchArgPattern(
  args: Record<string, unknown>,
  pattern?: string,
): boolean {
  if (pattern === undefined) {
    return true;
  }
  const argsStr = JSON.stringify(args);
  return argsStr.includes(pattern);
}

function matchCommandClass(
  toolName: string,
  args: Record<string, unknown>,
  commandClass?: PermissionRule['commandClass'],
): boolean {
  if (commandClass === undefined) {
    return true;
  }
  if (toolName !== 'bash') {
    return false;
  }
  const command =
    typeof args.command === 'string'
      ? args.command
      : typeof args.cmd === 'string'
        ? args.cmd
        : '';
  return classifyShellCommand(command).kind === commandClass;
}

export function matchRules(
  toolName: string,
  args: Record<string, unknown>,
  rules: PermissionRule[],
): PermissionAction {
  for (const rule of rules) {
    if (rule.tool !== toolName) {
      continue;
    }
    if (!matchArgPattern(args, rule.argPattern)) {
      continue;
    }
    if (!matchCommandClass(toolName, args, rule.commandClass)) {
      continue;
    }
    return rule.action;
  }
  return 'ask';
}

export function loadRules(cwd: string): PermissionRule[] {
  const rulesPath = join(cwd, '.agents', 'rules.json');
  if (!existsSync(rulesPath)) {
    return [...DEFAULT_RULES];
  }
  try {
    const content = readFileSync(rulesPath, 'utf8');
    const parsed = JSON.parse(content) as { rules?: PermissionRule[] };
    const userRules = parsed.rules ?? [];
    return [...DEFAULT_RULES, ...userRules];
  } catch {
    return [...DEFAULT_RULES];
  }
}

export function saveRules(cwd: string, rules: PermissionRule[]): void {
  const dirPath = join(cwd, '.agents');
  const rulesPath = join(dirPath, 'rules.json');
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  writeFileSync(rulesPath, JSON.stringify({ rules }, null, 2));
}

export function getDefaultRules(): PermissionRule[] {
  return [...DEFAULT_RULES];
}
