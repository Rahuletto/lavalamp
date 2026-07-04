import * as v from 'valibot';
import { defineTool } from '@flue/runtime';

const webSearchSchema = v.object({
  maxResults: v.optional(v.number()),
  query: v.string(),
});

export function createWebSearchTool() {
  return defineTool({
    description:
      'Search the web for information using DuckDuckGo. Returns search results with titles, URLs, and snippets. Use for researching documentation, finding solutions, or gathering context about external topics.',
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
    name: 'web_search',
    parameters: webSearchSchema,
  });
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchWeb(
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; lavalamp/1.0)' },
  });

  if (!resp.ok) {
    throw new Error(`Search failed: HTTP ${resp.status}`);
  }

  const html = await resp.text();
  return parseSearchResults(html, maxResults);
}

function parseSearchResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const resultRegex =
    /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links: string[] = [];
  const titles: string[] = [];
  const snippets: string[] = [];

  let match;
  while (
    (match = resultRegex.exec(html)) !== null &&
    links.length < maxResults
  ) {
    const href = match[1];
    const title = match[2];
    if (href === undefined || title === undefined) {
      continue;
    }
    const uddgMatch = href.match(/uddg=([^&]+)/);
    const encodedUrl = uddgMatch?.[1];
    const actualUrl =
      encodedUrl !== undefined ? decodeURIComponent(encodedUrl) : href;
    links.push(actualUrl);
    titles.push(title.replaceAll(/<[^>]+>/g, '').trim());
  }

  while (
    (match = snippetRegex.exec(html)) !== null &&
    snippets.length < maxResults
  ) {
    const snippet = match[1];
    if (snippet !== undefined) {
      snippets.push(snippet.replaceAll(/<[^>]+>/g, '').trim());
    }
  }

  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    results.push({
      snippet: snippets[i] ?? '',
      title: titles[i] ?? '',
      url: links[i] ?? '',
    });
  }

  return results;
}
