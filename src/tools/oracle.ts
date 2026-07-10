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
      const prompt =
        args.context !== null && args.context !== undefined
          ? `You are a second-opinion oracle. A coding assistant is asking for your perspective.\n\nContext:\n${args.context}\n\nQuestion:\n${args.question}\n\nProvide a concise, actionable answer.`
          : `You are a second-opinion oracle. A coding assistant is asking for your perspective.\n\nQuestion:\n${args.question}\n\nProvide a concise, actionable answer.`;

      try {
        const { loadCredentials } = await import('../auth/credentials');
        const creds = loadCredentials();
        if (creds === null || creds === undefined) {
          return '[oracle] Cloudflare credentials not found. Please run wrangler login or configure credentials first.';
        }

        const resp = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/v1/chat/completions`,
          {
            body: JSON.stringify({
              max_tokens: 1024,
              messages: [{ content: prompt, role: 'user' }],
              model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
            }),
            headers: {
              Authorization: `Bearer ${creds.apiToken}`,
              'Content-Type': 'application/json',
            },
            method: 'POST',
          },
        );

        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          return `[oracle] Cloudflare API error: ${resp.status} ${resp.statusText}${body ? ` - ${body.slice(0, 200)}` : ''}`;
        }

        const data = (await resp.json()) as Record<string, unknown>;
        const choices = data.choices as
          | Record<string, unknown>[]
          | undefined;
        const choice = choices?.[0];
        const text =
          choice !== undefined
            ? (choice.message as Record<string, unknown> | undefined) !==
              undefined
              ? (choice.message as Record<string, unknown>).content
              : undefined
            : undefined;
        if (typeof text === 'string' && text !== '') {
          return `[oracle — llama-3.3-70b]\n${text}`;
        }
        return '[oracle] Empty or invalid response returned by model.';
      } catch (error: any) {
        return `[oracle] Request failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    name: 'oracle',
    parameters: oracleSchema,
  });
}
