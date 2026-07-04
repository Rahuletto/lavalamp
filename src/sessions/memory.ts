import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { memoryDir, memoryPath, memoryPathCandidates } from '../storage/paths';

export function loadMemory(cwd: string): string | null {
  for (const path of memoryPathCandidates(cwd)) {
    if (!existsSync(path)) {
      continue;
    }
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  }
  return null;
}

export function saveMemory(cwd: string, content: string): void {
  mkdirSync(memoryDir(), { recursive: true });
  writeFileSync(memoryPath(cwd), content);
}

export function appendMemory(cwd: string, entry: string): void {
  const existing = loadMemory(cwd) ?? '';
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const newEntry = `\n[${timestamp}] ${entry}`;
  saveMemory(cwd, `${existing + newEntry}\n`);
}

export function getMemoryContext(cwd: string): string | null {
  const memory = loadMemory(cwd);
  if (memory === null || memory.trim().length === 0) {
    return null;
  }
  return `## Project Memory (from previous sessions)\n\n${memory}`;
}
