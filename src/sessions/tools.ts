import * as v from 'valibot';
import { defineTool } from '@flue/runtime';
import { listSessions, getSession, formatSessionSummary } from './store';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SESSIONS_DIR = join(homedir(), '.agents', 'sessions');

export function createSessionsTool() {
  return defineTool({
    description:
      'List recent lavalamp sessions. Shows session ID, timestamp, prompt, files changed, and model used. Use this to understand what was done before and resume context.',
    execute: async (args) => {
      const sessions = listSessions(args.limit);
      if (sessions.length === 0) {
        return 'No previous sessions found.';
      }
      return sessions.map(formatSessionSummary).join('\n\n');
    },
    name: 'sessions',
    parameters: v.object({
      limit: v.optional(v.number(), 10),
    }),
  });
}

export function createSessionContextTool() {
  return defineTool({
    description:
      'Get full context of a specific past session: what was asked, what files were changed, what model was used, and the summary. Pass the session ID (or first few characters) to look up.',
    execute: async (args) => {
      const session = getSession(args.sessionId);
      if (!session) {
        return `No session found matching "${args.sessionId}". Use sessions tool to list available sessions.`;
      }
      return formatSessionSummary(session);
    },
    name: 'session_context',
    parameters: v.object({
      sessionId: v.string(),
    }),
  });
}

export function createPullSessionTool() {
  return defineTool({
    description:
      'Pull the messages and full conversation history of a specific past session. Pass the session ID to load its contents.',
    execute: async (args) => {
      const id = args.sessionId.trim();
      const filePath = join(SESSIONS_DIR, `${id}.json`);
      if (!existsSync(filePath)) {
        return `No session found with ID "${id}".`;
      }
      try {
        const data = JSON.parse(readFileSync(filePath, 'utf8')) as { messages?: { role?: string; content?: string }[] };
        const messages = data.messages ?? [];
        if (messages.length === 0) {
          return `Session "${id}" has no messages.`;
        }
        return messages
          .map((m: { role?: string; content?: string }) => {
            const prefix = m.role === 'user' ? 'User' : 'Assistant';
            return `[${prefix}]: ${m.content}`;
          })
          .join('\n\n');
      } catch (error: unknown) {
        return `Error loading session: ${(error as Error).message}`;
      }
    },
    name: 'pull_session',
    parameters: v.object({
      sessionId: v.string(),
    }),
  });
}
