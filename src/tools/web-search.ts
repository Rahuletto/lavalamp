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
  const blocks = html.split(/<div[^>]*class="[^"]*links_main[^"]*"[^>]*>/i).slice(1);

  const resultRegex =
    /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i;

  for (const block of blocks) {
    if (results.length >= maxResults) {
      break;
    }

    const rMatch = resultRegex.exec(block);
    if (!rMatch) {
      continue;
    }

    const href = rMatch[1];
    const title = rMatch[2];
    if (href === undefined || title === undefined) {
      continue;
    }

    const uddgMatch = href.match(/uddg=([^&]+)/);
    const encodedUrl = uddgMatch?.[1];
    const actualUrl =
      encodedUrl !== undefined ? decodeURIComponent(encodedUrl) : href;

    const sMatch = snippetRegex.exec(block);
    const snippet = sMatch ? sMatch[1] : '';

    results.push({
      snippet: (snippet ?? '').replaceAll(/<[^>]+>/g, '').trim(),
      title: title.replaceAll(/<[^>]+>/g, '').trim(),
      url: actualUrl,
    });
  }

  return results;
}
