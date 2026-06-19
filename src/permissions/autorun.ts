import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
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
  if (!existsSync(autorunPath)) return;
  try {
    const content = readFileSync(autorunPath, 'utf-8');
    const parsed = JSON.parse(content) as { entries?: AutorunEntry[]; allowAll?: boolean };
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
    const { mkdirSync } = require('fs');
    mkdirSync(dirPath, { recursive: true });
  }
  const entries = Array.from(autorunMap.values());
  writeFileSync(autorunPath, JSON.stringify({ entries, allowAll }, null, 2));
}

export function setAutorun(cwd: string, tool: string, action: PermissionAction, pattern?: string): void {
  const key = pattern ? `${tool}:${pattern}` : tool;
  autorunMap.set(key, { tool, pattern, action, timestamp: Date.now() });
  saveAutorun(cwd);
}

export function clearAutorun(cwd: string, tool?: string): void {
  if (tool) {
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

export function getMatchingAutorun(tool: string, args: Record<string, unknown>): AutorunEntry | undefined {
  const exact = autorunMap.get(tool);
  if (exact) return exact;
  const argsText = JSON.stringify(args);
  for (const entry of autorunMap.values()) {
    if (entry.tool !== tool) continue;
    if (entry.pattern && argsText.includes(entry.pattern)) return entry;
  }
  return undefined;
}

export function isAutorunActive(): boolean {
  return allowAll || autorunMap.size > 0;
}

export function getAutorunEntries(): AutorunEntry[] {
  return Array.from(autorunMap.values());
}
