import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import {
  sessionDirs,
  sessionPath,
  sessionPathCandidates,
  sessionsDir,
} from '../storage/paths';

export interface SessionRecord {
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  cwd: string;
  prompt: string;
  filesChanged: string[];
  summary?: string;
  model?: string;
  toolCount: number;
  tokensUsed?: number;
}

function ensureDir() {
  mkdirSync(sessionsDir(), { recursive: true });
}

function generateId(): string {
  const now = new Date();
  const ts = now.toISOString().replaceAll(/[:.]/g, '-').slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rand}`;
}

export function startSession(
  prompt: string,
  cwd: string,
  model?: string,
): SessionRecord {
  ensureDir();
  const session: SessionRecord = {
    cwd,
    filesChanged: [],
    model,
    prompt,
    sessionId: generateId(),
    startedAt: new Date().toISOString(),
    toolCount: 0,
  };
  writeFileSync(
    sessionPath(session.sessionId),
    JSON.stringify(session, null, 2),
  );
  return session;
}

function readSessionFile(filePath: string): SessionRecord | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as SessionRecord;
  } catch {
    return null;
  }
}

export function findSessionFilePath(sessionId: string): string | null {
  for (const candidate of sessionPathCandidates(sessionId)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const dir of sessionDirs()) {
    if (!existsSync(dir)) {
      continue;
    }
    const match = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .find((f) => f.startsWith(sessionId));
    if (match !== undefined) {
      return join(dir, match);
    }
  }
  return null;
}

export function endSession(sessionId: string, summary?: string) {
  const filePath = findSessionFilePath(sessionId);
  if (filePath === null) {
    return;
  }
  const session = readSessionFile(filePath);
  if (session === null) {
    return;
  }
  session.endedAt = new Date().toISOString();
  if (summary !== undefined) {
    session.summary = summary;
  }
  writeFileSync(filePath, JSON.stringify(session, null, 2));
}

export function recordFileChange(sessionId: string, filePath: string) {
  const storedPath = findSessionFilePath(sessionId);
  if (storedPath === null) {
    return;
  }
  const session = readSessionFile(storedPath);
  if (session === null) {
    return;
  }
  if (!session.filesChanged.includes(filePath)) {
    session.filesChanged.push(filePath);
  }
  session.toolCount++;
  writeFileSync(storedPath, JSON.stringify(session, null, 2));
}

export function listSessions(limit = 20): SessionRecord[] {
  ensureDir();
  const seen = new Set<string>();
  const files: string[] = [];
  for (const dir of sessionDirs()) {
    if (!existsSync(dir)) {
      continue;
    }
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      files.push(join(dir, file));
    }
  }

  return files
    .toSorted((a, b) => basename(b).localeCompare(basename(a)))
    .slice(0, limit)
    .map(readSessionFile)
    .filter((session): session is SessionRecord => session !== null);
}

export function getSession(sessionId: string): SessionRecord | null {
  const filePath = findSessionFilePath(sessionId);
  return filePath === null ? null : readSessionFile(filePath);
}

export function formatSessionSummary(s: SessionRecord): string {
  const dur =
    s.endedAt !== undefined
      ? `${Math.round((new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 1000)}s`
      : 'active';
  const lines = [
    `Session: ${s.sessionId}`,
    `  Started:  ${s.startedAt}`,
    `  Duration: ${dur}`,
    `  Prompt:   ${s.prompt.slice(0, 80)}${s.prompt.length > 80 ? '...' : ''}`,
    `  Model:    ${s.model ?? 'default'}`,
    `  Tools:    ${s.toolCount} calls`,
    `  Files:    ${s.filesChanged.length} modified`,
  ];
  if (s.filesChanged.length > 0) {
    lines.push(`    ${s.filesChanged.join('\n    ')}`);
  }
  if (s.summary !== undefined) {
    lines.push(`  Summary:  ${s.summary}`);
  }
  return lines.join('\n');
}
