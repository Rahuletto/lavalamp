import * as v from 'valibot';
import { defineTool } from '@flue/runtime';

const MCP_URL = 'https://mcp.deepwiki.com/mcp';

interface McpRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

let requestId = 0;

async function mcpCall(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const body: McpRequest = {
    jsonrpc: '2.0',
    id: ++requestId,
    method,
    params,
  };

  const resp = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`MCP error (${resp.status}): ${text.slice(0, 200)}`);
  }

  const contentType = resp.headers.get('content-type') ?? '';

  if (contentType.includes('text/event-stream')) {
    const text = await resp.text();
    return parseSseResponse(text);
  }

  const data = await resp.json();
  if (data.error) {
    throw new Error(`MCP error: ${data.error.message ?? JSON.stringify(data.error)}`);
  }
  return data.result;
}

function parseSseResponse(text: string): unknown {
  const dataLines: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  for (let i = dataLines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(dataLines[i]);
      if (parsed.result !== undefined) return parsed.result;
      if (parsed.error) throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));
    } catch {}
  }

  throw new Error('No valid response in SSE stream');
}

let initialized = false;

async function ensureInit(): Promise<void> {
  if (initialized) return;
  await mcpCall('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'lavalamp', version: '0.1.0' },
  });
  await mcpCall('notifications/initialized');
  initialized = true;
}

const deepwikiSchema = v.object({
  repo: v.string(),
  question: v.optional(v.string()),
  topic: v.optional(v.string()),
});

export function createDeepWikiTool() {
  return defineTool({
    name: 'deepwiki',
    description:
      'Query repository documentation from DeepWiki via MCP. Use read_wiki_structure to list topics, read_wiki_contents to read a specific topic, or ask_question to ask anything about a repo. Only works for repos indexed on deepwiki.com.',
    parameters: deepwikiSchema,
    execute: async (args) => {
      await ensureInit();

      const repo = args.repo.trim().replace(/^https?:\/\/github\.com\//, '');

      if (args.question) {
        const result = await mcpCall('tools/call', {
          name: 'ask_question',
          arguments: { repo, question: args.question },
        });
        return extractText(result);
      }

      if (args.topic) {
        const result = await mcpCall('tools/call', {
          name: 'read_wiki_contents',
          arguments: { repo, topic: args.topic },
        });
        return extractText(result);
      }

      const result = await mcpCall('tools/call', {
        name: 'read_wiki_structure',
        arguments: { repo },
      });
      return extractText(result);
    },
  });
}

function extractText(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result ?? '');
  const r = result as Record<string, unknown>;

  if (Array.isArray(r.content)) {
    return r.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n');
  }

  if (typeof r.text === 'string') return r.text;
  if (typeof r === 'string') return r;
  return JSON.stringify(r, null, 2);
}
