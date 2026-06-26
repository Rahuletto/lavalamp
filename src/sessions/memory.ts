import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const MEMORY_DIR = join(homedir(), '.lavalamp', 'memory');

function workspaceHash(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12);
}

function memoryPath(cwd: string): string {
  return join(MEMORY_DIR, `${workspaceHash(cwd)}.md`);
}

export function loadMemory(cwd: string): string | null {
  const path = memoryPath(cwd);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function saveMemory(cwd: string, content: string): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
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
  if (!memory || memory.trim().length === 0) {
    return null;
  }
  return `## Project Memory (from previous sessions)\n\n${memory}`;
}
