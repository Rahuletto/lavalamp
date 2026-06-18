import * as v from 'valibot';
import { defineTool } from '@flue/runtime';

const READER_BASE = 'https://r.marban.lol';

const fetchUrlSchema = v.object({
  url: v.string(),
  selector: v.optional(v.string()),
  format: v.optional(v.string()),
});

export function createFetchUrlTool() {
  return defineTool({
    name: 'fetch_url',
    description:
      'Fetch a URL and return its content as clean markdown using the Reader API (r.marban.lol). Use this instead of raw HTML fetches when you need to read, summarize, or quote web content. Returns extracted text, headings, links, and structure.',
    parameters: fetchUrlSchema,
    execute: async (args) => {
      const params = new URLSearchParams({
        url: args.url,
        format: args.format ?? 'markdown',
        cache: 'bypass',
      });
      if (args.selector) params.set('selector', args.selector);

      const resp = await fetch(`${READER_BASE}/read?${params}`);

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Reader API error (${resp.status}): ${body.slice(0, 300)}`);
      }

      const finalUrl = resp.headers.get('X-Final-URL') ?? args.url;
      const content = await resp.text();

      if (finalUrl !== args.url) {
        return `(redirected: ${args.url} -> ${finalUrl})\n\n${content}`;
      }
      return content;
    },
  });
}
