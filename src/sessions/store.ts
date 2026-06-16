import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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

const SESSIONS_DIR = join(homedir(), '.lavalamp', 'sessions');

function ensureDir() {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

function generateId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rand}`;
}

export function startSession(prompt: string, cwd: string, model?: string): SessionRecord {
  ensureDir();
  const session: SessionRecord = {
    sessionId: generateId(),
    startedAt: new Date().toISOString(),
    cwd,
    prompt,
    filesChanged: [],
    model,
    toolCount: 0,
  };
  writeFileSync(join(SESSIONS_DIR, `${session.sessionId}.json`), JSON.stringify(session, null, 2));
  return session;
}

export function endSession(sessionId: string, summary?: string) {
  const filePath = join(SESSIONS_DIR, `${sessionId}.json`);
  if (!existsSync(filePath)) return;
  const session: SessionRecord = JSON.parse(readFileSync(filePath, 'utf-8'));
  session.endedAt = new Date().toISOString();
  if (summary) session.summary = summary;
  writeFileSync(filePath, JSON.stringify(session, null, 2));
}

export function recordFileChange(sessionId: string, filePath: string) {
  const sessionPath = join(SESSIONS_DIR, `${sessionId}.json`);
  if (!existsSync(sessionPath)) return;
  const session: SessionRecord = JSON.parse(readFileSync(sessionPath, 'utf-8'));
  if (!session.filesChanged.includes(filePath)) {
    session.filesChanged.push(filePath);
  }
  session.toolCount++;
  writeFileSync(sessionPath, JSON.stringify(session, null, 2));
}

export function listSessions(limit = 20): SessionRecord[] {
  ensureDir();
  const files = readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit);

  return files.map((f) => {
    const content = readFileSync(join(SESSIONS_DIR, f), 'utf-8');
    return JSON.parse(content) as SessionRecord;
  });
}

export function getSession(sessionId: string): SessionRecord | null {
  const filePath = join(SESSIONS_DIR, `${sessionId}.json`);
  if (!existsSync(filePath)) {
    const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
    const match = files.find((f) => f.startsWith(sessionId));
    if (!match) return null;
    return JSON.parse(readFileSync(join(SESSIONS_DIR, match), 'utf-8'));
  }
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

export function formatSessionSummary(s: SessionRecord): string {
  const dur = s.endedAt
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
  if (s.summary) {
    lines.push(`  Summary:  ${s.summary}`);
  }
  return lines.join('\n');
}
