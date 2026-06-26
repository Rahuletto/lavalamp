import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionAction } from './rules';

export interface AutorunEntry {
  tool: string;
  pattern?: string;
  action: PermissionAction;
  timestamp: number;
}

const autorunMap = new Map<string, AutorunEntry>();
let allowAll = false;

function getAutorunPath(cwd: string): string {
  return join(cwd, '.lavalamp', 'autorun.json');
}

export function loadAutorun(cwd: string): void {
  const autorunPath = getAutorunPath(cwd);
  if (!existsSync(autorunPath)) {
    return;
  }
  try {
    const content = readFileSync(autorunPath, 'utf8');
    const parsed = JSON.parse(content) as {
      entries?: AutorunEntry[];
      allowAll?: boolean;
    };
    autorunMap.clear();
    if (parsed.entries) {
      for (const entry of parsed.entries) {
        autorunMap.set(entry.tool, entry);
      }
    }
    allowAll = parsed.allowAll ?? false;
  } catch {}
}

export function saveAutorun(cwd: string): void {
  const dirPath = join(cwd, '.lavalamp');
  const autorunPath = getAutorunPath(cwd);
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  const entries = [...autorunMap.values()];
  writeFileSync(autorunPath, JSON.stringify({ allowAll, entries }, null, 2));
}

export function setAutorun(
  cwd: string,
  tool: string,
  action: PermissionAction,
  pattern?: string,
): void {
  const key = pattern !== undefined ? `${tool}:${pattern}` : tool;
  autorunMap.set(key, { action, pattern, timestamp: Date.now(), tool });
  saveAutorun(cwd);
}

export function clearAutorun(cwd: string, tool?: string): void {
  if (tool !== undefined) {
    autorunMap.delete(tool);
  } else {
    autorunMap.clear();
    allowAll = false;
  }
  saveAutorun(cwd);
}

export function setAllowAll(cwd: string, value: boolean): void {
  allowAll = value;
  saveAutorun(cwd);
}

export function isAllowAll(): boolean {
  return allowAll;
}

export function getAutorun(tool: string): AutorunEntry | undefined {
  return autorunMap.get(tool);
}

export function getMatchingAutorun(
  tool: string,
  args: Record<string, unknown>,
): AutorunEntry | undefined {
  const exact = autorunMap.get(tool);
  if (exact) {
    return exact;
  }
  const argsText = JSON.stringify(args);
  for (const entry of autorunMap.values()) {
    if (entry.tool !== tool) {
      continue;
    }
    if (entry.pattern !== undefined && argsText.includes(entry.pattern)) {
      return entry;
    }
  }
  return undefined;
}

export function isAutorunActive(): boolean {
  return allowAll || autorunMap.size > 0;
}

export function getAutorunEntries(): AutorunEntry[] {
  return [...autorunMap.values()];
}
