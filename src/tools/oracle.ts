import * as v from 'valibot';
import { defineTool } from '@flue/runtime';

const oracleSchema = v.object({
  context: v.optional(v.string()),
  question: v.string(),
});

export function createOracleTool() {
  return defineTool({
    description:
      'Get a second opinion from a different model. Use when uncertain about an approach, need to verify a solution, or want an alternative perspective. The oracle uses a different model than the one you are running on.',
    execute: async (args) => {
      const prompt = args.context
        ? `You are a second-opinion oracle. A coding assistant is asking for your perspective.\n\nContext:\n${args.context}\n\nQuestion:\n${args.question}\n\nProvide a concise, actionable answer.`
        : `You are a second-opinion oracle. A coding assistant is asking for your perspective.\n\nQuestion:\n${args.question}\n\nProvide a concise, actionable answer.`;

      try {
        const { loadCredentials } = require('../auth/credentials');
        const creds = loadCredentials();
        if (creds) {
          const resp = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/v1/chat/completions`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${creds.apiToken}`,
              },
              body: JSON.stringify({
                model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 1024,
              }),
            },
          );

          if (resp.ok) {
            const data = await resp.json();
            const text = data?.choices?.[0]?.message?.content;
            if (text) return `[oracle — llama-3.3-70b]\n${text}`;
          }
        }
      } catch {}

      return `[oracle] Second opinion requested but unavailable. Reconsider your approach to: ${args.question.slice(0, 200)}`;
    },
    name: 'oracle',
    parameters: oracleSchema,
  });
}
