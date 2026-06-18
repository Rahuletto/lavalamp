import * as v from 'valibot';
import { defineTool } from '@flue/runtime';
import { listSessions, getSession, formatSessionSummary } from './store';

export function createSessionsTool() {
  return defineTool({
    name: 'sessions',
    description:
      'List recent lavalamp sessions. Shows session ID, timestamp, prompt, files changed, and model used. Use this to understand what was done before and resume context.',
    parameters: v.object({
      limit: v.optional(v.number(), 10),
    }),
    execute: async (args) => {
      const sessions = listSessions(args.limit);
      if (sessions.length === 0) {
        return 'No previous sessions found.';
      }
      return sessions.map(formatSessionSummary).join('\n\n');
    },
  });
}

export function createSessionContextTool() {
  return defineTool({
    name: 'session_context',
    description:
      'Get full context of a specific past session: what was asked, what files were changed, what model was used, and the summary. Pass the session ID (or first few characters) to look up.',
    parameters: v.object({
      sessionId: v.string(),
    }),
    execute: async (args) => {
      const session = getSession(args.sessionId);
      if (!session) {
        return `No session found matching "${args.sessionId}". Use sessions tool to list available sessions.`;
      }
      return formatSessionSummary(session);
    },
  });
}
