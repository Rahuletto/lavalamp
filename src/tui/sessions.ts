import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Message } from './state';
import {
  sessionDirs,
  sessionPath,
  sessionPathCandidates,
  sessionsDir,
} from '../storage/paths';

function ensureSessionsDir() {
  fs.mkdirSync(sessionsDir(), { recursive: true });
}

export function nameSession(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) {
    return 'Empty Session';
  }

  let text = firstUser.content
    .replace(/^<<PLAN_MODE>>\s*/, '') // Strip plan mode tag
    .replace(/^\/\w+\s*/, '') // Strip slash commands (e.g., /ask)
    .replaceAll(/[#@][^\s]*/g, '') // Strip autocomplete prefixes/skills
    .replaceAll(/\s+/g, ' ') // Normalize spacing
    .trim();

  if (!text) {
    return 'Chat Session';
  }

  // Capitalize first letter
  text = text.charAt(0).toUpperCase() + text.slice(1);

  // Truncate to a reasonable length, avoiding word cutoff if possible
  const maxLength = 45;
  if (text.length > maxLength) {
    const truncated = text.slice(0, maxLength);
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > maxLength * 0.7) {
      text = `${truncated.slice(0, lastSpace)}...`;
    } else {
      text = `${truncated}...`;
    }
  }

  return text;
}

export function saveSession(
  messages: Message[],
  name: string,
  existingId?: string,
): string {
  ensureSessionsDir();
  const id = existingId ?? `session_${Date.now()}`;
  const file = sessionPath(id);
  fs.writeFileSync(
    file,
    JSON.stringify({ id, messages, name, savedAt: Date.now() }),
  );
  return id;
}

export function listSessions(): {
  id: string;
  name: string;
  savedAt: number;
  messageCount: number;
}[] {
  ensureSessionsDir();
  const seen = new Set<string>();
  const sessions: {
    id: string;
    name: string;
    savedAt: number;
    messageCount: number;
  }[] = [];
  for (const dir of sessionDirs()) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (typeof data.id === 'string' && data.id.length > 0) {
          if (seen.has(data.id)) {
            continue;
          }
          seen.add(data.id);
          sessions.push({
            id: data.id,
            messageCount: (data.messages ?? []).length,
            name: data.name ?? f.replace('.json', ''),
            savedAt: data.savedAt ?? 0,
          });
        }
      } catch {}
    }
  }
  sessions.sort((a, b) => b.savedAt - a.savedAt);
  return sessions.slice(0, 20);
}

export function loadSession(sessionId: string): Message[] | null {
  ensureSessionsDir();
  for (const file of sessionPathCandidates(sessionId)) {
    try {
      const data: { messages?: Message[] } = JSON.parse(
        fs.readFileSync(file, 'utf8'),
      );
      return data.messages ?? null;
    } catch {}
  }
  return null;
}
