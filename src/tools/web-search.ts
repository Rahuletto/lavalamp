import * as v from 'valibot';
import { defineTool } from '@flue/runtime';

const webSearchSchema = v.object({
  query: v.string(),
  maxResults: v.optional(v.number()),
});

export function createWebSearchTool() {
  return defineTool({
    name: 'web_search',
    description:
      'Search the web for information using DuckDuckGo. Returns search results with titles, URLs, and snippets. Use for researching documentation, finding solutions, or gathering context about external topics.',
    parameters: webSearchSchema,
    execute: async (args) => {
      const max = args.maxResults ?? 5;
      const results = await searchWeb(args.query, max);

      if (results.length === 0) {
        return `No results found for: ${args.query}`;
      }

      return results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join('\n\n');
    },
  });
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchWeb(query: string, maxResults: number): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; lavalamp/1.0)' },
  });

  if (!resp.ok) throw new Error(`Search failed: HTTP ${resp.status}`);

  const html = await resp.text();
  return parseSearchResults(html, maxResults);
}

function parseSearchResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links: string[] = [];
  const titles: string[] = [];
  const snippets: string[] = [];

  let match;
  while ((match = resultRegex.exec(html)) !== null && links.length < maxResults) {
    const href = match[1];
    const uddgMatch = href.match(/uddg=([^&]+)/);
    const actualUrl = uddgMatch ? decodeURIComponent(uddgMatch[1]) : href;
    links.push(actualUrl);
    titles.push(match[2].replace(/<[^>]+>/g, '').trim());
  }

  while ((match = snippetRegex.exec(html)) !== null && snippets.length < maxResults) {
    snippets.push(match[1].replace(/<[^>]+>/g, '').trim());
  }

  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    results.push({
      title: titles[i] ?? '',
      url: links[i] ?? '',
      snippet: snippets[i] ?? '',
    });
  }

  return results;
}
